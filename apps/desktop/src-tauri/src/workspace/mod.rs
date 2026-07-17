//! Workspace filesystem module — Tauri commands for browsing and editing a workspace
//! (a folder of Markdown files).
//!
//! All commands return `Result<_, String>` so errors surface cleanly in the
//! frontend via Tauri's IPC layer.

pub mod graph;
pub mod recent;
pub mod search;
pub mod tree;

use std::path::{Component, Path, PathBuf};

pub use recent::{
    add_recent_workspace, get_last_workspace, list_recent_workspaces, set_last_workspace,
    RecentWorkspace,
};
pub use tree::WorkspaceNode;

// ---------------------------------------------------------------------------
// Workspace-root confinement
// ---------------------------------------------------------------------------
//
// Two confinement rules apply to every filesystem command reachable from the
// webview:
//   1. Note-IO commands (read/write/create/rename/move/delete/stat) operate
//      *inside* the ACTIVE workspace root: they resolve their path argument(s)
//      against `active_workspace_root()` and reject `..`/symlink-escape/out-of-
//      root.
//   2. The workspace-open/enumerate commands (`read_workspace_tree`,
//      `search`/`graph`) take a workspace `root` and confine it to a KNOWN
//      workspace (via `require_known_workspace_root`) — NOT the single active
//      root, because they read the workspace being switched TO, which is not yet
//      active.
// Both rules trust the same admission model: a path becomes a known/active
// workspace root ONLY through the Rust-owned native folder picker
// (`recent::pick_workspace`) or a Rust command that produced the folder
// (`prepare_clone_dir`/`relocate_workspace`); the renderer can re-select an
// already-admitted root but can never introduce an arbitrary new one. The
// confinement is only as trustworthy as that anchor, so the anchor is not
// renderer-controlled. The lone command that writes *outside* any workspace is
// `export_file`, whose destination comes from a native save dialog opened in
// Rust (never a webview-supplied path).

/// Canonicalized root of the active workspace.
fn active_workspace_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = recent::get_last_workspace(app.clone())?
        .ok_or_else(|| "no active workspace".to_string())?;
    std::fs::canonicalize(&root).map_err(|e| format!("workspace root unavailable: {e}"))
}

/// Confine a caller-supplied workspace `root` (as passed to
/// `read_workspace_tree`/`search_workspace`/`build_link_graph`) to a KNOWN
/// workspace root — one admitted via the Rust picker or a Rust-produced folder,
/// tracked in the recents allowlist or the local registry.
///
/// This deliberately does NOT confine against the single *active* root: the
/// frontend reads the tree of the workspace it is switching TO, which is not yet
/// active, so an active-root check would break switching. Membership in the
/// admission allowlist is the right test — a legit (even aged-out) workspace
/// passes; an attacker's arbitrary path (`.md` enumeration/exfiltration) does
/// not, because it was never admitted through a Rust-owned origin.
pub(crate) fn require_known_workspace_root(
    app: &tauri::AppHandle,
    root: &str,
) -> Result<PathBuf, String> {
    if crate::workspaces_cmd::is_known_workspace(app, root) {
        Ok(PathBuf::from(root))
    } else {
        Err(format!("not a known workspace root: {root}"))
    }
}

/// Resolve `path` for reading: it must exist and canonicalize to a location
/// inside `root` (which must itself be canonical). Symlinks that point outside
/// the workspace are rejected because canonicalization resolves them.
///
/// Note: this canonicalizes and then the caller uses the returned path — a
/// classic TOCTOU window exists between check and use. It is not exploitable in
/// this threat model: no webview-reachable command creates symlinks inside the
/// workspace, so an attacker cannot swap a resolved path for an escaping one.
fn resolve_read_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let resolved = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if resolved.starts_with(root) {
        Ok(resolved)
    } else {
        Err(format!("path is outside the active workspace: {path}"))
    }
}

/// Resolve `path` for writing a file: the target may not exist yet, so
/// canonicalize the nearest existing ancestor and re-attach the (not yet
/// existing) remainder. Rejects `.`/`..` components outright — so
/// `create_dir_all` on the parent can never escape `root` — refuses broken
/// symlinks (writing "through" would re-route outside the workspace), and
/// rejects the root itself (not a writable file target).
fn resolve_write_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    resolve_confined_path(root, path, false)
}

