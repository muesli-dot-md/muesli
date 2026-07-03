//! Tauri commands for the clone + Tier-1 daemon (Plan 2).

use std::path::PathBuf;

use tauri::{AppHandle, State};

use crate::clone::clone_workspace as do_clone;
use crate::editor_bridge::{self, EditorBridges};
use crate::sync_daemon::{DaemonHandle, DaemonStatusView};

/// Eager-clone a cloud workspace into `path` (the folder the user picked). Returns the count
/// of documents present locally after the clone.
#[tauri::command]
pub async fn clone_workspace(
    server: String,
    workspace_id: String,
    path: String,
) -> Result<usize, String> {
    do_clone(&server, &workspace_id, &PathBuf::from(path))
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Start (or switch to) the Tier-1 content-sync daemon over `path` for `workspace_id`
/// (None = legacy / personal-default; the daemon then targets the personal workspace).
#[tauri::command]
pub fn start_workspace_sync(
    app: AppHandle,
    server: String,
    path: String,
    workspace_id: Option<String>,
    daemon: State<'_, DaemonHandle>,
) -> Result<(), String> {
    daemon.start(app, PathBuf::from(path), server, workspace_id);
    Ok(())
}

/// Stop the active daemon (clean flush).
#[tauri::command]
pub fn stop_workspace_sync(daemon: State<'_, DaemonHandle>) -> Result<(), String> {
    daemon.stop();
    Ok(())
}

/// Current daemon status for the StatusBar.
#[tauri::command]
pub fn workspace_sync_status(daemon: State<'_, DaemonHandle>) -> DaemonStatusView {
    daemon.status()
}

/// Attach the open editor at `path` to the daemon's replica (Tier-2). Builds the IPC bridge,
/// registers the editor→daemon channel, spawns the daemon→editor forwarder, and tells the
/// daemon to attach. Returns Ok even if the daemon isn't running (the attach is a no-op then).
#[tauri::command]
pub fn attach_editor(
    app: AppHandle,
    path: String,
    daemon: State<'_, DaemonHandle>,
    bridges: State<'_, EditorBridges>,
) -> Result<(), String> {
    let pb = PathBuf::from(&path);
    let bridge = editor_bridge::build_bridge(&app, &bridges, &pb);
    daemon.attach_editor(pb, bridge);
    Ok(())
}

/// Detach the editor at `path`: tell the daemon to drop the bridge and forget our channels.
#[tauri::command]
pub fn detach_editor(
    path: String,
    daemon: State<'_, DaemonHandle>,
    bridges: State<'_, EditorBridges>,
) -> Result<(), String> {
    let pb = PathBuf::from(&path);
    daemon.detach_editor(pb.clone());
    bridges.remove(&pb);
    Ok(())
}

/// Forward one y-protocols frame from the JS provider into the daemon's session for `path`.
#[tauri::command]
pub fn send_editor_frame(
    path: String,
    frame: Vec<u8>,
    bridges: State<'_, EditorBridges>,
) -> Result<(), String> {
    let pb = PathBuf::from(&path);
    match bridges.sender_for(&pb) {
        Some(tx) => tx.send(frame).map_err(|_| "editor bridge closed".to_string()),
        None => Ok(()), // not attached (e.g. local-only file) — drop silently
    }
}
