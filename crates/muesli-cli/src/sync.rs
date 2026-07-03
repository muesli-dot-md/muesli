//! `muesli sync <dir>` — the Drive-desktop-style folder sync daemon (Phase 5, ADR 0014;
//! docs/design/local-agent-cli.md). Every `*.md` under the dir (hidden dirs/files,
//! `node_modules`, `target`, `.git` skipped) is linked and live-synced; new files are
//! auto-linked, deletions stop the session but NEVER touch the server doc or the index
//! entry, and a rename whose content hash matches a known replica re-binds the path to the
//! same doc id (ADR 0009's re-link rule).
//!
//! Concurrency model: at most `MAX_SESSIONS` (64) websocket connections, guarded by a
//! semaphore. With ≤64 files every file holds a persistent session (a permit is never
//! released). With more files, sessions run "lazy": they idle-disconnect after
//! `IDLE_TIMEOUT` and release their permit, then reconnect on the next local change or
//! after `REPOLL` (round-robin) — so every file still gets its initial sync, and remote
//! edits land within one repoll interval at worst.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use notify::{RecursiveMode, Watcher};
use tokio::sync::{mpsc, watch, Semaphore};
use tracing::{debug, warn};

use crate::session::{text_hash, FileSession, SessionCtx, SessionMode, Stop, SyncShared};
use crate::{api, store};

pub const MAX_SESSIONS: usize = 64;
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const REPOLL: Duration = Duration::from_secs(300);

/// Coarse run state of the folder daemon, surfaced to embedders (the tray app). The CLI
/// ignores it; it polls `SyncShared` directly via its own stdout lines.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub enum DaemonState {
    /// Discovering + linking the tree; not yet live.
    #[default]
    Starting,
    /// Running: `files` files linked and live-syncing.
    Running,
    /// Stopped cleanly (flushed).
    Stopped,
    /// Fatal error (e.g. unauthorized) — carries a human message.
    Error(String),
}

/// A snapshot of the daemon for the tray app: state, how many files are linked, the last
/// activity line, and a monotonic event counter (so the UI can flash a "syncing" pulse).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct DaemonStatus {
    pub state: DaemonState,
    pub files: usize,
    pub last_activity: Option<String>,
    pub events: u64,
}

/// Out-of-band control of a running daemon by an embedder (the Tauri app).
pub enum DaemonControl {
    /// Attach an editor to the session for `path` (kept live while attached).
    Attach { path: PathBuf, bridge: crate::session::EditorBridge },
    /// Detach any editor from the session for `path`.
    Detach { path: PathBuf },
}

/// Best-effort canonical key for `handles` lookups (handles are keyed by canonical paths).
fn resolve_handle_key(dir: &Path, path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| {
        if path.is_absolute() { path.to_path_buf() } else { dir.join(path) }
    })
}

/// CLI entry: wire SIGINT → stop and run with stdout reporting on. The status channel is
/// created but its receiver is dropped (the CLI's feedback is the per-event stdout lines).
pub async fn sync(dir: PathBuf, server: String, prefix: Option<String>, web: String) -> Result<()> {
    let (stop_tx, stop_rx) = watch::channel(false);
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        let _ = stop_tx.send(true);
    });
    let (status_tx, _status_rx) = watch::channel(DaemonStatus::default());
    let (_control_tx, control_rx) = mpsc::unbounded_channel::<DaemonControl>(); // CLI never attaches editors
    run(dir, server, prefix, web, true, stop_rx, status_tx, control_rx, None, None).await
}

