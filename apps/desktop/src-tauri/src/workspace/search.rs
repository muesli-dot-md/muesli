//! Workspace search — case-insensitive search over note filenames and contents.

use std::path::Path;

use serde::Serialize;

/// A single search result.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// Absolute path to the note.
    pub path: String,
    /// Workspace-relative path (for display).
    pub display: String,
    /// File basename.
    pub name: String,
    /// Whether the query matched the filename.
    pub name_match: bool,
    /// First content line containing the query (trimmed, truncated).
    pub snippet: Option<String>,
    /// 1-based line number of the snippet.
    pub line: Option<usize>,
    /// Total number of content lines containing the query.
    pub matches: usize,
}

fn is_md(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

/// Search a single file. Returns a hit if the filename or any content line
/// matches `q` (already lowercased).
fn scan_file(path: &Path, root: &Path, q: &str) -> Option<SearchHit> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    let display = path
        .strip_prefix(root)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());

    let name_match = name.to_lowercase().contains(q);

    let content = std::fs::read_to_string(path).unwrap_or_default();
    let mut matches = 0usize;
    let mut first: Option<(usize, String)> = None;
    for (i, line) in content.lines().enumerate() {
        if line.to_lowercase().contains(q) {
            matches += 1;
            if first.is_none() {
                let snip: String = line.trim().chars().take(160).collect();
                first = Some((i + 1, snip));
            }
        }
    }

    if !name_match && matches == 0 {
        return None;
    }

    let (line, snippet) = match first {
        Some((l, s)) => (Some(l), Some(s)),
        None => (None, None),
    };

    Some(SearchHit {
        path: path.to_string_lossy().into_owned(),
        display,
        name,
        name_match,
        snippet,
        line,
        matches,
    })
}

fn walk(dir: &Path, root: &Path, q: &str, out: &mut Vec<SearchHit>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Skip dotfiles/dot-dirs (.git, .obsidian, .trash, …)
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(f) => f,
            Err(_) => continue,
        };
        if ft.is_dir() {
            walk(&path, root, q, out);
        } else if ft.is_file() && is_md(&path) {
            if let Some(hit) = scan_file(&path, root, q) {
                out.push(hit);
            }
        }
    }
}

/// Search the workspace rooted at `root` for `query` across note filenames and
/// contents. Returns up to 200 hits, filename matches first, then by content
/// match count, then alphabetically. An empty/whitespace query returns no hits.
#[tauri::command]
pub fn search_workspace(root: String, query: String) -> Result<Vec<SearchHit>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }

    let mut hits: Vec<SearchHit> = Vec::new();
    walk(root_path, root_path, &q, &mut hits);

    hits.sort_by(|a, b| {
        b.name_match
            .cmp(&a.name_match)
            .then(b.matches.cmp(&a.matches))
            .then(a.display.to_lowercase().cmp(&b.display.to_lowercase()))
    });
    hits.truncate(200);

    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use tempfile::TempDir;

    fn mkfile(dir: &Path, rel: &str, body: &str) {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&p, body).unwrap();
    }

    #[test]
    fn finds_name_and_content_matches() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        mkfile(root, "Recipes.md", "nothing here");
        mkfile(root, "notes/groceries.md", "buy apples\nand RECIPE ideas");
        mkfile(root, ".hidden/secret.md", "recipe");

        let root_s = root.to_string_lossy().into_owned();
        let hits = search_workspace(root_s, "recipe".into()).unwrap();

        // Recipes.md (name match) + groceries.md (content match); hidden excluded.
        assert_eq!(hits.len(), 2);
        // filename match sorts first
        assert_eq!(hits[0].name, "Recipes.md");
        assert!(hits[0].name_match);
        // content hit carries a snippet + line
        let g = hits.iter().find(|h| h.name == "groceries.md").unwrap();
        assert!(!g.name_match);
        assert_eq!(g.matches, 1);
        assert_eq!(g.line, Some(2));
        assert!(g.snippet.as_deref().unwrap().contains("RECIPE"));
    }

    #[test]
    fn empty_query_returns_nothing() {
        let tmp = TempDir::new().unwrap();
        mkfile(tmp.path(), "a.md", "hello");
        let hits = search_workspace(tmp.path().to_string_lossy().into_owned(), "  ".into()).unwrap();
        assert!(hits.is_empty());
    }
}
