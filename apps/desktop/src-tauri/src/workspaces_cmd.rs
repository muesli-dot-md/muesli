use crate::workspace::recent::{self, RecentWorkspace};
use crate::workspace_index::{self as idx, WorkspaceRecord};
use serde::Serialize;
use std::path::{Path, PathBuf};

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

// ---------------------------------------------------------------------------
// Admission: what counts as a KNOWN workspace root
// ---------------------------------------------------------------------------
//
// A path is a known/admitted workspace root iff it is in the recents allowlist
// OR the local registry. Both are populated only through Rust-owned origins: a
// path first becomes known via the native folder picker
// (`recent::pick_workspace`) or a Rust-produced folder (`prepare_clone_dir`,
// `relocate_workspace`), each of which admits to recents; the registry-write
// commands below then only re-affirm an already-known path (they are gated on
// this predicate). So the transitive closure of "known" roots is rooted in Rust
// and a raw renderer string can never enter it — the read commands and the open
// flow can trust "known workspace" as an admission source, and switching to a
// workspace that has aged out of the 10-entry recents still works because the
// registry keeps it known.

/// Pure membership test (recents ∪ registry). Exact-path match, mirroring how
/// the frontend passes back the same string it was given for a workspace.
pub(crate) fn is_known_workspace_in(
    recents: &[RecentWorkspace],
    registry: &[WorkspaceRecord],
    path: &str,
) -> bool {
    recent::require_admitted(recents, path).is_ok()
        || registry
            .iter()
            .any(|r| r.local_path.as_deref() == Some(path))
}

/// Whether `path` is a known/admitted workspace root, consulting the live
/// recents allowlist and local registry. A registry read failure degrades to
/// "recents only" (never widens admission).
pub(crate) fn is_known_workspace(app: &tauri::AppHandle, path: &str) -> bool {
    let recents = recent::load_recents(app);
    let registry = open()
        .ok()
        .and_then(|conn| idx::list_local(&conn).ok())
        .unwrap_or_default();
    is_known_workspace_in(&recents, &registry, path)
}

/// Gate a registry-write on admission: refuse to record a `local_path` that is
/// not already a known workspace root, so the registry can never be seeded with
/// a raw renderer path (which `is_known_workspace` would then trust).
fn require_known(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    if is_known_workspace(app, path) {
        Ok(())
    } else {
        Err(format!("refusing to register an unadmitted path: {path}"))
    }
}

/// The last remote-fetch error already reported, so the poll loop logs each
/// distinct failure once instead of every tick. Cleared on the next success.
static LAST_REMOTE_ERROR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn remote_fetch_failed(msg: &str) {
    let mut last = LAST_REMOTE_ERROR.lock().unwrap_or_else(|e| e.into_inner());
    if last.as_deref() != Some(msg) {
        eprintln!("remote fetch failed, degrading to local-only: {msg}");
        *last = Some(msg.to_string());
    }
}

fn remote_fetch_recovered() {
    let mut last = LAST_REMOTE_ERROR.lock().unwrap_or_else(|e| e.into_inner());
    *last = None;
}

#[tauri::command]
pub async fn list_workspaces_merged(server: Option<String>) -> Result<Vec<WorkspaceView>, String> {
    let conn = open()?;
    let local = idx::list_local(&conn).map_err(|e| e.to_string())?;
    let remote = match &server {
        Some(s) => match muesli_cli::store::load_token(s) {
            Some(token) => match muesli_cli::api::list_workspaces(s, &token).await {
                Ok(list) => {
                    remote_fetch_recovered();
                    list
                }
                Err(e) => {
                    // 401 = the stored token is stale (revoked, or the server's DB was
                    // reset): that's plain signed-out, which the identity UI already
                    // shows — not an error worth logging on every poll. Everything
                    // else (offline, DNS) logs once per distinct message, not per tick.
                    if !muesli_cli::api::is_unauthorized(&e) {
                        remote_fetch_failed(&format!("{e}"));
                    }
                    Vec::new()
                }
            },
            None => Vec::new(),
        },
        None => Vec::new(),
    };
    Ok(merge(local, remote, server.as_deref()))
}

#[tauri::command]
pub fn register_local_workspace(
    app: tauri::AppHandle,
    id: String,
    name: String,
    path: String,
) -> Result<(), String> {
    require_known(&app, &path)?;
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

/// Move a cloned workspace's folder under a new parent directory (mistake
/// recovery for a clone landed in the wrong place): fs::rename, rewrite every
/// link in the shared index to the new prefix, update the registry row. The
/// caller stops the daemon first if this workspace is the active one. Returns
/// the new root. Same-volume only — fs::rename does not cross filesystems, and
/// the error says to move the folder manually in that case.
/// Derive the local folder path of the workspace `id` from the registry. Pure,
/// so the id↔path binding is unit-testable. Errors if `id` is unknown or the row
/// has no local path.
fn local_path_for_id(records: &[WorkspaceRecord], id: &str) -> Result<String, String> {
    records
        .iter()
        .find(|r| r.id == id)
        .and_then(|r| r.local_path.clone())
        .ok_or_else(|| format!("unknown or non-local workspace: {id}"))
}

#[tauri::command]
pub async fn relocate_workspace(
    app: tauri::AppHandle,
    id: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    // Bind id → old_path via the registry: never trust a renderer-supplied
    // source path. Passing workspace X's id with A's path would otherwise move A
    // while repointing X's row (registry corruption), and an arbitrary path
    // would let a renderer relocate + read an existing directory it named.
    let old_path = {
        let conn = open()?;
        let records = idx::list_local(&conn).map_err(|e| e.to_string())?;
        local_path_for_id(&records, &id)?
    };
    // Defense in depth: the registered path must also be an admitted workspace.
    if !is_known_workspace(&app, &old_path) {
        return Err(format!(
            "refusing to relocate a directory that is not a known workspace: {old_path}"
        ));
    }

    // The destination parent is chosen by a native folder dialog opened IN RUST,
    // never supplied by the webview — so a renderer cannot move a workspace to a
    // location it chose (e.g. a login-persistence directory).
    let Some(new_parent) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let new_parent = new_parent.into_path().map_err(|e| e.to_string())?;

    let path = relocate_impl(&id, Path::new(&old_path), &new_parent)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("{e:#}"))?;
    // The moved folder is the Rust-produced new root; admit it so the reopen
    // that anchors note-IO confinement on it is authorized.
    recent::admit_recent(&app, &path)?;
    Ok(Some(path))
}

