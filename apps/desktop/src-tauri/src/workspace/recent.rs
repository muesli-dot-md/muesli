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

fn load_recents(app: &tauri::AppHandle) -> Vec<RecentWorkspace> {
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
    list.insert(0, RecentWorkspace { name, path: path.to_string(), last_opened: now });
    list.truncate(10);
    list
}

#[tauri::command]
pub fn list_recent_workspaces(app: tauri::AppHandle) -> Result<Vec<RecentWorkspace>, String> {
    Ok(load_recents(&app))
}

#[tauri::command]
pub fn add_recent_workspace(app: tauri::AppHandle, path: String) -> Result<Vec<RecentWorkspace>, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    let list = load_recents(&app);
    let updated = upsert_recent(list, &path, now);
    save_recents(&app, &updated)?;
    Ok(updated)
}

#[tauri::command]
pub fn set_last_workspace(app: tauri::AppHandle, path: String) -> Result<(), String> {
    // set_last_workspace calls add_recent_workspace logic (already updates last_opened)
    // but we do it separately so the command exists. We persist by calling add_recent_workspace internally.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    let list = load_recents(&app);
    let updated = upsert_recent(list, &path, now);
    save_recents(&app, &updated)
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
            RecentWorkspace { name: "a".into(), path: "/a".into(), last_opened: 100 },
            RecentWorkspace { name: "b".into(), path: "/b".into(), last_opened: 200 },
        ];
        let result = upsert_recent(existing, "/a", 300);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].path, "/a");
        assert_eq!(result[0].last_opened, 300);
    }

    #[test]
    fn upsert_moves_to_front() {
        let existing = vec![
            RecentWorkspace { name: "a".into(), path: "/a".into(), last_opened: 100 },
            RecentWorkspace { name: "b".into(), path: "/b".into(), last_opened: 200 },
        ];
        let result = upsert_recent(existing, "/b", 300);
        assert_eq!(result[0].path, "/b");
        assert_eq!(result[1].path, "/a");
    }

    #[test]
    fn upsert_caps_at_10() {
        let existing: Vec<RecentWorkspace> = (0..10)
            .map(|i| RecentWorkspace { name: format!("v{i}"), path: format!("/v{i}"), last_opened: i as u64 })
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
}
