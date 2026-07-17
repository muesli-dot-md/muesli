//! One linked file ⇄ one server room: the sync-bridge session (ADR 0014).
//!
//! Factored out of `muesli open` so `muesli sync` (Phase 5) can run one session per file in
//! a tree. A `FileSession` owns the CRDT replica across reconnects (offline edits accumulate
//! in it and on disk; each new connection reconciles + resyncs, y-sync exchanging only the
//! delta), ingests disk edits as text diffs, and materializes remote edits atomically.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use muesli_core::protocol::{
    frame_awareness, frame_sync, Cursor, MSG_AWARENESS, MSG_SYNC, SYNC_STEP1, SYNC_STEP2,
    SYNC_UPDATE,
};
use muesli_core::{IngestOutcome, MuesliDoc};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

use crate::store;

/// Debounce for materializing remote edits to disk.
pub const MATERIALIZE_DEBOUNCE: Duration = Duration::from_millis(500);

/// External stop signal for a session (a `tokio::sync::watch` value).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Stop {
    /// Keep running.
    Run,
    /// Stop and flush: final materialize of a dirty replica (SIGINT path).
    Flush,
    /// Stop WITHOUT touching disk — the file was deleted/renamed away; a final
    /// materialize would resurrect it (never destructive, but never surprising either).
    Drop,
}

pub enum SessionOutcome {
    /// Stopped by signal (the `Stop` value that ended it).
    Stopped(Stop),
    /// Idle-disconnected (lazy mode under the connection cap, `muesli sync`).
    Idle,
}

/// A live attachment of an in-process editor to a FileSession's replica (Tier-2, Plan 3).
/// The session treats the editor as a second y-sync + awareness peer of the canonical
/// replica. Frames are opaque y-protocols wire frames (MSG_SYNC / MSG_AWARENESS); the
/// session never inspects awareness, only relays it.
pub struct EditorBridge {
    /// Frames arriving FROM the editor (the TauriProvider sends them over IPC).
    pub inbound: mpsc::UnboundedReceiver<Vec<u8>>,
    /// Frames to deliver TO the editor (the embedder emits them as Tauri events).
    pub outbound: mpsc::UnboundedSender<Vec<u8>>,
}

/// Attach/detach an editor bridge on a running session.
pub enum BridgeCmd {
    Attach(EditorBridge),
    Detach,
}

/// State shared across the sessions of one `muesli sync` run: the last known text hash per
/// doc id (used for the ADR 0009 rename re-bind rule — content-hash match against the
/// replica text when a "new" file appears), plus a coarse activity surface the tray app
/// polls (a monotonic event counter + the last human-readable activity line).
pub struct SyncShared {
    doc_hashes: Mutex<HashMap<String, u64>>,
    events: AtomicU64,
    last_activity: Mutex<Option<String>>,
    /// Docs whose session completed at least one server sync handshake this run. The
    /// embedder's attach path consults this to tell an editor synchronously whether the
    /// bridge can serve a snapshot (a never-synced replica stays silent — see
    /// serve_bridge_offline) or the editor should seed from disk without waiting.
    synced_docs: Mutex<HashSet<String>>,
}

