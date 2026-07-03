//! Link-graph builder — scans a workspace's `.md` files for `[[wikilinks]]` and
//! returns the node/edge set the desktop graph view renders (ADR 0015,
//! design/wikilinks-and-link-graph.md). This mirrors the webapp's server-side
//! `getGraph()` shape so the desktop `GraphView.svelte` can share the same
//! force-sim assembly: every note is a node, resolved wikilinks are edges, and
//! unresolved targets surface as ghost nodes on the JS side.
//!
//! Resolution uses the same `slugify` rule as the markdown renderer
//! (`src/lib/markdown/render.ts`): a `[[Target]]` resolves to whichever note has
//! a matching slug. Notes are keyed by the slug of their **basename** (sans
//! `.md`), which is the desktop's filename-based identity.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

/// A note in the link graph (one per `.md` file).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    /// Absolute path — the id the frontend opens on click.
    pub id: String,
    /// Slug of the basename (resolution key, shared with wikilink targets).
    pub slug: String,
    /// Display label (basename without the `.md` extension).
    pub title: String,
    /// Count of resolved outgoing wikilinks.
    pub links_out: usize,
    /// Count of resolved incoming wikilinks.
    pub links_in: usize,
}

/// A resolved edge between two notes, by node id (absolute path).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    /// Source node id (absolute path).
    pub src: String,
    /// Destination node id (absolute path).
    pub dst: String,
}

/// An unresolved wikilink — a `[[Target]]` naming a note that doesn't exist.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedLink {
    /// Source node id (absolute path) that contains the link.
    pub src: String,
    /// The raw link target text (pre-slugify, for the ghost node's label).
    pub raw_target: String,
}

/// The full graph payload.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub unresolved: Vec<UnresolvedLink>,
}

/// Wikilink target -> slug. Mirrors `slugify` in `src/lib/markdown/render.ts`:
/// trim, lowercase, spaces -> '-', strip everything but `[a-z0-9_-]`, collapse
/// runs of '-', trim leading/trailing '-'.
pub fn slugify(s: &str) -> String {
    let lowered = s.trim().to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    let mut prev_dash = false;
    for ch in lowered.chars() {
        let mapped = if ch.is_whitespace() {
            Some('-')
        } else if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            Some(ch)
        } else {
            None
        };
        match mapped {
            Some('-') => {
                if !prev_dash {
                    out.push('-');
                    prev_dash = true;
                }
            }
            Some(c) => {
                out.push(c);
                prev_dash = false;
            }
            None => {}
        }
    }
    out.trim_matches('-').to_string()
}

/// Extract the raw `[[Target]]` / `[[Target|label]]` targets from markdown text.
/// Mirrors the renderer's wikilink tokenizer regex
/// (`^\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]+?))?\]\]`): the target is the text before
/// an optional `|`, and may not contain `[`, `]`, `|`, or a newline. The label
/// part is ignored here (graph resolution only needs the target).
pub fn extract_wikilink_targets(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut targets = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            // Scan the target: until '|', ']', '[', or newline.
            let start = i + 2;
            let mut j = start;
            let mut terminated_ok = false;
            while j < bytes.len() {
                let c = bytes[j];
                if c == b'\n' || c == b'[' {
                    break; // invalid — no closing within this run
                }
                if c == b'|' || c == b']' {
                    terminated_ok = true;
                    break;
                }
                j += 1;
            }
            if terminated_ok && j > start {
                // Require the link to actually close with `]]` (skipping an
                // optional `|label` segment that itself must stay on one line).
                let mut k = j;
                if bytes[k] == b'|' {
                    k += 1;
                    while k < bytes.len() {
                        let c = bytes[k];
                        if c == b'\n' || c == b'[' || c == b'|' || c == b']' {
                            break;
                        }
                        k += 1;
                    }
                }
                if k + 1 < bytes.len() && bytes[k] == b']' && bytes[k + 1] == b']' {
                    let target = text[start..j].trim().to_string();
                    if !target.is_empty() {
                        targets.push(target);
                    }
                    i = k + 2;
                    continue;
                }
            }
        }
        i += 1;
    }
    targets
}

fn is_md(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

/// Walk `dir`, collecting `(absolute_path, basename_without_md)` for every `.md`
/// file. Skips dotfiles/dot-dirs to match the tree/search walks.
fn collect_md(dir: &Path, out: &mut Vec<(std::path::PathBuf, String)>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(f) => f,
            Err(_) => continue,
        };
        if ft.is_dir() {
            collect_md(&path, out);
        } else if ft.is_file() && is_md(&path) {
            let stem = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| name.clone());
            out.push((path, stem));
        }
    }
}