/// The folder daemon, driveable by an embedder. `stop_rx` flips to `true` to request a
/// clean (flushing) shutdown; `status_tx` receives a snapshot whenever the picture changes.
/// `verbose` gates the human stdout lines (on for the CLI, off when embedded in the tray).
#[allow(clippy::too_many_arguments)]
pub async fn run(
    dir: PathBuf,
    server: String,
    prefix: Option<String>,
    web: String,
    verbose: bool,
    mut stop_rx: watch::Receiver<bool>,
    status_tx: watch::Sender<DaemonStatus>,
    mut control_rx: mpsc::UnboundedReceiver<DaemonControl>,
    workspace_id: Option<String>,
    events_tx: Option<mpsc::UnboundedSender<muesli_core::events::WorkspaceEventEnvelope>>,
) -> Result<()> {
    macro_rules! say { ($($a:tt)*) => { if verbose { println!($($a)*); } } }
    let dir = match dir.canonicalize().with_context(|| format!("directory does not exist: {}", dir.display())) {
        Ok(d) => d,
        Err(e) => {
            let _ = status_tx.send(DaemonStatus { state: DaemonState::Error(format!("{e:#}")), ..Default::default() });
            return Err(e);
        }
    };
    if !dir.is_dir() {
        let msg = format!("{} is not a directory", dir.display());
        let _ = status_tx.send(DaemonStatus { state: DaemonState::Error(msg.clone()), ..Default::default() });
        bail!(msg);
    }
    let token = store::load_token(&server);
    let client_id = uuid::Uuid::new_v4().to_string();
    let ws = workspace_id.as_deref();
    // events_tx is consumed in Phase C2 (forwarder); accept it now for a stable signature.
    let _ = &events_tx;

    // ── 1. Discover and link the existing tree ──────────────────────────────
    let files = discover_md_files(&dir)?;
    let mut taken: std::collections::HashSet<String> = store::load_links()
        .into_iter()
        .filter(|l| l.server == store::http_base(&server) && !files.contains(&l.file))
        .map(|l| l.doc)
        .collect();
    let mut plan: Vec<(PathBuf, String)> = Vec::new();
    for file in &files {
        let doc = match store::find_link(file) {
            Some(link) => link.doc, // stable identity wins over the naming rule (ADR 0009)
            None => {
                let rel = file.strip_prefix(&dir).expect("discovered under dir");
                unique_slug(&slug_from_rel_path(rel, prefix.as_deref()), &taken)
            }
        };
        taken.insert(doc.clone());
        store::record_link(file, &doc, &server, ws)?;
        plan.push((file.clone(), doc));
    }

    // ── 2. Startup summary ──────────────────────────────────────────────────
    say!("muesli sync — {} file(s) linked", plan.len());
    say!("  dir     {}", dir.display());
    say!("  server  {}", store::http_base(&server));
    say!("  web     {}/#<doc>", web.trim_end_matches('/'));
    for (file, doc) in &plan {
        say!("  {}  ⇄  #{doc}", rel_label(&dir, file));
    }
    if plan.len() > MAX_SESSIONS {
        say!("  ({} files > {MAX_SESSIONS} connection cap — lazy sessions, see --help)", plan.len());
    }

    // ── 3. One recursive watcher for the whole tree ─────────────────────────
    let (ev_tx, mut ev_rx) = mpsc::unbounded_channel::<notify::Event>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let _ = ev_tx.send(event);
        }
    })?;
    watcher.watch(&dir, RecursiveMode::Recursive)?;

    // Folder mirroring: the desired (folder path, title) for every linked doc. The
    // reconciler recreates the local tree as Muesli folders and places pristine docs.
    let places: Arc<Mutex<Vec<PlaceItem>>> =
        Arc::new(Mutex::new(plan.iter().map(|(file, doc)| place_item(&dir, file, doc)).collect()));
    let recon_server = server.clone();
    let recon_token = token.clone();

    let mut daemon = SyncDaemon {
        dir,
        server,
        prefix,
        token,
        workspace_id: workspace_id.clone(),
        client_id: client_id.clone(),
        lazy: plan.len() > MAX_SESSIONS,
        shared: Arc::new(SyncShared::new()),
        sem: Arc::new(Semaphore::new(MAX_SESSIONS)),
        tasks: tokio::task::JoinSet::new(),
        handles: HashMap::new(),
        doc_index: DocIndex::default(),
        places: places.clone(),
    };
    for (file, doc) in plan {
        daemon.spawn_file(file, doc);
    }
    tokio::spawn(reconcile_loop(
        recon_server,
        recon_token,
        client_id.clone(),
        workspace_id.clone(),
        places,
        stop_rx.clone(),
    ));

    // Publish a status snapshot whenever the picture changes (coalesced by `watch`).
    let publish = |st: &watch::Sender<DaemonStatus>, daemon: &SyncDaemon, state: DaemonState| {
        let _ = st.send_if_modified(|cur| {
            let next = DaemonStatus {
                state,
                files: daemon.handles.len(),
                last_activity: daemon.shared.last_activity(),
                events: daemon.shared.events(),
            };
            if *cur != next {
                *cur = next;
                true
            } else {
                false
            }
        });
    };
    publish(&status_tx, &daemon, DaemonState::Running);

    // ── 4. Inbound structure stream (Plan 4 B3/B4) ──────────────────────────
    // The SSE event is a "reconcile now" trigger, not a delta. Only meaningful for a real
    // workspace; the CLI open-mode / no-token path skips it.
    let (evt_tx, mut evt_rx) =
        mpsc::unbounded_channel::<muesli_core::events::WorkspaceEventEnvelope>();
    if let (Some(ws), Some(tok)) = (daemon.workspace_id.clone(), daemon.token.clone()) {
        api::subscribe_workspace_events(daemon.server.clone(), Some(tok), ws, client_id.clone(), evt_tx);
        daemon.inbound_reconcile().await; // converge once on connect
    }
    // Debounce structural events into a single reconcile; a periodic safety tick covers any miss.
    let mut reconcile_due: Option<tokio::time::Instant> = None;
    let mut safety = tokio::time::interval(Duration::from_secs(30));
    safety.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // ── 5. Event loop until stop is requested ───────────────────────────────
    // A 500ms tick republishes status (file count + the SyncShared activity pulse), so the
    // tray sees adds/removes and live syncing without per-session plumbing.
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            res = stop_rx.changed() => {
                // Sender dropped, or a stop was requested.
                if res.is_err() || *stop_rx.borrow() {
                    break;
                }
            }
            Some(event) = ev_rx.recv() => {
                daemon.on_event(event).await;
                publish(&status_tx, &daemon, DaemonState::Running);
            }
            _ = tick.tick() => publish(&status_tx, &daemon, DaemonState::Running),
            Some(ctl) = control_rx.recv() => {
                match ctl {
                    DaemonControl::Attach { path, bridge } => {
                        // doc_index unaffected: attach/detach reuse the existing path-keyed handle (B2).
                        let key = resolve_handle_key(&daemon.dir, &path);
                        if let Some(h) = daemon.handles.get(&key) {
                            let _ = h.bridge_ctl.send(crate::session::BridgeCmd::Attach(bridge));
                            let _ = h.fs_tx.send(()); // wake a lazily-idle session so it reconnects
                        } else {
                            warn!(path = %key.display(), "attach_editor: no linked file at path");
                        }
                    }
                    DaemonControl::Detach { path } => {
                        // doc_index unaffected: attach/detach reuse the existing path-keyed handle (B2).
                        let key = resolve_handle_key(&daemon.dir, &path);
                        if let Some(h) = daemon.handles.get(&key) {
                            let _ = h.bridge_ctl.send(crate::session::BridgeCmd::Detach);
                        }
                    }
                }
                publish(&status_tx, &daemon, DaemonState::Running);
            }
            Some(env) = evt_rx.recv() => {
                use muesli_core::events::WorkspaceEvent;
                match &env.event {
                    // Content wake-ping: nudge the cold session via the B2 doc index; no
                    // structure change. If no local session/link yet → reconcile soon.
                    WorkspaceEvent::DocUpdated { slug } => {
                        if let Some(h) = daemon.handle_for_doc(slug) {
                            let _ = h.fs_tx.send(()); // wake it to reconnect + pull
                        } else {
                            reconcile_due =
                                Some(tokio::time::Instant::now() + Duration::from_millis(300));
                        }
                    }
                    // Any structural event → debounced reconcile.
                    _ => {
                        reconcile_due =
                            Some(tokio::time::Instant::now() + Duration::from_millis(300));
                    }
                }
                publish(&status_tx, &daemon, DaemonState::Running);
            }
            _ = async {
                match reconcile_due {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            }, if reconcile_due.is_some() => {
                reconcile_due = None;
                daemon.inbound_reconcile().await;
                publish(&status_tx, &daemon, DaemonState::Running);
            }
            _ = safety.tick() => {
                if daemon.workspace_id.is_some() && daemon.token.is_some() {
                    daemon.inbound_reconcile().await;
                }
            }
        }
    }

    // ── 6. Clean shutdown: flush every dirty replica, keep the index ────────
    say!("\nstopping — flushing dirty buffers…");
    let n = daemon.handles.len();
    for handle in daemon.handles.values() {
        let _ = handle.stop_tx.send(Stop::Flush);
    }
    while daemon.tasks.join_next().await.is_some() {}
    say!("✓ sync stopped — {n} file(s); index and server docs retained");
    let _ = status_tx.send(DaemonStatus { state: DaemonState::Stopped, ..Default::default() });
    Ok(())
}

/// The doc-slug → current-path index, kept coherent with `handles` so a rename/reclone
/// resolves to the SAME session instead of minting a second replica (Plan 4 B2).
#[derive(Default)]
struct DocIndex(HashMap<String, PathBuf>);

impl DocIndex {
    fn bind(&mut self, doc: String, path: PathBuf) {
        self.0.insert(doc, path);
    }
    /// A rename of `doc` from `old` to `new_path`: only rebind if the index still points
    /// `doc` at `old` (defensive against stale events). Idempotent.
    fn rebind(&mut self, doc: &str, old: &Path, new_path: PathBuf) {
        if self.0.get(doc).is_some_and(|p| p == old) || !self.0.contains_key(doc) {
            self.0.insert(doc.to_string(), new_path);
        }
    }
    fn unbind(&mut self, path: &Path) {
        self.0.retain(|_, p| p != path);
    }
    fn path_of(&self, doc: &str) -> Option<&PathBuf> {
        self.0.get(doc)
    }
    #[cfg(test)]
    fn doc_count(&self) -> usize {
        self.0.len()
    }
    #[cfg(test)]
    fn docs_for_path(&self, path: &Path) -> usize {
        self.0.values().filter(|p| *p == path).count()
    }
}

struct FileHandle {
    fs_tx: mpsc::UnboundedSender<()>,
    stop_tx: watch::Sender<Stop>,
    bridge_ctl: mpsc::UnboundedSender<crate::session::BridgeCmd>,
    doc: String,
}

struct SyncDaemon {
    dir: PathBuf,
    server: String,
    prefix: Option<String>,
    token: Option<String>,
    /// Owning workspace id for this run (None in personal/open mode); written to each link.
    workspace_id: Option<String>,
    /// Per-run origin id (uuid v4) for the echo-guard (B3 SSE filter) and the
    /// `x-muesli-client-id` header on outbound REST (B5).
    client_id: String,
    lazy: bool,
    shared: Arc<SyncShared>,
    sem: Arc<Semaphore>,
    tasks: tokio::task::JoinSet<()>,
    handles: HashMap<PathBuf, FileHandle>,
    doc_index: DocIndex,
    /// Desired folder placement per linked doc, consumed by the reconciler task.
    places: Arc<Mutex<Vec<PlaceItem>>>,
}