impl Default for SyncShared {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncShared {
    pub fn new() -> Self {
        Self {
            doc_hashes: Mutex::new(HashMap::new()),
            events: AtomicU64::new(0),
            last_activity: Mutex::new(None),
            synced_docs: Mutex::new(HashSet::new()),
        }
    }
    /// Record that `doc_id`'s session completed a server sync handshake this run.
    pub fn mark_synced(&self, doc_id: &str) {
        self.synced_docs.lock().unwrap().insert(doc_id.to_string());
    }
    /// Whether `doc_id`'s session has synced at least once this run (its replica holds
    /// room-derived state and can serve an editor even while the socket is down).
    pub fn is_synced(&self, doc_id: &str) -> bool {
        self.synced_docs.lock().unwrap().contains(doc_id)
    }
    /// Forget a doc's synced marker. A respawned session (rename/move re-bind) starts
    /// with a PRISTINE replica: until its next handshake it must not report a live
    /// bridge, or an editor would wait on a snapshot that cannot come.
    pub fn clear_synced(&self, doc_id: &str) {
        self.synced_docs.lock().unwrap().remove(doc_id);
    }
    pub fn set_hash(&self, doc_id: &str, text: &str) {
        self.doc_hashes
            .lock()
            .unwrap()
            .insert(doc_id.to_string(), text_hash(text));
    }
    pub fn hash_of(&self, doc_id: &str) -> Option<u64> {
        self.doc_hashes.lock().unwrap().get(doc_id).copied()
    }
    /// Record a unit of sync activity (a connect/ingest/materialize). Bumps the monotonic
    /// counter (a "syncing" pulse for the tray icon) and stores the last activity line.
    pub fn note(&self, label: String) {
        self.events.fetch_add(1, Ordering::Relaxed);
        *self.last_activity.lock().unwrap() = Some(label);
    }
    /// Monotonic count of sync events since the run started.
    pub fn events(&self) -> u64 {
        self.events.load(Ordering::Relaxed)
    }
    /// The most recent human-readable activity line, if any.
    pub fn last_activity(&self) -> Option<String> {
        self.last_activity.lock().unwrap().clone()
    }
}

/// In-process content hash (only ever compared against hashes from this same run).
pub fn text_hash(text: &str) -> u64 {
    let mut h = DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

/// What the session reports, and to whom. `Open` keeps the exact `muesli open` UX;
/// `Sync` prints concise per-event lines and feeds the shared rename-tracking state.
pub enum SessionMode {
    Open {
        web: String,
    },
    Sync {
        label: String,
        shared: Arc<SyncShared>,
    },
}

pub struct SessionCtx {
    pub file: PathBuf,
    pub doc_id: String,
    /// The raw server argument (for the index; normalized by the store).
    pub server: String,
    /// Full websocket URL including the room.
    pub url: String,
    pub token: Option<String>,
    pub mode: SessionMode,
}

impl SessionCtx {
    /// First successful sync handshake of this process for this file.
    fn on_first_sync(&self) {
        match &self.mode {
            SessionMode::Open { web } => {
                println!(
                    "✓ {} is live — share: {}/#{}",
                    self.file.display(),
                    web.trim_end_matches('/'),
                    self.doc_id
                );
                if let Err(e) = store::record_link(&self.file, &self.doc_id, &self.server, None) {
                    warn!(%e, "could not record the link in the local index");
                }
            }
            SessionMode::Sync { label, shared } => {
                println!("✓ synced {label} ⇄ #{}", self.doc_id);
                shared.note(format!("synced {label}"));
                shared.mark_synced(&self.doc_id);
                let _ = store::touch_synced(&self.file, None);
            }
        }
    }

    /// `text` is the ingested disk text (== `last_written` at the call site), called
    /// AFTER the update was accepted by the socket sink. The persisted hash is a
    /// best-effort trust-on-send marker: the transport took the frame, but there is no
    /// server ack (and a read-only session's writes are dropped server-side), so it can
    /// overclaim; the failure mode is the merge path on a later first connect, never
    /// data loss. Persisted in EVERY mode — `muesli open` sessions feed the same
    /// baseline the sync daemon consults on its next first connect.
    fn on_ingest(&self, update_len: usize, text: &str) {
        match &self.mode {
            SessionMode::Open { .. } => info!("ingested disk edit ({} bytes update)", update_len),
            SessionMode::Sync { label, shared } => {
                println!("↑ ingested external edit: {label}");
                shared.note(format!("sent edit · {label}"));
            }
        }
        let _ = store::touch_synced(&self.file, Some(text));
    }

    /// `synced_text` is `Some` only when the materialized content is also held by the
    /// server (a live-connection materialize). An OFFLINE materialize passes `None`:
    /// persisting the hash of un-pushed content would let a later first connect treat
    /// the offline edit as "already synced" and overwrite it with the room's text.
    /// Persisted in EVERY mode (see `on_ingest`).
    fn on_materialize(&self, synced_text: Option<&str>) {
        match &self.mode {
            SessionMode::Open { .. } => {
                info!("materialized remote edits → {}", self.file.display())
            }
            SessionMode::Sync { label, shared } => {
                println!("↓ synced remote edit → {label}");
                shared.note(format!("received edit · {label}"));
            }
        }
        let _ = store::touch_synced(&self.file, synced_text);
    }

    /// Persist the synced baseline: `text` is simultaneously on disk, in `last_written`
    /// and in the replica, and is part of the room's state (received from it, or pushed
    /// to it on this connection's sink). Mode-independent: the link row exists in every
    /// mode (`Open` records it in `on_first_sync` before reconcile runs; `Sync` links
    /// are recorded at link time), and a baseline written by `muesli open` is exactly
    /// what protects the next daemon first connect from mistaking the file for an
    /// offline edit. Same trust-on-send caveat as `on_ingest`.
    fn on_synced_baseline(&self, text: &str) {
        let _ = store::touch_synced(&self.file, Some(text));
    }

    /// Track the latest replica/disk text (rename re-bind needs its hash).
    fn note_text(&self, text: &str) {
        if let SessionMode::Sync { shared, .. } = &self.mode {
            shared.set_hash(&self.doc_id, text);
        }
    }
}

/// A linked file's session state. Owns the replica so it survives reconnects AND lazy
/// idle-disconnects (`run` may be called repeatedly).
pub struct FileSession {
    pub ctx: SessionCtx,
    replica: MuesliDoc,
    last_written: String,
    announced: bool,
    bridge: Option<EditorBridge>, // Tier-2 editor attachment (Plan 3)
}

impl FileSession {
    pub fn new(ctx: SessionCtx) -> Self {
        Self {
            ctx,
            replica: MuesliDoc::new(),
            last_written: String::new(),
            announced: false,
            bridge: None,
        }
    }

    /// Connect and bridge until stopped (or idle, when `idle_timeout` is set), reconnecting
    /// with exponential backoff on connection loss. Fatal only on auth refusal.
    pub async fn run(
        &mut self,
        fs_rx: &mut mpsc::UnboundedReceiver<()>,
        stop_rx: &mut watch::Receiver<Stop>,
        bridge_ctl_rx: &mut mpsc::UnboundedReceiver<BridgeCmd>,
        idle_timeout: Option<Duration>,
    ) -> Result<SessionOutcome> {
        let mut attempts: u32 = 0;
        loop {
            let stop = *stop_rx.borrow();
            if stop != Stop::Run {
                return Ok(SessionOutcome::Stopped(stop));
            }
            let mut synced = false;
            match self
                .run_once(fs_rx, stop_rx, bridge_ctl_rx, idle_timeout, &mut synced)
                .await
            {
                Ok(outcome) => return Ok(outcome),
                Err(e) => {
                    if is_auth_error(&e) {
                        bail!("server refused the connection (unauthorized) — run `muesli login` (or check your share rights)");
                    }
                    if synced {
                        attempts = 0;
                    }
                    attempts += 1;
                    let delay = Duration::from_secs(2u64.pow(attempts.min(5)).min(30));
                    warn!(%e, "connection lost — reconnecting in {:?}", delay);
                    // The backoff is not dead time: an attached editor keeps getting served
                    // from the in-memory replica (local-first — the server socket being
                    // down must not blank the editor).
                    if let Some(outcome) = self
                        .serve_bridge_offline(delay, stop_rx, bridge_ctl_rx)
                        .await
                    {
                        return Ok(outcome);
                    }
                }
            }
        }
    }

    /// Serve an attached editor from the in-memory replica while the server socket is
    /// down (the reconnect backoff window). Bridge STEP1s get STEP2 replies, editor
    /// updates apply to the replica and materialize to disk (debounced), so the editor
    /// syncs instantly over IPC with no server at all.
    ///
    /// ONLY for a session that has synced at least once (`announced`): a pristine
    /// replica must stay silent — answering STEP1 with an empty state would make the
    /// editor treat an empty doc as the synced truth (the disk-clobber hazard); silence
    /// lets the editor's own fallback seed from the file on disk instead. Server-bound
    /// deltas are dropped here: the reconnect handshake (STEP1 with our state vector)
    /// carries every accumulated change. Dirty state is flushed to disk on every exit
    /// except `Stop::Drop` — the first-sync reconcile ingests DISK over the replica, so
    /// leaving offline edits unmaterialized would revert them at reconnect.
    ///
    /// Returns `Some(outcome)` when a stop was requested, `None` when the backoff
    /// expired and the caller should try to reconnect.
    async fn serve_bridge_offline(
        &mut self,
        delay: Duration,
        stop_rx: &mut watch::Receiver<Stop>,
        bridge_ctl_rx: &mut mpsc::UnboundedReceiver<BridgeCmd>,
    ) -> Option<SessionOutcome> {
        let ctx = &self.ctx;
        let file = ctx.file.as_path();
        let replica = &self.replica;
        let last_written = &mut self.last_written;
        let announced = self.announced;
        let bridge = &mut self.bridge;

        let deadline = tokio::time::Instant::now() + delay;
        let mut dirty = false;
        macro_rules! flush_dirty {
            () => {
                if dirty {
                    let text = replica.materialize();
                    if text != *last_written && atomic_write(file, &text).is_ok() {
                        *last_written = text;
                        ctx.note_text(last_written);
                        // Offline: the content has NOT reached the server — no hash.
                        ctx.on_materialize(None);
                    }
                }
            };
        }

        // An editor may already be attached from before the disconnect (or from the
        // pre-connect window, where attaches are stored without a bootstrap): offer it
        // the replica now. A repeated STEP1 is harmless — the editor just replies.
        if announced {
            if let Some(b) = bridge.as_ref() {
                let _ = b
                    .outbound
                    .send(frame_sync(SYNC_STEP1, &replica.state_vector()));
            }
        }

        let materialize_timer = tokio::time::sleep(Duration::from_secs(86_400 * 365));
        tokio::pin!(materialize_timer);
        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => {
                    flush_dirty!();
                    return None;
                }
                res = stop_rx.changed() => {
                    let stop = if res.is_err() { Stop::Flush } else { *stop_rx.borrow() };
                    if stop != Stop::Run {
                        if stop != Stop::Drop {
                            flush_dirty!();
                        }
                        return Some(SessionOutcome::Stopped(stop));
                    }
                }
                Some(cmd) = bridge_ctl_rx.recv() => {
                    match cmd {
                        BridgeCmd::Attach(b) => {
                            if announced {
                                let _ = b
                                    .outbound
                                    .send(frame_sync(SYNC_STEP1, &replica.state_vector()));
                            }
                            *bridge = Some(b);
                        }
                        BridgeCmd::Detach => *bridge = None,
                    }
                }
                frame = async {
                    match bridge.as_mut() {
                        Some(b) => b.inbound.recv().await,
                        None => std::future::pending().await,
                    }
                }, if announced => {
                    let Some(frame) = frame else { *bridge = None; continue };
                    let fo = handle_frame(replica, &frame, &mut dirty);
                    if let (Some(b), Some(reply)) = (bridge.as_ref(), fo.reply) {
                        let _ = b.outbound.send(reply);
                    }
                    // fo.delta (server-bound) and fo.awareness (presence relay) are
                    // dropped: no socket — the reconnect handshake resyncs content.
                    if dirty {
                        materialize_timer
                            .as_mut()
                            .reset(tokio::time::Instant::now() + MATERIALIZE_DEBOUNCE);
                    }
                }
                () = &mut materialize_timer, if dirty => {
                    dirty = false;
                    let text = replica.materialize();
                    if text != *last_written {
                        if let Err(e) = atomic_write(file, &text) {
                            warn!(%e, "offline materialize failed");
                        } else {
                            *last_written = text;
                            ctx.note_text(last_written);
                            // Offline: the content has NOT reached the server — no hash.
                            ctx.on_materialize(None);
                        }
                    }
                }
            }
        }
    }

