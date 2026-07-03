//! Local state (internal/design/local-agent-cli.md): the API token lives in the OS keychain
//! (never plaintext on disk by default); the path ↔ document index lives in SQLite at
//! `<data dir>/muesli/index.db` (ADR 0009). A pre-SQLite `links.json` index is migrated
//! transparently on first use (imported, then renamed to `links.json.migrated`).
//!
//! LEGACY MIRROR: integrations/vscode reads `links.json` directly (see
//! `integrations/vscode/src/core.ts` `linksPath()`), so every index mutation also rewrites
//! `links.json` as a generated mirror of `index.db` (with a "do not edit" marker entry the
//! extension's parser skips). Remove the mirror once the extension reads `index.db`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use tracing::warn;

const KEYRING_SERVICE: &str = "muesli";

/// Normalize any server argument (`ws://…/ws`, `http://…`) to the HTTP base URL —
/// the canonical key for tokens and the index.
pub fn http_base(server: &str) -> String {
    let s = server.trim_end_matches('/');
    let s = s.strip_suffix("/ws").unwrap_or(s);
    if let Some(rest) = s.strip_prefix("wss://") {
        format!("https://{rest}")
    } else if let Some(rest) = s.strip_prefix("ws://") {
        format!("http://{rest}")
    } else {
        s.to_string()
    }
}

/// The websocket endpoint for a server argument.
pub fn ws_base(server: &str) -> String {
    let http = http_base(server);
    let ws = if let Some(rest) = http.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = http.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        http
    };
    format!("{ws}/ws")
}

fn config_dir() -> Result<PathBuf> {
    let dir = dirs::config_dir()
        .context("no config dir for this OS user")?
        .join("muesli");
    std::fs::create_dir_all(&dir)?;
    // The dir can hold the credentials-file fallback — keep it private to the user.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

fn data_dir() -> Result<PathBuf> {
    let dir = dirs::data_dir()
        .context("no data dir for this OS user")?
        .join("muesli");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

// ---------------------------------------------------------------------------
// Token store: MUESLI_TOKEN env > OS keychain > 0600 file fallback.
// MUESLI_TOKEN_STORE=file skips the keychain (CI / tests / headless).
// The desktop app can also close the keychain branch at runtime via
// set_keychain_enabled(false) — the macOS consent gate (spec 2026-07-02).
// ---------------------------------------------------------------------------

/// Process-global keychain gate (desktop keychain-consent spec 2026-07-02).
///
/// Default TRUE — the `muesli` CLI is completely unaffected. The desktop app
/// closes the gate at startup on macOS (before any Tauri command can run) and
/// reopens it only after the user grants consent in the in-app explainer, so a
/// keyring read/write can never fire the macOS Keychain permission prompt
/// before the user has agreed. While closed, `save_token`/`load_token`/
/// `delete_token` skip the `keyring::Entry` branch entirely and fall through to
/// the `MUESLI_TOKEN` env override and the 0600 credentials-file fallback,
/// which never prompt.
static KEYCHAIN_ENABLED: AtomicBool = AtomicBool::new(true);

/// Open (`true`) or close (`false`) the keychain gate. Called by the desktop
/// app's startup and its `keychain_consent` command; the CLI never calls this.
pub fn set_keychain_enabled(enabled: bool) {
    KEYCHAIN_ENABLED.store(enabled, Ordering::SeqCst);
}

fn keychain_enabled() -> bool {
    KEYCHAIN_ENABLED.load(Ordering::SeqCst)
}

fn use_file_store() -> bool {
    std::env::var("MUESLI_TOKEN_STORE").is_ok_and(|v| v == "file")
}

fn credentials_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("credentials.json"))
}

fn read_file_tokens() -> BTreeMap<String, String> {
    credentials_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_file_tokens(tokens: &BTreeMap<String, String>) -> Result<()> {
    let path = credentials_path()?;
    let json = serde_json::to_string_pretty(tokens)?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        // Create the file 0600 from the start — never a world-readable window.
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)?;
        file.write_all(json.as_bytes())?;
        // `mode` only applies at creation; tighten pre-existing files too.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    std::fs::write(&path, json)?;
    Ok(())
}

