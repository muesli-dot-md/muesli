//! Workspace filesystem module — Tauri commands for browsing and editing a workspace
//! (a folder of Markdown files).
//!
//! All commands return `Result<_, String>` so errors surface cleanly in the
//! frontend via Tauri's IPC layer.

pub mod tree;
pub mod recent;
pub mod search;
pub mod graph;

use std::path::{Component, Path, PathBuf};

pub use tree::WorkspaceNode;
pub use recent::{RecentWorkspace, list_recent_workspaces, add_recent_workspace, set_last_workspace, get_last_workspace};

// ---------------------------------------------------------------------------
// Workspace-root confinement
// ---------------------------------------------------------------------------
//
// `read_note`/`write_note` are reachable from any script running in the
// webview, so they must not accept arbitrary filesystem paths. Every requested
// path is resolved and asserted to live inside the active workspace root
// (the most recently opened workspace — the frontend registers it via
// `add_recent_workspace` before any note IO). This mirrors the traversal
// guard already applied in `rename_path`.

/// Canonicalized root of the active workspace.
fn active_workspace_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = recent::get_last_workspace(app.clone())?
        .ok_or_else(|| "no active workspace".to_string())?;
    std::fs::canonicalize(&root).map_err(|e| format!("workspace root unavailable: {e}"))
}

/// Resolve `path` for reading: it must exist and canonicalize to a location
/// inside `root` (which must itself be canonical). Symlinks that point outside
/// the workspace are rejected because canonicalization resolves them.
fn resolve_read_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let resolved = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if resolved.starts_with(root) {
        Ok(resolved)
    } else {
        Err(format!("path is outside the active workspace: {path}"))
    }
}

/// Resolve `path` for writing: the target may not exist yet, so canonicalize
/// the nearest existing ancestor and re-attach the (not yet existing)
/// remainder. Rejects `.`/`..` components outright — so `create_dir_all` on
/// the parent can never escape `root` — and refuses broken symlinks, which
/// writing "through" would re-route outside the workspace.
fn resolve_write_path(root: &Path, path: &str) -> Result<PathBuf, String> {
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
    if full.starts_with(root) && full.as_path() != root {
        Ok(full)
    } else {
        Err(outside())
    }
}

// ---------------------------------------------------------------------------
// read_workspace_tree
// ---------------------------------------------------------------------------