    /// One websocket connection's lifetime. Errors are "reconnectable" (handled by `run`).
    async fn run_once(
        &mut self,
        fs_rx: &mut mpsc::UnboundedReceiver<()>,
        stop_rx: &mut watch::Receiver<Stop>,
        bridge_ctl_rx: &mut mpsc::UnboundedReceiver<BridgeCmd>,
        idle_timeout: Option<Duration>,
        synced: &mut bool,
    ) -> Result<SessionOutcome> {
        let ctx = &self.ctx;
        let file = ctx.file.as_path();
        let replica = &self.replica;
        let last_written = &mut self.last_written;
        let announced = &mut self.announced;
        let bridge = &mut self.bridge;

        // Apply any control commands that arrived while idle/reconnecting (non-blocking).
        while let Ok(cmd) = bridge_ctl_rx.try_recv() {
            match cmd {
                BridgeCmd::Attach(b) => *bridge = Some(b),
                BridgeCmd::Detach => *bridge = None,
            }
        }

        let disk_text = match std::fs::read(file) {
            Ok(bytes) => {
                String::from_utf8(bytes).context("file is not valid UTF-8 — refusing to sync")?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e).context(format!("reading {}", file.display())),
        };
        if !*announced {
            // First connect treats the file's current content as the baseline.
            *last_written = disk_text.clone();
            ctx.note_text(last_written);
        }
        // On a first connect the baseline above is VACUOUS — `disk == last_written`
        // holds by construction — so reconcile must not read it as "nothing happened
        // offline". Only the persisted last-synced hash can distinguish an untouched
        // disk from one edited while the daemon was down: without a match, reconcile
        // falls through to the merge path and the disk's possible offline edit survives
        // as CRDT ops instead of being overwritten by the room's text.
        let baseline_trusted = *announced
            || store::last_synced_hash(file).is_some_and(|h| h == store::content_hash(&disk_text));

        let mut request = ctx.url.as_str().into_client_request()?;
        if let Some(token) = &ctx.token {
            request.headers_mut().insert(
                AUTHORIZATION,
                format!("Bearer {token}").parse().context("token header")?,
            );
        }
        let (ws, _) = tokio_tungstenite::connect_async(request)
            .await
            .with_context(|| format!("connecting to {}", ctx.url))?;
        let (mut sink, mut stream) = ws.split();
        info!(file = %file.display(), doc_id = %ctx.doc_id, server = %ctx.url, "linked");

        sink.send(Message::Binary(frame_sync(
            SYNC_STEP1,
            &replica.state_vector(),
        )))
        .await?;
        // A pre-connected editor pulls current content via STEP1 too (mid-flight attaches
        // are bootstrapped in the control arm below).
        if let Some(b) = bridge.as_ref() {
            let _ = b
                .outbound
                .send(frame_sync(SYNC_STEP1, &replica.state_vector()));
        }

        let mut synced_once = false;
        let mut dirty = false; // replica changed since last materialize
        let materialize_timer = tokio::time::sleep(Duration::ZERO);
        tokio::pin!(materialize_timer);
        // Idle disconnect (lazy mode): armed only when idle_timeout is set, re-armed on
        // any session activity. (The fallback is "practically never"; tokio panics on
        // overflowing deadlines, so no Duration::MAX.)
        let idle_timer =
            tokio::time::sleep(idle_timeout.unwrap_or(Duration::from_secs(86_400 * 365)));
        tokio::pin!(idle_timer);
        macro_rules! touch_idle {
            () => {
                if let Some(t) = idle_timeout {
                    idle_timer.as_mut().reset(tokio::time::Instant::now() + t);
                }
            };
        }

        let session = async {
            loop {
                // Clone the editor's outbound sender (if attached) for the send-only arms
                // (server/disk), reserving the `&mut bridge` borrow for the inbound + control
                // arms. `UnboundedSender` is cheap to clone; this sidesteps borrow conflicts.
                let out_tx = bridge.as_ref().map(|b| b.outbound.clone());
                tokio::select! {
                    // ── Remote → replica ────────────────────────────────────────────────
                    msg = stream.next() => {
                        touch_idle!();
                        let Some(msg) = msg else { bail!("server closed the connection") };
                        match msg? {
                            Message::Binary(data) => {
                                let fo = handle_frame(replica, &data, &mut dirty);
                                if fo.step2_failed {
                                    // The client sends exactly one STEP1 per connection,
                                    // so no replacement STEP2 will arrive on this socket:
                                    // reconnect (run()'s exponential backoff) to retry
                                    // the handshake instead of limping un-synced.
                                    bail!("the server's sync step 2 failed to apply — retrying the handshake");
                                }
                                if let Some(reply) = fo.reply {
                                    sink.send(Message::Binary(reply)).await?;
                                }
                                // Fan a server edit/awareness out to the editor.
                                if let Some(tx) = &out_tx {
                                    if let Some(delta) = fo.delta {
                                        let _ = tx.send(frame_sync(SYNC_UPDATE, &delta));
                                    }
                                    if let Some(aw) = fo.awareness {
                                        let _ = tx.send(frame_awareness(&aw));
                                    }
                                }
                                // First-sync gate: the room greets a joiner with its own
                                // STEP1 (a state vector, no content) before its STEP2
                                // reply on the same FIFO, and handle_frame applies a
                                // STEP2 payload before returning — so step2_applied
                                // guarantees the replica holds the server's content when
                                // reconcile decides whether to seed, merge or materialize.
                                if !synced_once && fo.step2_applied {
                                    synced_once = true;
                                    *synced = true;
                                    if !*announced {
                                        *announced = true;
                                        ctx.on_first_sync();
                                    }
                                    // Reconcile room state vs disk state (covers offline edits).
                                    let disk_now = std::fs::read_to_string(file).unwrap_or_else(|_| disk_text.clone());
                                    if let Some(update) = reconcile(replica, &disk_now, file, last_written, baseline_trusted)? {
                                        ctx.note_text(last_written);
                                        sink.send(Message::Binary(frame_sync(SYNC_UPDATE, &update))).await?;
                                    }
                                    // Reconcile leaves disk, last_written and the replica
                                    // holding the same room-backed text: persist its hash
                                    // as the baseline for the next first connect.
                                    ctx.on_synced_baseline(last_written);
                                }
                                if dirty {
                                    materialize_timer.as_mut().reset(tokio::time::Instant::now() + MATERIALIZE_DEBOUNCE);
                                }
                            }
                            Message::Ping(p) => sink.send(Message::Pong(p)).await?,
                            Message::Close(_) => bail!("server closed the connection"),
                            _ => {}
                        }
                    }

                    // ── Disk → replica → server (ingest) ───────────────────────────────
                    // Gated on handshake completion for the run's FIRST connection:
                    // ingest diffs the disk against the replica, which is EMPTY until
                    // the server's STEP2 is applied — ingesting earlier would push the
                    // whole file as brand-new ops into a possibly non-empty room
                    // (duplication). Nothing is lost while the gate is closed: the event
                    // stays queued on fs_rx, and the reconcile at the gate re-reads the
                    // disk fresh, so a pre-handshake edit reaches the room through the
                    // merge path. On reconnects (`announced`) the replica is already
                    // populated and ingest is safe from the first event.
                    Some(()) = fs_rx.recv(), if synced_once || *announced => {
                        touch_idle!();
                        // Small settle delay: editors emit bursts (write + rename).
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        while fs_rx.try_recv().is_ok() {}
                        let Ok(bytes) = std::fs::read(file) else { continue }; // transient (rename window)
                        let Ok(text) = String::from_utf8(bytes) else {
                            warn!("file became non-UTF-8; skipping ingest (fail-safe)");
                            continue;
                        };
                        if text == *last_written {
                            debug!("echo of our own materialization — ignored");
                            continue;
                        }
                        let sv = replica.state_vector();
                        let outcome = replica.ingest(&text);
                        *last_written = text;
                        ctx.note_text(last_written);
                        match outcome {
                            IngestOutcome::NoOp => {}
                            outcome => {
                                if outcome == IngestOutcome::WholesaleReplace {
                                    warn!("external edit replaced most of the document — merged as one change");
                                }
                                let update = replica.diff_update(&sv).map_err(|e| anyhow::anyhow!(e.to_string()))?;
                                sink.send(Message::Binary(frame_sync(SYNC_UPDATE, &update))).await?;
                                // Only after the sink accepted the frame (trust-on-send,
                                // see on_ingest): a failed send must not move the marker.
                                ctx.on_ingest(update.len(), last_written);
                                // A disk edit shows live in the editor too (replaces the Plan-2 poll).
                                if let Some(tx) = &out_tx {
                                    let _ = tx.send(frame_sync(SYNC_UPDATE, &update));
                                }
                            }
                        }
                    }

                    // ── Replica → disk (debounced materialization) ─────────────────────
                    () = &mut materialize_timer, if dirty => {
                        touch_idle!();
                        dirty = false;
                        let text = replica.materialize();
                        if text != *last_written {
                            atomic_write(file, &text)?;
                            *last_written = text;
                            ctx.note_text(last_written);
                            ctx.on_materialize(Some(last_written));
                        }
                    }

                    // ── Editor → replica → server (Tier-2 inbound) ─────────────────────
                    frame = async {
                        match bridge.as_mut() {
                            Some(b) => b.inbound.recv().await,
                            None => std::future::pending().await,
                        }
                    } => {
                        touch_idle!();
                        let Some(frame) = frame else { *bridge = None; continue }; // editor detached/closed
                        let fo = handle_frame(replica, &frame, &mut dirty);
                        if let Some(b) = bridge.as_ref() {
                            if let Some(reply) = fo.reply {
                                let _ = b.outbound.send(reply); // STEP2 back to the editor
                            }
                        }
                        if let Some(delta) = fo.delta {
                            sink.send(Message::Binary(frame_sync(SYNC_UPDATE, &delta))).await?; // editor edit → server
                        }
                        if let Some(aw) = fo.awareness {
                            sink.send(Message::Binary(frame_awareness(&aw))).await?; // editor presence → server
                        }
                        if dirty {
                            materialize_timer.as_mut().reset(tokio::time::Instant::now() + MATERIALIZE_DEBOUNCE);
                        }
                    }

                    // ── Editor attach/detach (mid-flight) ──────────────────────────────
                    Some(cmd) = bridge_ctl_rx.recv() => {
                        match cmd {
                            BridgeCmd::Attach(b) => {
                                // Bootstrap the new editor with current replica state.
                                let _ = b.outbound.send(frame_sync(SYNC_STEP1, &replica.state_vector()));
                                *bridge = Some(b);
                            }
                            BridgeCmd::Detach => *bridge = None,
                        }
                    }

                    // ── Idle disconnect (lazy mode only; never while a bridge is attached) ─
                    () = &mut idle_timer, if idle_timeout.is_some() && bridge.is_none() => {
                        return Ok(SessionOutcome::Idle);
                    }

                    // ── External stop ───────────────────────────────────────────────────
                    res = stop_rx.changed() => {
                        let stop = if res.is_err() { Stop::Flush } else { *stop_rx.borrow() };
                        if stop != Stop::Run {
                            return Ok(SessionOutcome::Stopped(stop));
                        }
                    }
                }
            }
        }
        .await;

        // Don't strand a pending materialize on disconnect/stop — except on Drop, where
        // the file is gone on purpose and writing would resurrect it.
        let skip_flush = matches!(session, Ok(SessionOutcome::Stopped(Stop::Drop)));
        if dirty && !skip_flush {
            let text = replica.materialize();
            if text != *last_written {
                atomic_write(file, &text)?;
                *last_written = text;
                ctx.note_text(last_written);
                // A clean exit (Flush/Idle) flushes content that reached the replica
                // from server frames or from editor deltas already accepted by this
                // connection's sink — server-held text, exactly like the live
                // materialize arm — so it must move the persisted baseline too: a stale
                // hash would make the next first connect treat this write as an offline
                // edit and, if the room advances meanwhile, merge it over the newer
                // room text. An error exit keeps the old baseline — the connection died
                // mid-frame, so no such claim can be made; the reconnect handshake
                // resyncs from the retained replica instead.
                if session.is_ok() {
                    ctx.on_synced_baseline(last_written);
                }
            }
        }
        session
    }
}