/// Resolve a *directory* `path` that must live inside `root`. Same confinement
/// as [`resolve_write_path`], but the root itself is a valid target (a note or
/// folder may be created directly at the workspace top level).
fn resolve_dir_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    resolve_confined_path(root, path, true)
}

/// Shared body of [`resolve_write_path`]/[`resolve_dir_path`]. `allow_root`
/// decides whether the confined path may equal `root` (true for directory
/// targets, false for file targets).
fn resolve_confined_path(root: &Path, path: &str, allow_root: bool) -> Result<PathBuf, String> {
    let requested = Path::new(path);
    if requested
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(format!("invalid path: {path}"));
    }
    let outside = || format!("path is outside the active workspace: {path}");

    // Walk up to the nearest existing ancestor, collecting the missing tail.
    let mut base = requested.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let resolved_base = loop {
        match std::fs::canonicalize(&base) {
            Ok(resolved) => break resolved,
            Err(_) => {
                // Exists but does not canonicalize => broken symlink.
                if std::fs::symlink_metadata(&base).is_ok() {
                    return Err(outside());
                }
                let name = base.file_name().ok_or_else(outside)?.to_os_string();
                tail.push(name);
                if !base.pop() {
                    return Err(outside());
                }
            }
        }
    };

    let mut full = resolved_base;
    for seg in tail.iter().rev() {
        full.push(seg);
    }
    let within = full.starts_with(root) && (allow_root || full.as_path() != root);
    if within {
        Ok(full)
    } else {
        Err(outside())
    }
}

