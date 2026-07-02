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
        rusqlite::params![
            rec.id,
            rec.server,
            rec.name,
            rec.local_path,
            rec.local_only as i64
        ],
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

pub fn delete_workspace(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM workspaces WHERE id = ?1;",
        rusqlite::params![id],
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

    #[test]
    fn delete_removes_row() {
        let conn = mem();
        let rec = WorkspaceRecord {
            id: "w1".into(),
            server: None,
            name: "Notes".into(),
            local_path: Some("/Users/me/Notes".into()),
            local_only: true,
        };
        upsert_workspace(&conn, &rec).unwrap();
        assert_eq!(find_by_id(&conn, "w1").unwrap(), Some(rec));
        delete_workspace(&conn, "w1").unwrap();
        assert_eq!(find_by_id(&conn, "w1").unwrap(), None);
        // Deleting a non-existent row is a no-op, not an error.
        delete_workspace(&conn, "missing").unwrap();
    }
}