fn is_auth_error(e: &anyhow::Error) -> bool {
    e.chain().any(|cause| {
        matches!(
            cause.downcast_ref::<tokio_tungstenite::tungstenite::Error>(),
            Some(tokio_tungstenite::tungstenite::Error::Http(resp))
                if resp.status() == 401 || resp.status() == 403
        )
    })
}

/// What parsing one frame produced. `reply` is a frame to send back to the SAME peer
/// (a STEP2 answering its STEP1). `delta` is a y-sync update describing how the replica
/// changed (to fan out to OTHER peers). `awareness` is a raw awareness payload to relay.
#[derive(Default)]
pub(crate) struct FrameOut {
    pub reply: Option<Vec<u8>>,
    pub delta: Option<Vec<u8>>,
    pub awareness: Option<Vec<u8>>,
    /// Set ONLY when a SYNC_STEP2 payload decoded and applied cleanly: the positive
    /// proof that the replica now holds the server's content. The first-sync gate keys
    /// on this, so every failure mode — unknown frame, truncated framing, undecodable
    /// payload — leaves the gate closed by construction (an empty replica behind a
    /// passed gate would re-seed a non-empty room and duplicate the document).
    pub step2_applied: bool,
    /// A SYNC_STEP2 frame arrived but its payload could not be read or applied (the
    /// replica is untouched). The client sends exactly one STEP1 per connection, so no
    /// replacement STEP2 will come: the session must reconnect to retry the handshake.
    pub step2_failed: bool,
}

