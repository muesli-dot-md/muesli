//! Single-owner Doc Rooms (ADR 0010): one tokio task owns each Document's in-memory CRDT and
//! is its sole writer. Connections forward inbound frames to the room; the room broadcasts to
//! everyone else. Phase 0: in-memory only (no persistence, no idle eviction yet).

use std::collections::HashMap;
use std::sync::Arc;

use muesli_core::{Anchor, MuesliDoc};
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::events::WorkspaceEvents;
use crate::links::LinkHandle;
use crate::persistence::{Persistence, SNAPSHOT_EVERY};
use crate::storage::StorageHandle;

use muesli_core::events::{WorkspaceEvent, WorkspaceEventEnvelope};

use muesli_core::protocol::{
    decode_awareness, encode_awareness, frame_awareness, frame_sync, AwarenessEntry, Cursor,
    MSG_AWARENESS, MSG_QUERY_AWARENESS, MSG_SYNC, SYNC_STEP1, SYNC_STEP2, SYNC_UPDATE,
};

pub type ConnId = u64;
pub type Outbound = mpsc::UnboundedSender<Vec<u8>>;

pub enum RoomMsg {
    Join {
        conn: ConnId,
        tx: Outbound,
        can_edit: bool,
        author_id: Option<Uuid>,
        author_is_agent: bool,
    },
    Leave {
        conn: ConnId,
    },
    Inbound {
        conn: ConnId,
        data: Vec<u8>,
    },
    /// Pin a byte range with sticky indices (ADR 0019); replies with the anchor's json form.
    CreateAnchor {
        start: usize,
        end: usize,
        reply: oneshot::Sender<Result<serde_json::Value, String>>,
    },
    /// Current byte range of a stored anchor: None = unresolvable, start==end = text gone.
    ResolveAnchor {
        anchor: serde_json::Value,
        reply: oneshot::Sender<Option<(usize, usize)>>,
    },
    GetText {
        reply: oneshot::Sender<String>,
    },
    GetSeq {
        reply: oneshot::Sender<i64>,
    },
    /// The Postgres documents.id this room hydrated as (None = volatile). Because the room
    /// processes commands only after hydration, a reply also guarantees the doc row exists.
    GetDocumentId {
        reply: oneshot::Sender<Option<Uuid>>,
    },
    /// Apply (start, end, replacement) edits as ONE transaction = one atomic, attributed,
    /// revertable change set (ADR 0007); persists with change_set_id and broadcasts.
    ApplyEdit {
        ops: Vec<(usize, usize, String)>,
        author_id: Option<Uuid>,
        change_set_id: Option<Uuid>,
        origin: String,
        reply: oneshot::Sender<Result<i64, String>>,
    },
    /// Out-of-band ingest (ADR 0013): merge externally rewritten markdown into the live doc
    /// as a text diff (MuesliDoc::ingest), persisted with origin 'ingest' and author None,
    /// then broadcast. NoOp ingests persist nothing. Replies with the room's seq.
    IngestText {
        text: String,
        reply: oneshot::Sender<Result<i64, String>>,
    },
    /// ADR 0007 presence-aware default: is any human (non-agent) connection announcing
    /// awareness state right now?
    HumanPresent {
        reply: oneshot::Sender<bool>,
    },
    /// Best-effort "✦ Agent editing" (ADR 0007): inject a synthetic awareness entry
    /// (kind: "agent") through the normal broadcast + join-replay path. Replies with a
    /// generation token so a delayed clear never removes a newer announcement.
    AgentPresenceSet {
        name: String,
        reply: oneshot::Sender<u64>,
    },
    AgentPresenceClear {
        generation: u64,
    },
}

/// Reserved connection slot for the synthetic agent-presence awareness entry; real
/// connections count up from 1 (main.rs NEXT_CONN) and never reach it.
const AGENT_PRESENCE_CONN: ConnId = ConnId::MAX;

struct ClientConn {
    tx: Outbound,
    /// Role gate (sync-protocol.md): Viewer/Commenter connections receive updates and send
    /// awareness, but their direct-edit sync messages are rejected server-side.
    can_edit: bool,
    /// Attribution for the update log (ADR 0007); None = anonymous guest / open mode.
    author_id: Option<Uuid>,
    /// users.kind of the author: agents (Bearer-token principals) don't count as human
    /// presence and their ws edits log origin 'agent'.
    is_agent: bool,
}

