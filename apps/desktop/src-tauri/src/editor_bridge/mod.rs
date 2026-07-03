//! Tier-2 (Plan 3) editor↔daemon IPC bridge state. Maps each open synced file to the
//! channel that carries editor→daemon y-protocols frames; the daemon→editor direction is
//! pumped by a per-attachment forwarder task that emits `editor://frame` Tauri events.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use muesli_cli::session::EditorBridge;
use serde::Serialize;
use tauri::{AppHandle, Emitter as _};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

/// Payload of an `editor://frame` event: which file, and one opaque y-protocols frame.
#[derive(Clone, Serialize)]
pub struct FramePayload {
    pub path: String,
    /// One frame, as a byte array (serde → JS number[]; the TauriProvider feeds it to y-protocols).
    pub frame: Vec<u8>,
}

/// Per-open-file editor channels. Holds the sender that `send_editor_frame` pushes into
/// (the `EditorBridge.inbound` producer end).
struct EditorChannels {
    to_daemon: UnboundedSender<Vec<u8>>,
}

/// Managed Tauri state: the set of currently-attached editors.
pub struct EditorBridges {
    map: Mutex<HashMap<PathBuf, EditorChannels>>,
}

impl EditorBridges {
    pub fn new() -> Self {
        Self { map: Mutex::new(HashMap::new()) }
    }

    /// Record the editor→daemon sender for `path`.
    pub fn register(&self, path: PathBuf, to_daemon: UnboundedSender<Vec<u8>>) {
        self.map.lock().unwrap().insert(path, EditorChannels { to_daemon });
    }

    /// The editor→daemon sender for `path`, if attached.
    pub fn sender_for(&self, path: &Path) -> Option<UnboundedSender<Vec<u8>>> {
        self.map.lock().unwrap().get(path).map(|c| c.to_daemon.clone())
    }

    /// Forget `path` (drops the sender; the daemon side sees its inbound channel close).
    pub fn remove(&self, path: &Path) {
        self.map.lock().unwrap().remove(path);
    }
}

impl Default for EditorBridges {
    fn default() -> Self {
        Self::new()
    }
}

/// Pump daemon→editor frames to the frontend as `editor://frame` events until the channel
/// closes (on detach / session end). Spawned per attachment on the Tauri async runtime.
pub fn spawn_forwarder(app: AppHandle, path: String, mut outbound_rx: UnboundedReceiver<Vec<u8>>) {
    tauri::async_runtime::spawn(async move {
        while let Some(frame) = outbound_rx.recv().await {
            if let Err(e) = app.emit("editor://frame", FramePayload { path: path.clone(), frame }) {
                eprintln!("editor_bridge: emit failed: {e}");
                break;
            }
        }
    });
}

/// Create a fresh editor bridge for `path`: register the editor→daemon sender, spawn the
/// daemon→editor forwarder, and return the muesli-cli-side `EditorBridge` to attach.
pub fn build_bridge(app: &AppHandle, bridges: &EditorBridges, path: &Path) -> EditorBridge {
    let (to_daemon_tx, inbound_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let (outbound_tx, outbound_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    bridges.register(path.to_path_buf(), to_daemon_tx);
    spawn_forwarder(app.clone(), path.to_string_lossy().to_string(), outbound_rx);
    EditorBridge { inbound: inbound_rx, outbound: outbound_tx }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn register_then_take_roundtrips_sender() {
        let bridges = EditorBridges::new();
        let p = PathBuf::from("/tmp/x.md");
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        bridges.register(p.clone(), tx);
        assert!(bridges.sender_for(&p).is_some(), "registered path resolves to a sender");
        bridges.remove(&p);
        assert!(bridges.sender_for(&p).is_none(), "removed path no longer resolves");
    }
}