/// Build the link graph from a slice of `(path, basename, contents)`. Pure (no
/// filesystem) so the resolution logic is unit-testable.
fn build_graph(files: &[(String, String, String)]) -> LinkGraph {
    // Map slug -> node index, for resolution. First writer wins on slug clashes
    // (deterministic given the caller's ordering).
    let mut by_slug: HashMap<String, usize> = HashMap::new();
    let mut nodes: Vec<GraphNode> = Vec::with_capacity(files.len());
    for (path, title, _) in files {
        let slug = slugify(title);
        let idx = nodes.len();
        by_slug.entry(slug.clone()).or_insert(idx);
        nodes.push(GraphNode {
            id: path.clone(),
            slug,
            title: title.clone(),
            links_out: 0,
            links_in: 0,
        });
    }

    let mut edges: Vec<GraphEdge> = Vec::new();
    let mut unresolved: Vec<UnresolvedLink> = Vec::new();
    for (src_i, (path, _, contents)) in files.iter().enumerate() {
        for raw in extract_wikilink_targets(contents) {
            let slug = slugify(&raw);
            if slug.is_empty() {
                continue;
            }
            match by_slug.get(&slug) {
                Some(&dst_i) if dst_i != src_i => {
                    nodes[src_i].links_out += 1;
                    nodes[dst_i].links_in += 1;
                    edges.push(GraphEdge {
                        src: path.clone(),
                        dst: files[dst_i].0.clone(),
                    });
                }
                Some(_) => {} // self-link — drop (matches webapp a===b skip)
                None => unresolved.push(UnresolvedLink {
                    src: path.clone(),
                    raw_target: raw,
                }),
            }
        }
    }

    LinkGraph {
        nodes,
        edges,
        unresolved,
    }
}

/// Scan the workspace at `root` for `.md` notes and their `[[wikilinks]]`,
/// returning the node/edge/unresolved set for the graph view.
#[tauri::command]
pub fn build_link_graph(root: String) -> Result<LinkGraph, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let mut md: Vec<(std::path::PathBuf, String)> = Vec::new();
    collect_md(root_path, &mut md);

    let files: Vec<(String, String, String)> = md
        .into_iter()
        .map(|(path, title)| {
            let contents = std::fs::read_to_string(&path).unwrap_or_default();
            (path.to_string_lossy().into_owned(), title, contents)
        })
        .collect();

    Ok(build_graph(&files))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_matches_renderer_rules() {
        assert_eq!(slugify("Hello World"), "hello-world");
        assert_eq!(slugify("  Trim  Me  "), "trim-me");
        assert_eq!(slugify("Café & Crème!"), "caf-crme");
        assert_eq!(slugify("Multiple   Spaces"), "multiple-spaces");
        assert_eq!(slugify("--edge-dashes--"), "edge-dashes");
        assert_eq!(slugify("UPPER_case-123"), "upper_case-123");
        assert_eq!(slugify("!!!"), "");
    }

    #[test]
    fn extracts_wikilink_targets_with_and_without_labels() {
        let text = "See [[Alpha]] and [[Beta|the second]] plus [[ Gamma ]].";
        assert_eq!(
            extract_wikilink_targets(text),
            vec!["Alpha".to_string(), "Beta".to_string(), "Gamma".to_string()]
        );
    }

    #[test]
    fn ignores_malformed_or_empty_wikilinks() {
        // Unclosed, empty, nested-bracket, and newline-broken links are skipped;
        // only the well-formed [[ok]] survives.
        let text = "[[unclosed and [[]] and [[a\nb]] and [[ok]]";
        assert_eq!(extract_wikilink_targets(text), vec!["ok".to_string()]);
    }

    #[test]
    fn build_graph_resolves_edges_and_ghosts() {
        let files = vec![
            (
                "/v/Alpha.md".to_string(),
                "Alpha".to_string(),
                "Link to [[Beta]] and [[Ghost Note]].".to_string(),
            ),
            (
                "/v/Beta.md".to_string(),
                "Beta".to_string(),
                "Back to [[Alpha]] and self [[Beta]].".to_string(),
            ),
        ];
        let g = build_graph(&files);

        assert_eq!(g.nodes.len(), 2);
        // Alpha->Beta and Beta->Alpha resolve; Beta->Beta self-link dropped.
        assert_eq!(g.edges.len(), 2);
        // Exactly one unresolved target: "Ghost Note".
        assert_eq!(g.unresolved.len(), 1);
        assert_eq!(g.unresolved[0].raw_target, "Ghost Note");
        assert_eq!(g.unresolved[0].src, "/v/Alpha.md");

        let alpha = g.nodes.iter().find(|n| n.title == "Alpha").unwrap();
        let beta = g.nodes.iter().find(|n| n.title == "Beta").unwrap();
        // Alpha: one resolved out (Beta), one in (from Beta).
        assert_eq!(alpha.links_out, 1);
        assert_eq!(alpha.links_in, 1);
        // Beta: one resolved out (Alpha) — self-link excluded — one in (from Alpha).
        assert_eq!(beta.links_out, 1);
        assert_eq!(beta.links_in, 1);
    }

    #[test]
    fn case_insensitive_resolution_via_slug() {
        let files = vec![
            (
                "/v/Note A.md".to_string(),
                "Note A".to_string(),
                "[[note a]] is a self link; [[NOTE B]] resolves.".to_string(),
            ),
            ("/v/Note B.md".to_string(), "Note B".to_string(), "".to_string()),
        ];
        let g = build_graph(&files);
        // self-link dropped, [[NOTE B]] resolves to Note B.
        assert_eq!(g.edges.len(), 1);
        assert_eq!(g.edges[0].src, "/v/Note A.md");
        assert_eq!(g.edges[0].dst, "/v/Note B.md");
        assert!(g.unresolved.is_empty());
    }
}
