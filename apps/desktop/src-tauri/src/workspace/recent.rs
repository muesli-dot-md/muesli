use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentWorkspace {
    pub name: String,
    pub path: String,
    pub last_opened: u64,
}

fn recent_workspaces_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(config_dir.join("recent-workspaces.json"))
}

pub(crate) fn load_recents(app: &tauri::AppHandle) -> Vec<RecentWorkspace> {
    let path = match recent_workspaces_path(app) {
        Ok(p) => p,
        Err(_) => return vec![],
    };
    let data = match std::fs::read_to_string(&path) {
        Ok(d) => d,
        Err(_) => return vec![],
    };
    serde_json::from_str(&data).unwrap_or_default()
}

fn save_recents(app: &tauri::AppHandle, list: &[RecentWorkspace]) -> Result<(), String> {
    let path = recent_workspaces_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

/// Pure list-transform: dedupe by path, move to front, cap at 10.
/// Name is derived from the last path component.
pub fn upsert_recent(mut list: Vec<RecentWorkspace>, path: &str, now: u64) -> Vec<RecentWorkspace> {
    list.retain(|r| r.path != path);
    let name = Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
        .to_string();
    list.insert(
        0,
        RecentWorkspace {
            name,
            path: path.to_string(),
            last_opened: now,
        },
    );
    list.truncate(10);
    list
}

fn now_ms() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())
        .map(|d| d.as_millis() as u64)
}

/// Admit `path` as a known workspace root: upsert it into the recents list and
/// persist. This is the ONLY way a new, arbitrary root enters the recents
/// allowlist, and it must be reached only from a trusted (Rust-owned) origin —
/// the native folder picker ([`pick_workspace`]) or a Rust command that itself
/// produced the folder ([`crate::sync_cmd::prepare_clone_dir`],
/// [`crate::workspaces_cmd::relocate_workspace`]). Never call it with a path
/// that came straight from the webview.
pub(crate) fn admit_recent(
    app: &tauri::AppHandle,
    path: &str,
) -> Result<Vec<RecentWorkspace>, String> {
    let updated = upsert_recent(load_recents(app), path, now_ms()?);
    save_recents(app, &updated)?;
    Ok(updated)
}

/// Whether `path` is present in the recents allowlist. Pure, for unit testing
/// and for reuse by the combined recents∪registry membership check
/// ([`crate::workspaces_cmd::is_known_workspace`]).
pub(crate) fn require_admitted(list: &[RecentWorkspace], path: &str) -> Result<(), String> {
    if list.iter().any(|r| r.path == path) {
        Ok(())
    } else {
        Err(format!(
            "workspace not admitted: open it with the folder picker first: {path}"
        ))
    }
}

#[tauri::command]
pub fn list_recent_workspaces(app: tauri::AppHandle) -> Result<Vec<RecentWorkspace>, String> {
    Ok(load_recents(&app))
}

/// Open the native directory picker IN RUST and admit the chosen folder as a
/// workspace root, returning its path (or `None` if the user cancelled).
///
/// This is the trust boundary for opening a NEW workspace: the path is supplied
/// by the OS/user, never by a renderer argument, so a compromised webview cannot
/// point the active workspace root (and thus every "confined" note-IO command)
/// at an arbitrary location. Mirrors `export_file`'s Rust-owned save dialog.
#[tauri::command]
pub async fn pick_workspace(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let Some(file_path) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = file_path.into_path().map_err(|e| e.to_string())?;
    let path = path.to_string_lossy().into_owned();
    admit_recent(&app, &path)?;
    Ok(Some(path))
}

/// Re-touch (or re-admit) an already-KNOWN workspace root — one present in the
/// recents allowlist or the local registry — bumping its `last_opened`/moving it
/// to the front, and return the updated list. Rejects any path that is not a
/// known workspace: a new root can only become known through [`pick_workspace`]
/// or a Rust command that produced the folder, never a raw renderer path. This
/// is how switching to a workspace that has aged out of the 10-entry recents
/// still works — the registry keeps it known — without letting the renderer
/// widen the confinement anchor to an arbitrary location.
#[tauri::command]
pub fn add_recent_workspace(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<RecentWorkspace>, String> {
    if !crate::workspaces_cmd::is_known_workspace(&app, &path) {
        return Err(format!(
            "workspace not admitted: open it with the folder picker first: {path}"
        ));
    }
    admit_recent(&app, &path)
}

#[tauri::command]
pub fn set_last_workspace(app: tauri::AppHandle, path: String) -> Result<(), String> {
    if !crate::workspaces_cmd::is_known_workspace(&app, &path) {
        return Err(format!(
            "workspace not admitted: open it with the folder picker first: {path}"
        ));
    }
    admit_recent(&app, &path).map(|_| ())
}

#[tauri::command]
pub fn get_last_workspace(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let list = load_recents(&app);
    let last = list.into_iter().max_by_key(|r| r.last_opened);
    Ok(last.map(|r| r.path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_deduplicates() {
        let existing = vec![
            RecentWorkspace {
                name: "a".into(),
                path: "/a".into(),
                last_opened: 100,
            },
            RecentWorkspace {
                name: "b".into(),
                path: "/b".into(),
                last_opened: 200,
            },
        ];
        let result = upsert_recent(existing, "/a", 300);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].path, "/a");
        assert_eq!(result[0].last_opened, 300);
    }

    #[test]
    fn upsert_moves_to_front() {
        let existing = vec![
            RecentWorkspace {
                name: "a".into(),
                path: "/a".into(),
                last_opened: 100,
            },
            RecentWorkspace {
                name: "b".into(),
                path: "/b".into(),
                last_opened: 200,
            },
        ];
        let result = upsert_recent(existing, "/b", 300);
        assert_eq!(result[0].path, "/b");
        assert_eq!(result[1].path, "/a");
    }

    #[test]
    fn upsert_caps_at_10() {
        let existing: Vec<RecentWorkspace> = (0..10)
            .map(|i| RecentWorkspace {
                name: format!("v{i}"),
                path: format!("/v{i}"),
                last_opened: i as u64,
            })
            .collect();
        let result = upsert_recent(existing, "/new", 999);
        assert_eq!(result.len(), 10);
        assert_eq!(result[0].path, "/new");
    }

    #[test]
    fn upsert_derives_name_from_path() {
        let result = upsert_recent(vec![], "/home/user/my-workspace", 1);
        assert_eq!(result[0].name, "my-workspace");
    }

    /// Anchor integrity (the core BLOCKER regression): the renderer may only
    /// select a root ALREADY present in recents. An arbitrary new path — e.g.
    /// `/` to widen the confinement anchor — is refused, so set_last_workspace/
    /// add_recent_workspace cannot re-point the active workspace root.
    #[test]
    fn require_admitted_rejects_unknown_paths() {
        let known = vec![
            RecentWorkspace {
                name: "notes".into(),
                path: "/Users/me/notes".into(),
                last_opened: 1,
            },
            RecentWorkspace {
                name: "work".into(),
                path: "/Users/me/work".into(),
                last_opened: 2,
            },
        ];

        // A path not in the list (the attack: anchor := "/") is rejected.
        assert!(require_admitted(&known, "/").is_err());
        assert!(require_admitted(&known, "/Users/victim/Library").is_err());
        // Empty recents admits nothing.
        assert!(require_admitted(&[], "/Users/me/notes").is_err());
        // Switching among already-admitted roots stays allowed.
        assert!(require_admitted(&known, "/Users/me/notes").is_ok());
        assert!(require_admitted(&known, "/Users/me/work").is_ok());
    }
}
