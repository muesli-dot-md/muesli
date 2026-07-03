//! Lazy clone of a cloud workspace into a Finder folder (Plan 2).

pub mod paths;

use std::path::Path;

use anyhow::{Context, Result};
use muesli_cli::api::{self, DocInfo, FolderInfo};
use muesli_cli::{session, store};

use paths::plan_layout;

/// Keep only the documents and folders belonging to `workspace_id`.
pub(crate) fn filter_workspace(
    docs: Vec<DocInfo>,
    folders: Vec<FolderInfo>,
    workspace_id: &str,
) -> (Vec<DocInfo>, Vec<FolderInfo>) {
    let docs = docs
        .into_iter()
        .filter(|d| d.workspace_id.as_deref() == Some(workspace_id))
        .collect();
    let folders = folders
        .into_iter()
        .filter(|f| f.workspace_id.as_deref() == Some(workspace_id))
        .collect();
    (docs, folders)
}

/// Create `<parent>/<workspace name>` for a fresh clone: the folder picker chooses
/// the PARENT and the workspace gets its own folder (git-clone semantics), so
/// picking ~/Documents never turns all of Documents into the workspace. The name
/// is sanitized like document filenames; an existing EMPTY folder of that name is
/// reused (pre-created by the user), a non-empty one gets a -2/-3… suffix so an
/// unrelated folder is never merged into.
pub fn prepare_clone_dir(parent: &Path, name: &str) -> Result<std::path::PathBuf> {
    let base = paths::sanitize_segment(name);
    let base = if base.is_empty() {
        "workspace".to_string()
    } else {
        base
    };
    for i in 1..=100u32 {
        let candidate = if i == 1 {
            base.clone()
        } else {
            format!("{base}-{i}")
        };
        let dir = parent.join(&candidate);
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let empty = std::fs::read_dir(&dir)
                    .with_context(|| format!("reading {}", dir.display()))?
                    .next()
                    .is_none();
                if empty {
                    return Ok(dir);
                }
            }
            Err(e) => {
                return Err(e).with_context(|| format!("creating {}", dir.display()));
            }
        }
    }
    anyhow::bail!(
        "no free folder name for {base:?} under {}",
        parent.display()
    )
}

/// Eager full pull of a workspace into `root` (which must already exist). Rebuilds the folder
/// tree, pulls each document's current text, writes the `.md` files atomically, and records
/// each file↔slug link in the shared index the daemon reads. Resumable: documents already
/// linked at their target path are left untouched. Returns the document count present after.
pub async fn clone_workspace(server: &str, workspace_id: &str, root: &Path) -> Result<usize> {
    // Canonicalize once: the daemon's discovery canonicalizes the root, so links must too.
    let root = root
        .canonicalize()
        .with_context(|| format!("clone target does not exist: {}", root.display()))?;
    let token = store::load_token(server);

    let (docs, folders) = api::list_docs_and_folders(server, token.as_deref())
        .await
        .context("listing workspace documents")?;
    let (docs, folders) = filter_workspace(docs, folders, workspace_id);

    let plan = plan_layout(&docs, &folders);
    let mut present = 0usize;
    for item in &plan {
        let file = root.join(&item.rel_path);
        // Resumable: an existing link at this path means this doc is already cloned.
        if store::find_link(&file).is_some() {
            present += 1;
            continue;
        }
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        // Pull current text; on failure write empty — the daemon's reconcile() will
        // materialize the room into the empty file on first connect (never loses content).
        let text = match api::doc_text(server, token.as_deref(), &item.slug).await {
            Ok(t) => t,
            Err(e) => {
                eprintln!(
                    "clone: text pull failed for {slug}: {e}; writing empty placeholder",
                    slug = item.slug
                );
                String::new()
            }
        };
        session::atomic_write(&file, &text)
            .with_context(|| format!("writing {}", file.display()))?;
        store::record_link(&file, &item.slug, server, Some(workspace_id))
            .with_context(|| format!("recording link for {}", item.slug))?;
        present += 1;
    }
    Ok(present)
}

#[cfg(test)]
mod tests {
    use super::*;
    use muesli_cli::api::{DocInfo, FolderInfo};

    #[test]
    fn prepare_clone_dir_creates_named_subfolder() {
        let parent = tempfile::tempdir().unwrap();
        let dir = prepare_clone_dir(parent.path(), "Team Notes").unwrap();
        assert_eq!(dir, parent.path().join("Team-Notes"));
        assert!(dir.is_dir());
    }

    #[test]
    fn prepare_clone_dir_reuses_an_empty_existing_folder() {
        let parent = tempfile::tempdir().unwrap();
        std::fs::create_dir(parent.path().join("Notes")).unwrap();
        let dir = prepare_clone_dir(parent.path(), "Notes").unwrap();
        assert_eq!(dir, parent.path().join("Notes"));
    }

    #[test]
    fn prepare_clone_dir_suffixes_past_a_non_empty_folder() {
        let parent = tempfile::tempdir().unwrap();
        std::fs::create_dir(parent.path().join("Notes")).unwrap();
        std::fs::write(parent.path().join("Notes/keep.md"), b"x").unwrap();
        let dir = prepare_clone_dir(parent.path(), "Notes").unwrap();
        assert_eq!(dir, parent.path().join("Notes-2"));
    }

    #[test]
    fn prepare_clone_dir_survives_a_hostile_name() {
        let parent = tempfile::tempdir().unwrap();
        let dir = prepare_clone_dir(parent.path(), "../..//:*?").unwrap();
        assert_eq!(dir, parent.path().join("workspace"));
    }

    fn doc(slug: &str, ws: Option<&str>) -> DocInfo {
        DocInfo {
            slug: slug.into(),
            title: None,
            folder_id: None,
            workspace_id: ws.map(Into::into),
        }
    }
    fn folder(id: &str, ws: Option<&str>) -> FolderInfo {
        FolderInfo {
            id: id.into(),
            parent_id: None,
            name: id.into(),
            workspace_id: ws.map(Into::into),
        }
    }

    #[test]
    fn filter_keeps_only_the_target_workspace() {
        let docs = vec![doc("a", Some("w1")), doc("b", Some("w2")), doc("c", None)];
        let folders = vec![folder("f1", Some("w1")), folder("f2", Some("w2"))];
        let (docs, folders) = filter_workspace(docs, folders, "w1");
        assert_eq!(
            docs.iter().map(|d| d.slug.as_str()).collect::<Vec<_>>(),
            vec!["a"]
        );
        assert_eq!(
            folders.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(),
            vec!["f1"]
        );
    }
}
