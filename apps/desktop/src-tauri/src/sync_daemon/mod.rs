//! The embedded Tier-1 content-sync daemon: a Tauri-managed wrapper around
//! `muesli_cli::sync::run` for the active workspace folder (Plan 2). One daemon at a time;
//! switching workspaces stops the old and starts the new.

use std::path::PathBuf;
use std::sync::Mutex;

use muesli_cli::store;
use muesli_cli::sync::{self, DaemonState, DaemonStatus};
use muesli_core::events::WorkspaceEventEnvelope;
use serde::Serialize;
use tauri::{AppHandle, Emitter as _};
use tokio::sync::{mpsc, watch};

/// A snapshot of the daemon for the frontend StatusBar.
#[derive(Serialize, Clone, Default)]
pub struct DaemonStatusView {
    pub running: bool,
    pub dir: Option<String>,
    pub files: usize,
    pub last_activity: Option<String>,
    pub events: u64,
    pub error: Option<String>,
}

struct Running {
    dir: PathBuf,
    stop_tx: watch::Sender<bool>,
    status_rx: watch::Receiver<DaemonStatus>,
    control_tx: mpsc::UnboundedSender<muesli_cli::sync::DaemonControl>,
    // Held to keep the task attached while active; detached-on-drop when `Running` is dropped.
    _task: tauri::async_runtime::JoinHandle<()>,
}

/// Owns the single active daemon. Managed in Tauri state.
pub struct DaemonHandle {
    inner: Mutex<Option<Running>>,
}

impl DaemonHandle {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    /// Start (or restart) the daemon over `dir`. If a daemon is already running on the same
    /// canonical dir, this is a no-op; otherwise the existing daemon is stopped first.
    pub fn start(
        &self,
        app: AppHandle,
        dir: PathBuf,
        server: String,
        workspace_id: Option<String>,
    ) {
        let dir = dir.canonicalize().unwrap_or(dir);
        let mut guard = self.inner.lock().unwrap();
        if guard.as_ref().is_some_and(|r| r.dir == dir) {
            return; // already syncing this workspace
        }
        if let Some(prev) = guard.take() {
            let _ = prev.stop_tx.send(true);
            // Don't abort: stop_tx signals a clean (flushing) shutdown; dropping `prev`
            // detaches the handle so the task finishes flushing in the background.
        }
        let (stop_tx, stop_rx) = watch::channel(false);
        let (status_tx, status_rx) = watch::channel(DaemonStatus::default());
        let (control_tx, control_rx) = mpsc::unbounded_channel::<muesli_cli::sync::DaemonControl>();
        // Structure events: the daemon publishes WorkspaceEventEnvelopes here; the forwarder
        // task below drains them and re-emits as `workspace://structure` Tauri events for the
        // sidebar to refresh on (mirrors editor_bridge::spawn_forwarder for `editor://frame`).
        let (events_tx, events_rx) = mpsc::unbounded_channel::<WorkspaceEventEnvelope>();
        spawn_structure_forwarder(app, events_rx);
        let web = store::http_base(&server);
        let run_dir = dir.clone();
        let task = tauri::async_runtime::spawn(async move {
            if let Err(e) = sync::run(
                run_dir,
                server,
                None,
                web,
                false,
                stop_rx,
                status_tx,
                control_rx,
                workspace_id,
                Some(events_tx),
            )
            .await
            {
                // `tracing` is not a direct dep of this crate; stderr surfaces in the
                // `tauri dev` console (matches the clone module's error path).
                eprintln!("workspace sync daemon error: {e:#}");
            }
        });
        *guard = Some(Running {
            dir,
            stop_tx,
            status_rx,
            control_tx,
            _task: task,
        });
    }

    /// Request a clean (flushing) stop of the active daemon, if any.
    pub fn stop(&self) {
        if let Some(prev) = self.inner.lock().unwrap().take() {
            let _ = prev.stop_tx.send(true);
            // Don't abort: let it flush dirty replicas. The task ends on its own.
        }
    }

    /// Attach an editor bridge to the running daemon's session for `path`. No-op if not running.
    pub fn attach_editor(&self, path: PathBuf, bridge: muesli_cli::session::EditorBridge) {
        if let Some(r) = self.inner.lock().unwrap().as_ref() {
            let _ = r
                .control_tx
                .send(muesli_cli::sync::DaemonControl::Attach { path, bridge });
        }
    }

    /// Detach any editor from the running daemon's session for `path`. No-op if not running.
    pub fn detach_editor(&self, path: PathBuf) {
        if let Some(r) = self.inner.lock().unwrap().as_ref() {
            let _ = r
                .control_tx
                .send(muesli_cli::sync::DaemonControl::Detach { path });
        }
    }

    pub fn status(&self) -> DaemonStatusView {
        let guard = self.inner.lock().unwrap();
        let Some(r) = guard.as_ref() else {
            return DaemonStatusView::default();
        };
        let st = r.status_rx.borrow().clone();
        let error = match &st.state {
            DaemonState::Error(msg) => Some(msg.clone()),
            _ => None,
        };
        DaemonStatusView {
            running: !matches!(st.state, DaemonState::Stopped),
            dir: Some(r.dir.display().to_string()),
            files: st.files,
            last_activity: st.last_activity,
            events: st.events,
            error,
        }
    }
}

/// Drain the daemon's structure-event channel and re-emit each envelope to the frontend as a
/// `workspace://structure` Tauri event until the channel closes (daemon stop / restart).
/// Mirrors `editor_bridge::spawn_forwarder`'s `editor://frame` pump.
fn spawn_structure_forwarder(
    app: AppHandle,
    mut events_rx: mpsc::UnboundedReceiver<WorkspaceEventEnvelope>,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(envelope) = events_rx.recv().await {
            if let Err(e) = app.emit("workspace://structure", envelope) {
                eprintln!("sync_daemon: structure emit failed: {e}");
                break;
            }
        }
    });
}

impl Default for DaemonHandle {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_is_idle_before_start() {
        let h = DaemonHandle::new();
        let s = h.status();
        assert!(!s.running);
        assert_eq!(s.files, 0);
    }

    #[test]
    fn stop_when_idle_is_a_noop() {
        let h = DaemonHandle::new();
        h.stop(); // must not panic / must not require a running daemon
        assert!(!h.status().running);
    }

    #[test]
    fn start_signature_takes_app_handle_and_workspace_id() {
        let h = DaemonHandle::new();
        // Type-level assertion: `start` takes (AppHandle, PathBuf, String, Option<String>).
        let _f: fn(&DaemonHandle, tauri::AppHandle, std::path::PathBuf, String, Option<String>) =
            DaemonHandle::start;
        assert!(!h.status().running);
    }
}