impl SyncDaemon {
    /// Start the per-file session task (the factored `muesli open` machinery).
    fn spawn_file(&mut self, file: PathBuf, doc: String) {
        let (fs_tx, mut fs_rx) = mpsc::unbounded_channel::<()>();
        let (stop_tx, mut stop_rx) = watch::channel(Stop::Run);
        let label = rel_label(&self.dir, &file);
        let ctx = SessionCtx {
            url: format!("{}/{}", store::ws_base(&self.server).trim_end_matches('/'), doc),
            file: file.clone(),
            doc_id: doc.clone(),
            server: self.server.clone(),
            token: self.token.clone(),
            mode: SessionMode::Sync { label: label.clone(), shared: self.shared.clone() },
        };
        let sem = self.sem.clone();
        let lazy = self.lazy;
        let (bridge_ctl_tx, mut bridge_ctl_rx) =
            mpsc::unbounded_channel::<crate::session::BridgeCmd>();
        self.tasks.spawn(async move {
            let mut session = FileSession::new(ctx);
            loop {
                // A connection slot (the cap); stop requests win while waiting.
                let permit = tokio::select! {
                    permit = sem.acquire() => permit.expect("semaphore never closed"),
                    _ = stop_rx.changed() => {
                        if *stop_rx.borrow() != Stop::Run { return; }
                        continue;
                    }
                };
                let outcome = session
                    .run(&mut fs_rx, &mut stop_rx, &mut bridge_ctl_rx, lazy.then_some(IDLE_TIMEOUT))
                    .await;
                drop(permit);
                match outcome {
                    Ok(crate::session::SessionOutcome::Stopped(_)) => return,
                    Ok(crate::session::SessionOutcome::Idle) => {
                        debug!(%label, "idle — released the connection slot");
                        // Lazy wakeup: a local change, the round-robin repoll, or stop.
                        tokio::select! {
                            Some(()) = fs_rx.recv() => {}
                            _ = tokio::time::sleep(REPOLL) => {}
                            _ = stop_rx.changed() => {
                                if *stop_rx.borrow() != Stop::Run { return; }
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("✗ {label}: {e:#}");
                        return;
                    }
                }
            }
        });
        self.handles.insert(file.clone(), FileHandle { fs_tx, stop_tx, bridge_ctl: bridge_ctl_tx, doc: doc.clone() });
        self.doc_index.bind(doc, file);
    }

    /// The live handle for a doc slug, via the secondary index (B2).
    fn handle_for_doc(&self, doc: &str) -> Option<&FileHandle> {
        self.doc_index.path_of(doc).and_then(|p| self.handles.get(p))
    }

    async fn on_event(&mut self, event: notify::Event) {
        let mut seen: Vec<PathBuf> = Vec::new();
        for path in event.paths {
            if seen.contains(&path) {
                continue;
            }
            seen.push(path.clone());

            if let Some(handle) = self.handles.get(&path) {
                if path.is_file() {
                    let _ = handle.fs_tx.send(()); // ordinary change → the file's session
                } else {
                    // Possible delete or rename-away. Editors also "replace" files for a
                    // moment (write + rename) — settle, then re-check before declaring it.
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    if path.is_file() {
                        let _ = handle.fs_tx.send(());
                    } else {
                        self.on_removed(&path);
                    }
                }
            } else if is_candidate(&self.dir, &path) && path.is_file() {
                self.on_new_file(path).await;
            }
        }
    }

    /// File gone: stop its session WITHOUT a final write, then TRASH the server doc — but ONLY
    /// for a known-synced doc (one a prior server round-trip stamped `last_synced`). A
    /// never-pushed local touches nothing on the server. Trash is a reversible soft-delete
    /// (`DELETE /api/documents/{slug}`), so this stays within the "never destructive" posture.
    ///
    /// Behavior change (Plan 4 B5): previously a local delete kept the server doc forever; it
    /// now propagates the delete as a trash for docs that were actually pushed.
    ///
    /// Guard note (deviation from the brief, deliberate — see report): the brief keyed the
    /// "was pushed" proxy off `link.workspace.is_some()`, but the workspace tag is stamped at
    /// DISCOVERY time (run() step 1), not after a server sync — so a freshly-created,
    /// never-pushed local file is already workspace-tagged and would be wrongly trashed. B4
    /// reached the same conclusion for inbound deletes; `last_synced.is_some()` is the signal
    /// the brief's own comment describes ("recorded after a server sync"), strictly more
    /// conservative: when unsure, we do NOT trash.
    fn on_removed(&mut self, path: &Path) {
        if let Some(handle) = self.handles.remove(path) {
            let _ = handle.stop_tx.send(Stop::Drop);
            self.doc_index.unbind(path);
            let doc = handle.doc.clone();
            let known_synced = should_trash_on_delete(
                store::find_link(path).and_then(|l| l.last_synced).as_deref(),
            );
            if known_synced {
                let (server, token, client_id) =
                    (self.server.clone(), self.token.clone(), self.client_id.clone());
                let slug = doc.clone();
                tokio::spawn(async move {
                    if let Err(e) = api::trash_document(&server, token.as_deref(), &client_id, &slug).await {
                        warn!(%e, %slug, "outbound trash failed");
                    }
                });
                println!(
                    "- file removed: {} — trashed #{doc} on the server (reversible soft-delete)",
                    rel_label(&self.dir, path)
                );
            } else {
                println!(
                    "- file removed: {} — kept #{doc} (never pushed; nothing to trash)",
                    rel_label(&self.dir, path)
                );
            }
        }
    }

    /// New `.md` in the tree: re-use an exact index entry, else apply the ADR 0009 rename
    /// re-bind rule (content hash vs known replica texts), else mint a fresh slug. In
    /// workspace mode a brand-new doc is BORN in the target workspace via REST before the
    /// room connect, so `resolve_access` opens the existing doc rather than creating one in
    /// the creator's personal workspace (root-level files included).
    async fn on_new_file(&mut self, path: PathBuf) {
        tokio::time::sleep(Duration::from_millis(100)).await; // settle (create + write bursts)
        if !path.is_file() || self.handles.contains_key(&path) {
            return;
        }
        let Ok(bytes) = std::fs::read(&path) else { return };
        let Ok(text) = String::from_utf8(bytes) else {
            warn!(file = %path.display(), "new file is not valid UTF-8 — not linking");
            return;
        };
        let label = rel_label(&self.dir, &path);
        let server_base = store::http_base(&self.server);
        let links = store::load_links();

        // Resolve the doc slug AND whether this is a brand-new link (vs. re-link / rename).
        // Only a brand-new link in workspace mode needs the doc birthed server-side.
        let (doc, is_new) = if let Some(link) = links.iter().find(|l| l.file == path) {
            // The exact path was linked before (e.g. deleted then restored).
            println!("+ file re-linked: {label} → #{}", link.doc);
            (link.doc.clone(), false)
        } else {
            let candidates: Vec<(String, bool, Option<u64>)> = links
                .iter()
                .filter(|l| l.server == server_base)
                .map(|l| (l.doc.clone(), l.file.is_file(), self.shared.hash_of(&l.doc)))
                .collect();
            match rebind_candidate(text_hash(&text), &candidates) {
                Some(doc) => {
                    // Rename: same content, old path gone → same Document identity. Retire any
                    // handle still parked at the old path so we don't keep two sessions for one doc.
                    if let Some(old) = self.doc_index.path_of(&doc).cloned() {
                        if old != path {
                            if let Some(h) = self.handles.remove(&old) {
                                let _ = h.stop_tx.send(Stop::Drop);
                            }
                            self.doc_index.rebind(&doc, &old, path.clone());
                        }
                    }
                    if let Err(e) = store::rebind_link(&doc, &self.server, &path) {
                        warn!(%e, "could not re-bind the renamed file in the index");
                    }
                    println!("↻ re-linked (rename): {label} → #{doc}");
                    (doc, false)
                }
                None => {
                    let rel = path.strip_prefix(&self.dir).expect("candidate is under dir");
                    let taken = links.iter().map(|l| l.doc.clone()).collect();
                    let doc = unique_slug(&slug_from_rel_path(rel, self.prefix.as_deref()), &taken);
                    if let Err(e) = store::record_link(&path, &doc, &self.server, self.workspace_id.as_deref()) {
                        warn!(%e, "could not record the new link in the index");
                    }
                    println!("+ new file linked: {label} → #{doc}");
                    (doc, true)
                }
            }
        };
        let item = place_item(&self.dir, &path, &doc);
        self.places.lock().unwrap().push(item.clone());

        // WORKSPACE MODE: birth a brand-new doc in the target workspace W BEFORE connecting
        // the room. Resolve (creating if needed) the folder chain first, then POST
        // /api/documents so the server row exists in W; resolve_access then OPENS this doc
        // (the Some(doc) branch) instead of lazily minting one in the personal workspace.
        // Root-level files (folder_id None) MUST still POST — that's the gap being closed.
        // NOTE (known deferral): resolve_folder_chain re-lists folders per call, so a bulk
        // promote of N files makes ~N list round-trips. Acceptable for v1 (promote is
        // one-time; files settle progressively); a future pass can cache the folder map.
        let workspace_mode = self.workspace_id.is_some() && self.token.is_some();
        if should_create_remote_doc(workspace_mode, is_new) {
            let workspace_id = self.workspace_id.clone().expect("workspace_mode ⇒ Some");
            let folder_id = self.resolve_folder_chain(&item).await;
            if let Err(e) = api::create_document(
                &self.server,
                self.token.as_deref(),
                &self.client_id,
                &workspace_id,
                &item.slug,
                folder_id.as_deref(),
                Some(&item.title),
            )
            .await
            {
                warn!(%e, slug = %item.slug, "birthing new doc in workspace failed — \
                      room connect may fall back to the personal workspace");
            }
        }

        // Outbound placement of a rename/move: PATCH title+folder to match the new path. Only
        // for docs already pushed to the server (a fresh local is placed by the reconcile_loop
        // after its first push). Same conservative `last_synced` proxy as the trash guard.
        if store::find_link(&path).map(|l| l.last_synced.is_some()).unwrap_or(false) {
            let (server, token, client_id) =
                (self.server.clone(), self.token.clone(), self.client_id.clone());
            let folder_parent = self.resolve_folder_chain(&item).await;
            let (slug, title) = (item.slug.clone(), item.title.clone());
            if let Err(e) =
                api::place_document(&server, token.as_deref(), &client_id, &slug, folder_parent.as_deref(), &title).await
            {
                warn!(%e, %slug, "outbound place (rename) failed");
            }
        }
        self.spawn_file(path, doc);
    }

    /// Ensure `item`'s folder chain exists on the server (creating missing levels) and
    /// return the leaf folder id (None = root). Best-effort: on any error returns what it
    /// has so far (the reconcile_loop will retry placement).
    async fn resolve_folder_chain(&self, item: &PlaceItem) -> Option<String> {
        let (_docs, folders) =
            api::list_docs_and_folders(&self.server, self.token.as_deref()).await.ok()?;
        let mut fmap: HashMap<(Option<String>, String), String> = folders
            .iter()
            .filter(|f| match (&self.workspace_id, &f.workspace_id) {
                (Some(w), Some(h)) => w == h,
                (Some(_), None) => false,
                (None, _) => true,
            })
            .map(|f| ((f.parent_id.clone(), f.name.clone()), f.id.clone()))
            .collect();
        let mut parent: Option<String> = None;
        for name in &item.folders {
            let key = (parent.clone(), name.clone());
            let id = if let Some(id) = fmap.get(&key) {
                id.clone()
            } else {
                match api::create_folder(
                    &self.server,
                    self.token.as_deref(),
                    &self.client_id,
                    self.workspace_id.as_deref(),
                    name,
                    parent.as_deref(),
                )
                .await
                {
                    Ok(id) => {
                        fmap.insert(key, id.clone());
                        id
                    }
                    Err(e) => {
                        warn!(%e, name, "rename place: create folder failed");
                        return parent;
                    }
                }
            };
            parent = Some(id);
        }
        parent
    }

    /// Converge local disk toward the server's structure (Contract 5). Idempotent; safe to call
    /// on connect, on each debounced structural event, and on the safety tick.
    async fn inbound_reconcile(&mut self) {
        let (docs, folders) =
            match api::list_docs_and_folders(&self.server, self.token.as_deref()).await {
                Ok(v) => v,
                Err(e) => {
                    warn!(%e, "inbound reconcile: list failed");
                    return;
                }
            };
        // Filter to our workspace (client-side; Contract 4). None = open mode → keep all.
        let mine = |ws: &Option<String>| match (&self.workspace_id, ws) {
            (Some(want), Some(have)) => want == have,
            (Some(_), None) => false,
            (None, _) => true,
        };
        let folders: Vec<&api::FolderInfo> = folders.iter().filter(|f| mine(&f.workspace_id)).collect();
        let docs: Vec<&api::DocInfo> = docs.iter().filter(|d| mine(&d.workspace_id)).collect();

        // folder id → ordered ancestor names (root-first).
        let by_id: HashMap<&str, &api::FolderInfo> =
            folders.iter().map(|f| (f.id.as_str(), *f)).collect();
        let mut chain: HashMap<String, Vec<String>> = HashMap::new();
        for f in &folders {
            let mut names = Vec::new();
            let mut cur = Some(f.id.as_str());
            let mut guard = 0;
            while let Some(id) = cur {
                let Some(fi) = by_id.get(id) else { break };
                names.push(fi.name.clone());
                cur = fi.parent_id.as_deref();
                guard += 1;
                if guard > 64 {
                    break;
                } // cycle guard
            }
            names.reverse();
            chain.insert(f.id.clone(), names);
        }

        let server_docs: Vec<(String, PathBuf)> = docs
            .iter()
            .map(|d| {
                (
                    d.slug.clone(),
                    desired_rel_path(d.folder_id.as_deref(), d.title.as_deref(), &d.slug, &chain),
                )
            })
            .collect();

        // Local links for THIS server.
        let server_base = store::http_base(&self.server);
        let links = store::load_links();
        let local_links: Vec<(String, PathBuf)> = links
            .iter()
            .filter(|l| l.server == server_base)
            .map(|l| (l.doc.clone(), l.file.clone()))
            .collect();
        // known-synced = the local link exists AND the doc currently has (or had) a server row.
        // A doc had a server row iff EITHER it is present on the server right now, OR a prior
        // sync round-trip recorded `last_synced` (set only after a real snapshot/applied/flush
        // exchange — see session.rs). A pristine never-pushed local has neither, so it is
        // excluded from deletes (the data-loss invariant).
        //
        // NOTE (deviation from the brief, deliberate — see report): the brief's code keyed
        // known-synced off `l.workspace.is_some()`. But the workspace tag is stamped at
        // DISCOVERY time (run() step 1, `record_link(.., ws)`), NOT after a server sync, so in
        // workspace mode a freshly-created, not-yet-pushed local file is workspace-tagged and
        // would be wrongly classed "known-synced" → a `Delete` could remove a never-pushed file
        // if the inbound list ran before that file's session pushed it. `last_synced` is the
        // signal the brief's own comment describes ("recorded after a server sync"); using it
        // closes the hole while staying strictly more conservative.
        let server_slugs: HashSet<&str> = docs.iter().map(|d| d.slug.as_str()).collect();
        let known_synced: HashSet<String> = links
            .iter()
            .filter(|l| l.server == server_base)
            .filter(|l| l.last_synced.is_some() || server_slugs.contains(l.doc.as_str()))
            .map(|l| l.doc.clone())
            .collect();

        // Folders that contain no docs → empty dirs to materialize.
        let nonempty: HashSet<&str> = docs.iter().filter_map(|d| d.folder_id.as_deref()).collect();
        let empty_folders: Vec<PathBuf> = folders
            .iter()
            .filter(|f| !nonempty.contains(f.id.as_str()))
            .filter_map(|f| chain.get(&f.id))
            .map(|names| names.iter().map(|n| sanitize_segment(n)).collect::<PathBuf>())
            .collect();

        let actions =
            reconcile_actions(&self.dir, &server_docs, &local_links, &known_synced, &empty_folders);
        for action in actions {
            self.apply_inbound(action).await;
        }
    }

    /// Apply one convergence action to disk + the in-memory maps. Every branch is echo-safe:
    /// a create whose dest already exists, or a move whose source is gone / dest is taken, is a
    /// no-op — so re-running the reconcile lands on the same state.
    async fn apply_inbound(&mut self, action: InboundAction) {
        match action {
            InboundAction::Create { slug, dest } => {
                if dest.exists() {
                    return; // converged already (echo-safe)
                }
                let text = match api::doc_text(&self.server, self.token.as_deref(), &slug).await {
                    Ok(t) => t,
                    Err(e) => {
                        warn!(%e, %slug, "inbound create: doc_text failed");
                        return;
                    }
                };
                if let Some(parent) = dest.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Err(e) = crate::session::atomic_write(&dest, &text) {
                    warn!(%e, "inbound create: write failed");
                    return;
                }
                if let Err(e) =
                    store::record_link(&dest, &slug, &self.server, self.workspace_id.as_deref())
                {
                    warn!(%e, "inbound create: record_link failed");
                }
                println!("↓ remote new: {} → #{slug}", rel_label(&self.dir, &dest));
                self.spawn_file(dest, slug);
            }
            InboundAction::Move { slug, from, to } => {
                if !from.exists() || to.exists() {
                    return; // already converged
                }
                if let Some(parent) = to.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Err(e) = std::fs::rename(&from, &to) {
                    warn!(%e, "inbound move: fs rename failed");
                    return;
                }
                // Retire the old-path handle, rebind both the index and the link to the new path.
                if let Some(h) = self.handles.remove(&from) {
                    let _ = h.stop_tx.send(Stop::Drop);
                }
                self.doc_index.rebind(&slug, &from, to.clone());
                if let Err(e) = store::rebind_link(&slug, &self.server, &to) {
                    warn!(%e, "inbound move: rebind_link failed");
                }
                println!(
                    "↓ remote move: {} → {}",
                    rel_label(&self.dir, &from),
                    rel_label(&self.dir, &to)
                );
                self.spawn_file(to, slug);
            }
            InboundAction::Delete { slug, path } => {
                if let Some(h) = self.handles.remove(&path) {
                    let _ = h.stop_tx.send(Stop::Drop);
                }
                self.doc_index.unbind(&path);
                let _ = std::fs::remove_file(&path);
                let _ = store::remove_link(&path);
                println!("↓ remote delete: removed {} (#{slug})", rel_label(&self.dir, &path));
            }
            InboundAction::Mkdir { path } => {
                let _ = std::fs::create_dir_all(&path);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Folder mirroring (disk → Muesli folders): recreate the local tree as folders
// and place each doc, while RESPECTING any reorganization done in the web app.
// ---------------------------------------------------------------------------

/// The desired placement of one linked doc: the folder path under the synced root
/// (empty = a root-level file) and the display title (the file stem).
#[derive(Clone)]
struct PlaceItem {
    slug: String,
    folders: Vec<String>,
    title: String,
}

/// Decide whether `on_new_file` should birth the doc in the target workspace via
/// `api::create_document` BEFORE connecting the room. True only when (a) we run in
/// workspace mode (a `workspace_id` + token are set) and (b) this is a brand-NEW link
/// (not a re-link or a rename/rebind — those docs already exist server-side). Root-level
/// files (folder_id None) are NOT special-cased here: a new root file in workspace mode
/// still returns true, which is the gap this closes.
fn should_create_remote_doc(workspace_mode: bool, is_new_link: bool) -> bool {
    workspace_mode && is_new_link
}

fn place_item(dir: &Path, file: &Path, doc: &str) -> PlaceItem {
    let rel = file.strip_prefix(dir).unwrap_or(file);
    let folders = rel
        .parent()
        .map(|p| {
            p.components()
                .filter_map(|c| match c {
                    Component::Normal(n) => Some(n.to_string_lossy().to_string()),
                    _ => None,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let title = file
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| doc.to_string());
    PlaceItem { slug: doc.to_string(), folders, title }
}

/// Periodically ensure each nested doc's folder chain exists and the doc is placed +
/// titled. Placement is ONE-TIME per doc: only docs that are still pristine (at the root
/// with a default/slug title) are moved, so reorganizing in the web app sticks. Quiesces
/// once every nested doc is placed (no further writes; the pass short-circuits before the
/// network call). Ends when the daemon stops.
async fn reconcile_loop(
    server: String,
    token: Option<String>,
    client_id: String,
    workspace_id: Option<String>,
    places: Arc<Mutex<Vec<PlaceItem>>>,
    mut stop_rx: watch::Receiver<bool>,
) {
    let mut placed: HashSet<String> = HashSet::new();
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            res = stop_rx.changed() => {
                if res.is_err() || *stop_rx.borrow() { return; }
            }
            _ = tick.tick() => {}
        }

        // Only nested docs need placement; skip the network call once all are handled.
        let pending: Vec<PlaceItem> = places
            .lock()
            .unwrap()
            .iter()
            .filter(|i| !i.folders.is_empty() && !placed.contains(&i.slug))
            .cloned()
            .collect();
        if pending.is_empty() {
            continue;
        }

        let (docs, folders) = match api::list_docs_and_folders(&server, token.as_deref()).await {
            Ok(v) => v,
            Err(e) => {
                warn!(%e, "placement: could not list docs/folders");
                continue;
            }
        };
        let doc_by_slug: HashMap<&str, &api::DocInfo> =
            docs.iter().map(|d| (d.slug.as_str(), d)).collect();
        // (parent_id, name) → folder id, so an existing tree is reused, not duplicated.
        let mut fmap: HashMap<(Option<String>, String), String> = folders
            .iter()
            .map(|f| ((f.parent_id.clone(), f.name.clone()), f.id.clone()))
            .collect();

        for item in &pending {
            let Some(doc) = doc_by_slug.get(item.slug.as_str()) else {
                continue; // not minted yet (no WS sync) — retry next pass
            };
            // Respect the user: only place a doc still at root with its default title.
            let title_is_default = doc.title.as_deref().is_none_or(|t| t == item.slug || t.is_empty());
            if doc.folder_id.is_some() || !title_is_default {
                placed.insert(item.slug.clone());
                continue;
            }
            // Ensure the folder chain, creating missing levels.
            let mut parent: Option<String> = None;
            let mut chain_ok = true;
            for name in &item.folders {
                let key = (parent.clone(), name.clone());
                let id = if let Some(id) = fmap.get(&key) {
                    id.clone()
                } else {
                    match api::create_folder(&server, token.as_deref(), &client_id, workspace_id.as_deref(), name, parent.as_deref()).await {
                        Ok(id) => {
                            fmap.insert(key, id.clone());
                            id
                        }
                        Err(e) => {
                            warn!(%e, name, "placement: create folder failed");
                            chain_ok = false;
                            break;
                        }
                    }
                };
                parent = Some(id);
            }
            if !chain_ok {
                continue;
            }
            match api::place_document(&server, token.as_deref(), &client_id, &item.slug, parent.as_deref(), &item.title).await {
                Ok(()) => {
                    placed.insert(item.slug.clone());
                    debug!(slug = %item.slug, "placed into folder tree");
                }
                Err(e) => warn!(%e, slug = %item.slug, "placement: PATCH failed"),
            }
        }
    }
}

fn rel_label(dir: &Path, file: &Path) -> String {
    file.strip_prefix(dir).unwrap_or(file).display().to_string()
}

// ---------------------------------------------------------------------------
// Tree discovery
// ---------------------------------------------------------------------------

/// Components we never descend into / link: hidden entries (incl. our `.…muesli-tmp`
/// atomic-write files), package/build dirs, and VCS internals.
fn is_skipped_name(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules" || name == "target"
}

/// Is `path` a file we would sync? (`.md`, under `dir`, no skipped component.)
fn is_candidate(dir: &Path, path: &Path) -> bool {
    let md = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("md"));
    md && path.strip_prefix(dir).is_ok_and(|rel| {
        rel.components().all(|c| match c {
            Component::Normal(name) => !is_skipped_name(&name.to_string_lossy()),
            _ => false,
        })
    })
}

/// All candidate `.md` files under `dir`, sorted (stable summary + slug allocation).
pub fn discover_md_files(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d).with_context(|| format!("reading {}", d.display()))? {
            let entry = entry?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if is_skipped_name(&name) {
                continue;
            }
            let ty = entry.file_type()?;
            if ty.is_dir() {
                stack.push(path);
            } else if ty.is_file() && is_candidate(dir, &path) {
                out.push(path);
            }
        }
    }
    out.sort();
    Ok(out)
}

// ---------------------------------------------------------------------------
// Naming: doc slug from the dir-relative path (docs/design/local-agent-cli.md;
// fallback rule: path separators → '-', slugified, optional --prefix prepended).
// ---------------------------------------------------------------------------

pub fn slug_from_rel_path(rel: &Path, prefix: Option<&str>) -> String {
    let mut raw = String::new();
    for c in rel.components() {
        if let Component::Normal(name) = c {
            if !raw.is_empty() {
                raw.push('-');
            }
            raw.push_str(&name.to_string_lossy());
        }
    }
    if raw.len() >= 3 && raw[raw.len() - 3..].eq_ignore_ascii_case(".md") {
        raw.truncate(raw.len() - 3);
    }
    let body = slugify(&raw);
    let slug = match prefix.map(slugify).filter(|p| !p.is_empty()) {
        Some(p) if body.is_empty() => p,
        Some(p) => format!("{p}-{body}"),
        None => body,
    };
    if slug.is_empty() {
        "untitled".into()
    } else {
        slug
    }
}

/// Lowercased ASCII alphanumerics; everything else collapses to single '-' (no leading/
/// trailing dash). Non-ASCII letters are folded into separators — slugs stay URL-trivial.
fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch.to_ascii_lowercase());
        } else {
            pending_dash = true;
        }
    }
    out
}