/// Reject a single path *segment* (a file/folder name) that would let a caller
/// step outside its parent directory. Names must be non-empty, not the current
/// directory (`.`), and free of path separators and `..`.
fn reject_unsafe_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
    {
        return Err(format!("invalid name: {name}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// read_workspace_tree
// ---------------------------------------------------------------------------

/// Return a recursive tree of workspace nodes rooted at `root`.
///
/// `root` must be a known workspace root (recents or registry); an unknown path
/// is rejected. Only `.md` files and directories are included. Dotfiles and
/// dot-dirs (`.git`, `.obsidian`, `.muesli`, `.trash`) are skipped. Within each
/// directory folders appear first (case-insensitive alphabetical order),
/// then files (same order).
#[tauri::command]
pub fn read_workspace_tree(app: tauri::AppHandle, root: String) -> Result<WorkspaceNode, String> {
    let path = require_known_workspace_root(&app, &root)?;
    if !path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    tree::build_tree(&path).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// read_note
// ---------------------------------------------------------------------------

/// Return the UTF-8 contents of the file at `path`.
///
/// `path` must resolve inside the active workspace root; anything else is
/// rejected (defense-in-depth against a compromised webview).
#[tauri::command]
pub fn read_note(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let root = active_workspace_root(&app)?;
    read_note_in(&root, &path)
}

/// Root-confined body of [`read_note`], separated for unit testing.
fn read_note_in(root: &Path, path: &str) -> Result<String, String> {
    let resolved = resolve_read_path(root, path)?;
    std::fs::read_to_string(resolved).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// write_note
// ---------------------------------------------------------------------------

/// Overwrite (or create) the file at `path` with `contents`, creating any
/// missing parent directories first.
///
/// `path` must resolve inside the active workspace root; anything else is
/// rejected (defense-in-depth against a compromised webview).
#[tauri::command]
pub fn write_note(app: tauri::AppHandle, path: String, contents: String) -> Result<(), String> {
    let root = active_workspace_root(&app)?;
    write_note_in(&root, &path, &contents)
}

/// Root-confined body of [`write_note`], separated for unit testing.
fn write_note_in(root: &Path, path: &str, contents: &str) -> Result<(), String> {
    let target = resolve_write_path(root, path)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&target, contents).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// export_file
// ---------------------------------------------------------------------------

/// Sanitize `name` into a safe file stem: keep alphanumerics and a small set of
/// punctuation, replace everything else with `_`, and fall back to `export` when
/// the result is empty. Shared by [`export_file`] and [`print_export`].
fn sanitize_export_stem(name: &str) -> String {
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.trim().is_empty() {
        "export".to_string()
    } else {
        safe
    }
}

/// Save an export (the toolbar's standalone HTML render) to a user-chosen
/// location, returning the saved path — or `None` if the user cancelled.
///
/// This is the only filesystem write that legitimately lands OUTSIDE the
/// workspace root, so the destination must not be trusted from the webview.
/// The native save dialog is opened *in Rust* (`blocking_save_file`), so the
/// path comes from the OS/user, never from a renderer-supplied argument — a
/// script in the webview cannot drive this command to an arbitrary path because
/// there is no path parameter to supply. The dialog plugin's Rust API is not
/// capability-gated, so no `plugin-fs` grant is involved.
#[tauri::command]
pub async fn export_file(
    app: tauri::AppHandle,
    name: String,
    contents: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let stem = sanitize_export_stem(&name);
    let chosen = app
        .dialog()
        .file()
        .set_file_name(format!("{stem}.html"))
        .add_filter("HTML", &["html"])
        .blocking_save_file();

    let Some(file_path) = chosen else {
        return Ok(None);
    };
    let path = file_path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// "Export → PDF": write `contents` (a standalone HTML render, with a load-time
/// `print()` injected by the caller) to a temp `<name>.html` and open it in the
/// user's default browser, where the print sheet lets them "Save as PDF".
///
/// This lives in Rust because the WKWebview can't reliably drive
/// `window.print()`/`window.open`, and the opener capability doesn't grant the
/// webview `open-path` — but the plugin's Rust API is not capability-gated.
#[tauri::command]
pub fn print_export(app: tauri::AppHandle, name: String, contents: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let safe = sanitize_export_stem(&name);

    let dir = std::env::temp_dir().join("muesli-exports");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{safe}.html"));
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;

    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// create_note
// ---------------------------------------------------------------------------

/// Create a new empty `.md` file inside `dir` with the given `name`.
///
/// `.md` is appended to `name` if it is not already present. If the target
/// path already exists the name is de-duplicated: `Untitled.md`,
/// `Untitled 1.md`, `Untitled 2.md`, …
///
/// Returns the final absolute path.
///
/// `dir` must resolve inside the active workspace root and `name` must be a
/// bare filename; anything else is rejected (defense-in-depth against a
/// compromised webview).
#[tauri::command]
pub fn create_note(app: tauri::AppHandle, dir: String, name: String) -> Result<String, String> {
    let root = active_workspace_root(&app)?;
    create_note_in(&root, &dir, &name)
}

/// Root-confined body of [`create_note`], separated for unit testing.
fn create_note_in(root: &Path, dir: &str, name: &str) -> Result<String, String> {
    reject_unsafe_name(name)?;
    let dir_path = resolve_dir_path(root, dir)?;
    std::fs::create_dir_all(&dir_path).map_err(|e| e.to_string())?;

    // Strip .md suffix from base_name for dedup logic, then we'll re-append.
    let base_name = if name.to_lowercase().ends_with(".md") {
        name[..name.len() - 3].to_string()
    } else {
        name.to_string()
    };

    // Try "Untitled.md", "Untitled 1.md", "Untitled 2.md", ...
    let candidate = dir_path.join(format!("{base_name}.md"));
    if !candidate.exists() {
        std::fs::write(&candidate, "").map_err(|e| e.to_string())?;
        return Ok(candidate.to_string_lossy().into_owned());
    }

    let mut counter = 1u32;
    loop {
        let candidate = dir_path.join(format!("{base_name} {counter}.md"));
        if !candidate.exists() {
            std::fs::write(&candidate, "").map_err(|e| e.to_string())?;
            return Ok(candidate.to_string_lossy().into_owned());
        }
        counter += 1;
    }
}

// ---------------------------------------------------------------------------
// create_folder
// ---------------------------------------------------------------------------

/// Create a new subdirectory named `name` inside `dir`.
///
/// De-duplicates: `name`, `name 1`, `name 2`, …  Returns the final absolute
/// path.
///
/// `dir` must resolve inside the active workspace root and `name` must be a
/// bare folder name; anything else is rejected.
#[tauri::command]
pub fn create_folder(app: tauri::AppHandle, dir: String, name: String) -> Result<String, String> {
    let root = active_workspace_root(&app)?;
    create_folder_in(&root, &dir, &name)
}

/// Root-confined body of [`create_folder`], separated for unit testing.
fn create_folder_in(root: &Path, dir: &str, name: &str) -> Result<String, String> {
    reject_unsafe_name(name)?;
    let dir_path = resolve_dir_path(root, dir)?;
    std::fs::create_dir_all(&dir_path).map_err(|e| e.to_string())?;

    let candidate = dir_path.join(name);
    if !candidate.exists() {
        std::fs::create_dir(&candidate).map_err(|e| e.to_string())?;
        return Ok(candidate.to_string_lossy().into_owned());
    }

    let mut counter = 1u32;
    loop {
        let candidate = dir_path.join(format!("{name} {counter}"));
        if !candidate.exists() {
            std::fs::create_dir(&candidate).map_err(|e| e.to_string())?;
            return Ok(candidate.to_string_lossy().into_owned());
        }
        counter += 1;
    }
}

// ---------------------------------------------------------------------------
// rename_path
// ---------------------------------------------------------------------------

/// Rename `path` to `new_name` within the same parent directory.
///
/// For files: if `path` ends with `.md` and `new_name` does not, `.md` is
/// appended so the extension is preserved.
///
/// Returns the new absolute path. Errors if the target already exists.
///
/// `path` must resolve inside the active workspace root, and `new_name` must be
/// a bare filename (no separators / traversal) so the rename stays in the same
/// parent directory.
#[tauri::command]
pub fn rename_path(
    app: tauri::AppHandle,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let root = active_workspace_root(&app)?;
    rename_path_in(&root, &path, &new_name)
}

/// Root-confined body of [`rename_path`], separated for unit testing.
fn rename_path_in(root: &Path, path: &str, new_name: &str) -> Result<String, String> {
    // Renames stay within the same parent: reject path separators / traversal.
    reject_unsafe_name(new_name)?;
    let new_name = new_name.to_string();
    let src = resolve_read_path(root, path)?;
    if src.as_path() == root {
        return Err("refusing to rename the workspace root".to_string());
    }
    let parent = src
        .parent()
        .ok_or_else(|| format!("path has no parent: {path}"))?;

    // Preserve .md extension for files.
    let final_name = if src.is_file()
        && src
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("md"))
            .unwrap_or(false)
        && !new_name.to_lowercase().ends_with(".md")
    {
        format!("{new_name}.md")
    } else {
        new_name
    };

    let dest = parent.join(&final_name);
    if dest.exists() {
        return Err(format!("target already exists: {}", dest.display()));
    }

    std::fs::rename(&src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// move_path
// ---------------------------------------------------------------------------

/// Move `src` into `dest_dir` (keeping the same filename).
///
/// Returns the new absolute path. Errors if the target already exists.
///
/// Both `src` and `dest_dir` must resolve inside the active workspace root.
#[tauri::command]
pub fn move_path(app: tauri::AppHandle, src: String, dest_dir: String) -> Result<String, String> {
    let root = active_workspace_root(&app)?;
    move_path_in(&root, &src, &dest_dir)
}

/// Root-confined body of [`move_path`], separated for unit testing.
fn move_path_in(root: &Path, src: &str, dest_dir: &str) -> Result<String, String> {
    let src_path = resolve_read_path(root, src)?;
    if src_path.as_path() == root {
        return Err("refusing to move the workspace root".to_string());
    }
    let file_name = src_path
        .file_name()
        .ok_or_else(|| format!("src has no file name: {src}"))?;

    let dest_dir_path = resolve_dir_path(root, dest_dir)?;
    std::fs::create_dir_all(&dest_dir_path).map_err(|e| e.to_string())?;

    let dest = dest_dir_path.join(file_name);
    if dest.exists() {
        return Err(format!("target already exists: {}", dest.display()));
    }

    std::fs::rename(&src_path, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// delete_path
// ---------------------------------------------------------------------------

/// Move `path` to the OS trash using the `trash` crate.
///
/// `path` must resolve inside the active workspace root and may not be the root
/// itself; anything else is rejected before `trash::delete` is ever reached.
#[tauri::command]
pub fn delete_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let root = active_workspace_root(&app)?;
    delete_path_in(&root, &path)
}

/// Root-confined body of [`delete_path`], separated for unit testing.
fn delete_path_in(root: &Path, path: &str) -> Result<(), String> {
    let resolved = resolve_read_path(root, path)?;
    if resolved.as_path() == root {
        return Err("refusing to delete the workspace root".to_string());
    }
    trash::delete(&resolved).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// stat_path
// ---------------------------------------------------------------------------

/// Basic filesystem metadata for the "File information" context-menu action.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInfo {
    /// Absolute path.
    pub path: String,
    /// Basename.
    pub name: String,
    /// Whether the path is a directory.
    pub is_dir: bool,
    /// Size in bytes — for a folder, the recursive total of its `.md` files.
    pub size: u64,
    /// Last-modified time as Unix millis (None if unavailable on this platform).
    pub modified_ms: Option<u64>,
    /// Created time as Unix millis (None if unavailable on this platform).
    pub created_ms: Option<u64>,
    /// For a folder: number of immediate `.md` files; None for a file.
    pub child_count: Option<usize>,
}

fn system_time_to_ms(t: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    t.ok()
        .and_then(|st| st.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

/// Recursively sum the byte sizes of `.md` files under `dir` and count the
/// immediate `.md` children. Skips dotfiles/dot-dirs to match the tree walk.
fn dir_md_size(dir: &Path) -> (u64, usize) {
    let mut total = 0u64;
    let mut immediate = 0usize;
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return (0, 0),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let p = entry.path();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => {
                let (sub, _) = dir_md_size(&p);
                total += sub;
            }
            Ok(ft) if ft.is_file() => {
                let is_md = p
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case("md"))
                    .unwrap_or(false);
                if is_md {
                    immediate += 1;
                    total += entry.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
            _ => {}
        }
    }
    (total, immediate)
}

/// Return basic metadata for `path` (size, modified/created times, child count).
///
/// `path` must resolve inside the active workspace root; anything else is
/// rejected (a metadata/enumeration leak otherwise).
#[tauri::command]
pub fn stat_path(app: tauri::AppHandle, path: String) -> Result<PathInfo, String> {
    let root = active_workspace_root(&app)?;
    stat_path_in(&root, &path)
}

/// Root-confined body of [`stat_path`], separated for unit testing.
fn stat_path_in(root: &Path, path: &str) -> Result<PathInfo, String> {
    let p = resolve_read_path(root, path)?;
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let is_dir = meta.is_dir();
    let (size, child_count) = if is_dir {
        let (s, c) = dir_md_size(&p);
        (s, Some(c))
    } else {
        (meta.len(), None)
    };
    Ok(PathInfo {
        path: p.to_string_lossy().into_owned(),
        name,
        is_dir,
        size,
        modified_ms: system_time_to_ms(meta.modified()),
        created_ms: system_time_to_ms(meta.created()),
        child_count,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn mkfile(dir: &Path, rel: &str) {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&p, "").unwrap();
    }

    // -----------------------------------------------------------------------
    // create_note dedup
    // -----------------------------------------------------------------------

    /// Two calls to create_note with the same base name produce Untitled.md
    /// then Untitled 1.md.
    #[test]
    fn create_note_dedup() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let dir = root.to_str().unwrap().to_string();

        let first = create_note_in(&root, &dir, "Untitled").unwrap();
        assert!(first.ends_with("Untitled.md"), "first: {first}");

        let second = create_note_in(&root, &dir, "Untitled").unwrap();
        assert!(second.ends_with("Untitled 1.md"), "second: {second}");
    }

    /// create_note/create_folder create in a nested in-root dir, but reject a
    /// dir outside the workspace, a `..` escape, and unsafe leaf names.
    #[test]
    fn create_note_folder_confined_to_root() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_root = outside.path().canonicalize().unwrap();

        // In-root (including a not-yet-existing nested dir) succeeds.
        let sub = root.join("sub").to_str().unwrap().to_string();
        let note = create_note_in(&root, &sub, "Untitled").unwrap();
        assert!(note.ends_with("Untitled.md"));
        let folder = create_folder_in(&root, root.to_str().unwrap(), "Ideas").unwrap();
        assert!(folder.ends_with("Ideas"));

        // Dir outside the workspace, or a `..` escape, is rejected.
        let out = outside_root.to_str().unwrap().to_string();
        assert!(create_note_in(&root, &out, "x").is_err());
        assert!(create_folder_in(&root, &out, "x").is_err());
        let escape = root.join("..").to_str().unwrap().to_string();
        assert!(create_note_in(&root, &escape, "x").is_err());
        assert!(create_folder_in(&root, &escape, "x").is_err());

        // Unsafe leaf names are rejected before any filesystem touch.
        for bad in ["../evil", "a/b", "..", ""] {
            assert!(create_note_in(&root, &sub, bad).is_err(), "note {bad:?}");
            assert!(
                create_folder_in(&root, &sub, bad).is_err(),
                "folder {bad:?}"
            );
        }
        // Nothing landed outside the workspace.
        assert!(!outside_root.join("x.md").exists());
    }

    // -----------------------------------------------------------------------
    // rename_path keeps .md
    // -----------------------------------------------------------------------

    /// Renaming a.md to b (no extension) yields b.md.
    #[test]
    fn rename_keeps_md_extension() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        mkfile(&root, "a.md");

        let src = root.join("a.md").to_str().unwrap().to_string();
        let new_path = rename_path_in(&root, &src, "b").unwrap();

        assert!(new_path.ends_with("b.md"), "new_path: {new_path}");
        assert!(Path::new(&new_path).exists());
        assert!(!root.join("a.md").exists());
    }

    #[test]
    fn rename_rejects_path_traversal() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        mkfile(&root, "a.md");
        let src = root.join("a.md").to_str().unwrap().to_string();
        for bad in ["../evil", "sub/evil", "..", ""] {
            assert!(
                rename_path_in(&root, &src, bad).is_err(),
                "expected error for {bad:?}"
            );
        }
        // Original untouched.
        assert!(root.join("a.md").exists());
    }

    /// rename_path rejects a source path outside the workspace root.
    #[test]
    fn rename_rejects_source_outside_root() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_root = outside.path().canonicalize().unwrap();
        std::fs::write(outside_root.join("secret.md"), "secret").unwrap();

        let src = outside_root.join("secret.md").to_str().unwrap().to_string();
        assert!(rename_path_in(&root, &src, "pwned").is_err());
        // Untouched, and no rename landed outside the workspace.
        assert!(outside_root.join("secret.md").exists());
        assert!(!outside_root.join("pwned.md").exists());
    }

    // -----------------------------------------------------------------------
    // write_note / read_note round-trip + parent-dir creation
    // -----------------------------------------------------------------------

    /// write_note creates parent dirs and the file; read_note returns the same
    /// contents. (Tested through the root-confined bodies, with the tempdir as
    /// the active workspace root.)
    #[test]
    fn write_then_read_round_trip_creates_parents() {
        let tmp = TempDir::new().unwrap();
        // Canonicalize: on macOS TempDir lives under /var, a symlink to /private/var.
        let root = tmp.path().canonicalize().unwrap();
        let nested = root.join("nested").join("deep").join("note.md");
        let path = nested.to_str().unwrap().to_string();
        let contents = "# Hello\nworld".to_string();

        write_note_in(&root, &path, &contents).unwrap();

        assert!(nested.exists());
        let read_back = read_note_in(&root, &path).unwrap();
        assert_eq!(read_back, contents);
    }

    /// read_note/write_note reject paths outside the workspace root: absolute
    /// paths elsewhere, `..` traversal, and writes to the root itself.
    #[test]
    fn read_write_reject_paths_outside_workspace_root() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_root = outside.path().canonicalize().unwrap();
        std::fs::write(outside_root.join("secret.md"), "secret").unwrap();

        // Absolute path outside the root.
        let secret = outside_root.join("secret.md").to_str().unwrap().to_string();
        assert!(read_note_in(&root, &secret).is_err());
        assert!(write_note_in(&root, &secret, "pwned").is_err());
        assert_eq!(
            std::fs::read_to_string(outside_root.join("secret.md")).unwrap(),
            "secret"
        );

        // `..` traversal escaping the root (existing and not-yet-existing targets).
        for bad in [
            root.join("..").join("evil.md"),
            root.join("sub").join("..").join("..").join("evil.md"),
            root.join("..").to_path_buf(),
        ] {
            let bad = bad.to_str().unwrap().to_string();
            assert!(
                read_note_in(&root, &bad).is_err(),
                "read should reject {bad}"
            );
            assert!(
                write_note_in(&root, &bad, "x").is_err(),
                "write should reject {bad}"
            );
        }
        assert!(!root.parent().unwrap().join("evil.md").exists());

        // The root itself is not a writable note target.
        assert!(write_note_in(&root, root.to_str().unwrap(), "x").is_err());

        // In-root paths still work, including `..`-free nested creation.
        let ok = root.join("a").join("b.md").to_str().unwrap().to_string();
        write_note_in(&root, &ok, "fine").unwrap();
        assert_eq!(read_note_in(&root, &ok).unwrap(), "fine");
    }

    /// A symlink inside the workspace pointing outside it must not be readable
    /// or writable through these commands (canonicalization resolves it).
    #[cfg(unix)]
    #[test]
    fn read_write_reject_symlink_escape() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let outside = TempDir::new().unwrap();
        let target = outside.path().canonicalize().unwrap().join("secret.md");
        std::fs::write(&target, "secret").unwrap();

        let link = root.join("link.md");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let link_str = link.to_str().unwrap().to_string();
        assert!(read_note_in(&root, &link_str).is_err());
        assert!(write_note_in(&root, &link_str, "pwned").is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "secret");

        // Broken symlink: writing "through" it would create the outside target.
        let dangling_target = outside.path().canonicalize().unwrap().join("not-yet.md");
        let dangling = root.join("dangling.md");
        std::os::unix::fs::symlink(&dangling_target, &dangling).unwrap();
        assert!(write_note_in(&root, dangling.to_str().unwrap(), "pwned").is_err());
        assert!(!dangling_target.exists());
    }

    // -----------------------------------------------------------------------
    // move_path
    // -----------------------------------------------------------------------

    /// move_path moves a file into a subdirectory; original is gone, dest exists.
    #[test]
    fn move_path_into_subdir() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        mkfile(&root, "note.md");
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();

        let src = root.join("note.md").to_str().unwrap().to_string();
        let dest_dir = sub.to_str().unwrap().to_string();

        let new_path = move_path_in(&root, &src, &dest_dir).unwrap();

        assert!(!Path::new(&src).exists(), "original should be gone");
        assert!(Path::new(&new_path).exists(), "dest should exist");
        assert!(new_path.ends_with("note.md"));
    }

    /// move_path rejects a source or destination outside the workspace root.
    #[test]
    fn move_path_rejects_paths_outside_root() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        mkfile(&root, "note.md");
        let outside = TempDir::new().unwrap();
        let outside_root = outside.path().canonicalize().unwrap();
        std::fs::write(outside_root.join("secret.md"), "secret").unwrap();

        let in_src = root.join("note.md").to_str().unwrap().to_string();
        let out_dir = outside_root.to_str().unwrap().to_string();
        let out_src = outside_root.join("secret.md").to_str().unwrap().to_string();
        let in_dir = root.to_str().unwrap().to_string();

        // Destination outside the root: rejected, file stays put.
        assert!(move_path_in(&root, &in_src, &out_dir).is_err());
        assert!(root.join("note.md").exists());
        assert!(!outside_root.join("note.md").exists());

        // Source outside the root: rejected, secret untouched.
        assert!(move_path_in(&root, &out_src, &in_dir).is_err());
        assert!(outside_root.join("secret.md").exists());
        assert!(!root.join("secret.md").exists());

        // `..` escape on the destination is rejected too.
        let escape = root.join("..").to_str().unwrap().to_string();
        assert!(move_path_in(&root, &in_src, &escape).is_err());
    }

    /// rename_path and move_path refuse to operate on the workspace root
    /// itself: renaming/moving the vault dir would push it outside the boundary
    /// (parent.join(new_name)) and is never a legitimate file-tree action.
    #[test]
    fn rename_and_move_refuse_the_root() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();

        // rename the root → refused, root still there.
        assert!(rename_path_in(&root, root.to_str().unwrap(), "evil").is_err());
        assert!(root.exists());
        assert!(!root.parent().unwrap().join("evil").exists());

        // move the root into a subdir → refused.
        let dest = sub.to_str().unwrap().to_string();
        assert!(move_path_in(&root, root.to_str().unwrap(), &dest).is_err());
        assert!(root.exists());
    }

    /// The `resolve_read_path` contract that backs the note-IO commands
    /// (read_note/delete/stat/move-src/rename-src): a path inside the active
    /// root resolves, an out-of-root path is rejected. (The workspace-open
    /// commands — tree/search/graph — instead gate on known-workspace
    /// membership, tested in `workspaces_cmd`.)
    #[test]
    fn root_confinement_rejects_out_of_root_enumeration() {
        let tmp = TempDir::new().unwrap();
        let active = tmp.path().canonicalize().unwrap();
        let sub = active.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let outside = TempDir::new().unwrap();
        let outside_root = outside.path().canonicalize().unwrap();

        // The active root itself and a subdir resolve (legit in-root IO).
        assert_eq!(
            resolve_read_path(&active, active.to_str().unwrap()).unwrap(),
            active
        );
        assert!(resolve_read_path(&active, sub.to_str().unwrap()).is_ok());
        // A root outside the active workspace is refused (no arbitrary `.md`
        // enumeration / content grep).
        assert!(resolve_read_path(&active, outside_root.to_str().unwrap()).is_err());
    }

    /// delete_path rejects paths outside the workspace root (and the root
    /// itself) before ever calling into the OS trash.
    #[test]
    fn delete_path_rejects_paths_outside_root() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_root = outside.path().canonicalize().unwrap();
        std::fs::write(outside_root.join("secret.md"), "secret").unwrap();

        let secret = outside_root.join("secret.md").to_str().unwrap().to_string();
        assert!(delete_path_in(&root, &secret).is_err());
        assert!(outside_root.join("secret.md").exists());

        let escape = root
            .join("..")
            .join("evil.md")
            .to_str()
            .unwrap()
            .to_string();
        assert!(delete_path_in(&root, &escape).is_err());

        // The workspace root itself is not a deletable target.
        assert!(delete_path_in(&root, root.to_str().unwrap()).is_err());
    }

    // -----------------------------------------------------------------------
    // stat_path
    // -----------------------------------------------------------------------

    /// stat_path on a file returns its byte size and no child count.
    #[test]
    fn stat_path_file() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let p = root.join("note.md");
        std::fs::write(&p, "hello").unwrap();

        let info = stat_path_in(&root, p.to_str().unwrap()).unwrap();
        assert_eq!(info.name, "note.md");
        assert!(!info.is_dir);
        assert_eq!(info.size, 5);
        assert_eq!(info.child_count, None);
        assert!(info.modified_ms.is_some());
    }

    /// stat_path on a folder sums its `.md` sizes and counts immediate `.md` files.
    #[test]
    fn stat_path_folder_sums_md() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        std::fs::write(root.join("a.md"), "aaa").unwrap();
        std::fs::write(root.join("b.md"), "bb").unwrap();
        std::fs::write(root.join("ignore.txt"), "xxxxx").unwrap();
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("c.md"), "c").unwrap();

        let info = stat_path_in(&root, root.to_str().unwrap()).unwrap();
        assert!(info.is_dir);
        // 3 + 2 (root .md) + 1 (nested .md) = 6 bytes; non-.md ignored.
        assert_eq!(info.size, 6);
        // Only immediate .md children are counted.
        assert_eq!(info.child_count, Some(2));
    }

    /// stat_path refuses to report metadata for a path outside the workspace.
    #[test]
    fn stat_path_rejects_outside_root() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_root = outside.path().canonicalize().unwrap();
        std::fs::write(outside_root.join("secret.md"), "secret").unwrap();

        let secret = outside_root.join("secret.md").to_str().unwrap().to_string();
        assert!(stat_path_in(&root, &secret).is_err());
    }

    /// The export filename sanitizer strips path separators / traversal and
    /// falls back to `export` for an empty result — so `export_file`'s default
    /// filename can never introduce a path.
    #[test]
    fn sanitize_export_stem_is_a_bare_name() {
        assert_eq!(sanitize_export_stem("My Note"), "My Note");
        assert_eq!(sanitize_export_stem("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(sanitize_export_stem("a/b\\c"), "a_b_c");
        assert_eq!(sanitize_export_stem("   "), "export");
        assert_eq!(sanitize_export_stem(""), "export");
    }
}