pub fn spawn_room(
    doc_id: String,
    persistence: Option<Arc<Persistence>>,
    storage: Option<StorageHandle>,
    links: Option<LinkHandle>,
    workspace_events: WorkspaceEvents,
) -> mpsc::UnboundedSender<RoomMsg> {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(run_room(
        doc_id,
        persistence,
        storage,
        links,
        workspace_events,
        rx,
    ));
    tx
}

struct Room {
    doc_id: String,
    doc: MuesliDoc,
    clients: HashMap<ConnId, ClientConn>,
    /// Latest awareness state per connection: client_id -> (clock, state json).
    awareness: HashMap<ConnId, HashMap<u64, (u64, String)>>,
    /// Persistence (ADR 0010): the room is the sole writer to its document's log.
    persistence: Option<Arc<Persistence>>,
    /// Storage materialization (ADR 0013): a fire-and-forget dirty ping after every persist;
    /// the storage manager debounces and writes. Never blocks the actor.
    storage: Option<StorageHandle>,
    /// Link extraction (ADR 0015): the same fire-and-forget seam — a dirty ping after
    /// every persist (the indexer debounces ~2s) and a hydration ping (re-resolution +
    /// lazy backfill). None in volatile mode: links are silently skipped.
    links: Option<LinkHandle>,
    document_id: Option<Uuid>,
    /// The workspace this room's document belongs to (learned at hydrate); None in open mode
    /// or volatile. Needed to publish DocUpdated on the right stream.
    workspace_id: Option<Uuid>,
    /// Plan 4: per-workspace structure stream. `persist` publishes DocUpdated wake-pings here.
    workspace_events: WorkspaceEvents,
    seq: i64,
    since_snapshot: u64,
    /// Synthetic agent presence (ADR 0007): a stable fake awareness client id, its lamport
    /// clock, and a generation counter guarding delayed clears.
    agent_client_id: u64,
    agent_clock: u64,
    agent_generation: u64,
}

async fn run_room(
    doc_id: String,
    persistence: Option<Arc<Persistence>>,
    storage: Option<StorageHandle>,
    links: Option<LinkHandle>,
    workspace_events: WorkspaceEvents,
    mut rx: mpsc::UnboundedReceiver<RoomMsg>,
) {
    let mut room = Room {
        // Empty until hydrated; content comes from the log, clients, or the Local Agent's
        // ingest of the Canonical File (ADR 0001/0014).
        doc: MuesliDoc::new(),
        doc_id,
        clients: HashMap::new(),
        awareness: HashMap::new(),
        persistence,
        storage,
        links,
        document_id: None,
        workspace_id: None,
        workspace_events,
        seq: 0,
        since_snapshot: 0,
        // Yjs client ids are u32-ish doubles in JS clients — stay in that range.
        agent_client_id: u64::from(rand::random::<u32>()),
        agent_clock: 0,
        agent_generation: 0,
    };
    room.hydrate().await;
    while let Some(msg) = rx.recv().await {
        match msg {
            RoomMsg::Join {
                conn,
                tx,
                can_edit,
                author_id,
                author_is_agent,
            } => room.on_join(conn, tx, can_edit, author_id, author_is_agent),
            RoomMsg::Leave { conn } => room.on_leave(conn),
            RoomMsg::Inbound { conn, data } => room.on_inbound(conn, &data).await,
            RoomMsg::CreateAnchor { start, end, reply } => {
                let _ = reply.send(
                    room.doc
                        .create_anchor(start, end)
                        .map(|a| a.to_json())
                        .map_err(|e| e.to_string()),
                );
            }
            RoomMsg::ResolveAnchor { anchor, reply } => {
                let resolved = Anchor::from_json(&anchor)
                    .ok()
                    .and_then(|a| room.doc.resolve_anchor(&a));
                let _ = reply.send(resolved);
            }
            RoomMsg::GetText { reply } => {
                let _ = reply.send(room.doc.materialize());
            }
            RoomMsg::GetSeq { reply } => {
                let _ = reply.send(room.seq);
            }
            RoomMsg::GetDocumentId { reply } => {
                let _ = reply.send(room.document_id);
            }
            RoomMsg::ApplyEdit {
                ops,
                author_id,
                change_set_id,
                origin,
                reply,
            } => {
                let _ = reply.send(
                    room.on_apply_edit(ops, author_id, change_set_id, &origin)
                        .await,
                );
            }
            RoomMsg::IngestText { text, reply } => {
                let _ = reply.send(room.on_ingest(&text).await);
            }
            RoomMsg::HumanPresent { reply } => {
                let _ = reply.send(room.human_present());
            }
            RoomMsg::AgentPresenceSet { name, reply } => {
                let _ = reply.send(room.agent_presence_set(&name));
            }
            RoomMsg::AgentPresenceClear { generation } => {
                room.agent_presence_clear(generation);
            }
        }
    }
}

