# Plan 1: Workspaces & Auth Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename "vault" → "workspace" throughout demo_muesli, add device-code login to a muesli-server (token in the macOS Keychain), a local SQLite workspace registry, and a workspace picker that lists local-only · cloud-only · cloned workspaces and can open/create local ones. No remote file sync yet (that is Plan 2).

**Architecture:** demo_muesli's Tauri (Rust) backend path-depends on the existing `muesli-core` and `muesli-cli` library crates in `~/Code/muesli`, reusing `muesli_cli::api` (device flow, `/api/me`) and `muesli_cli::store` (Keychain token store, URL normalization). A new `workspace_index` SQLite module holds the workspace registry. New Tauri commands expose auth + the registry to the Svelte frontend, which gains a `workspaces` runes store, a `WorkspacePicker` component, and server login UI in Settings.

**Tech Stack:** Tauri 2, SvelteKit + Svelte 5 runes, DaisyUI v5 / Tailwind v4, Rust, `rusqlite` (bundled SQLite), `muesli-core` + `muesli_cli` (path deps), `keyring` (transitively, via `muesli_cli::store`).

## Global Constraints

- **Sibling repo path:** the muesli repo is at `/Users/julianbeaulieu/Code/muesli`; demo_muesli is at `/Users/julianbeaulieu/Code/demo_muesli`. Path deps from `src-tauri/` use `../../muesli/crates/<crate>`.
- **Terminology:** "workspace" replaces "vault" in ALL product language, identifiers, Rust module/command names, and UI copy. The only allowed remaining "vault" strings after this plan are inside `~/Code/muesli` (not ours) and historical spec text.
- **Branch:** `feat/auth-remote-workspaces`. Commit messages are clean conventional commits (`feat:`, `refactor:`, `test:`) with **NO** `Co-Authored-By` / AI-attribution / `Claude-Session` trailers.
- **Token store reuse:** logging in via the app writes the **same** Keychain entry the CLI uses (`keyring` service `"muesli"`, account = `http_base(server)`), so the app and `muesli` CLI share one login.
- **`pnpm check` must stay at 0 errors.** The 2 pre-existing VaultPicker a11y warnings are acceptable and are removed by the rename (VaultPicker → WorkspacePicker) anyway.
- **Server-in-scope:** Task 2 adds a `list_workspaces` helper to `~/Code/muesli/crates/muesli-cli/src/api.rs`. That repo has its own tests/build; run `cargo test -p muesli_cli` there after editing.
- **macOS only** for now (Keychain + vibrancy); no cross-platform branches required.

---

### Task 1: Path dependencies + `workspace_index` SQLite module

**Files:**
- Modify: `src-tauri/Cargo.toml` (`[dependencies]`)
- Create: `src-tauri/src/workspace_index/mod.rs`
- Modify: `src-tauri/src/lib.rs:1-5` (add `mod workspace_index;`)

**Interfaces:**
- Produces:
  - `struct WorkspaceRecord { id: String, server: Option<String>, name: String, local_path: Option<String>, local_only: bool }` (serde `Serialize`/`Deserialize`)
  - `fn open_index(db_path: &std::path::Path) -> rusqlite::Result<rusqlite::Connection>` — opens + migrates.
  - `fn upsert_workspace(conn: &Connection, rec: &WorkspaceRecord) -> rusqlite::Result<()>`
  - `fn list_local(conn: &Connection) -> rusqlite::Result<Vec<WorkspaceRecord>>`
  - `fn set_local_path(conn: &Connection, id: &str, path: &str) -> rusqlite::Result<()>`
  - `fn find_by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<WorkspaceRecord>>`

- [ ] **Step 1: Add dependencies**

In `src-tauri/Cargo.toml` under `[dependencies]`, add:

```toml
muesli-core = { path = "../../muesli/crates/muesli-core" }
muesli-cli = { package = "muesli_cli", path = "../../muesli/crates/muesli-cli" }
rusqlite = { version = "0.32", features = ["bundled"] }
dirs = "5"
```

- [ ] **Step 2: Write the failing test**

Create `src-tauri/src/workspace_index/mod.rs`:

