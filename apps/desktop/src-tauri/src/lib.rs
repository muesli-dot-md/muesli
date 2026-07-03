mod appearance;
pub mod audio;
mod auth;
mod clone;
mod collab;
mod commands;
mod editor_bridge;
mod output;
mod stt;
mod sync_cmd;
mod sync_daemon;
pub mod workspace;
pub mod workspace_index;
mod workspaces_cmd;

use commands::AppState;
#[cfg(target_os = "macos")]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Keychain consent gate (spec 2026-07-02): on macOS, close muesli_cli's
    // process-global keychain gate BEFORE the Tauri runtime — and therefore any
    // command — can run, so no frontend path can trigger the scary macOS
    // Keychain prompt ahead of user consent (worst case is the launch-time
    // has_token read). The frontend reopens the gate via the `keychain_consent`
    // command once consent is granted (or was granted on a previous launch —
    // the gate is process state, not persisted in Rust). Other platforms keep
    // the default (open): Windows Credential Manager doesn't prompt, Linux
    // varies, and the dialog doesn't exist there.
    #[cfg(target_os = "macos")]
    muesli_cli::store::set_keychain_enabled(false);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Seamless updates (spec 2026-07-02): updater checks/downloads/installs;
        // process provides relaunch() after install.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                let window = _app.get_webview_window("main").unwrap();
                apply_vibrancy(
                    &window,
                    NSVisualEffectMaterial::UnderWindowBackground,
                    None,
                    None,
                )
                .expect("apply_vibrancy failed");
            }
            Ok(())
        })
        .manage(AppState::default())
        .manage(sync_daemon::DaemonHandle::new())
        .manage(editor_bridge::EditorBridges::new())
        .invoke_handler(tauri::generate_handler![
            commands::transcription_supported,
            commands::platform_is_macos,
            commands::ensure_model,
            commands::warm_models,
            commands::start_capture,
            commands::stop_capture,
            commands::check_permissions,
            commands::reveal_output,
            workspace::read_workspace_tree,
            workspace::search::search_workspace,
            workspace::graph::build_link_graph,
            workspace::read_note,
            workspace::write_note,
            workspace::create_note,
            workspace::create_folder,
            workspace::rename_path,
            workspace::move_path,
            workspace::delete_path,
            workspace::stat_path,
            workspace::recent::list_recent_workspaces,
            workspace::recent::add_recent_workspace,
            workspace::recent::set_last_workspace,
            workspace::recent::get_last_workspace,
            auth::server_login,
            auth::server_logout,
            auth::current_identity,
            auth::has_token,
            auth::keychain_consent,
            collab::api_request,
            workspaces_cmd::list_workspaces_merged,
            workspaces_cmd::register_local_workspace,
            workspaces_cmd::set_workspace_path,
            workspaces_cmd::register_cloned_workspace,
            workspaces_cmd::create_remote_workspace,
            workspaces_cmd::promote_workspace,
            sync_cmd::clone_workspace,
            sync_cmd::start_workspace_sync,
            sync_cmd::stop_workspace_sync,
            sync_cmd::workspace_sync_status,
            sync_cmd::attach_editor,
            sync_cmd::detach_editor,
            sync_cmd::send_editor_frame,
            appearance::set_window_appearance,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
