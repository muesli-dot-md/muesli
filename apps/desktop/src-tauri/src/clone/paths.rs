//! Inverse of muesli's slug-from-path naming: rebuild on-disk `.md` paths from the
//! server's folder + document rows so the clone can lay out a workspace as a Finder tree.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use muesli_cli::api::{DocInfo, FolderInfo};

/// One document's planned location under the clone root.
pub struct PlannedFile {
    pub slug: String,
    pub rel_path: PathBuf,
}

/// Compute a deterministic relative `.md` path for every document. Directory = the folder
/// name chain (root → `folder_id`); filename = sanitized title (else slug) + `.md`, with
/// numeric suffixes resolving same-directory collisions. Deterministic in slug order so a
/// re-clone reproduces identical paths (the basis for resumability via the link index).
pub fn plan_layout(docs: &[DocInfo], folders: &[FolderInfo]) -> Vec<PlannedFile> {
    let by_id: HashMap<&str, &FolderInfo> = folders.iter().map(|f| (f.id.as_str(), f)).collect();

    let mut ordered: Vec<&DocInfo> = docs.iter().collect();
    ordered.sort_by(|a, b| a.slug.cmp(&b.slug));

    // Per-directory set of taken filenames (without extension) for collision suffixing.
    let mut taken: HashMap<PathBuf, HashSet<String>> = HashMap::new();
    let mut out = Vec::with_capacity(ordered.len());
    for doc in ordered {
        let dir: PathBuf = dir_segments(doc.folder_id.as_deref(), &by_id).iter().collect();
        let base = {
            let raw = doc.title.as_deref().filter(|t| !t.trim().is_empty()).unwrap_or(&doc.slug);
            let s = sanitize_segment(raw);
            if s.is_empty() { sanitize_segment(&doc.slug) } else { s }
        };
        let stem = unique_stem(&base, taken.entry(dir.clone()).or_default());
        let rel_path = dir.join(format!("{stem}.md"));
        out.push(PlannedFile { slug: doc.slug.clone(), rel_path });
    }
    out
}

/// Build directory segments (root → folder) for a given folder_id.
/// Guards against cycles and orphan references.
fn dir_segments<'a>(
    mut folder_id: Option<&'a str>,
    by_id: &HashMap<&'a str, &'a FolderInfo>,
) -> Vec<String> {
    let mut chain: Vec<String> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    while let Some(id) = folder_id {
        let Some(folder) = by_id.get(id) else { break }; // orphan ref → stop (root-ish)
        if !seen.insert(id) {
            break; // cycle guard
        }
        chain.push(sanitize_segment(&folder.name));
        folder_id = folder.parent_id.as_deref();
    }
    chain.reverse();
    chain
}

/// Fold path separators, control chars, reserved filename characters, and whitespace runs
/// to single dashes; trim leading/trailing dashes and dots.
fn sanitize_segment(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut pending_dash = false;
    for ch in name.chars() {
        let bad = ch.is_control()
            || ch.is_whitespace()
            || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|');
        if bad {
            pending_dash = true;
        } else {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch);
        }
    }
    out.trim().trim_matches(|c| c == '-' || c == '.').to_string()
}

/// `base`, or `base-2`, `base-3`, … until free in `taken`. Records the result in `taken`.
fn unique_stem(base: &str, taken: &mut HashSet<String>) -> String {
    let base = if base.is_empty() { "untitled".to_string() } else { base.to_string() };
    if taken.insert(base.clone()) {
        return base;
    }
    for n in 2.. {
        let candidate = format!("{base}-{n}");
        if taken.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use muesli_cli::api::{DocInfo, FolderInfo};
    use std::path::PathBuf;

    fn folder(id: &str, parent: Option<&str>, name: &str) -> FolderInfo {
        FolderInfo {
            id: id.into(),
            parent_id: parent.map(Into::into),
            name: name.into(),
            workspace_id: Some("w1".into()),
        }
    }
    fn doc(slug: &str, title: Option<&str>, folder: Option<&str>) -> DocInfo {
        DocInfo {
            slug: slug.into(),
            title: title.map(Into::into),
            folder_id: folder.map(Into::into),
            workspace_id: Some("w1".into()),
        }
    }

    #[test]
    fn root_doc_uses_title_then_slug() {
        let plan = plan_layout(&[doc("welcome", Some("Welcome"), None)], &[]);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].slug, "welcome");
        assert_eq!(plan[0].rel_path, PathBuf::from("Welcome.md"));
    }

    #[test]
    fn missing_title_falls_back_to_slug() {
        let plan = plan_layout(&[doc("abc-123", None, None)], &[]);
        assert_eq!(plan[0].rel_path, PathBuf::from("abc-123.md"));
    }

    #[test]
    fn nested_folders_become_directories() {
        let folders = vec![
            folder("f1", None, "Projects"),
            folder("f2", Some("f1"), "Muesli"),
        ];
        let plan = plan_layout(&[doc("spec", Some("Spec"), Some("f2"))], &folders);
        assert_eq!(plan[0].rel_path, PathBuf::from("Projects/Muesli/Spec.md"));
    }

    #[test]
    fn unsafe_title_chars_are_sanitized() {
        let plan = plan_layout(&[doc("s", Some("a/b: c?"), None)], &[]);
        assert_eq!(plan[0].rel_path, PathBuf::from("a-b-c.md"));
    }

    #[test]
    fn duplicate_names_in_same_dir_get_suffixes_deterministically() {
        // Two docs, same title, same (root) dir. Sorted by slug: "a" first, "b" second.
        let plan = plan_layout(
            &[doc("b", Some("Notes"), None), doc("a", Some("Notes"), None)],
            &[],
        );
        let by_slug: std::collections::HashMap<_, _> =
            plan.iter().map(|p| (p.slug.as_str(), p.rel_path.clone())).collect();
        assert_eq!(by_slug["a"], PathBuf::from("Notes.md"));
        assert_eq!(by_slug["b"], PathBuf::from("Notes-2.md"));
    }

    #[test]
    fn orphan_folder_ref_falls_back_to_root() {
        // folder_id points at a folder not in the list → place at root, never panic.
        let plan = plan_layout(&[doc("x", Some("X"), Some("missing"))], &[]);
        assert_eq!(plan[0].rel_path, PathBuf::from("X.md"));
    }
}