/// Collision insurance: "a/b.md" and "a-b.md" both slug to "a-b" — suffix until free.
fn unique_slug(base: &str, taken: &std::collections::HashSet<String>) -> String {
    if !taken.contains(base) {
        return base.to_string();
    }
    for n in 2.. {
        let candidate = format!("{base}-{n}");
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

// ---------------------------------------------------------------------------
// Rename re-bind decision (ADR 0009): a "new" file whose content hash equals the last
// known replica text of EXACTLY ONE doc whose path is gone is that doc, renamed.
// Ambiguity (several byte-identical gone files) → None: prompt-don't-guess, mint fresh.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Outbound delete → trash guard (Plan 4 B5). The data-loss-sensitive decision: a local
// delete propagates as a server trash ONLY for a doc that was actually pushed. "Was pushed"
// is proxied by `last_synced` (stamped after a real server round-trip — see session.rs),
// NOT by the workspace tag (stamped at discovery, before any push). A missing link → never
// trash. Pure + unit-tested below; the side-effecting spawn in `on_removed` calls into it.
// ---------------------------------------------------------------------------

/// Decide whether a locally-deleted file should trash its server doc. `last_synced` is the
/// link's `last_synced` column (Some iff a prior sync round-trip stamped it). `None` means no
/// link row was found → conservatively do NOT trash.
fn should_trash_on_delete(last_synced: Option<&str>) -> bool {
    last_synced.is_some()
}

pub fn rebind_candidate(new_hash: u64, candidates: &[(String, bool, Option<u64>)]) -> Option<String> {
    let mut matches = candidates
        .iter()
        .filter(|(_, path_exists, hash)| !path_exists && *hash == Some(new_hash))
        .map(|(doc, _, _)| doc.clone());
    match (matches.next(), matches.next()) {
        (Some(doc), None) => Some(doc),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Inbound reconcile (server → disk convergence, Plan 4 B4 / Contract 5). The SSE
// event is a "reconcile now" trigger, not a delta: we list the server's structure
// and converge the local tree toward it, idempotently. The risky decision logic is
// the pure `reconcile_actions` below — unit-tested without a live server.
// ---------------------------------------------------------------------------

/// One convergence action computed from the server's doc list vs the local link list.
#[derive(Debug, PartialEq, Eq)]
enum InboundAction {
    /// Remote create / move-in: doc not linked locally → pull + write at `dest` + link + spawn.
    Create { slug: String, dest: PathBuf },
    /// Remote rename/move: linked doc's desired path changed → fs rename `from`→`to` + rebind.
    Move { slug: String, from: PathBuf, to: PathBuf },
    /// Remote delete: a known-synced doc now trashed/absent on the server → remove + unlink.
    Delete { slug: String, path: PathBuf },
    /// An empty remote folder with no docs → mkdir (best-effort).
    Mkdir { path: PathBuf },
}

/// Pure decision: given the server's live docs (slug, desired relative path), the local links
/// (slug → current absolute path), the set of slugs that were known-synced (had a server row),
/// and the set of empty remote folder relative paths → the actions to converge. `root` anchors
/// the relative server paths.
///
/// Safety invariants (this is the data-loss-sensitive core):
/// - Idempotent: a converged state yields zero actions; the same input always yields the same
///   actions, so applying the run once or ten times lands on the same disk state.
/// - A locally-linked doc that is NOT known-synced (pending its first server push) is NEVER in
///   the delete set, even when it is absent on the server.
fn reconcile_actions(
    root: &Path,
    server_docs: &[(String, PathBuf)],
    local_links: &[(String, PathBuf)],
    known_synced: &HashSet<String>,
    empty_folders: &[PathBuf],
) -> Vec<InboundAction> {
    let local: HashMap<&str, &PathBuf> =
        local_links.iter().map(|(s, p)| (s.as_str(), p)).collect();
    let server: HashSet<&str> = server_docs.iter().map(|(s, _)| s.as_str()).collect();
    let mut out = Vec::new();

    // Creates + moves, driven by the server's desired state.
    for (slug, rel) in server_docs {
        let dest = root.join(rel);
        match local.get(slug.as_str()) {
            None => out.push(InboundAction::Create { slug: slug.clone(), dest }),
            Some(cur) if **cur != dest => out.push(InboundAction::Move {
                slug: slug.clone(),
                from: (*cur).clone(),
                to: dest,
            }),
            Some(_) => {} // already in place
        }
    }
    // Deletes: locally-linked, known-synced, and now absent on the server. Never touch a
    // never-synced local (pending first push).
    for (slug, path) in local_links {
        if !server.contains(slug.as_str()) && known_synced.contains(slug) {
            out.push(InboundAction::Delete { slug: slug.clone(), path: path.clone() });
        }
    }
    // Empty remote folders → mkdir.
    for rel in empty_folders {
        out.push(InboundAction::Mkdir { path: root.join(rel) });
    }
    out
}

/// The server's desired path (rel to root) for a doc: its folder chain + `<title>.md`
/// (falling back to the slug when the title is empty/None). `folder_chain` maps a folder id
/// to its ordered ancestor names (root-first).
fn desired_rel_path(
    folder_id: Option<&str>,
    title: Option<&str>,
    slug: &str,
    folder_chain: &HashMap<String, Vec<String>>,
) -> PathBuf {
    let mut path = PathBuf::new();
    if let Some(fid) = folder_id {
        if let Some(names) = folder_chain.get(fid) {
            for n in names {
                path.push(sanitize_segment(n));
            }
        }
    }
    let stem = title.filter(|t| !t.is_empty()).unwrap_or(slug);
    path.push(format!("{}.md", sanitize_segment(stem)));
    path
}

/// Filesystem-safe single path segment: strip separators and leading dots so a server
/// title can never escape the synced root or create hidden entries.
fn sanitize_segment(s: &str) -> String {
    let cleaned: String =
        s.chars().map(|c| if std::path::is_separator(c) { '-' } else { c }).collect();
    let cleaned = cleaned.trim_start_matches('.').trim();
    if cleaned.is_empty() {
        "untitled".into()
    } else {
        cleaned.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn p(root: &Path, rel: &str) -> PathBuf {
        root.join(rel)
    }

    #[test]
    fn reconcile_actions_cover_create_move_delete_mkdir() {
        let root = Path::new("/root");
        // server has: notes (root), moved (now under sub/), keepfresh (never-synced local stays)
        let server_docs = vec![
            ("notes".to_string(), PathBuf::from("notes.md")),
            ("moved".to_string(), PathBuf::from("sub/moved.md")),
        ];
        // locally: notes already at the right place; moved still at the OLD root path;
        // gone was linked + known-synced but no longer on the server; localnew never pushed.
        let local_links = vec![
            ("notes".to_string(), p(root, "notes.md")),
            ("moved".to_string(), p(root, "moved.md")),
            ("gone".to_string(), p(root, "gone.md")),
            ("localnew".to_string(), p(root, "localnew.md")),
        ];
        let known_synced: HashSet<String> =
            ["notes", "moved", "gone"].iter().map(|s| s.to_string()).collect();
        let empty_folders = vec![PathBuf::from("EmptyDir")];

        let mut acts =
            reconcile_actions(root, &server_docs, &local_links, &known_synced, &empty_folders);
        acts.sort_by_key(|a| format!("{a:?}"));

        // notes: in place → no action. moved: rename old→new. gone: delete (known-synced, absent).
        // localnew: NOT deleted (never on server). EmptyDir: mkdir.
        assert!(acts.contains(&InboundAction::Move {
            slug: "moved".into(),
            from: p(root, "moved.md"),
            to: p(root, "sub/moved.md"),
        }));
        assert!(acts.contains(&InboundAction::Delete {
            slug: "gone".into(),
            path: p(root, "gone.md")
        }));
        assert!(acts.contains(&InboundAction::Mkdir { path: p(root, "EmptyDir") }));
        assert!(
            !acts.iter().any(
                |a| matches!(a, InboundAction::Delete { slug, .. } if slug == "localnew")
            ),
            "a never-synced local file is never deleted by inbound reconcile"
        );
        assert!(
            !acts
                .iter()
                .any(|a| matches!(a, InboundAction::Create { slug, .. } if slug == "notes")),
            "an already-linked, in-place doc needs no create"
        );
    }

    #[test]
    fn reconcile_actions_create_for_remote_new() {
        let root = Path::new("/root");
        let server_docs = vec![("fresh".to_string(), PathBuf::from("dir/fresh.md"))];
        let local_links: Vec<(String, PathBuf)> = vec![];
        let known_synced = HashSet::new();
        let acts = reconcile_actions(root, &server_docs, &local_links, &known_synced, &[]);
        assert_eq!(
            acts,
            vec![InboundAction::Create { slug: "fresh".into(), dest: p(root, "dir/fresh.md") }]
        );
    }

    #[test]
    fn reconcile_actions_idempotent_on_converged_state() {
        // A fully converged tree: every server doc linked in place, none known-synced missing,
        // no empty folders → reconcile must produce zero actions, no matter how often it runs.
        let root = Path::new("/root");
        let server_docs = vec![
            ("a".to_string(), PathBuf::from("a.md")),
            ("b".to_string(), PathBuf::from("sub/b.md")),
        ];
        let local_links = vec![
            ("a".to_string(), p(root, "a.md")),
            ("b".to_string(), p(root, "sub/b.md")),
        ];
        let known_synced: HashSet<String> =
            ["a", "b"].iter().map(|s| s.to_string()).collect();
        let acts = reconcile_actions(root, &server_docs, &local_links, &known_synced, &[]);
        assert_eq!(acts, vec![], "a converged tree yields no actions");
    }

    #[test]
    fn reconcile_actions_renames_file_on_title_only_change() {
        // A doc's display title changed on the server (same folder — root here). The local file
        // still has the OLD title's stem, so reconcile must emit exactly one Move from the old
        // path to the new desired path, and no Create/Delete for that slug.
        let root = Path::new("/root");
        // Server's desired path is built from the NEW title via the real rule (not hardcoded).
        let new_rel = desired_rel_path(None, Some("Renamed Title"), "abc", &HashMap::new());
        assert_eq!(new_rel, PathBuf::from("Renamed Title.md"));
        let server_docs = vec![("abc".to_string(), new_rel)];
        // On disk the file is still named after the OLD title.
        let local_links = vec![("abc".to_string(), p(root, "Old Title.md"))];
        let known_synced: HashSet<String> = ["abc"].iter().map(|s| s.to_string()).collect();

        let acts = reconcile_actions(root, &server_docs, &local_links, &known_synced, &[]);

        assert!(acts.contains(&InboundAction::Move {
            slug: "abc".into(),
            from: p(root, "Old Title.md"),
            to: p(root, "Renamed Title.md"),
        }));
        assert!(
            !acts
                .iter()
                .any(|a| matches!(a, InboundAction::Create { slug, .. } if slug == "abc")),
            "a title-only rename is a move, never a create"
        );
        assert!(
            !acts
                .iter()
                .any(|a| matches!(a, InboundAction::Delete { slug, .. } if slug == "abc")),
            "a title-only rename is a move, never a delete"
        );
    }

    #[test]
    fn reconcile_actions_never_deletes_unpushed_even_when_absent() {
        // A local link that is NOT known-synced and absent on the server must never be deleted,
        // even when other docs are present. This is the data-loss guard.
        let root = Path::new("/root");
        let server_docs = vec![("kept".to_string(), PathBuf::from("kept.md"))];
        let local_links = vec![
            ("kept".to_string(), p(root, "kept.md")),
            ("pending".to_string(), p(root, "pending.md")),
        ];
        // Only "kept" is known-synced; "pending" was created locally, never pushed.
        let known_synced: HashSet<String> = ["kept"].iter().map(|s| s.to_string()).collect();
        let acts = reconcile_actions(root, &server_docs, &local_links, &known_synced, &[]);
        assert!(
            !acts.iter().any(|a| matches!(a, InboundAction::Delete { .. })),
            "a pending, never-synced local must never be deleted"
        );
    }

    #[test]
    fn desired_rel_path_builds_folder_chain_and_sanitizes() {
        let mut chain = HashMap::new();
        chain.insert("f2".to_string(), vec!["Top".to_string(), "Sub".to_string()]);
        assert_eq!(
            desired_rel_path(Some("f2"), Some("My Note"), "slug", &chain),
            PathBuf::from("Top/Sub/My Note.md")
        );
        // path-escaping title is neutralized: the result must not contain a ".." component.
        assert!(
            !desired_rel_path(None, Some("../evil"), "s", &HashMap::new())
                .to_string_lossy()
                .contains(".."),
            "a path-escaping title must be sanitized"
        );
        // empty title → slug
        assert_eq!(
            desired_rel_path(None, None, "fallback", &HashMap::new()),
            PathBuf::from("fallback.md")
        );
    }

    #[test]
    fn slug_rules() {
        assert_eq!(slug_from_rel_path(Path::new("notes.md"), None), "notes");
        assert_eq!(slug_from_rel_path(Path::new("sub/deep.md"), None), "sub-deep");
        assert_eq!(slug_from_rel_path(Path::new("a/b/c file.MD"), None), "a-b-c-file");
        assert_eq!(slug_from_rel_path(Path::new("Weird  Näme!!.md"), None), "weird-n-me");
        assert_eq!(slug_from_rel_path(Path::new("notes.md"), Some("Team Docs")), "team-docs-notes");
        assert_eq!(slug_from_rel_path(Path::new("---.md"), None), "untitled");
        assert_eq!(slug_from_rel_path(Path::new("---.md"), Some("p")), "p");
    }

    #[test]
    fn unique_slug_suffixes() {
        let taken: std::collections::HashSet<String> = ["a-b".into(), "a-b-2".into()].into();
        assert_eq!(unique_slug("a-b", &taken), "a-b-3");
        assert_eq!(unique_slug("fresh", &taken), "fresh");
    }

    #[test]
    fn trash_guard_only_trashes_pushed_docs() {
        // A doc with a prior server round-trip (last_synced set) → trash on local delete.
        assert!(should_trash_on_delete(Some("2026-06-24 12:00:00")));
        // A never-pushed local (no last_synced) → NEVER trash, even if workspace-tagged.
        assert!(!should_trash_on_delete(None));
        // No link row at all (find_link → None) → conservatively do NOT trash.
        let no_link: Option<String> = None;
        assert!(!should_trash_on_delete(no_link.as_deref()));
    }

    #[test]
    fn rebind_decision() {
        let candidates = vec![
            ("gone-match".to_string(), false, Some(42)),
            ("still-there".to_string(), true, Some(42)), // path exists → a copy, not a rename
            ("gone-other".to_string(), false, Some(7)),
            ("gone-unknown".to_string(), false, None),
        ];
        assert_eq!(rebind_candidate(42, &candidates), Some("gone-match".into()));
        assert_eq!(rebind_candidate(9, &candidates), None);

        // two byte-identical gone files → ambiguous → never guess
        let ambiguous = vec![
            ("one".to_string(), false, Some(42)),
            ("two".to_string(), false, Some(42)),
        ];
        assert_eq!(rebind_candidate(42, &ambiguous), None);
    }

    #[test]
    fn discovery_skips_hidden_and_vendor_dirs() {
        let root = std::env::temp_dir().join(format!("muesli-sync-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for d in ["sub", ".hidden", "node_modules/pkg", "target/debug", ".git"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        for f in [
            "top.md",
            "sub/deep.md",
            "sub/readme.txt",
            ".hidden/skip.md",
            ".dotfile.md",
            "node_modules/pkg/skip.md",
            "target/debug/skip.md",
            ".git/skip.md",
        ] {
            std::fs::write(root.join(f), "x").unwrap();
        }
        let root = root.canonicalize().unwrap();
        let found = discover_md_files(&root).unwrap();
        let rels: Vec<String> =
            found.iter().map(|p| p.strip_prefix(&root).unwrap().display().to_string()).collect();
        assert_eq!(rels, vec!["sub/deep.md", "top.md"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_keeps_one_handle_per_doc() {
        let mut idx = DocIndex::default();
        let a = PathBuf::from("/root/a.md");
        let b = PathBuf::from("/root/b.md");

        idx.bind("doc-x".into(), a.clone());
        assert_eq!(idx.path_of("doc-x"), Some(&a));
        assert_eq!(idx.doc_count(), 1);

        // rename a.md → b.md for the SAME doc: old path drops, doc stays, new path binds.
        idx.rebind("doc-x", &a, b.clone());
        assert_eq!(idx.path_of("doc-x"), Some(&b));
        assert_eq!(idx.doc_count(), 1, "a rename must not leave two entries for one doc");
        assert_eq!(idx.docs_for_path(&a), 0, "old path no longer maps");
        assert_eq!(idx.docs_for_path(&b), 1);

        // removing the file drops the doc entry entirely.
        idx.unbind(&b);
        assert_eq!(idx.path_of("doc-x"), None);
        assert_eq!(idx.doc_count(), 0);
    }

    #[test]
    fn attach_path_resolves_to_canonical_key() {
        let root = std::env::temp_dir().join(format!("muesli-attach-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/a.md"), "x").unwrap();
        let root = root.canonicalize().unwrap();
        let canonical = root.join("sub/a.md");
        // A path with a redundant component resolves to the same key.
        let messy = root.join("sub/../sub/a.md");
        assert_eq!(resolve_handle_key(&root, &messy), canonical);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn create_remote_doc_only_for_new_links_in_workspace_mode() {
        // workspace mode + a brand-new link → birth the doc in W (root or foldered alike)
        assert!(should_create_remote_doc(true, true));
        // workspace mode but a re-link / rename → the doc already exists server-side
        assert!(!should_create_remote_doc(true, false));
        // non-workspace mode (plain `muesli open`) → never create; the room does it lazily
        assert!(!should_create_remote_doc(false, true));
        assert!(!should_create_remote_doc(false, false));
    }
}
