//! Recursive directory tree builder for the workspace filesystem module.

use std::io;
use std::path::Path;

use serde::Serialize;

/// A node in the workspace file tree.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<WorkspaceNode>>,
}

/// Returns true if the given filename should be excluded from the tree.
/// Skips all dotfiles/dot-dirs (anything starting with '.'), which includes
/// .git, .obsidian, .muesli, .trash, and any hidden file.
fn should_skip(name: &str) -> bool {
    name.starts_with('.')
}

/// Build a recursive `WorkspaceNode` tree rooted at `root`.
///
/// Rules:
/// - Only `.md` files and directories are included.
/// - Dotfiles and specific dot-dirs (`.git`, `.obsidian`, `.muesli`, `.trash`) are skipped.
/// - Within each directory: folders first (alphabetical, case-insensitive), then files
///   (alphabetical, case-insensitive).
pub fn build_tree(root: &Path) -> io::Result<WorkspaceNode> {
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned());

    let path = root.to_string_lossy().into_owned();

    if root.is_dir() {
        let mut dirs: Vec<WorkspaceNode> = Vec::new();
        let mut files: Vec<WorkspaceNode> = Vec::new();

        let entries = std::fs::read_dir(root)?;

        for entry in entries {
            let entry = entry?;
            let entry_name = entry.file_name().to_string_lossy().into_owned();

            // Skip dotfiles/dot-dirs
            if should_skip(&entry_name) {
                continue;
            }

            let entry_path = entry.path();
            let file_type = entry.file_type()?;

            if file_type.is_dir() {
                dirs.push(build_tree(&entry_path)?);
            } else if file_type.is_file() {
                // Only include .md files
                if entry_path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case("md"))
                    .unwrap_or(false)
                {
                    files.push(WorkspaceNode {
                        name: entry_name,
                        path: entry_path.to_string_lossy().into_owned(),
                        is_dir: false,
                        children: None,
                    });
                }
            }
        }

        // Sort folders case-insensitively
        dirs.sort_by_key(|d| d.name.to_lowercase());
        // Sort files case-insensitively
        files.sort_by_key(|f| f.name.to_lowercase());

        let mut children = dirs;
        children.extend(files);

        Ok(WorkspaceNode {
            name,
            path,
            is_dir: true,
            children: Some(children),
        })
    } else {
        Ok(WorkspaceNode {
            name,
            path,
            is_dir: false,
            children: None,
        })
    }
}

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

    /// Build a tree with: a.md, z.md, sub/b.md, .hidden/x.md, note.txt
    /// Expected: sub (dir) before a.md before z.md; note.txt and .hidden excluded;
    ///           sub has child b.md.
    #[test]
    fn tree_shape_filter_sort() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        mkfile(root, "a.md");
        mkfile(root, "z.md");
        mkfile(root, "sub/b.md");
        mkfile(root, ".hidden/x.md");
        mkfile(root, "note.txt");

        let tree = build_tree(root).unwrap();

        assert!(tree.is_dir);
        let children = tree.children.unwrap();

        // sub directory first, then a.md, then z.md
        assert_eq!(
            children.len(),
            3,
            "expected sub + a.md + z.md, got: {:?}",
            children.iter().map(|c| &c.name).collect::<Vec<_>>()
        );
        assert_eq!(children[0].name, "sub");
        assert!(children[0].is_dir);
        assert_eq!(children[1].name, "a.md");
        assert!(!children[1].is_dir);
        assert_eq!(children[2].name, "z.md");
        assert!(!children[2].is_dir);

        // sub has exactly b.md
        let sub_children = children[0].children.as_ref().unwrap();
        assert_eq!(sub_children.len(), 1);
        assert_eq!(sub_children[0].name, "b.md");
    }

    /// Verify that .hidden dirs and non-.md files are excluded.
    #[test]
    fn dotfiles_and_non_md_excluded() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        mkfile(root, "note.txt");
        mkfile(root, "image.png");
        mkfile(root, ".git/config");
        mkfile(root, ".obsidian/config");
        mkfile(root, "valid.md");

        let tree = build_tree(root).unwrap();
        let children = tree.children.unwrap();

        assert_eq!(children.len(), 1);
        assert_eq!(children[0].name, "valid.md");
    }
}