fn relocate_impl(id: &str, old_path: &Path, new_parent: &Path) -> anyhow::Result<PathBuf> {
    use anyhow::Context;
    let old_root = old_path
        .canonicalize()
        .context("the workspace folder does not exist")?;
    let name = old_root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("workspace")
        .to_string();
    let mut target = new_parent.join(&name);
    let mut i = 2u32;
    while target.exists() {
        anyhow::ensure!(
            i <= 100,
            "no free folder name for {name:?} under {}",
            new_parent.display()
        );
        target = new_parent.join(format!("{name}-{i}"));
        i += 1;
    }
    std::fs::rename(&old_root, &target).with_context(|| {
        format!(
            "moving {} to {} (a cross-volume move is not supported; move the folder manually,              then open it from the picker)",
            old_root.display(),
            target.display()
        )
    })?;
    muesli_cli::store::relocate_links(&old_root, &target).context("rewriting the link index")?;
    let conn = idx::open_index(&index_path()).context("opening the registry")?;
    idx::set_local_path(&conn, id, &target.to_string_lossy()).context("updating the registry")?;
    Ok(target)
}

#[tauri::command]
pub fn set_workspace_path(app: tauri::AppHandle, id: String, path: String) -> Result<(), String> {
    require_known(&app, &path)?;
    let conn = open()?;
    idx::set_local_path(&conn, &id, &path).map_err(|e| e.to_string())
}

/// Mark a server workspace as cloned to `path`. A cloud-only workspace has no
/// local row yet (it comes from the server list), so this must UPSERT the full
/// record — `set_workspace_path` would no-op against a non-existent row.
#[tauri::command]
pub fn register_cloned_workspace(
    app: tauri::AppHandle,
    id: String,
    server: String,
    name: String,
    path: String,
) -> Result<(), String> {
    require_known(&app, &path)?;
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
    app: tauri::AppHandle,
    old_id: String,
    server: String,
    name: String,
    path: String,
) -> Result<String, String> {
    // Promotion keeps the same folder; it must already be a known workspace.
    require_known(&app, &path)?;
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

    fn rec(path: &str) -> RecentWorkspace {
        RecentWorkspace {
            name: "w".into(),
            path: path.into(),
            last_opened: 1,
        }
    }
    fn reg(path: &str) -> WorkspaceRecord {
        WorkspaceRecord {
            id: path.into(),
            server: None,
            name: "w".into(),
            local_path: Some(path.into()),
            local_only: true,
        }
    }

    /// The admission source for the read commands and the open/switch flow.
    /// It must ACCEPT a workspace known via EITHER recents or the registry — so
    /// switching to a workspace that aged out of the 10-entry recents but is
    /// still registered works (B1) — and REJECT any path in neither, which is
    /// what blocks read/enumerate against arbitrary roots and the relocate
    /// old_path exfiltration (R3).
    #[test]
    fn is_known_workspace_accepts_recents_or_registry_only() {
        let recents = [rec("/Users/me/notes")];
        let registry = [reg("/Users/me/archive")];

        // Known via recents (the currently-active/recent workspace).
        assert!(is_known_workspace_in(
            &recents,
            &registry,
            "/Users/me/notes"
        ));
        // Known via the registry only — aged out of recents but still a real
        // workspace we can switch to.
        assert!(is_known_workspace_in(
            &recents,
            &registry,
            "/Users/me/archive"
        ));
        // Unknown arbitrary paths are refused: the read-command threat and the
        // relocate exfiltration both hinge on this rejection.
        assert!(!is_known_workspace_in(
            &recents,
            &registry,
            "/Users/victim/Documents/private-notes"
        ));
        assert!(!is_known_workspace_in(&recents, &registry, "/"));
        // Empty allowlists admit nothing.
        assert!(!is_known_workspace_in(&[], &[], "/Users/me/notes"));
    }

    /// relocate derives the source path FROM the workspace id (registry), so a
    /// renderer cannot pass one workspace's id with another's path (which would
    /// move A's folder while repointing X's row) — and an unknown id is refused
    /// outright rather than moving a renderer-named directory.
    #[test]
    fn local_path_for_id_binds_id_to_its_registered_path() {
        let records = [
            local("A", "A", Some("/Users/me/A"), None),
            local("X", "X", Some("/Users/me/X"), None),
            local("no-path", "np", None, Some("srv")),
        ];
        assert_eq!(local_path_for_id(&records, "A").unwrap(), "/Users/me/A");
        assert_eq!(local_path_for_id(&records, "X").unwrap(), "/Users/me/X");
        // Unknown id and a row without a local path are both refused.
        assert!(local_path_for_id(&records, "missing").is_err());
        assert!(local_path_for_id(&records, "no-path").is_err());
    }

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