impl Room {
    /// Load = latest snapshot + replay tail (ADR 0010). On failure the room stays up but
    /// volatile — loudly, so operators see it.
    async fn hydrate(&mut self) {
        let Some(p) = self.persistence.clone() else {
            return;
        };
        match p.load(&self.doc_id).await {
            Ok(state) => {
                if let Some(snapshot) = &state.snapshot {
                    if let Err(e) = self.doc.apply_update(snapshot) {
                        error!(doc = %self.doc_id, %e, "corrupt snapshot — falling back to full log replay is not implemented; room starts volatile");
                        self.persistence = None;
                        return;
                    }
                }
                let tail_len = state.tail.len();
                for update in &state.tail {
                    if let Err(e) = self.doc.apply_update(update) {
                        warn!(doc = %self.doc_id, %e, "skipping corrupt update during replay");
                    }
                }
                self.document_id = Some(state.document_id);
                self.workspace_id = state.workspace_id;
                self.seq = state.last_seq;
                // Link graph (ADR 0015): a (possibly fresh) document is live — re-resolve
                // unresolved links pointing at it and lazily backfill its own rows.
                if let Some(links) = &self.links {
                    links.doc_hydrated(state.document_id);
                }
                info!(doc = %self.doc_id, seq = self.seq, replayed = tail_len, "hydrated from postgres");
            }
            Err(e) => {
                error!(doc = %self.doc_id, %e, "hydration failed — room is VOLATILE (edits not persisted)");
                self.persistence = None;
            }
        }
    }

    /// Append an applied update to the log; snapshot every SNAPSHOT_EVERY appends.
    async fn persist(
        &mut self,
        update: &[u8],
        origin: &str,
        author_id: Option<Uuid>,
        change_set_id: Option<Uuid>,
    ) {
        let (Some(p), Some(document_id)) = (self.persistence.as_ref(), self.document_id) else {
            return;
        };
        self.seq += 1;
        if let Err(e) = p
            .append_update(
                document_id,
                self.seq,
                update,
                origin,
                author_id,
                change_set_id,
            )
            .await
        {
            error!(doc = %self.doc_id, seq = self.seq, %e, "FAILED to persist update");
            return;
        }
        // Plan 4: wake any cold daemon session watching this workspace so it pulls the new text.
        self.publish_doc_updated();
        // Materialization (ADR 0013): fire-and-forget; the storage manager debounces and
        // skips documents without an attached backend.
        if let Some(storage) = &self.storage {
            storage.mark_dirty(document_id);
        }
        // Link extraction rides the same seam (ADR 0015): debounced in the indexer.
        if let Some(links) = &self.links {
            links.mark_dirty(document_id);
        }
        self.since_snapshot += 1;
        if self.since_snapshot >= SNAPSHOT_EVERY {
            self.since_snapshot = 0;
            let snapshot = self.doc.encode_full_update();
            if let Err(e) = p.save_snapshot(document_id, self.seq, &snapshot).await {
                warn!(doc = %self.doc_id, %e, "snapshot failed (log is still intact)");
            } else {
                debug!(doc = %self.doc_id, up_to = self.seq, "snapshot written");
            }
        }
    }

    /// Publish a DocUpdated wake-ping for this room's document (Plan 4 Contract 1). Origin is
    /// None — this event is born inside the room, not from a daemon REST call. No-op when the
    /// room has no workspace (open mode / volatile) or no live subscribers.
    fn publish_doc_updated(&self) {
        let Some(ws) = self.workspace_id else { return };
        self.workspace_events.publish(
            ws,
            WorkspaceEventEnvelope {
                origin: None,
                event: WorkspaceEvent::DocUpdated {
                    slug: self.doc_id.clone(),
                },
            },
        );
    }

