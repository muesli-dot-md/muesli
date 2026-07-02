use crate::workspace_index::{self as idx, WorkspaceRecord};
use serde::Serialize;
use std::path::PathBuf;

/// Where the SQLite registry lives: <app-data>/Muesli/index.db.
pub fn index_path() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("Muesli").join("index.db")
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorkspaceView {
    pub id: String,
    pub server: Option<String>,
    pub name: String,
    pub local_path: Option<String>,
    pub local_only: bool,
    /// "local-only" | "cloud-only" | "cloned"
    pub state: String,
}

/// Merge the local registry with a server's workspace list into the three
/// picker states. A server workspace present locally (by id) with a path is
/// "cloned"; absent locally it is "cloud-only"; a record with no server is
/// "local-only".
pub fn merge(
    local: Vec<WorkspaceRecord>,
    remote: Vec<muesli_cli::api::WorkspaceInfo>,
    server: Option<&str>,
) -> Vec<WorkspaceView> {
    let mut out: Vec<WorkspaceView> = Vec::new();

    for rec in &local {
        if rec.server.is_none() {
            out.push(WorkspaceView {
                id: rec.id.clone(),
                server: None,
                name: rec.name.clone(),
                local_path: rec.local_path.clone(),
                local_only: true,
                state: "local-only".into(),
            });
        }
    }

    for r in &remote {
        let cloned = local
            .iter()
            .find(|l| l.id == r.id && l.local_path.is_some());
        out.push(WorkspaceView {
            id: r.id.clone(),
            server: server.map(|s| s.to_string()),
            name: r.name.clone(),
            local_path: cloned.and_then(|l| l.local_path.clone()),
            local_only: false,
            state: if cloned.is_some() {
                "cloned"
            } else {
                "cloud-only"
            }
            .into(),
        });
    }

    out
}

fn open() -> Result<rusqlite::Connection, String> {
    let path = index_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    idx::open_index(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_workspaces_merged(server: Option<String>) -> Result<Vec<WorkspaceView>, String> {
    let conn = open()?;
    let local = idx::list_local(&conn).map_err(|e| e.to_string())?;
    let remote = match &server {
        Some(s) => match muesli_cli::store::load_token(s) {
            Some(token) => muesli_cli::api::list_workspaces(s, &token)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("remote fetch failed, degrading to local-only: {e}");
                    Vec::new()
                }),
            None => Vec::new(),
        },
        None => Vec::new(),
    };
    Ok(merge(local, remote, server.as_deref()))
}