/// Parse one peer frame against `replica`. Applies sync payloads; sets `dirty` when the
/// replica content changed and returns that change as `delta` (so the caller can forward
/// it to other peers). Surfaces awareness payloads verbatim for relay (never drops them).
pub(crate) fn handle_frame(replica: &MuesliDoc, data: &[u8], dirty: &mut bool) -> FrameOut {
    let mut out = FrameOut::default();
    let mut c = Cursor::new(data);
    let Ok(msg_type) = c.read_var_u64() else {
        return out;
    };
    match msg_type {
        MSG_SYNC => {
            let Ok(subtype) = c.read_var_u64() else {
                return out;
            };
            let Ok(payload) = c.read_bytes() else {
                // Truncated framing: for a STEP2 this is a failed handshake, not a
                // skippable frame (see FrameOut::step2_failed).
                out.step2_failed = subtype == SYNC_STEP2;
                return out;
            };
            match subtype {
                SYNC_STEP1 => {
                    if let Ok(diff) = replica.diff_update(payload) {
                        out.reply = Some(frame_sync(SYNC_STEP2, &diff));
                    }
                }
                SYNC_STEP2 | SYNC_UPDATE => {
                    let before = replica.state_vector();
                    match replica.apply_update_changed(payload) {
                        Ok(changed) => {
                            out.step2_applied = subtype == SYNC_STEP2;
                            if changed {
                                *dirty = true;
                                if let Ok(delta) = replica.diff_update(&before) {
                                    out.delta = Some(delta);
                                }
                            }
                        }
                        Err(e) => {
                            warn!(%e, "sync payload failed to apply — ignored");
                            out.step2_failed = subtype == SYNC_STEP2;
                        }
                    }
                }
                _ => {}
            }
        }
        MSG_AWARENESS => {
            if let Ok(payload) = c.read_bytes() {
                out.awareness = Some(payload.to_vec());
            }
        }
        _ => {}
    }
    out
}

/// First-sync reconciliation of room state vs disk state (internal/design/ingest-and-
/// materialization.md, "offline daemon" case). Returns an update to send, if any.
///
/// `baseline_trusted` is false only on a first connect whose disk content does not
/// match the persisted last-synced hash: `last_written` was just seeded FROM the disk,
/// so `disk == last_written` holds vacuously and must not be read as "no offline edit"
/// — the merge path below is the safe interpretation (the disk's edit becomes CRDT ops
/// rather than being overwritten by the room's text).
fn reconcile(
    replica: &MuesliDoc,
    disk_text: &str,
    file: &Path,
    last_written: &mut String,
    baseline_trusted: bool,
) -> Result<Option<Vec<u8>>> {
    let room_text = replica.materialize();
    if room_text == disk_text {
        return Ok(None);
    }
    if room_text.is_empty() && !disk_text.is_empty() {
        // Fresh room: the file is the source of truth.
        let sv = replica.state_vector();
        replica.ingest(disk_text);
        info!("seeded room from file ({} bytes)", disk_text.len());
        return Ok(Some(
            replica
                .diff_update(&sv)
                .map_err(|e| anyhow::anyhow!(e.to_string()))?,
        ));
    }
    if disk_text.is_empty() {
        // Live room, empty/missing file: materialize the room.
        atomic_write(file, &room_text)?;
        *last_written = room_text;
        info!("materialized room state → {}", file.display());
        return Ok(None);
    }
    if disk_text == *last_written && baseline_trusted {
        // The file holds exactly what we last wrote — nothing external happened. The
        // divergence is replica-side (remote ops merged during this handshake, or
        // offline editor edits whose exit flush failed): ingesting the stale disk
        // would REVERT those changes and push the reversion to the server.
        // Materialize the replica over the file instead; the connect handshake
        // already carries the replica's ops, so there is nothing to send.
        atomic_write(file, &room_text)?;
        *last_written = room_text;
        info!("materialized replica-side changes → {}", file.display());
        return Ok(None);
    }
    // Both non-empty and divergent: the disk edit happened while we weren't watching —
    // merge it as an out-of-band ingest (CRDT merge, one coherent change; never discard).
    if !baseline_trusted && disk_text == *last_written {
        // First connect with no (or mismatching) persisted baseline: indistinguishable
        // from an offline edit, so the disk wins as a merge — room-side changes may be
        // superseded (recoverable via CRDT history). This is the expected one-time path
        // for links recorded before the hash column existed; logged so the event is
        // diagnosable.
        warn!(
            file = %file.display(),
            "no trusted sync baseline for this file — merging its disk content over the room's"
        );
    }
    let sv = replica.state_vector();
    let outcome = replica.ingest(disk_text);
    if outcome == IngestOutcome::WholesaleReplace {
        warn!("disk and room diverged heavily; merged disk edits as one change set");
    } else {
        info!("merged offline disk edits into the room");
    }
    *last_written = disk_text.to_string();
    Ok(Some(
        replica
            .diff_update(&sv)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?,
    ))
}