    fn on_join(
        &mut self,
        conn: ConnId,
        tx: Outbound,
        can_edit: bool,
        author_id: Option<Uuid>,
        is_agent: bool,
    ) {
        debug!(doc = %self.doc_id, conn, can_edit, clients = self.clients.len() + 1, "client joined");
        // y-sync handshake: server opens with step 1 (its state vector); the client replies
        // with step 2 and sends its own step 1 (internal/design/sync-protocol.md).
        let _ = tx.send(frame_sync(SYNC_STEP1, &self.doc.state_vector()));
        // Replay current awareness so the joiner sees existing cursors immediately.
        let snapshot = self.awareness_snapshot();
        if !snapshot.is_empty() {
            let _ = tx.send(frame_awareness(&encode_awareness(&snapshot)));
        }
        self.clients.insert(
            conn,
            ClientConn {
                tx,
                can_edit,
                author_id,
                is_agent,
            },
        );
    }

    fn on_leave(&mut self, conn: ConnId) {
        self.clients.remove(&conn);
        // Tell remaining clients this participant's awareness states are gone.
        if let Some(states) = self.awareness.remove(&conn) {
            let removals: Vec<AwarenessEntry> = states
                .into_iter()
                .map(|(client_id, (clock, _))| AwarenessEntry {
                    client_id,
                    clock: clock + 1,
                    json: "null".into(),
                })
                .collect();
            if !removals.is_empty() {
                self.broadcast(frame_awareness(&encode_awareness(&removals)), None);
            }
        }
        debug!(doc = %self.doc_id, conn, clients = self.clients.len(), "client left");
    }

    async fn on_inbound(&mut self, conn: ConnId, data: &[u8]) {
        let mut c = Cursor::new(data);
        let Ok(msg_type) = c.read_var_u64() else {
            return;
        };
        match msg_type {
            MSG_SYNC => {
                let Ok(subtype) = c.read_var_u64() else {
                    return;
                };
                let Ok(payload) = c.read_bytes() else { return };
                let payload = payload.to_vec();
                self.on_sync(conn, subtype, &payload).await;
            }
            MSG_AWARENESS => {
                let Ok(payload) = c.read_bytes() else { return };
                self.on_awareness(conn, payload);
            }
            MSG_QUERY_AWARENESS => {
                let snapshot = self.awareness_snapshot();
                if let Some(client) = self.clients.get(&conn) {
                    let _ = client
                        .tx
                        .send(frame_awareness(&encode_awareness(&snapshot)));
                }
            }
            other => {
                warn!(doc = %self.doc_id, conn, msg_type = other, "ignoring unknown message type")
            }
        }
    }

    async fn on_sync(&mut self, conn: ConnId, subtype: u64, payload: &[u8]) {
        match subtype {
            SYNC_STEP1 => {
                // Client sent its state vector; answer with the missing delta (read is
                // allowed for every role).
                match self.doc.diff_update(payload) {
                    Ok(diff) => {
                        if let Some(client) = self.clients.get(&conn) {
                            let _ = client.tx.send(frame_sync(SYNC_STEP2, &diff));
                        }
                    }
                    Err(e) => warn!(doc = %self.doc_id, conn, %e, "bad state vector"),
                }
            }
            SYNC_STEP2 | SYNC_UPDATE => {
                // Role gate (ADR 0011): only Editors may write. Enforced here, not trusted
                // from the client.
                let Some(client) = self.clients.get(&conn) else {
                    return;
                };
                if !client.can_edit {
                    warn!(doc = %self.doc_id, conn, "dropped write from non-editor connection");
                    return;
                }
                let author_id = client.author_id;
                let origin = if client.is_agent { "agent" } else { "human" };
                // The room is the single writer: apply, persist, then fan out to everyone
                // else. Snapshot comparison (not state vector!) so delete-only updates —
                // which advance no client clock — are persisted too.
                let changed = match self.doc.apply_update_changed(payload) {
                    Ok(changed) => changed,
                    Err(e) => {
                        warn!(doc = %self.doc_id, conn, %e, "rejected malformed update");
                        return;
                    }
                };
                if changed {
                    self.persist(payload, origin, author_id, None).await;
                }
                self.broadcast(frame_sync(SYNC_UPDATE, payload), Some(conn));
            }
            other => warn!(doc = %self.doc_id, conn, subtype = other, "unknown sync subtype"),
        }
    }