/// Return a recursive tree of workspace nodes rooted at `root`.
///
/// Only `.md` files and directories are included. Dotfiles and dot-dirs
/// (`.git`, `.obsidian`, `.muesli`, `.trash`) are skipped. Within each
/// directory folders appear first (case-insensitive alphabetical order),
/// then files (same order).
#[tauri::command]
pub fn read_workspace_tree(root: String) -> Result<WorkspaceNode, String> {
    let path = Path::new(&root);
    if !path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    tree::build_tree(path).map_err(|e| e.to_string())
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
// create_note
// ---------------------------------------------------------------------------

/// Create a new empty `.md` file inside `dir` with the given `name`.
///
/// `.md` is appended to `name` if it is not already present. If the target
/// path already exists the name is de-duplicated: `Untitled.md`,
/// `Untitled 1.md`, `Untitled 2.md`, …
///
/// Returns the final absolute path.
#[tauri::command]
pub fn create_note(dir: String, name: String) -> Result<String, String> {
    let dir_path = Path::new(&dir);
    std::fs::create_dir_all(dir_path).map_err(|e| e.to_string())?;

    // Strip .md suffix from base_name for dedup logic, then we'll re-append.
    let base_name = if name.to_lowercase().ends_with(".md") {
        name[..name.len() - 3].to_string()
    } else {
        name
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
#[tauri::command]
pub fn create_folder(dir: String, name: String) -> Result<String, String> {
    let dir_path = Path::new(&dir);
    std::fs::create_dir_all(dir_path).map_err(|e| e.to_string())?;

    let candidate = dir_path.join(&name);
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
#[tauri::command]
pub fn rename_path(path: String, new_name: String) -> Result<String, String> {
    // Renames stay within the same parent: reject path separators / traversal.
    if new_name.is_empty() || new_name.contains('/') || new_name.contains('\\') || new_name.contains("..") {
        return Err(format!("invalid name: {new_name}"));
    }
    let src = PathBuf::from(&path);
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
#[tauri::command]
pub fn move_path(src: String, dest_dir: String) -> Result<String, String> {
    let src_path = PathBuf::from(&src);
    let file_name = src_path
        .file_name()
        .ok_or_else(|| format!("src has no file name: {src}"))?;

    let dest_dir_path = Path::new(&dest_dir);
    std::fs::create_dir_all(dest_dir_path).map_err(|e| e.to_string())?;

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
#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
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
#[tauri::command]
pub fn stat_path(path: String) -> Result<PathInfo, String> {
    let p = PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
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
        let dir = tmp.path().to_str().unwrap().to_string();

        let first = create_note(dir.clone(), "Untitled".to_string()).unwrap();
        assert!(first.ends_with("Untitled.md"), "first: {first}");

        let second = create_note(dir.clone(), "Untitled".to_string()).unwrap();
        assert!(second.ends_with("Untitled 1.md"), "second: {second}");
    }

    // -----------------------------------------------------------------------
    // rename_path keeps .md
    // -----------------------------------------------------------------------

    /// Renaming a.md to b (no extension) yields b.md.
    #[test]
    fn rename_keeps_md_extension() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        mkfile(root, "a.md");

        let src = root.join("a.md").to_str().unwrap().to_string();
        let new_path = rename_path(src, "b".to_string()).unwrap();

        assert!(new_path.ends_with("b.md"), "new_path: {new_path}");
        assert!(Path::new(&new_path).exists());
        assert!(!root.join("a.md").exists());
    }

    #[test]
    fn rename_rejects_path_traversal() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        mkfile(root, "a.md");
        let src = root.join("a.md").to_str().unwrap().to_string();
        for bad in ["../evil", "sub/evil", "..", ""] {
            assert!(rename_path(src.clone(), bad.to_string()).is_err(), "expected error for {bad:?}");
        }
        // Original untouched.
        assert!(root.join("a.md").exists());
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
        assert_eq!(std::fs::read_to_string(outside_root.join("secret.md")).unwrap(), "secret");

        // `..` traversal escaping the root (existing and not-yet-existing targets).
        for bad in [
            root.join("..").join("evil.md"),
            root.join("sub").join("..").join("..").join("evil.md"),
            root.join("..").to_path_buf(),
        ] {
            let bad = bad.to_str().unwrap().to_string();
            assert!(read_note_in(&root, &bad).is_err(), "read should reject {bad}");
            assert!(write_note_in(&root, &bad, "x").is_err(), "write should reject {bad}");
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
        let root = tmp.path();
        mkfile(root, "note.md");
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();

        let src = root.join("note.md").to_str().unwrap().to_string();
        let dest_dir = sub.to_str().unwrap().to_string();

        let new_path = move_path(src.clone(), dest_dir).unwrap();

        assert!(!Path::new(&src).exists(), "original should be gone");
        assert!(Path::new(&new_path).exists(), "dest should exist");
        assert!(new_path.ends_with("note.md"));
    }

    // -----------------------------------------------------------------------
    // stat_path
    // -----------------------------------------------------------------------

    /// stat_path on a file returns its byte size and no child count.
    #[test]
    fn stat_path_file() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("note.md");
        std::fs::write(&p, "hello").unwrap();

        let info = stat_path(p.to_str().unwrap().to_string()).unwrap();
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
        let root = tmp.path();
        std::fs::write(root.join("a.md"), "aaa").unwrap();
        std::fs::write(root.join("b.md"), "bb").unwrap();
        std::fs::write(root.join("ignore.txt"), "xxxxx").unwrap();
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("c.md"), "c").unwrap();

        let info = stat_path(root.to_str().unwrap().to_string()).unwrap();
        assert!(info.is_dir);
        // 3 + 2 (root .md) + 1 (nested .md) = 6 bytes; non-.md ignored.
        assert_eq!(info.size, 6);
        // Only immediate .md children are counted.
        assert_eq!(info.child_count, Some(2));
    }
}