/// Crash-safe write: temp file in the same directory, then rename (ADR 0001 fail-safe).
pub fn atomic_write(path: &Path, text: &str) -> Result<()> {
    let dir = path.parent().context("file has no parent directory")?;
    let tmp = dir.join(format!(
        ".{}.muesli-tmp",
        path.file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "out".into())
    ));
    std::fs::write(&tmp, text).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("renaming over {}", path.display()))?;
    Ok(())
}

/// Absolute, symlink-resolved path. The parent is canonicalized (it must exist) rather than
/// the file itself (which may not exist yet) — and crucially, watcher events report
/// canonical paths (e.g. macOS `/tmp` → `/private/tmp`), so the watch filter must compare
/// canonical forms.
pub fn absolutize(p: &Path) -> Result<PathBuf> {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()?.join(p)
    };
    let parent = abs.parent().context("file has no parent directory")?;
    let file_name = abs.file_name().context("path has no file name")?;
    let canonical_parent = parent
        .canonicalize()
        .with_context(|| format!("directory does not exist: {}", parent.display()))?;
    Ok(canonical_parent.join(file_name))
}

#[cfg(test)]
fn sync_payload(frame: &[u8]) -> Option<Vec<u8>> {
    let mut c = Cursor::new(frame);
    if c.read_var_u64().ok()? != MSG_SYNC {
        return None;
    }
    let _sub = c.read_var_u64().ok()?;
    c.read_bytes().ok().map(|b| b.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handle_frame_reports_sync_delta_and_step1_reply() {
        let replica = MuesliDoc::with_text("hello");
        let peer = MuesliDoc::new();

        // STEP1 from an empty peer → we reply STEP2, no local change.
        let step1 = frame_sync(SYNC_STEP1, &peer.state_vector());
        let mut dirty = false;
        let out = handle_frame(&replica, &step1, &mut dirty);
        assert!(!dirty, "answering step1 must not dirty the replica");
        assert!(out.delta.is_none(), "step1 reply is not a local delta");
        let reply = out.reply.expect("step1 must produce a step2 reply");
        // Applying that reply to the peer converges it to our text.
        // Decode the step2 payload out of the reply frame and apply.
        let payload = sync_payload(&reply).expect("reply is a sync frame");
        peer.apply_update(&payload).unwrap();
        assert_eq!(peer.materialize(), "hello");

        // An UPDATE that changes the replica → dirty + a forwardable delta.
        // `peer` already has replica's state (from the step2 exchange above), so its edit
        // is anchored to shared CRDT history and will actually mutate `replica`.
        let sv = peer.state_vector();
        peer.ingest("hello world");
        let upd = peer.diff_update(&sv).unwrap();
        let frame = frame_sync(SYNC_UPDATE, &upd);
        let mut dirty2 = false;
        let out2 = handle_frame(&replica, &frame, &mut dirty2);
        assert!(dirty2, "an effective update sets dirty");
        assert!(
            out2.delta.is_some(),
            "an effective update yields a delta to fan out"
        );
        assert!(out2.reply.is_none());
    }

    #[test]
    fn editor_update_produces_server_delta_and_dirties() {
        // Simulate: replica holds "hi"; editor sends an UPDATE turning it into "hi there".
        // A real editor first y-syncs the replica's state (so its edit is anchored to shared
        // CRDT history); we model that by seeding the editor from the replica's full update.
        let replica = MuesliDoc::with_text("hi");
        let base = replica.encode_full_update(); // the shared "hi" base, captured pre-edit
        let editor_doc = MuesliDoc::new();
        editor_doc.apply_update(&base).unwrap();
        assert_eq!(editor_doc.materialize(), "hi");
        let sv = editor_doc.state_vector();
        editor_doc.ingest("hi there");
        let upd = editor_doc.diff_update(&sv).unwrap();
        let frame = frame_sync(SYNC_UPDATE, &upd);

        let mut dirty = false;
        let out = handle_frame(&replica, &frame, &mut dirty);
        assert!(dirty);
        let delta = out.delta.expect("editor edit yields a server-bound delta");
        // The delta carries the edit: a server replica sharing the same base applying it converges.
        let server = MuesliDoc::new();
        server.apply_update(&base).unwrap();
        server.apply_update(&delta).unwrap();
        assert_eq!(server.materialize(), "hi there");
    }

    /// disk == last_written means nothing external happened: replica-side changes
    /// (remote ops merged in this handshake, or offline edits whose flush failed) must
    /// be materialized OVER the file — never reverted by ingesting the stale disk.
    #[test]
    fn reconcile_keeps_replica_side_changes_when_disk_unchanged() {
        let tmp = std::env::temp_dir().join(format!("muesli-reconcile-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("n.md");
        std::fs::write(&file, "base").unwrap();

        let replica = MuesliDoc::with_text("base");
        replica.ingest("base plus offline edit");
        let mut last_written = "base".to_string();

        let update = reconcile(&replica, "base", &file, &mut last_written, true).unwrap();
        assert!(update.is_none(), "no out-of-band ingest to push");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "base plus offline edit",
            "replica-side changes reach disk"
        );
        assert_eq!(last_written, "base plus offline edit");
        assert_eq!(
            replica.materialize(),
            "base plus offline edit",
            "the replica is never reverted to stale disk text"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn test_dir(tag: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(format!("muesli-session-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        tmp
    }

    /// THE production frame order at daemon start: the room greets a joiner with its
    /// own SYNC_STEP1 (state vector only, no content) and only then answers the
    /// client's STEP1 with STEP2 — both on the same FIFO. The first-sync gate must
    /// ignore the greeting: reconciling on it ran against a still-empty replica, and
    /// the seed path re-ingested the whole file as brand-new ops into the non-empty
    /// room, doubling the document on every daemon start.
    #[test]
    fn greeting_step1_does_not_open_the_first_sync_gate() {
        let tmp = test_dir("gate-order");
        let file = tmp.join("t.md");
        std::fs::write(&file, "the text T").unwrap();

        let server = MuesliDoc::with_text("the text T");
        let replica = MuesliDoc::new();
        let empty_sv = replica.state_vector();
        // First connect: last_written is seeded from the disk (run_once baseline).
        let mut last_written = "the text T".to_string();
        let mut dirty = false;

        // Frame 1: the greeting STEP1, exactly what a room join sends first.
        let greeting = frame_sync(SYNC_STEP1, &server.state_vector());
        let fo = handle_frame(&replica, &greeting, &mut dirty);
        assert!(
            !fo.step2_applied,
            "the greeting STEP1 must not open the first-sync gate"
        );
        assert!(!fo.step2_failed, "the greeting is a healthy frame");
        assert!(
            fo.reply.is_some(),
            "STEP1 still gets its protocol STEP2 answer"
        );
        assert!(fo.delta.is_none(), "no content moved — nothing to push");
        assert_eq!(
            replica.materialize(),
            "",
            "the replica holds no server content yet"
        );

        // Frame 2: the server's STEP2 answering our connect STEP1 (diff vs our empty
        // state). handle_frame applies its payload BEFORE the gate is consulted.
        let step2 = frame_sync(SYNC_STEP2, &server.diff_update(&empty_sv).unwrap());
        let fo2 = handle_frame(&replica, &step2, &mut dirty);
        assert!(fo2.step2_applied, "the STEP2 reply completes the handshake");
        assert_eq!(
            replica.materialize(),
            "the text T",
            "the replica already holds the server's content when reconcile runs"
        );
        // Worst case for the gate: an untrusted first-connect baseline. room == disk
        // returns before any baseline question arises.
        let update = reconcile(&replica, "the text T", &file, &mut last_written, false).unwrap();
        assert!(update.is_none(), "room == disk: nothing to push, no seed");
        assert_eq!(replica.materialize(), "the text T", "text is NOT doubled");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "the text T");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// An empty room's STEP2 carries an empty diff: the gate opens, the replica stays
    /// empty, and the legitimate seed path fires exactly once with ONE copy of the file.
    #[test]
    fn empty_room_step2_still_seeds_exactly_once() {
        let tmp = test_dir("gate-seed");
        let file = tmp.join("s.md");
        std::fs::write(&file, "seed me").unwrap();

        let server = MuesliDoc::new();
        let replica = MuesliDoc::new();
        let step2 = frame_sync(
            SYNC_STEP2,
            &server.diff_update(&replica.state_vector()).unwrap(),
        );
        let mut dirty = false;
        let fo = handle_frame(&replica, &step2, &mut dirty);
        assert!(fo.step2_applied, "an empty diff is a valid STEP2");
        assert_eq!(
            replica.materialize(),
            "",
            "empty room: the replica stays empty"
        );

        let mut last_written = "seed me".to_string();
        let update = reconcile(&replica, "seed me", &file, &mut last_written, false)
            .unwrap()
            .expect("a fresh room is seeded from the file");
        assert_eq!(replica.materialize(), "seed me");
        let room = MuesliDoc::new();
        room.apply_update(&update).unwrap();
        assert_eq!(
            room.materialize(),
            "seed me",
            "exactly one copy of the disk text"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// First connect, disk untouched while the daemon was down (persisted hash matched),
    /// server advanced: the room's text wins — materialized over the file, nothing pushed.
    #[test]
    fn first_connect_trusted_baseline_lets_the_room_win() {
        let tmp = test_dir("gate-trusted");
        let file = tmp.join("u.md");
        std::fs::write(&file, "old disk").unwrap();

        let replica = MuesliDoc::with_text("server advanced");
        let mut last_written = "old disk".to_string(); // first-connect baseline = disk
        let update = reconcile(&replica, "old disk", &file, &mut last_written, true).unwrap();
        assert!(
            update.is_none(),
            "nothing external happened — nothing to push"
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "server advanced");
        assert_eq!(last_written, "server advanced");
        assert_eq!(replica.materialize(), "server advanced");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// First connect, disk edited while the daemon was down (persisted hash mismatch):
    /// the offline edit wins as a CRDT merge — pushed to the room, never overwritten.
    #[test]
    fn first_connect_offline_edit_wins_as_a_merge() {
        let tmp = test_dir("gate-offline-edit");
        let file = tmp.join("o.md");
        std::fs::write(&file, "offline edit").unwrap();

        let replica = MuesliDoc::with_text("server text");
        let mut last_written = "offline edit".to_string(); // vacuous first-connect baseline
        let update = reconcile(&replica, "offline edit", &file, &mut last_written, false)
            .unwrap()
            .expect("the offline edit is pushed as CRDT ops");
        assert!(!update.is_empty());
        assert_eq!(replica.materialize(), "offline edit");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "offline edit",
            "the offline edit stays on disk"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Defense in depth: a STEP2 whose payload fails to apply leaves the replica empty —
    /// it must NOT open the gate (a non-empty room would be re-seeded, duplicating the
    /// document), and it must flag the handshake as failed so the session reconnects
    /// (the client sends exactly one STEP1 per connection — no replacement STEP2 comes).
    #[test]
    fn malformed_step2_does_not_open_the_gate() {
        let replica = MuesliDoc::new();
        let mut dirty = false;
        let step2 = frame_sync(SYNC_STEP2, b"definitely not a yrs update");
        let fo = handle_frame(&replica, &step2, &mut dirty);
        assert!(
            !fo.step2_applied,
            "a failed STEP2 must not open the seed gate"
        );
        assert!(fo.step2_failed, "a garbage payload fails the handshake");
        assert!(!dirty, "the replica is untouched");
        assert!(fo.delta.is_none());
        assert_eq!(replica.materialize(), "");
    }

    /// The gate signal is POSITIVE (step2_applied), so a STEP2 broken at the FRAMING
    /// layer — header only, or a declared payload length with missing bytes — must
    /// neither open the gate nor pass as a healthy frame. (A negative "malformed" flag
    /// re-parsed from the raw bytes missed exactly this case: the framing check bailed
    /// before the payload was ever inspected.)
    #[test]
    fn truncated_step2_framing_does_not_open_the_gate() {
        let replica = MuesliDoc::new();
        let mut dirty = false;

        // MSG_SYNC + SYNC_STEP2 varints with no payload length at all.
        let header_only = vec![0x00, 0x01];
        let fo = handle_frame(&replica, &header_only, &mut dirty);
        assert!(
            !fo.step2_applied,
            "header-only STEP2 must not open the gate"
        );
        assert!(fo.step2_failed, "header-only STEP2 fails the handshake");

        // Declared payload length (5) with the bytes missing.
        let short_payload = vec![0x00, 0x01, 0x05, 0xaa];
        let fo2 = handle_frame(&replica, &short_payload, &mut dirty);
        assert!(!fo2.step2_applied, "short STEP2 must not open the gate");
        assert!(fo2.step2_failed, "short STEP2 fails the handshake");

        assert!(!dirty, "the replica is untouched");
        assert_eq!(replica.materialize(), "");
    }

    fn offline_test_session(file: PathBuf) -> FileSession {
        FileSession::new(SessionCtx {
            file,
            doc_id: "doc-offline".into(),
            server: "http://unreachable.invalid".into(),
            url: "ws://unreachable.invalid/ws/doc-offline".into(),
            token: None,
            mode: SessionMode::Open {
                web: "http://unreachable.invalid".into(),
            },
        })
    }

    /// Decode (msg subtype, payload) of a MSG_SYNC frame.
    fn sync_frame_parts(frame: &[u8]) -> Option<(u64, Vec<u8>)> {
        let mut c = Cursor::new(frame);
        if c.read_var_u64().ok()? != MSG_SYNC {
            return None;
        }
        let sub = c.read_var_u64().ok()?;
        c.read_bytes().ok().map(|b| (sub, b.to_vec()))
    }

    /// A pristine (never-synced) session must not answer an offline editor: replying
    /// STEP2 from an empty replica would make the editor treat an empty doc as the
    /// synced truth (the disk-clobber hazard). Silence → the editor seeds from disk.
    #[tokio::test]
    async fn offline_bridge_stays_silent_before_first_sync() {
        let tmp = std::env::temp_dir().join(format!("muesli-offline-a-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("a.md");
        std::fs::write(&file, "on disk").unwrap();

        let mut session = offline_test_session(file.clone());
        let (_stop_tx, mut stop_rx) = watch::channel(Stop::Run);
        let (ctl_tx, mut ctl_rx) = mpsc::unbounded_channel();
        let (in_tx, in_rx) = mpsc::unbounded_channel();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel();
        ctl_tx
            .send(BridgeCmd::Attach(EditorBridge {
                inbound: in_rx,
                outbound: out_tx,
            }))
            .unwrap();
        in_tx
            .send(frame_sync(SYNC_STEP1, &MuesliDoc::new().state_vector()))
            .unwrap();

        let outcome = session
            .serve_bridge_offline(Duration::from_millis(150), &mut stop_rx, &mut ctl_rx)
            .await;
        assert!(outcome.is_none(), "backoff expiry returns None (reconnect)");
        assert!(
            out_rx.try_recv().is_err(),
            "a pristine replica must stay silent toward the editor"
        );
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "on disk",
            "the file is untouched"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// After a first sync, the offline window serves the editor from the replica:
    /// attach → bootstrap STEP1; editor STEP1 → STEP2 carrying the replica text;
    /// editor UPDATE → applied and materialized to disk (debounced).
    #[tokio::test]
    async fn offline_bridge_serves_replica_and_materializes_edits() {
        let tmp = std::env::temp_dir().join(format!("muesli-offline-b-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("b.md");
        std::fs::write(&file, "hello").unwrap();

        let mut session = offline_test_session(file.clone());
        session.announced = true; // a prior server round-trip happened
        session.replica.ingest("hello");
        session.last_written = "hello".into();
        let base = session.replica.encode_full_update();

        // The "editor": a peer doc anchored to the replica's state, with one edit.
        let editor = MuesliDoc::new();
        editor.apply_update(&base).unwrap();
        let sv = editor.state_vector();
        editor.ingest("hello world");
        let upd = editor.diff_update(&sv).unwrap();

        let (_stop_tx, mut stop_rx) = watch::channel(Stop::Run);
        let (ctl_tx, mut ctl_rx) = mpsc::unbounded_channel();
        let (in_tx, in_rx) = mpsc::unbounded_channel();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel();
        ctl_tx
            .send(BridgeCmd::Attach(EditorBridge {
                inbound: in_rx,
                outbound: out_tx,
            }))
            .unwrap();
        in_tx
            .send(frame_sync(SYNC_STEP1, &MuesliDoc::new().state_vector()))
            .unwrap();
        in_tx.send(frame_sync(SYNC_UPDATE, &upd)).unwrap();

        // Long enough to cover the 500ms materialize debounce.
        let outcome = session
            .serve_bridge_offline(Duration::from_millis(900), &mut stop_rx, &mut ctl_rx)
            .await;
        assert!(outcome.is_none());

        // Outbound: a bootstrap STEP1, then a STEP2 answering the editor's STEP1 with
        // the replica's pre-edit text.
        let frames: Vec<Vec<u8>> = std::iter::from_fn(|| out_rx.try_recv().ok()).collect();
        let subs: Vec<u64> = frames
            .iter()
            .filter_map(|f| sync_frame_parts(f).map(|(s, _)| s))
            .collect();
        assert!(
            subs.contains(&SYNC_STEP1),
            "attach must bootstrap with STEP1: {subs:?}"
        );
        let step2 = frames
            .iter()
            .filter_map(|f| sync_frame_parts(f))
            .find(|(s, _)| *s == SYNC_STEP2)
            .expect("editor STEP1 must get a STEP2 reply");
        let peer = MuesliDoc::new();
        peer.apply_update(&step2.1).unwrap();
        assert_eq!(peer.materialize(), "hello");

        // The editor's UPDATE reached disk while fully offline.
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hello world");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn handle_frame_surfaces_awareness_for_relay() {
        let replica = MuesliDoc::new();
        let aw = frame_awareness(b"{\"opaque\":true}");
        let mut dirty = false;
        let out = handle_frame(&replica, &aw, &mut dirty);
        assert!(!dirty);
        assert!(out.delta.is_none());
        assert!(out.reply.is_none());
        assert_eq!(
            out.awareness.as_deref(),
            Some(&b"{\"opaque\":true}"[..]),
            "awareness payload is surfaced verbatim for relay, not dropped"
        );
    }

    /// Regression test for the wss:// TLS bug: without a TLS feature enabled on
    /// tokio-tungstenite, `connect_async` fails EVERY `wss://` URL with
    /// `Error::Url(UrlError::TlsFeatureNotEnabled)` — raised only AFTER a successful TCP
    /// connect, once tungstenite tries (and fails) to hand the socket to a TLS backend
    /// (see tokio-tungstenite's tls.rs: `Mode::Tls => Err(TlsFeatureNotEnabled)`). A
    /// closed/refused port (e.g. port 1) never reaches that code path — the TCP connect
    /// itself fails first with `Error::Io`, which is indistinguishable from the real bug.
    /// So this test binds a real local listener (TCP connect succeeds) and drops the
    /// accepted socket immediately, forcing whatever comes next: with no TLS feature,
    /// tungstenite bails with `TlsFeatureNotEnabled` before touching the socket again;
    /// with `rustls-tls-webpki-roots` (Cargo.toml) it attempts a real TLS handshake
    /// against the closed peer and fails with a plain IO error instead. That is exactly
    /// the daemon's real-world failure mode: it could reach app.muesli.md's TCP port
    /// fine, then hit the missing-TLS-feature error on every attempt (session.rs run_once
    /// -> connect_async), while local ws://localhost e2e testing never exercised this at
    /// all.
    #[tokio::test]
    async fn wss_url_reaches_tls_stack_instead_of_missing_feature_error() {
        use tokio_tungstenite::tungstenite::error::UrlError;
        use tokio_tungstenite::tungstenite::Error as WsError;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local listener");
        let port = listener.local_addr().expect("local addr").port();
        let server = tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                // Drop immediately: the client gets a closed peer, not a real TLS server,
                // so whatever it does next past the TCP connect fails fast either way.
                drop(stream);
            }
        });

        let request = format!("wss://127.0.0.1:{port}/ws/x")
            .into_client_request()
            .expect("valid request");
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            tokio_tungstenite::connect_async(request),
        )
        .await
        .expect("connect_async must not hang");
        let err = result.expect_err("no real TLS server is listening");
        server.abort();

        assert!(
            !matches!(err, WsError::Url(UrlError::TlsFeatureNotEnabled)),
            "tokio-tungstenite has no TLS feature compiled in — wss:// can never connect: {err:?}"
        );
        // With the feature present, the failure is a genuine connection-level error (the
        // TLS handshake against our closed peer), never the feature/config error above.
        assert!(
            matches!(
                err,
                WsError::Io(_) | WsError::ConnectionClosed | WsError::AlreadyClosed
            ),
            "expected a connection error once TLS is enabled, got: {err:?}"
        );
    }
}
