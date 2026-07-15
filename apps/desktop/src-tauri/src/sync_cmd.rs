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

/// Create the workspace's own subfolder under `parent` (the directory the user
/// picked) and return its path — the clone target. See clone::prepare_clone_dir.
#[tauri::command]
pub fn prepare_clone_dir(parent: String, name: String) -> Result<String, String> {
    crate::clone::prepare_clone_dir(&PathBuf::from(parent), &name)
        .map(|p| p.to_string_lossy().into_owned())
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
/// daemon to attach. Returns whether the bridge is LIVE — a linked session exists and has
/// synced this run — so the editor can seed from disk immediately instead of waiting out a
/// fallback timer when the answer is no. A slow daemon (reply timeout) reads as live: the
/// editor's timer still covers that case, and a false "dead" would needlessly sever a
/// working bridge.
#[tauri::command]
pub async fn attach_editor(
    app: AppHandle,
    path: String,
    daemon: State<'_, DaemonHandle>,
    bridges: State<'_, EditorBridges>,
) -> Result<bool, String> {
    let pb = PathBuf::from(&path);
    let bridge = editor_bridge::build_bridge(&app, &bridges, &pb);
    let live_rx = daemon.attach_editor(pb, bridge);
    let live = match tokio::time::timeout(std::time::Duration::from_millis(250), live_rx).await {
        Ok(Ok(live)) => live,
        Ok(Err(_)) => false, // daemon dropped the channel (stopping) — treat as dead
        Err(_) => true,      // timeout: optimistic; the editor's fallback timer guards
    };
    Ok(live)
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
        Some(tx) => tx
            .send(frame)
            .map_err(|_| "editor bridge closed".to_string()),
        None => Ok(()), // not attached (e.g. local-only file) — drop silently
    }
}