    fn on_awareness(&mut self, conn: ConnId, payload: &[u8]) {
        // Validate before relaying: awareness carries the identity peers render (name,
        // kind, cursor), so it is NOT relayed untouched. Undecodable payloads are dropped
        // outright (we never relay what we can't validate), and each entry must pass the
        // identity checks in `awareness_entry_ok` before it is tracked (join replay +
        // disconnect removal) and re-encoded for broadcast.
        let entries = match decode_awareness(payload) {
            Ok(entries) => entries,
            Err(e) => {
                warn!(doc = %self.doc_id, conn, ?e, "dropping unparseable awareness update");
                return;
            }
        };
        let accepted: Vec<AwarenessEntry> = entries
            .into_iter()
            .filter(|e| self.awareness_entry_ok(conn, e))
            .collect();
        if accepted.is_empty() {
            return;
        }
        let states = self.awareness.entry(conn).or_default();
        for e in &accepted {
            if e.json == "null" {
                states.remove(&e.client_id);
            } else {
                states.insert(e.client_id, (e.clock, e.json.clone()));
            }
        }
        self.broadcast(frame_awareness(&encode_awareness(&accepted)), Some(conn));
    }

    /// May `conn` announce this awareness entry? Two spoofing gates:
    /// - a Yjs client_id already announced by ANOTHER connection (or the reserved
    ///   synthetic agent entry) cannot be claimed — that would clobber or impersonate
    ///   someone else's presence;
    /// - `user.kind: "agent"` (the "✦ Agent editing" trust signal) is only accepted from
    ///   connections whose authenticated principal actually IS an agent; a state blob
    ///   that isn't valid JSON is rejected too, since it can't be validated.
    fn awareness_entry_ok(&self, conn: ConnId, e: &AwarenessEntry) -> bool {
        let owned_elsewhere = e.client_id == self.agent_client_id
            || self
                .awareness
                .iter()
                .any(|(&owner, states)| owner != conn && states.contains_key(&e.client_id));
        if owned_elsewhere {
            warn!(doc = %self.doc_id, conn, client_id = e.client_id,
                  "dropping awareness entry claiming another connection's client_id");
            return false;
        }
        if e.json == "null" {
            return true; // a removal carries no identity
        }
        let is_agent_conn = self.clients.get(&conn).is_some_and(|c| c.is_agent);
        if !is_agent_conn {
            let Ok(state) = serde_json::from_str::<serde_json::Value>(&e.json) else {
                warn!(doc = %self.doc_id, conn, "dropping awareness entry with invalid state json");
                return false;
            };
            if state
                .pointer("/user/kind")
                .and_then(serde_json::Value::as_str)
                == Some("agent")
            {
                warn!(doc = %self.doc_id, conn,
                      "dropping awareness entry claiming agent identity from a non-agent connection");
                return false;
            }
        }
        true
    }

    /// Server-side edit (ADR 0007): suggestion accepts and agent REST edits land as one
    /// CRDT transaction = one update = one atomic change set, attributed to the original
    /// author, persisted with its change_set_id, and broadcast to every client.
    async fn on_apply_edit(
        &mut self,
        ops: Vec<(usize, usize, String)>,
        author_id: Option<Uuid>,
        change_set_id: Option<Uuid>,
        origin: &str,
    ) -> Result<i64, String> {
        if ops.is_empty() {
            return Ok(self.seq);
        }
        let update = self.doc.apply_edits(&ops).map_err(|e| e.to_string())?;
        self.persist(&update, origin, author_id, change_set_id)
            .await;
        self.broadcast(frame_sync(SYNC_UPDATE, &update), None);
        debug!(doc = %self.doc_id, ops = ops.len(), ?change_set_id, origin, "applied server-side edit");
        Ok(self.seq)
    }

    /// Out-of-band ingest (ADR 0013): merge an externally rewritten `.md` into the live doc
    /// as a text diff. The update covering exactly this merge is persisted with origin
    /// 'ingest' / author None and broadcast to every client. NoOp = nothing persisted.
    async fn on_ingest(&mut self, text: &str) -> Result<i64, String> {
        let before = self.doc.state_vector();
        if self.doc.ingest(text) == muesli_core::IngestOutcome::NoOp {
            return Ok(self.seq);
        }
        let update = self.doc.diff_update(&before).map_err(|e| e.to_string())?;
        self.persist(&update, "ingest", None, None).await;
        self.broadcast(frame_sync(SYNC_UPDATE, &update), None);
        debug!(doc = %self.doc_id, bytes = text.len(), "ingested out-of-band text");
        Ok(self.seq)
    }