```rust
use rusqlite::{Connection, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// A row in the local workspace registry. `server`/`local_path` are NULL for
/// the states they don't apply to:
///   local-only  → server = None, local_path = Some, local_only = true
///   cloned      → server = Some, local_path = Some, local_only = false
/// (cloud-only workspaces are NOT stored here — they come from the server list
///  at runtime and are merged in the frontend.)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceRecord {
    pub id: String,
    pub server: Option<String>,
    pub name: String,
    pub local_path: Option<String>,
    pub local_only: bool,
}

pub fn open_index(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workspaces (
            id          TEXT PRIMARY KEY,
            server      TEXT,
            name        TEXT NOT NULL,
            local_path  TEXT,
            local_only  INTEGER NOT NULL DEFAULT 0
        );",
    )?;
    Ok(conn)
}

pub fn upsert_workspace(conn: &Connection, rec: &WorkspaceRecord) -> Result<()> {
    conn.execute(
        "INSERT INTO workspaces (id, server, name, local_path, local_only)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
            server = excluded.server,
            name = excluded.name,
            local_path = excluded.local_path,
            local_only = excluded.local_only;",
        rusqlite::params![rec.id, rec.server, rec.name, rec.local_path, rec.local_only as i64],
    )?;
    Ok(())
}

pub fn list_local(conn: &Connection) -> Result<Vec<WorkspaceRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, server, name, local_path, local_only FROM workspaces ORDER BY name;",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(WorkspaceRecord {
            id: r.get(0)?,
            server: r.get(1)?,
            name: r.get(2)?,
            local_path: r.get(3)?,
            local_only: r.get::<_, i64>(4)? != 0,
        })
    })?;
    rows.collect()
}

pub fn set_local_path(conn: &Connection, id: &str, path: &str) -> Result<()> {
    conn.execute(
        "UPDATE workspaces SET local_path = ?2 WHERE id = ?1;",
        rusqlite::params![id, path],
    )?;
    Ok(())
}

pub fn find_by_id(conn: &Connection, id: &str) -> Result<Option<WorkspaceRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, server, name, local_path, local_only FROM workspaces WHERE id = ?1;",
    )?;
    let mut rows = stmt.query_map(rusqlite::params![id], |r| {
        Ok(WorkspaceRecord {
            id: r.get(0)?,
            server: r.get(1)?,
            name: r.get(2)?,
            local_path: r.get(3)?,
            local_only: r.get::<_, i64>(4)? != 0,
        })
    })?;
    rows.next().transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE workspaces (id TEXT PRIMARY KEY, server TEXT, name TEXT NOT NULL,
             local_path TEXT, local_only INTEGER NOT NULL DEFAULT 0);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn upsert_then_list_roundtrips() {
        let conn = mem();
        let rec = WorkspaceRecord {
            id: "w1".into(),
            server: None,
            name: "Notes".into(),
            local_path: Some("/Users/me/Notes".into()),
            local_only: true,
        };
        upsert_workspace(&conn, &rec).unwrap();
        assert_eq!(list_local(&conn).unwrap(), vec![rec]);
    }

    #[test]
    fn upsert_updates_existing_row() {
        let conn = mem();
        let mut rec = WorkspaceRecord {
            id: "w1".into(),
            server: Some("https://s".into()),
            name: "Team".into(),
            local_path: None,
            local_only: false,
        };
        upsert_workspace(&conn, &rec).unwrap();
        set_local_path(&conn, "w1", "/Users/me/Team").unwrap();
        rec.local_path = Some("/Users/me/Team".into());
        assert_eq!(find_by_id(&conn, "w1").unwrap(), Some(rec));
    }
}
```

Add `pub mod workspace_index;` to `src-tauri/src/lib.rs` after the existing `pub mod vault;` line (line 5).

- [ ] **Step 3: Run the test to verify it fails, then passes**

Run: `cd src-tauri && cargo test workspace_index`
Expected: compiles after deps resolve; both tests PASS. (If `muesli-core`/`muesli-cli` path deps fail to resolve, confirm `~/Code/muesli` exists and `cargo build -p muesli-core` works there.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/workspace_index/mod.rs src-tauri/src/lib.rs
git commit -m "feat(workspace): add muesli path deps + SQLite workspace registry"
```

---

### Task 2: Add `list_workspaces` helper to `muesli_cli::api` (upstream)

**Files:**
- Modify: `/Users/julianbeaulieu/Code/muesli/crates/muesli-cli/src/api.rs` (append a helper + struct near the other `pub async fn`s, after `me()` ~line 162)

**Interfaces:**
- Produces (in `muesli_cli::api`):
  - `struct WorkspaceInfo { id: String, name: String, role: String, is_personal: bool }` (serde `Deserialize`, `Serialize`, `Clone`)
  - `async fn list_workspaces(server: &str, token: &str) -> anyhow::Result<Vec<WorkspaceInfo>>`

The server route `GET /api/workspaces` returns `{ "workspaces": [{ "id", "name", "role", "is_personal" }] }` (verified in `muesli-server/src/workspace.rs:119-141`).

- [ ] **Step 1: Write the failing test**

Append to `crates/muesli-cli/src/api.rs`:

```rust
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    pub role: String,
    pub is_personal: bool,
}

#[derive(serde::Deserialize)]
struct WorkspacesEnvelope {
    workspaces: Vec<WorkspaceInfo>,
}

/// List the workspaces the authenticated caller belongs to.
/// `GET {server}/api/workspaces` → `{ workspaces: [...] }`.
pub async fn list_workspaces(server: &str, token: &str) -> anyhow::Result<Vec<WorkspaceInfo>> {
    let url = format!("{}/api/workspaces", crate::store::http_base(server));
    let env: WorkspacesEnvelope = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(env.workspaces)
}