pub fn save_token(server: &str, token: &str) -> Result<()> {
    let key = http_base(server);
    if !use_file_store() && keychain_enabled() {
        match keyring::Entry::new(KEYRING_SERVICE, &key).and_then(|e| e.set_password(token)) {
            Ok(()) => return Ok(()),
            Err(e) => warn!(%e, "keychain unavailable — falling back to credentials file (0600)"),
        }
    }
    let mut tokens = read_file_tokens();
    tokens.insert(key, token.to_string());
    write_file_tokens(&tokens)
}

pub fn load_token(server: &str) -> Option<String> {
    if let Ok(t) = std::env::var("MUESLI_TOKEN") {
        return Some(t);
    }
    let key = http_base(server);
    if !use_file_store() && keychain_enabled() {
        if let Ok(t) = keyring::Entry::new(KEYRING_SERVICE, &key).and_then(|e| e.get_password()) {
            return Some(t);
        }
    }
    read_file_tokens().get(&key).cloned()
}

pub fn delete_token(server: &str) -> Result<()> {
    let key = http_base(server);
    if !use_file_store() && keychain_enabled() {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &key) {
            let _ = entry.delete_credential();
        }
    }
    let mut tokens = read_file_tokens();
    if tokens.remove(&key).is_some() {
        write_file_tokens(&tokens)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Link index (ADR 0009): canonical file path → (doc slug, server) in index.db.
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct Link {
    pub file: PathBuf,
    pub doc: String,
    pub server: String,
    /// Owning workspace id (None in open mode / personal / legacy rows).
    pub workspace: Option<String>,
    /// `datetime('now')` (UTC) of the last successful sync activity, if any.
    pub last_synced: Option<String>,
}

/// The pre-SQLite `links.json` entry shape (also what the legacy mirror re-emits).
#[derive(Deserialize)]
struct LegacyEntry {
    file: PathBuf,
    doc: String,
    server: String,
}

/// Serialize the index writes: connections are short-lived and per-call, and the legacy
/// mirror is a whole-file rewrite — one writer at a time keeps both coherent.
static STORE_LOCK: Mutex<()> = Mutex::new(());

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS links (
    file_path      TEXT PRIMARY KEY,
    doc_id         TEXT NOT NULL,
    server         TEXT NOT NULL,
    workspace      TEXT,
    added_at       TEXT NOT NULL DEFAULT (datetime('now')),
    last_synced_at TEXT
)";

fn open_index_in(dir: &Path) -> Result<Connection> {
    migrate_legacy_json_in(dir)?;
    let conn = Connection::open(dir.join("index.db"))?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

/// Transparent migration: if `links.json` exists and `index.db` does not, import the JSON
/// entries into a fresh `index.db`, rename `links.json` → `links.json.migrated`, and emit
/// the generated `links.json` mirror in its place.
fn migrate_legacy_json_in(dir: &Path) -> Result<()> {
    let db = dir.join("index.db");
    let legacy = dir.join("links.json");
    if db.exists() || !legacy.exists() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(&legacy).context("reading legacy links.json")?;
    // Tolerant parse: skip anything that isn't a {file, doc, server} entry (e.g. markers).
    let entries: Vec<LegacyEntry> = serde_json::from_str::<Vec<serde_json::Value>>(&raw)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();
    let conn = Connection::open(&db)?;
    conn.execute_batch(SCHEMA)?;
    for e in &entries {
        conn.execute(
            "INSERT OR REPLACE INTO links (file_path, doc_id, server) VALUES (?1, ?2, ?3)",
            params![e.file.to_string_lossy(), e.doc, e.server],
        )?;
    }
    drop(conn);
    std::fs::rename(&legacy, dir.join("links.json.migrated"))
        .context("renaming links.json → links.json.migrated")?;
    warn!(
        "migrated links.json → index.db ({} link(s)); old file kept as links.json.migrated",
        entries.len()
    );
    write_mirror_in(dir)?;
    Ok(())
}

/// Rewrite the `links.json` legacy mirror from `index.db` (see module docs: the VS Code
/// extension still reads it). The first array element is a marker object its parser skips.
fn write_mirror_in(dir: &Path) -> Result<()> {
    let links = load_links_in(dir)?;
    let mut arr = vec![serde_json::json!({
        "_generated": "by muesli from index.db — do not edit (legacy mirror for integrations/vscode)"
    })];
    arr.extend(links.iter().map(|l| {
        serde_json::json!({ "file": l.file.to_string_lossy(), "doc": l.doc, "server": l.server })
    }));
    std::fs::write(dir.join("links.json"), serde_json::to_string_pretty(&arr)?)?;
    Ok(())
}

fn load_links_in(dir: &Path) -> Result<Vec<Link>> {
    let conn = open_index_in(dir)?;
    let mut stmt = conn.prepare(
        "SELECT file_path, doc_id, server, workspace, last_synced_at FROM links ORDER BY file_path",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Link {
            file: PathBuf::from(row.get::<_, String>(0)?),
            doc: row.get(1)?,
            server: row.get(2)?,
            workspace: row.get(3)?,
            last_synced: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn record_link_in(
    dir: &Path,
    file: &Path,
    doc: &str,
    server: &str,
    workspace: Option<&str>,
) -> Result<()> {
    let _guard = STORE_LOCK.lock().unwrap();
    let conn = open_index_in(dir)?;
    conn.execute(
        "INSERT INTO links (file_path, doc_id, server, workspace) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(file_path) DO UPDATE SET
           doc_id = excluded.doc_id, server = excluded.server, workspace = excluded.workspace",
        params![file.to_string_lossy(), doc, http_base(server), workspace],
    )?;
    drop(conn);
    write_mirror_in(dir)
}

fn remove_link_in(dir: &Path, file: &Path) -> Result<Option<Link>> {
    let _guard = STORE_LOCK.lock().unwrap();
    let conn = open_index_in(dir)?;
    let removed = conn
        .query_row(
            "DELETE FROM links WHERE file_path = ?1 RETURNING file_path, doc_id, server, workspace, last_synced_at",
            params![file.to_string_lossy()],
            |row| {
                Ok(Link {
                    file: PathBuf::from(row.get::<_, String>(0)?),
                    doc: row.get(1)?,
                    server: row.get(2)?,
                    workspace: row.get(3)?,
                    last_synced: row.get(4)?,
                })
            },
        )
        .optional()?;
    drop(conn);
    write_mirror_in(dir)?;
    Ok(removed)
}

/// Re-bind a document to a new path (rename tracking, ADR 0009): the entry keeps its
/// doc id and added_at; any stale entry already at the new path is replaced.
fn rebind_link_in(dir: &Path, doc: &str, server: &str, new_file: &Path) -> Result<()> {
    let _guard = STORE_LOCK.lock().unwrap();
    let conn = open_index_in(dir)?;
    let server = http_base(server);
    conn.execute(
        "DELETE FROM links WHERE file_path = ?1",
        params![new_file.to_string_lossy()],
    )?;
    conn.execute(
        "UPDATE links SET file_path = ?1 WHERE doc_id = ?2 AND server = ?3",
        params![new_file.to_string_lossy(), doc, server],
    )?;
    drop(conn);
    write_mirror_in(dir)
}

/// Stamp sync activity (shown by `muesli status`). No mirror rewrite: the mirror carries
/// only {file, doc, server}, which a touch never changes.
fn touch_synced_in(dir: &Path, file: &Path) -> Result<()> {
    let conn = open_index_in(dir)?;
    conn.execute(
        "UPDATE links SET last_synced_at = datetime('now') WHERE file_path = ?1",
        params![file.to_string_lossy()],
    )?;
    Ok(())
}

pub fn load_links() -> Vec<Link> {
    match data_dir().and_then(|d| load_links_in(&d)) {
        Ok(links) => links,
        Err(e) => {
            warn!(%e, "could not read the link index");
            Vec::new()
        }
    }
}

pub fn record_link(file: &Path, doc: &str, server: &str, workspace: Option<&str>) -> Result<()> {
    record_link_in(&data_dir()?, file, doc, server, workspace)
}

pub fn remove_link(file: &Path) -> Result<Option<Link>> {
    remove_link_in(&data_dir()?, file)
}

pub fn rebind_link(doc: &str, server: &str, new_file: &Path) -> Result<()> {
    rebind_link_in(&data_dir()?, doc, server, new_file)
}

pub fn touch_synced(file: &Path) -> Result<()> {
    touch_synced_in(&data_dir()?, file)
}

/// Rewrite every link under `old_root` to the same relative location under
/// `new_root` (a workspace folder move/rename). Prefix-matched with substr, not
/// LIKE, so `%`/`_` in paths need no escaping. Returns how many links moved.
pub fn relocate_links(old_root: &Path, new_root: &Path) -> Result<usize> {
    relocate_links_in(&data_dir()?, old_root, new_root)
}

fn relocate_links_in(dir: &Path, old_root: &Path, new_root: &Path) -> Result<usize> {
    let _guard = STORE_LOCK.lock().unwrap();
    let conn = open_index_in(dir)?;
    let old_prefix = format!("{}/", old_root.to_string_lossy().trim_end_matches('/'));
    let new_prefix = format!("{}/", new_root.to_string_lossy().trim_end_matches('/'));
    let n = conn.execute(
        "UPDATE links SET file_path = ?2 || substr(file_path, length(?1) + 1)
         WHERE substr(file_path, 1, length(?1)) = ?1",
        params![old_prefix, new_prefix],
    )?;
    drop(conn);
    write_mirror_in(dir)?;
    Ok(n)
}

pub fn find_link(file: &Path) -> Option<Link> {
    load_links().into_iter().find(|l| l.file == file)
}

fn doc_path_in(dir: &Path, doc: &str, server: &str) -> Result<Option<PathBuf>> {
    let server = http_base(server);
    Ok(load_links_in(dir)?
        .into_iter()
        .find(|l| l.doc == doc && l.server == server)
        .map(|l| l.file))
}

/// The linked file path for `doc` on `server`, if any.
pub fn doc_path(doc: &str, server: &str) -> Option<PathBuf> {
    data_dir()
        .and_then(|d| doc_path_in(&d, doc, server))
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("muesli-store-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn relocate_links_moves_only_the_old_root_prefix() {
        let dir = tmp_dir("relocate");
        let ws = "ws://localhost:8787/ws";
        record_link_in(&dir, Path::new("/old/root/a.md"), "doc-a", ws, None).unwrap();
        record_link_in(&dir, Path::new("/old/root/sub/b.md"), "doc-b", ws, None).unwrap();
        // Sibling that merely shares the string prefix without the separator: untouched.
        record_link_in(&dir, Path::new("/old/rootish/c.md"), "doc-c", ws, None).unwrap();
        let n = relocate_links_in(&dir, Path::new("/old/root"), Path::new("/new/home")).unwrap();
        assert_eq!(n, 2);
        let links = load_links_in(&dir).unwrap();
        let path_of = |doc: &str| links.iter().find(|l| l.doc == doc).unwrap().file.clone();
        assert_eq!(path_of("doc-a"), PathBuf::from("/new/home/a.md"));
        assert_eq!(path_of("doc-b"), PathBuf::from("/new/home/sub/b.md"));
        assert_eq!(path_of("doc-c"), PathBuf::from("/old/rootish/c.md"));
    }

    #[test]
    fn fresh_index_roundtrip_and_mirror() {
        let dir = tmp_dir("fresh");
        record_link_in(
            &dir,
            Path::new("/tmp/a.md"),
            "doc-a",
            "ws://localhost:8787/ws",
            None,
        )
        .unwrap();
        record_link_in(
            &dir,
            Path::new("/tmp/b.md"),
            "doc-b",
            "http://localhost:8787",
            None,
        )
        .unwrap();

        let links = load_links_in(&dir).unwrap();
        assert_eq!(links.len(), 2);
        // server normalized to the HTTP base
        assert!(links.iter().all(|l| l.server == "http://localhost:8787"));
        assert!(links.iter().all(|l| l.last_synced.is_none()));

        touch_synced_in(&dir, Path::new("/tmp/a.md")).unwrap();
        let a = load_links_in(&dir)
            .unwrap()
            .into_iter()
            .find(|l| l.doc == "doc-a")
            .unwrap();
        assert!(a.last_synced.is_some());

        // the legacy mirror exists, carries a marker + both entries
        let mirror: Vec<serde_json::Value> =
            serde_json::from_str(&std::fs::read_to_string(dir.join("links.json")).unwrap())
                .unwrap();
        assert!(mirror[0].get("_generated").is_some());
        assert_eq!(mirror.len(), 3);

        let removed = remove_link_in(&dir, Path::new("/tmp/a.md"))
            .unwrap()
            .unwrap();
        assert_eq!(removed.doc, "doc-a");
        assert_eq!(load_links_in(&dir).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrates_legacy_links_json() {
        let dir = tmp_dir("migrate");
        std::fs::write(
            dir.join("links.json"),
            r#"[{"file":"/tmp/x.md","doc":"my-doc","server":"http://localhost:8787"}]"#,
        )
        .unwrap();

        let links = load_links_in(&dir).unwrap(); // any access triggers the migration
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].doc, "my-doc");
        assert_eq!(links[0].file, PathBuf::from("/tmp/x.md"));

        assert!(dir.join("index.db").exists(), "index.db created");
        assert!(
            dir.join("links.json.migrated").exists(),
            "original kept as .migrated"
        );
        // and the mirror was regenerated in place of the old file
        let mirror: Vec<serde_json::Value> =
            serde_json::from_str(&std::fs::read_to_string(dir.join("links.json")).unwrap())
                .unwrap();
        assert!(mirror[0].get("_generated").is_some());
        assert_eq!(mirror[1]["doc"], "my-doc");

        // a second access must NOT re-import (index.db now exists)
        std::fs::write(dir.join("links.json"), "[]").unwrap();
        assert_eq!(load_links_in(&dir).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn records_workspace_and_resolves_doc_path() {
        let dir = tmp_dir("workspace-col");
        record_link_in(
            &dir,
            Path::new("/tmp/w.md"),
            "doc-w",
            "http://localhost:8787",
            Some("ws-1"),
        )
        .unwrap();
        record_link_in(
            &dir,
            Path::new("/tmp/n.md"),
            "doc-n",
            "http://localhost:8787",
            None,
        )
        .unwrap();

        let links = load_links_in(&dir).unwrap();
        let w = links.iter().find(|l| l.doc == "doc-w").unwrap();
        assert_eq!(w.workspace.as_deref(), Some("ws-1"));
        let n = links.iter().find(|l| l.doc == "doc-n").unwrap();
        assert_eq!(n.workspace, None);

        // reverse lookup by (doc, server)
        assert_eq!(
            doc_path_in(&dir, "doc-w", "http://localhost:8787").unwrap(),
            Some(PathBuf::from("/tmp/w.md"))
        );
        // wrong server → no hit
        assert_eq!(doc_path_in(&dir, "doc-w", "http://other").unwrap(), None);
        // unknown doc → None
        assert_eq!(
            doc_path_in(&dir, "nope", "http://localhost:8787").unwrap(),
            None
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rebind_moves_the_path_and_keeps_the_doc() {
        let dir = tmp_dir("rebind");
        record_link_in(
            &dir,
            Path::new("/tmp/old.md"),
            "kept-doc",
            "http://localhost:8787",
            None,
        )
        .unwrap();
        rebind_link_in(
            &dir,
            "kept-doc",
            "http://localhost:8787",
            Path::new("/tmp/new.md"),
        )
        .unwrap();
        let links = load_links_in(&dir).unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].file, PathBuf::from("/tmp/new.md"));
        assert_eq!(links[0].doc, "kept-doc");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // -----------------------------------------------------------------------
    // Keychain gate (desktop keychain-consent spec 2026-07-02).
    //
    // The gate is a process-global AtomicBool and these tests also mutate the
    // process-global MUESLI_TOKEN / MUESLI_TOKEN_STORE env vars, so every test
    // that touches either holds this lock for the full mutate-AND-use span
    // (house pattern: muesli-server's secrets::SECRET_KEY_ENV_TEST_LOCK).
    static KEYCHAIN_GATE_TEST_LOCK: Mutex<()> = Mutex::new(());

    /// RAII guard: snapshots + clears the token env vars on construction, and on
    /// drop reopens the gate and restores the env — even when an assert panics,
    /// so one failing test can't poison the others.
    struct GateGuard {
        token: Option<String>,
        store: Option<String>,
    }
    impl GateGuard {
        fn new() -> Self {
            let token = std::env::var("MUESLI_TOKEN").ok();
            let store = std::env::var("MUESLI_TOKEN_STORE").ok();
            std::env::remove_var("MUESLI_TOKEN");
            std::env::remove_var("MUESLI_TOKEN_STORE");
            Self { token, store }
        }
    }
    impl Drop for GateGuard {
        fn drop(&mut self) {
            set_keychain_enabled(true);
            match &self.token {
                Some(v) => std::env::set_var("MUESLI_TOKEN", v),
                None => std::env::remove_var("MUESLI_TOKEN"),
            }
            match &self.store {
                Some(v) => std::env::set_var("MUESLI_TOKEN_STORE", v),
                None => std::env::remove_var("MUESLI_TOKEN_STORE"),
            }
        }
    }

    #[test]
    fn keychain_gate_defaults_open() {
        let _lock = KEYCHAIN_GATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // Default state (and the state every gate test restores on drop): open —
        // the CLI is completely unaffected by the desktop consent feature.
        assert!(keychain_enabled(), "gate must default to true");
    }

    #[test]
    fn closed_gate_skips_the_keyring_and_round_trips_via_the_file_fallback() {
        let _lock = KEYCHAIN_GATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _env = GateGuard::new(); // MUESLI_TOKEN + MUESLI_TOKEN_STORE unset
        const SERVER: &str = "http://keychain-gate-test.invalid";

        set_keychain_enabled(false);
        assert!(!keychain_enabled());

        save_token(SERVER, "tok-gate-123").unwrap();
        // With the gate closed the write must land in the 0600 credentials file:
        // had the keyring branch run (and succeeded, as it would on a macOS dev
        // machine), save_token would have returned before the file branch.
        assert_eq!(
            read_file_tokens().get(SERVER).map(String::as_str),
            Some("tok-gate-123"),
            "closed gate: save_token must fall through to the credentials file"
        );
        // ...and load must round-trip from the file with the keyring still skipped.
        assert_eq!(load_token(SERVER).as_deref(), Some("tok-gate-123"));

        // Delete while the gate is STILL closed (a delete after reopening would
        // touch the real keyring): the file entry goes away, nothing is left.
        delete_token(SERVER).unwrap();
        assert_eq!(load_token(SERVER), None);
        // _env drop: gate reopened, env restored.
    }

    #[test]
    fn reopening_the_gate_restores_the_flag() {
        let _lock = KEYCHAIN_GATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _env = GateGuard::new();
        set_keychain_enabled(false);
        assert!(!keychain_enabled());
        set_keychain_enabled(true);
        assert!(keychain_enabled());
    }
}