    /// Announce "✦ Agent editing" (ADR 0007): store a synthetic awareness entry under the
    /// reserved conn slot (so join-replay includes it) and broadcast it like any other
    /// awareness update. Returns the generation for the matching clear.
    fn agent_presence_set(&mut self, name: &str) -> u64 {
        self.agent_generation += 1;
        self.agent_clock += 1;
        // The shape the web client renders (collab.ts participants()): state.user.{name,kind}.
        let json = serde_json::json!({
            "user": { "name": name, "color": "#8b5cf6", "colorLight": "#ede9fe", "kind": "agent" }
        })
        .to_string();
        self.awareness
            .entry(AGENT_PRESENCE_CONN)
            .or_default()
            .insert(self.agent_client_id, (self.agent_clock, json.clone()));
        let entry = AwarenessEntry {
            client_id: self.agent_client_id,
            clock: self.agent_clock,
            json,
        };
        self.broadcast(frame_awareness(&encode_awareness(&[entry])), None);
        self.agent_generation
    }

    /// Remove the synthetic agent presence — but only if no newer announcement superseded
    /// the one this clear belongs to.
    fn agent_presence_clear(&mut self, generation: u64) {
        if generation != self.agent_generation {
            return;
        }
        let had = self
            .awareness
            .get_mut(&AGENT_PRESENCE_CONN)
            .is_some_and(|s| s.remove(&self.agent_client_id).is_some());
        if had {
            self.agent_clock += 1;
            let entry = AwarenessEntry {
                client_id: self.agent_client_id,
                clock: self.agent_clock,
                json: "null".into(),
            };
            self.broadcast(frame_awareness(&encode_awareness(&[entry])), None);
        }
    }

    /// Any human (non-agent) connection currently announcing awareness state (ADR 0007:
    /// the presence-aware Direct-vs-Suggest default). The synthetic agent entry lives under
    /// a conn slot that is never in `clients`, so it can't count as human.
    fn human_present(&self) -> bool {
        self.clients
            .iter()
            .any(|(conn, c)| !c.is_agent && self.awareness.get(conn).is_some_and(|s| !s.is_empty()))
    }

    fn awareness_snapshot(&self) -> Vec<AwarenessEntry> {
        self.awareness
            .values()
            .flat_map(|states| {
                states
                    .iter()
                    .map(|(&client_id, (clock, json))| AwarenessEntry {
                        client_id,
                        clock: *clock,
                        json: json.clone(),
                    })
            })
            .collect()
    }

    fn broadcast(&self, frame: Vec<u8>, except: Option<ConnId>) {
        for (&id, client) in &self.clients {
            if Some(id) == except {
                continue;
            }
            let _ = client.tx.send(frame.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::WorkspaceEvents;
    use muesli_core::events::WorkspaceEvent;

    fn test_room(doc_id: &str, workspace_id: Option<Uuid>, hub: WorkspaceEvents) -> Room {
        Room {
            doc: MuesliDoc::new(),
            doc_id: doc_id.to_string(),
            clients: HashMap::new(),
            awareness: HashMap::new(),
            persistence: None, // volatile: persist() early-returns on the append, but...
            storage: None,
            links: None,
            document_id: None,
            workspace_id,
            workspace_events: hub,
            seq: 0,
            since_snapshot: 0,
            agent_client_id: 1,
            agent_clock: 0,
            agent_generation: 0,
        }
    }

    #[tokio::test]
    async fn persist_publishes_doc_updated_when_persistence_present() {
        // We cannot stand up Postgres here, so we test the PUBLISH path directly via the
        // helper `publish_doc_updated`, which persist() calls after a successful append.
        let hub = WorkspaceEvents::default();
        let ws = Uuid::now_v7();
        let mut rx = hub.subscribe(ws);
        let room = test_room("notes", Some(ws), hub);
        room.publish_doc_updated();
        let env = rx.try_recv().expect("an envelope was published");
        assert_eq!(env.origin, None);
        assert_eq!(
            env.event,
            WorkspaceEvent::DocUpdated {
                slug: "notes".into()
            }
        );
    }

    #[tokio::test]
    async fn publish_doc_updated_is_silent_without_workspace_id() {
        let hub = WorkspaceEvents::default();
        let ws = Uuid::now_v7();
        let mut rx = hub.subscribe(ws);
        let room = test_room("notes", None, hub);
        room.publish_doc_updated(); // no workspace_id → nothing to publish
        assert!(rx.try_recv().is_err());
    }
}