#[cfg(test)]
mod workspace_list_tests {
    use super::WorkspacesEnvelope;

    #[test]
    fn parses_workspaces_envelope() {
        let json = r#"{"workspaces":[
            {"id":"w1","name":"Personal","role":"admin","is_personal":true},
            {"id":"w2","name":"Team A","role":"member","is_personal":false}
        ]}"#;
        let env: WorkspacesEnvelope = serde_json::from_str(json).unwrap();
        assert_eq!(env.workspaces.len(), 2);
        assert_eq!(env.workspaces[0].name, "Personal");
        assert!(env.workspaces[0].is_personal);
        assert_eq!(env.workspaces[1].role, "member");
    }
}
```

- [ ] **Step 2: Run the test**

Run: `cd /Users/julianbeaulieu/Code/muesli && cargo test -p muesli_cli workspace_list`
Expected: PASS. (`serde_json` is already a dependency of the crate.)

- [ ] **Step 3: Commit (in the muesli repo)**

```bash
cd /Users/julianbeaulieu/Code/muesli
git add crates/muesli-cli/src/api.rs
git commit -m "feat(cli-api): add list_workspaces helper for GET /api/workspaces"
```

---

### Task 3: Auth Tauri commands (`server_login`, `server_logout`, `current_identity`)

**Files:**
- Create: `src-tauri/src/auth/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod auth;` and register the three commands in `invoke_handler`)

**Interfaces:**
- Consumes: `muesli_cli::api::{auth_config, device_flow, cli_login, me}`, `muesli_cli::store::{http_base, save_token, load_token, delete_token}`.
- Produces (Tauri commands, async):
  - `server_login(server: String) -> Result<Identity, String>` — runs the device flow, stores the token, returns identity.
  - `server_logout(server: String) -> Result<(), String>`
  - `current_identity(server: String) -> Result<Option<Identity>, String>` — uses a stored token if present.
  - `struct Identity { server: String, display_name: Option<String>, email: Option<String>, avatar_url: Option<String>, mode: String }` (serde `Serialize`).

- [ ] **Step 1: Implement the module**

Create `src-tauri/src/auth/mod.rs`:

```rust
//! Server auth for demo_muesli. Reuses muesli_cli's device-code flow and OS
//! Keychain token store, so logging in here is the same login the `muesli` CLI
//! uses (keyring service "muesli", account = http_base(server)).
use muesli_cli::{api, store};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Identity {
    pub server: String,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    /// "open" or "oidc" — from GET /api/me.
    pub mode: String,
}

fn label() -> String {
    let host = hostname();
    format!("demo_muesli@{host}")
}

fn hostname() -> String {
    std::env::var("HOST")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "mac".to_string())
}

async fn identity_from_me(server: &str, token: Option<&str>) -> Result<Identity, String> {
    let me = api::me(server, token).await.map_err(|e| e.to_string())?;
    let user = me.user;
    Ok(Identity {
        server: store::http_base(server),
        display_name: user.as_ref().and_then(|u| u.display_name.clone()),
        email: user.as_ref().and_then(|u| u.email.clone()),
        avatar_url: user.as_ref().and_then(|u| u.avatar_url.clone()),
        mode: me.mode,
    })
}

#[tauri::command]
pub async fn server_login(server: String) -> Result<Identity, String> {
    let cfg = api::auth_config(&server).await.map_err(|e| e.to_string())?;
    if cfg.mode == "open" {
        // Open-mode server: no sign-in. Identity is anonymous; no token to store.
        return identity_from_me(&server, None).await;
    }
    let issuer = cfg
        .issuer
        .ok_or_else(|| "server is in oidc mode but returned no issuer".to_string())?;
    let client_id = cfg
        .cli_client_id
        .ok_or_else(|| "server returned no cli_client_id".to_string())?;
    // Opens the system browser to the issuer's device page and polls for the
    // id_token. Blocks until the user approves (or the device code expires).
    let id_token = api::device_flow(&issuer, &client_id)
        .await
        .map_err(|e| e.to_string())?;
    let resp = api::cli_login(&server, &id_token, &label())
        .await
        .map_err(|e| e.to_string())?;
    store::save_token(&server, &resp.token).map_err(|e| e.to_string())?;
    identity_from_me(&server, Some(&resp.token)).await
}