#[tauri::command]
pub fn register_local_workspace(id: String, name: String, path: String) -> Result<(), String> {
    let conn = open()?;
    idx::upsert_workspace(
        &conn,
        &WorkspaceRecord {
            id,
            server: None,
            name,
            local_path: Some(path),
            local_only: true,
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_workspace_path(id: String, path: String) -> Result<(), String> {
    let conn = open()?;
    idx::set_local_path(&conn, &id, &path).map_err(|e| e.to_string())
}

/// Mark a server workspace as cloned to `path`. A cloud-only workspace has no
/// local row yet (it comes from the server list), so this must UPSERT the full
/// record — `set_workspace_path` would no-op against a non-existent row.
#[tauri::command]
pub fn register_cloned_workspace(
    id: String,
    server: String,
    name: String,
    path: String,
) -> Result<(), String> {
    let conn = open()?;
    idx::upsert_workspace(
        &conn,
        &WorkspaceRecord {
            id,
            server: Some(server),
            name,
            local_path: Some(path),
            local_only: false,
        },
    )
    .map_err(|e| e.to_string())
}

/// Pure registry transition for promote: in ONE connection, drop the stale
/// local-only row (keyed by its path) and upsert the server-id'd cloned row.
/// Factored out (no network) so the swap is unit-testable.
fn promote_in_index(
    conn: &rusqlite::Connection,
    old_id: &str,
    rec: &WorkspaceRecord,
) -> rusqlite::Result<()> {
    idx::delete_workspace(conn, old_id)?;
    idx::upsert_workspace(conn, rec)?;
    Ok(())
}

/// Create an empty server workspace named `name` on `server`. Returns the server's
/// WorkspaceInfo. Does NOT touch the local registry or any path — the store calls
/// `register_cloned_workspace` next to record the local clone.
#[tauri::command]
pub async fn create_remote_workspace(
    server: String,
    name: String,
) -> Result<muesli_cli::api::WorkspaceInfo, String> {
    let token = muesli_cli::store::load_token(&server);
    muesli_cli::api::create_workspace(&server, token.as_deref(), &name)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Promote a LOCAL-ONLY workspace (`old_id`, currently keyed by its folder path) to a
/// shared one: create a server workspace `W`, then in ONE connection delete the stale
/// `id=old_id` local-only row and upsert the `id=W` cloned row pointing at `path`.
/// Returns the new server workspace id `W`. Deletes only a SQLite row (never a file).
#[tauri::command]
pub async fn promote_workspace(
    old_id: String,
    server: String,
    name: String,
    path: String,
) -> Result<String, String> {
    let token = muesli_cli::store::load_token(&server);
    let info = muesli_cli::api::create_workspace(&server, token.as_deref(), &name)
        .await
        .map_err(|e| format!("{e:#}"))?;
    let conn = open()?;
    promote_in_index(
        &conn,
        &old_id,
        &WorkspaceRecord {
            id: info.id.clone(),
            server: Some(server),
            name,
            local_path: Some(path),
            local_only: false,
        },
    )
    .map_err(|e| e.to_string())?;
    Ok(info.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use muesli_cli::api::WorkspaceInfo;

    #[test]
    fn promote_in_index_swaps_local_only_for_cloned_row() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE workspaces (id TEXT PRIMARY KEY, server TEXT, name TEXT NOT NULL,
             local_path TEXT, local_only INTEGER NOT NULL DEFAULT 0);",
        )
        .unwrap();
        // A pre-existing local-only row keyed by its path (id == path).
        idx::upsert_workspace(
            &conn,
            &WorkspaceRecord {
                id: "/Users/me/Notes".into(),
                server: None,
                name: "Notes".into(),
                local_path: Some("/Users/me/Notes".into()),
                local_only: true,
            },
        )
        .unwrap();

        // Promote: delete the stale id=path row, insert the server-id'd cloned row.
        let new_rec = WorkspaceRecord {
            id: "srv-w-42".into(),
            server: Some("ws://localhost:8787/ws".into()),
            name: "Notes".into(),
            local_path: Some("/Users/me/Notes".into()),
            local_only: false,
        };
        promote_in_index(&conn, "/Users/me/Notes", &new_rec).unwrap();

        // The phantom local-only row is gone; the cloned row is present.
        assert_eq!(idx::find_by_id(&conn, "/Users/me/Notes").unwrap(), None);
        assert_eq!(idx::find_by_id(&conn, "srv-w-42").unwrap(), Some(new_rec));
    }

    fn wi(id: &str, name: &str) -> WorkspaceInfo {
        WorkspaceInfo {
            id: id.into(),
            name: name.into(),
            role: "member".into(),
            is_personal: false,
            status: None,
        }
    }
    fn local(id: &str, name: &str, path: Option<&str>, server: Option<&str>) -> WorkspaceRecord {
        WorkspaceRecord {
            id: id.into(),
            server: server.map(Into::into),
            name: name.into(),
            local_path: path.map(Into::into),
            local_only: server.is_none(),
        }
    }

    #[test]
    fn classifies_three_states() {
        let local_recs = vec![
            local("loc", "My Notes", Some("/n"), None), // local-only
            local("w2", "Team A", Some("/t"), Some("https://s")), // cloned
        ];
        let remote = vec![wi("w2", "Team A"), wi("w3", "Team B")]; // w3 cloud-only
        let v = merge(local_recs, remote, Some("https://s"));

        let by = |id: &str| v.iter().find(|x| x.id == id).unwrap().state.clone();
        assert_eq!(by("loc"), "local-only");
        assert_eq!(by("w2"), "cloned");
        assert_eq!(by("w3"), "cloud-only");
        assert_eq!(
            v.iter()
                .find(|x| x.id == "w2")
                .unwrap()
                .local_path
                .as_deref(),
            Some("/t")
        );
        assert!(v
            .iter()
            .find(|x| x.id == "w3")
            .unwrap()
            .local_path
            .is_none());
    }
}
