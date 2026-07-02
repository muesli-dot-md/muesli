//! One linked file ⇄ one server room: the sync-bridge session (ADR 0014).
//!
//! Factored out of `muesli open` so `muesli sync` (Phase 5) can run one session per file in
//! a tree. A `FileSession` owns the CRDT replica across reconnects (offline edits accumulate
//! in it and on disk; each new connection reconciles + resyncs, y-sync exchanging only the
//! delta), ingests disk edits as text diffs, and materializes remote edits atomically.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
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
        }
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
                let _ = store::touch_synced(&self.file);
            }
        }
    }

    fn on_ingest(&self, update_len: usize) {
        match &self.mode {
            SessionMode::Open { .. } => info!("ingested disk edit ({} bytes update)", update_len),
            SessionMode::Sync { label, shared } => {
                println!("↑ ingested external edit: {label}");
                shared.note(format!("sent edit · {label}"));
                let _ = store::touch_synced(&self.file);
            }
        }
    }

    fn on_materialize(&self) {
        match &self.mode {
            SessionMode::Open { .. } => {
                info!("materialized remote edits → {}", self.file.display())
            }
            SessionMode::Sync { label, shared } => {
                println!("↓ synced remote edit → {label}");
                shared.note(format!("received edit · {label}"));
                let _ = store::touch_synced(&self.file);
            }
        }
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
                    tokio::select! {
                        _ = tokio::time::sleep(delay) => {}
                        res = stop_rx.changed() => {
                            let stop = if res.is_err() { Stop::Flush } else { *stop_rx.borrow() };
                            if stop != Stop::Run {
                                return Ok(SessionOutcome::Stopped(stop));
                            }
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
                                if !synced_once && is_sync_frame(&data) {
                                    synced_once = true;
                                    *synced = true;
                                    if !*announced {
                                        *announced = true;
                                        ctx.on_first_sync();
                                    }
                                    // Reconcile room state vs disk state (covers offline edits).
                                    let disk_now = std::fs::read_to_string(file).unwrap_or_else(|_| disk_text.clone());
                                    if let Some(update) = reconcile(replica, &disk_now, file, last_written)? {
                                        ctx.note_text(last_written);
                                        sink.send(Message::Binary(frame_sync(SYNC_UPDATE, &update))).await?;
                                    }
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
                    Some(()) = fs_rx.recv() => {
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
                                ctx.on_ingest(update.len());
                                sink.send(Message::Binary(frame_sync(SYNC_UPDATE, &update))).await?;
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
                            ctx.on_materialize();
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
                    if replica.apply_update_changed(payload).unwrap_or(false) {
                        *dirty = true;
                        if let Ok(delta) = replica.diff_update(&before) {
                            out.delta = Some(delta);
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

/// Heuristic: the first sync frame (step 1 or step 2) from the server completes the handshake.
fn is_sync_frame(data: &[u8]) -> bool {
    let mut c = Cursor::new(data);
    matches!(c.read_var_u64(), Ok(MSG_SYNC))
}

/// First-sync reconciliation of room state vs disk state (internal/design/ingest-and-
/// materialization.md, "offline daemon" case). Returns an update to send, if any.
fn reconcile(
    replica: &MuesliDoc,
    disk_text: &str,
    file: &Path,
    last_written: &mut String,
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
    // Both non-empty and divergent: the disk edit happened while we weren't watching —
    // merge it as an out-of-band ingest (CRDT merge, one coherent change; never discard).
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
}