#[tauri::command]
pub async fn server_logout(server: String) -> Result<(), String> {
    store::delete_token(&server).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn current_identity(server: String) -> Result<Option<Identity>, String> {
    match store::load_token(&server) {
        Some(token) => Ok(Some(identity_from_me(&server, Some(&token)).await?)),
        None => {
            // No token: still report mode so the UI can show "open" servers as
            // usable without login.
            let cfg = api::auth_config(&server).await.map_err(|e| e.to_string())?;
            if cfg.mode == "open" {
                Ok(Some(identity_from_me(&server, None).await?))
            } else {
                Ok(None)
            }
        }
    }
}
```

Register in `src-tauri/src/lib.rs`: add `mod auth;` near the other `mod` lines, and add to `invoke_handler![ ... ]`:

```rust
            auth::server_login,
            auth::server_logout,
            auth::current_identity,
```

- [ ] **Step 2: Build check**

Run: `cd src-tauri && cargo build`
Expected: compiles. (No unit test here — the flow needs a live/mocked OIDC server; it's exercised in Task 12's manual verification. `MeResponse.user` is `Option<MeUser>` with `display_name`/`email`/`avatar_url` per `muesli_cli::api`.)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/auth/mod.rs src-tauri/src/lib.rs
git commit -m "feat(auth): device-code server login + Keychain token via muesli_cli"
```

---

### Task 4: Workspace-list command (merge server list + local registry)

**Files:**
- Create: `src-tauri/src/workspaces_cmd.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod workspaces_cmd;`, register commands, extend `AppState` for the index path)

**Interfaces:**
- Consumes: `workspace_index::*`, `muesli_cli::api::list_workspaces`, `muesli_cli::store::load_token`.
- Produces (Tauri commands):
  - `list_workspaces_merged(server: Option<String>) -> Result<Vec<WorkspaceView>, String>`
  - `register_local_workspace(id: String, name: String, path: String) -> Result<(), String>`
  - `set_workspace_path(id: String, path: String) -> Result<(), String>`
  - `struct WorkspaceView { id, server: Option<String>, name, local_path: Option<String>, local_only: bool, state: String }` where `state` ∈ `"local-only" | "cloud-only" | "cloned"`.

- [ ] **Step 1: Implement with the merge logic + test**

Create `src-tauri/src/workspaces_cmd.rs`:

```rust
use crate::workspace_index::{self as idx, WorkspaceRecord};
use serde::Serialize;
use std::path::PathBuf;

/// Where the SQLite registry lives: <app-data>/demo_muesli/index.db.
pub fn index_path() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("demo_muesli").join("index.db")
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
            state: if cloned.is_some() { "cloned" } else { "cloud-only" }.into(),
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
pub async fn list_workspaces_merged(
    server: Option<String>,
) -> Result<Vec<WorkspaceView>, String> {
    let conn = open()?;
    let local = idx::list_local(&conn).map_err(|e| e.to_string())?;
    let remote = match &server {
        Some(s) => match muesli_cli::store::load_token(s) {
            Some(token) => muesli_cli::api::list_workspaces(s, &token)
                .await
                .map_err(|e| e.to_string())?,
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
        &WorkspaceRecord { id, server: None, name, local_path: Some(path), local_only: true },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_workspace_path(id: String, path: String) -> Result<(), String> {
    let conn = open()?;
    idx::set_local_path(&conn, &id, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use muesli_cli::api::WorkspaceInfo;

    fn wi(id: &str, name: &str) -> WorkspaceInfo {
        WorkspaceInfo { id: id.into(), name: name.into(), role: "member".into(), is_personal: false }
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
            local("loc", "My Notes", Some("/n"), None),          // local-only
            local("w2", "Team A", Some("/t"), Some("https://s")), // cloned
        ];
        let remote = vec![wi("w2", "Team A"), wi("w3", "Team B")]; // w3 cloud-only
        let v = merge(local_recs, remote, Some("https://s"));

        let by = |id: &str| v.iter().find(|x| x.id == id).unwrap().state.clone();
        assert_eq!(by("loc"), "local-only");
        assert_eq!(by("w2"), "cloned");
        assert_eq!(by("w3"), "cloud-only");
        assert_eq!(v.iter().find(|x| x.id == "w2").unwrap().local_path.as_deref(), Some("/t"));
        assert!(v.iter().find(|x| x.id == "w3").unwrap().local_path.is_none());
    }
}
```

Register in `lib.rs`: `mod workspaces_cmd;` + add `workspaces_cmd::list_workspaces_merged`, `workspaces_cmd::register_local_workspace`, `workspaces_cmd::set_workspace_path` to `invoke_handler!`.

- [ ] **Step 2: Run the test**

Run: `cd src-tauri && cargo test workspaces_cmd`
Expected: `classifies_three_states` PASSES.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/workspaces_cmd.rs src-tauri/src/lib.rs
git commit -m "feat(workspace): merge server list + local registry into picker states"
```

---

### Task 5: Rename backend `vault` → `workspace`

**Files (rename + edit):**
- Rename dir: `src-tauri/src/vault/` → `src-tauri/src/workspace/`
- Modify: `src-tauri/src/lib.rs`, `src/lib/tauri.ts` (frontend invoke names — done in Task 6)

**Interfaces:**
- Produces: renamed Tauri commands consumed by the frontend in Task 6.

Command-name mapping (Rust `#[tauri::command]` fn names AND the `invoke_handler!` entries):

| Old | New |
| --- | --- |
| `read_vault_tree` | `read_workspace_tree` |
| `search_vault` | `search_workspace` |
| `list_recent_vaults` | `list_recent_workspaces` |
| `add_recent_vault` | `add_recent_workspace` |
| `set_last_vault` | `set_last_workspace` |
| `get_last_vault` | `get_last_workspace` |

(`read_note`, `write_note`, `create_note`, `create_folder`, `rename_path`, `move_path`, `delete_path` keep their names — they're note/path ops, not "vault".)

- [ ] **Step 1: Rename the module directory**

```bash
git mv src-tauri/src/vault src-tauri/src/workspace
```

- [ ] **Step 2: Update module declaration + handler registration**

In `src-tauri/src/lib.rs`: change `pub mod vault;` → `pub mod workspace;`, and in `invoke_handler!` replace each `vault::...` path and the six command names per the table above. Example final block for these entries:

```rust
            workspace::read_workspace_tree,
            workspace::search::search_workspace,
            workspace::read_note,
            workspace::write_note,
            workspace::create_note,
            workspace::create_folder,
            workspace::rename_path,
            workspace::move_path,
            workspace::delete_path,
            workspace::recent::list_recent_workspaces,
            workspace::recent::add_recent_workspace,
            workspace::recent::set_last_workspace,
            workspace::recent::get_last_workspace,
```

- [ ] **Step 3: Rename the command fns + any internal `vault` identifiers**

In `src-tauri/src/workspace/mod.rs`, `recent.rs`, `search.rs`, `tree.rs`: rename the six `#[tauri::command]` fns per the table, and rename any internal symbols/types containing `vault` (e.g. `VaultNode` → `WorkspaceNode`, `RecentVault` → `RecentWorkspace`, `recent_vaults.json` storage filename → `recent_workspaces.json`). Update all references within the module.

Find remaining backend occurrences to fix:

```bash
grep -rni "vault" src-tauri/src
```

Expected after edits: no matches (or only in comments you choose to keep accurate).

- [ ] **Step 4: Build**

Run: `cd src-tauri && cargo build`
Expected: compiles with no `vault` references.

- [ ] **Step 5: Commit**

```bash
git add -A src-tauri/src
git commit -m "refactor(workspace): rename vault module + commands to workspace"
```

---

### Task 6: Rename frontend `vault` → `workspace` + update invoke names

**Files:**
- Rename: `src/lib/vault.svelte.ts` → `src/lib/workspace.svelte.ts`
- Rename: `src/lib/FileTree.svelte` stays; `src/lib/VaultPicker.svelte` → `src/lib/WorkspacePicker.svelte` (recreated in Task 10 — for now just rename + fix imports)
- Modify: `src/lib/tauri.ts`, `src/lib/AppShell.svelte`, `src/lib/TreeNode.svelte`, `src/lib/FileTree.svelte`, and any importer of the store.

**Interfaces:**
- Consumes: the renamed Tauri commands from Task 5.
- Produces: `workspace` store (was `vault`), consumed by AppShell/TreeNode/picker.

- [ ] **Step 1: Rename the store file + class**

```bash
git mv src/lib/vault.svelte.ts src/lib/workspace.svelte.ts
```

In `src/lib/workspace.svelte.ts`: rename `class VaultStore` → `class WorkspaceStore`, `export const vault` → `export const workspace`, and the methods `openVault` → `openWorkspace`, `loadRecents` stays. Update the type imports (`VaultNode` → `WorkspaceNode`, `RecentVault` → `RecentWorkspace`) and the `readVaultTree`/recent function imports to their renamed forms (next step).

- [ ] **Step 2: Update `tauri.ts` wrappers**

In `src/lib/tauri.ts`: rename the TS interfaces `VaultNode` → `WorkspaceNode`, `RecentVault` → `RecentWorkspace`, and the wrapper consts + their `invoke(...)` strings:

```ts
export const readWorkspaceTree = (root: string): Promise<WorkspaceNode> =>
  invoke("read_workspace_tree", { root });
export const searchWorkspace = (root: string, query: string): Promise<SearchHit[]> =>
  invoke("search_workspace", { root, query });
export const listRecentWorkspaces = (): Promise<RecentWorkspace[]> =>
  invoke("list_recent_workspaces");
export const addRecentWorkspace = (path: string): Promise<RecentWorkspace[]> =>
  invoke("add_recent_workspace", { path });
export const setLastWorkspace = (path: string): Promise<void> =>
  invoke("set_last_workspace", { path });
export const getLastWorkspace = (): Promise<string | null> =>
  invoke("get_last_workspace");
```

(Keep `readNote`/`writeNote`/`createNote`/`createFolder`/`renamePath`/`movePath`/`deletePath`/`pickFolder` unchanged.)

- [ ] **Step 3: Sweep the rest of the frontend**

```bash
grep -rni "vault" src --include=*.svelte --include=*.ts
```

Update every match: imports of `{ vault }` → `{ workspace }`, `vault.xxx` → `workspace.xxx`, UI copy ("Open Vault" → "Open Workspace", "Recent Vaults" → "Recent Workspaces", etc.), and rename `src/lib/VaultPicker.svelte` → `src/lib/WorkspacePicker.svelte` with its component imports. The two pre-existing VaultPicker a11y warnings disappear with this file's rebuild in Task 10; if VaultPicker had `<!-- svelte-ignore -->` comments, carry them over.

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: 0 errors (warnings only if any remain pre-existing; the 2 VaultPicker ones are gone or moved to WorkspacePicker).

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "refactor(workspace): rename vault store/components/copy to workspace"
```

---

### Task 7: Frontend `tauri.ts` wrappers for auth + workspace-index commands

**Files:**
- Modify: `src/lib/tauri.ts`

**Interfaces:**
- Produces: typed wrappers consumed by the `workspaces` store (Task 8).

- [ ] **Step 1: Add the wrappers + types**

Append to `src/lib/tauri.ts`:

```ts
export interface Identity {
  server: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  mode: "open" | "oidc";
}

export type WorkspaceState = "local-only" | "cloud-only" | "cloned";

export interface WorkspaceView {
  id: string;
  server: string | null;
  name: string;
  local_path: string | null;
  local_only: boolean;
  state: WorkspaceState;
}

export const serverLogin = (server: string): Promise<Identity> =>
  invoke("server_login", { server });
export const serverLogout = (server: string): Promise<void> =>
  invoke("server_logout", { server });
export const currentIdentity = (server: string): Promise<Identity | null> =>
  invoke("current_identity", { server });

export const listWorkspacesMerged = (server: string | null): Promise<WorkspaceView[]> =>
  invoke("list_workspaces_merged", { server });
export const registerLocalWorkspace = (id: string, name: string, path: string): Promise<void> =>
  invoke("register_local_workspace", { id, name, path });
export const setWorkspacePath = (id: string, path: string): Promise<void> =>
  invoke("set_workspace_path", { id, path });
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm check` → 0 errors.

```bash
git add src/lib/tauri.ts
git commit -m "feat(workspace): frontend wrappers for auth + workspace-index commands"
```

---

### Task 8: `workspaces` runes store (login state, list, actions)

**Files:**
- Create: `src/lib/workspaces.svelte.ts`
- Modify: `src/lib/settings.svelte.ts` (reuse `wsBase` as the active server URL; add an `activeServer` derived from it)

**Interfaces:**
- Consumes: Task 7 wrappers, the `workspace` store's `openWorkspace`.
- Produces: `export const workspaces` singleton with `{ identity, list, activeServer, refresh(), login(server), logout(), openLocalFolder(path, name), openWorkspaceView(view) }`.

- [ ] **Step 1: Implement the store**

Create `src/lib/workspaces.svelte.ts`:

```ts
import {
  currentIdentity,
  serverLogin,
  serverLogout,
  listWorkspacesMerged,
  registerLocalWorkspace,
  setWorkspacePath,
  type Identity,
  type WorkspaceView,
} from "$lib/tauri";
import { settings } from "$lib/settings.svelte";
import { workspace } from "$lib/workspace.svelte";

class WorkspacesStore {
  identity = $state<Identity | null>(null);
  list = $state<WorkspaceView[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);

  /** The active server URL, mirroring the existing Settings field. */
  get activeServer(): string {
    return settings.wsBase;
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      this.identity = await currentIdentity(this.activeServer).catch(() => null);
      this.list = await listWorkspacesMerged(this.activeServer);
    } catch (e) {
      this.error = String(e);
    } finally {
      this.loading = false;
    }
  }

  async login(): Promise<void> {
    this.error = null;
    try {
      this.identity = await serverLogin(this.activeServer);
      await this.refresh();
    } catch (e) {
      this.error = String(e);
    }
  }

  async logout(): Promise<void> {
    await serverLogout(this.activeServer);
    this.identity = null;
    await this.refresh();
  }

  /** Open an existing local folder as a local-only workspace (registers it). */
  async openLocalFolder(path: string, name: string): Promise<void> {
    await registerLocalWorkspace(path, name, path); // id = path for local-only
    await workspace.openWorkspace(path);
    await this.refresh();
  }

  /**
   * Open a workspace from the picker. local-only / cloned → open its folder.
   * cloud-only → caller must first resolve a local path (Plan 2 does the clone;
   * in Plan 1 we register the chosen path and open it empty).
   */
  async openWorkspaceView(view: WorkspaceView, chosenPath?: string): Promise<void> {
    if (view.local_path) {
      await workspace.openWorkspace(view.local_path);
      return;
    }
    if (chosenPath) {
      await setWorkspacePath(view.id, chosenPath);
      await workspace.openWorkspace(chosenPath);
      await this.refresh();
    }
  }
}

export const workspaces = new WorkspacesStore();
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm check` → 0 errors.

```bash
git add src/lib/workspaces.svelte.ts
git commit -m "feat(workspace): workspaces store (login state, merged list, actions)"
```

---

### Task 9: Settings — server login/logout UI

**Files:**
- Modify: `src/lib/SettingsModal.svelte` (the existing Sync section, lines 70-111)

**Interfaces:**
- Consumes: `workspaces` store.

- [ ] **Step 1: Add login UI under the Server URL field**

In `SettingsModal.svelte`, import the store at the top of `<script>`:

```ts
import { workspaces } from "$lib/workspaces.svelte";
```

After the existing Server URL `<label>` block (ends ~line 98), insert:

```svelte
<!-- Server login: device-code flow, token in Keychain -->
<div class="flex items-center justify-between gap-4">
  {#if workspaces.identity?.display_name}
    <span class="text-sm text-base-content/70 truncate">
      Signed in as {workspaces.identity.display_name}
    </span>
    <button class="btn btn-ghost btn-xs" onclick={() => workspaces.logout()}>Sign out</button>
  {:else if workspaces.identity?.mode === "open"}
    <span class="text-sm text-base-content/60">Open server — no sign-in needed</span>
  {:else}
    <span class="text-sm text-base-content/60">Not signed in</span>
    <button class="btn btn-primary btn-xs" onclick={() => workspaces.login()}>
      Sign in…
    </button>
  {/if}
</div>
{#if workspaces.error}
  <p class="text-xs text-error">{workspaces.error}</p>
{/if}
```

- [ ] **Step 2: Refresh identity when settings opens**

In `SettingsModal.svelte`, add an effect so the identity reflects the current token whenever the modal opens:

```svelte
$effect(() => {
  if (open) workspaces.refresh();
});
```

- [ ] **Step 3: Typecheck + manual smoke**

Run: `pnpm check` → 0 errors.
Manual: `pnpm tauri dev`, open Settings → with the default `ws://localhost:8787/ws` and no server running, "Sign in…" shows an error string (not a crash). (Full success path is Task 12.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/SettingsModal.svelte
git commit -m "feat(settings): server sign-in/out UI (device-code, Keychain)"
```

---

### Task 10: `WorkspacePicker` component (three-state list + open/create local)

**Files:**
- Create: `src/lib/WorkspacePicker.svelte` (replaces the file renamed in Task 6)

**Interfaces:**
- Consumes: `workspaces` store, `pickFolder` from `tauri.ts`.

- [ ] **Step 1: Implement the picker dropdown**

Create `src/lib/WorkspacePicker.svelte`:

```svelte
<script lang="ts">
  import { Check, Cloud, FolderOpen, Plus, HardDrive } from "lucide-svelte";
  import { workspaces } from "$lib/workspaces.svelte";
  import { workspace } from "$lib/workspace.svelte";
  import { pickFolder } from "$lib/tauri";
  import type { WorkspaceView } from "$lib/tauri";

  let openMenu = $state(false);

  const activeName = $derived(
    workspaces.list.find((w) => w.local_path && w.local_path === workspace.root)?.name ??
      "Select workspace",
  );

  async function choose(view: WorkspaceView) {
    openMenu = false;
    if (view.state === "cloud-only") {
      // Plan 1: pick where it lives, register, open empty. Plan 2 clones content.
      const path = await pickFolder();
      if (!path) return;
      await workspaces.openWorkspaceView(view, path);
    } else {
      await workspaces.openWorkspaceView(view);
    }
  }

  async function openLocal() {
    openMenu = false;
    const path = await pickFolder();
    if (!path) return;
    const name = path.split("/").filter(Boolean).pop() ?? path;
    await workspaces.openLocalFolder(path, name);
  }
</script>

<div class="relative">
  <button
    class="btn btn-ghost btn-sm gap-1.5 max-w-full"
    onclick={() => { openMenu = !openMenu; if (openMenu) workspaces.refresh(); }}
  >
    <span class="truncate">{activeName}</span>
  </button>

  {#if openMenu}
    <div
      class="absolute left-0 top-full mt-1 z-40 w-64 flex flex-col gap-0.5 p-1.5"
      style="background: var(--overlay); box-shadow: var(--shadow-overlay); border-radius: var(--radius-overlay, 0.875rem);"
    >
      {#each workspaces.list as view (view.id)}
        <button
          class="flex items-center gap-2 px-2 py-1.5 rounded-selector text-sm hover:bg-base-200 text-left"
          onclick={() => choose(view)}
        >
          {#if view.state === "cloud-only"}
            <Cloud size={15} class="shrink-0 text-base-content/50" />
          {:else if view.state === "cloned"}
            <Check size={15} class="shrink-0 text-success" />
          {:else}
            <HardDrive size={15} class="shrink-0 text-base-content/50" />
          {/if}
          <span class="truncate flex-1">{view.name}</span>
          {#if view.state === "cloud-only"}
            <span class="text-[10px] text-base-content/40">not downloaded</span>
          {/if}
        </button>
      {/each}

      <div class="h-px bg-base-300/70 my-1"></div>

      <button
        class="flex items-center gap-2 px-2 py-1.5 rounded-selector text-sm hover:bg-base-200 text-left"
        onclick={openLocal}
      >
        <FolderOpen size={15} class="shrink-0 text-base-content/50" />
        <span>Open local folder…</span>
      </button>
      <!-- Create-remote + promote land in Plan 5; create-local is "Open local folder". -->
    </div>
  {/if}
</div>
```

- [ ] **Step 2: Typecheck**

Run: `pnpm check` → 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/WorkspacePicker.svelte
git commit -m "feat(workspace): WorkspacePicker with local-only/cloud-only/cloned states"
```

---

### Task 11: Wire the picker into the sidebar header

**Files:**
- Modify: `src/lib/AppShell.svelte` (the workspace/vault header area, ~lines around the current vault header `class="flex items-center gap-1 px-2 pt-2 pb-1"`)

**Interfaces:**
- Consumes: `WorkspacePicker`.

- [ ] **Step 1: Replace the static header with the picker**

In `AppShell.svelte`, import:

```ts
import WorkspacePicker from "$lib/WorkspacePicker.svelte";
import { workspaces } from "$lib/workspaces.svelte";
```

Replace the existing workspace-name header element with `<WorkspacePicker />`, keeping the surrounding `class="flex items-center gap-1 px-2 pt-2 pb-1"` container. On mount, populate the list:

```svelte
import { onMount } from "svelte";
onMount(() => workspaces.refresh());
```

- [ ] **Step 2: Typecheck + manual**

Run: `pnpm check` → 0 errors.
Manual: `pnpm tauri dev` → the sidebar header is now a dropdown; "Open local folder…" opens a folder and loads it as today; previously-opened local folders appear in the list with the drive icon.

- [ ] **Step 3: Commit**

```bash
git add src/lib/AppShell.svelte
git commit -m "feat(workspace): wire WorkspacePicker into the sidebar header"
```

---

### Task 12: Integration verification against a dev muesli-server

**Files:** none (verification task)

This is the end-to-end gate. It uses the muesli repo's dev stack.

- [ ] **Step 1: Start a dev server in OPEN mode**

```bash
cd /Users/julianbeaulieu/Code/muesli
# Open mode = no OIDC_ISSUER. Volatile (no DB) is fine for this check.
MUESLI_LISTEN=127.0.0.1:8787 cargo run -p muesli-server
```

Expected: listens on `127.0.0.1:8787`; `curl -s localhost:8787/api/cli/auth-config` returns `{"mode":"open",...}`.

- [ ] **Step 2: Verify open-mode identity + workspace list**

In demo_muesli (`pnpm tauri dev`), Settings → server URL `ws://localhost:8787/ws` → it should show "Open server — no sign-in needed". Open the picker: `list_workspaces_merged` returns whatever the open-mode server lists (may be empty) without error. Confirm no crash and no `vault` strings anywhere in the UI.

- [ ] **Step 3: (If available) verify OIDC device-code login**

Start the full dev stack with Dex (`cd /Users/julianbeaulieu/Code/muesli && docker compose up -d` then run the server with `OIDC_ISSUER` set per its README). In demo_muesli Settings → "Sign in…" → the system browser opens to Dex → approve → Settings shows "Signed in as <name>", and the picker lists your workspaces as **cloud-only** (no `local_path` yet). Selecting one prompts for a folder and opens it (empty — content clone is Plan 2). Confirm the token landed in Keychain:

```bash
security find-generic-password -s muesli -a http://localhost:8787 -w
```
Expected: prints a `mua_...` token.

- [ ] **Step 4: Final checks + commit a note**

Run: `cd src-tauri && cargo test && cd .. && pnpm check`
Expected: all Rust tests pass; `pnpm check` 0 errors.

```bash
git commit --allow-empty -m "test(workspace): verified auth + picker against dev muesli-server"
```

---

## Notes for Plan 2

- `muesli_cli::api::list_docs_and_folders`, `create_folder`, `place_document` and `muesli_cli::store` link helpers (`record_link`, `find_link`, `rebind_link`) are the reuse surface for clone + structure.
- `muesli-core::MuesliDoc` (`materialize`, `ingest`, `state_vector`, `diff_update`, `apply_update`, `apply_update_changed`) + `muesli_cli::session` is the daemon reuse surface for content sync.
- The `index.db` opened here gains a `links` table in Plan 2 (file↔doc), so keep the connection helper (`workspaces_cmd::open`) reusable.
- `device_flow` currently opens the browser and blocks while polling; a Plan 3 refinement can surface the `user_code`/`verification_uri` in-app instead of relying on the browser page.
```
