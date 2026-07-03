//! Cross-document link graph (ADR 0015; docs/design/wikilinks-and-link-graph.md).
//!
//! Three parts:
//!
//! 1. **Extraction** — pure functions turning markdown text into [`ExtractedLink`]s:
//!    wikilinks (`[[Target]]` / `[[Target|label]]` / `[[Target#Heading]]`) and *relative*
//!    markdown links (`[x](./foo.md)`, `[x](foo.md)`). Links inside fenced code blocks or
//!    inline code spans don't count, mirroring the web preview (render.ts), where marked's
//!    lexer consumes code before the wikilink tokenizer can fire. [`slugify`] is a 1:1 port
//!    of render.ts `slugify` — the parity fixtures in both test suites pin them together.
//!
//! 2. **Indexing** — [`LinkIndexer`]: rooms ping `mark_dirty` after every persisted update
//!    (the same seam as StorageManager materialization); the indexer debounces ~2s per
//!    document, materializes the text straight from Postgres (snapshot + tail — no room
//!    dependency), re-extracts, and diff-updates `document_links` in one transaction.
//!    Room hydration pings `doc_hydrated`, which (a) re-points unresolved links whose
//!    target slugifies to this document (the "a matching doc appeared" trigger) and
//!    (b) lazily backfills documents that predate the index. Volatile mode has no
//!    indexer at all — rooms simply hold no handle.
//!
//! 3. **REST** — `GET /api/graph` (the whole visible graph: nodes/edges/unresolved) and
//!    `GET /api/documents/{slug}/links` (outgoing + incoming for the backlinks panel).
//!
//! Resolution scope note: `documents.slug` is globally unique and *is* the identity the
//! web client navigates by (render.ts renders `[[Target]]` as `#slugify(target)`), so
//! resolution is slug-first; `target_path` additionally matches `documents.rel_path` for
//! storage-attached documents. Title-based resolution falls out of slug matching because
//! slugs are minted from titles (DocumentsMenu createDoc).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::{debug, warn};
use uuid::Uuid;

use crate::persistence::Persistence;
use crate::AppState;

// ---------------------------------------------------------------------------
// slugify — exact port of apps/web/src/render.ts slugify()
// ---------------------------------------------------------------------------

/// Wikilink target -> slug: trim, lowercase, whitespace runs -> '-', strip everything
/// outside [a-z0-9_-], collapse '-' runs, trim '-'. Must stay byte-for-byte compatible
/// with render.ts (the web client navigates wikilinks by this slug); the shared fixtures
/// live in [`tests::SLUGIFY_FIXTURES`] and apps/web/scripts/render-test.mjs.
pub fn slugify(s: &str) -> String {
    // Step order matters and mirrors the JS chain exactly.
    let lowered = s.trim().to_lowercase();
    // /\s+/g -> "-"
    let mut dashed = String::with_capacity(lowered.len());
    let mut in_ws = false;
    for c in lowered.chars() {
        if c.is_whitespace() {
            if !in_ws {
                dashed.push('-');
                in_ws = true;
            }
        } else {
            dashed.push(c);
            in_ws = false;
        }
    }
    // /[^a-z0-9_-]/g -> ""
    let filtered: String = dashed
        .chars()
        .filter(|c| matches!(c, 'a'..='z' | '0'..='9' | '_' | '-'))
        .collect();
    // /-+/g -> "-" then trim '-'
    let mut out = String::with_capacity(filtered.len());
    let mut prev_dash = false;
    for c in filtered.chars() {
        if c == '-' {
            if !prev_dash {
                out.push('-');
            }
            prev_dash = true;
        } else {
            out.push(c);
            prev_dash = false;
        }
    }
    out.trim_matches('-').to_string()
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/// One link occurrence, normalized for resolution but keeping the raw text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedLink {
    /// The target exactly as written (wikilink target incl. any `#fragment`; md link href).
    pub raw_target: String,
    /// render.ts-compatible slug of the target (fragment and `.md` stripped first).
    pub target_slug: String,
    /// Cleaned relative path (md links / path-style wikilinks), for `rel_path` matching.
    pub target_path: Option<String>,
}

/// Does `line` open/close a fenced code block? Returns the fence string (e.g. "```").
/// CommonMark-lite: up to 3 leading spaces, then >= 3 backticks or tildes.
fn fence_of(line: &str) -> Option<(char, usize)> {
    let trimmed = line.strip_prefix("   ").or_else(|| line.strip_prefix("  "))
        .or_else(|| line.strip_prefix(' '))
        .unwrap_or(line);
    let mut chars = trimmed.chars();
    let first = chars.next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let run = 1 + chars.take_while(|&c| c == first).count();
    if run >= 3 {
        Some((first, run))
    } else {
        None
    }
}

/// Extract wikilinks + relative markdown links from `text`, skipping fenced code blocks
/// and inline code spans (mirroring how the preview never renders wikilinks there).
/// Deduplicated by `raw_target` (the table's primary key), in first-seen order.
pub fn extract_links(text: &str) -> Vec<ExtractedLink> {
    let mut out: Vec<ExtractedLink> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut fence: Option<(char, usize)> = None;

    for line in text.lines() {
        if let Some((open_ch, open_len)) = fence {
            // Inside a fence: only a closing fence of the same char and >= length matters.
            if let Some((ch, len)) = fence_of(line) {
                if ch == open_ch && len >= open_len {
                    fence = None;
                }
            }
            continue;
        }
        if let Some(f) = fence_of(line) {
            fence = Some(f);
            continue;
        }
        scan_line(line, &mut out, &mut seen);
    }
    out
}

/// Scan one non-fence line: skip inline code spans (`` `…` ``, CommonMark run-length
/// matching), recognize `[[…]]` and `[text](dest)`.
fn scan_line(line: &str, out: &mut Vec<ExtractedLink>, seen: &mut HashSet<String>) {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'`' => {
                // A backtick run of length n opens a span closed by a run of exactly n.
                let run = bytes[i..].iter().take_while(|&&b| b == b'`').count();
                let rest = &line[i + run..];
                if let Some(close) = find_backtick_run(rest, run) {
                    i += run + close + run; // skip the whole code span
                } else {
                    i += run; // unmatched backticks: literal text
                }
            }
            b'[' if bytes.get(i + 1) == Some(&b'[') => {
                if let Some((link, consumed)) = parse_wikilink(&line[i..]) {
                    push_link(link, out, seen);
                    i += consumed;
                } else {
                    i += 1;
                }
            }
            b'[' => {
                if let Some((link, consumed)) = parse_md_link(&line[i..]) {
                    if let Some(link) = link {
                        push_link(link, out, seen);
                    }
                    i += consumed;
                } else {
                    i += 1;
                }
            }
            _ => i += 1,
        }
    }
}

fn push_link(link: ExtractedLink, out: &mut Vec<ExtractedLink>, seen: &mut HashSet<String>) {
    if seen.insert(link.raw_target.clone()) {
        out.push(link);
    }
}

/// Position of a backtick run of *exactly* `n` in `s`, returning the offset of its start.
fn find_backtick_run(s: &str, n: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let run = bytes[i..].iter().take_while(|&&b| b == b'`').count();
            if run == n {
                return Some(i);
            }
            i += run;
        } else {
            i += 1;
        }
    }
    None
}

/// `[[target]]` / `[[target|label]]` at the start of `s` — the same shape render.ts
/// matches: target has no `[`, `]`, `|`; label has no `[`, `]`. Returns (link, bytes
/// consumed). The target may carry a `#Heading` fragment; the index records a link to
/// the *document* (the fragment resolves at navigation time, per the design doc).
fn parse_wikilink(s: &str) -> Option<(ExtractedLink, usize)> {
    let inner_start = 2; // past "[["
    let rest = &s[inner_start..];
    let close = rest.find("]]")?;
    let inner = &rest[..close];
    if inner.contains('[') || inner.contains(']') {
        return None;
    }
    let target = match inner.split_once('|') {
        Some((t, _label)) => t,
        None => inner,
    };
    if target.contains('|') {
        return None; // unreachable, kept for clarity
    }
    let raw_target = target.trim().to_string();
    // Resolution uses the document part only; `#Heading` is a render/nav-time concern.
    let name = raw_target.split('#').next().unwrap_or("").trim();
    let name = name.strip_suffix(".md").unwrap_or(name);
    let target_slug = slugify(name);
    if target_slug.is_empty() {
        return None; // matches render.ts: an empty slug isn't a wikilink
    }
    let target_path = if name.contains('/') {
        Some(format!("{}.md", clean_rel_path(name)))
    } else {
        None
    };
    let consumed = inner_start + close + 2;
    Some((ExtractedLink { raw_target, target_slug, target_path }, consumed))
}

/// `[text](dest)` at the start of `s`. Returns (Some(link) | None-for-skipped, bytes
/// consumed) — http(s):/mailto:/any-scheme, `#fragment`, absolute paths, and non-`.md`
/// destinations consume the link syntax but index nothing.
fn parse_md_link(s: &str) -> Option<(Option<ExtractedLink>, usize)> {
    let close_text = s.find(']')?;
    let after = &s[close_text + 1..];
    if !after.starts_with('(') {
        return None;
    }
    let close_paren = after.find(')')?;
    let consumed = close_text + 1 + close_paren + 1;
    let dest = after[1..close_paren].trim();
    // `<dest>` form, and an optional "title" after whitespace.
    let dest = dest.strip_prefix('<').and_then(|d| d.strip_suffix('>')).unwrap_or_else(|| {
        dest.split_whitespace().next().unwrap_or("")
    });
    if dest.is_empty() || dest.starts_with('#') || dest.starts_with('/') || has_scheme(dest) {
        return Some((None, consumed));
    }
    let raw_target = dest.to_string();
    // Strip any fragment, then require a .md target — only document links are indexed.
    let path_part = dest.split('#').next().unwrap_or("");
    let Some(stem) = path_part.strip_suffix(".md").or_else(|| path_part.strip_suffix(".MD"))
    else {
        return Some((None, consumed));
    };
    let cleaned = clean_rel_path(stem);
    if cleaned.is_empty() {
        return Some((None, consumed));
    }
    let basename = cleaned.rsplit('/').next().unwrap_or(&cleaned);
    let target_slug = slugify(basename);
    if target_slug.is_empty() {
        return Some((None, consumed));
    }
    let link = ExtractedLink {
        raw_target,
        target_slug,
        target_path: Some(format!("{cleaned}.md")),
    };
    Some((Some(link), consumed))
}

/// `scheme:` per RFC 3986 (letter, then letters/digits/+/-/.) — http:, https:, mailto:, …
fn has_scheme(dest: &str) -> bool {
    let Some(colon) = dest.find(':') else { return false };
    let scheme = &dest[..colon];
    let mut chars = scheme.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

/// Drop leading `./` and `../` segments (resolution is workspace-flat; documents.rel_path
/// is connection-root-relative).
fn clean_rel_path(p: &str) -> String {
    let mut rest = p.trim_start_matches('/');
    loop {
        if let Some(r) = rest.strip_prefix("./") {
            rest = r;
        } else if let Some(r) = rest.strip_prefix("../") {
            rest = r;
        } else {
            break;
        }
    }
    rest.to_string()
}

// ---------------------------------------------------------------------------
// LinkIndexer — debounce + extract + diff-update (the mark_dirty seam)
// ---------------------------------------------------------------------------

/// Re-extract ~2s after the burst of edits goes quiet (slower than storage's 500ms —
/// link rows are pure derived data, freshness is not user-blocking).
const LINK_DEBOUNCE: Duration = Duration::from_secs(2);

enum LinkEvent {
    /// A persisted update landed; re-extract (debounced).
    Dirty(Uuid),
    /// A room hydrated this document: re-resolve links *to* it, backfill links *from* it.
    Hydrated(Uuid),
}

/// What rooms hold: fire-and-forget pings (never blocks the room actor). Absent in
/// volatile mode — the silent skip the design doc asks for.
#[derive(Clone)]
pub struct LinkHandle {
    tx: mpsc::UnboundedSender<LinkEvent>,
}

impl LinkHandle {
    pub fn mark_dirty(&self, document_id: Uuid) {
        let _ = self.tx.send(LinkEvent::Dirty(document_id));
    }
    pub fn doc_hydrated(&self, document_id: Uuid) {
        let _ = self.tx.send(LinkEvent::Hydrated(document_id));
    }
}

pub struct LinkIndexer {
    persistence: Arc<Persistence>,
    handle: LinkHandle,
}

impl LinkIndexer {
    pub fn spawn(persistence: Arc<Persistence>) -> Arc<LinkIndexer> {
        let (tx, rx) = mpsc::unbounded_channel();
        let indexer = Arc::new(LinkIndexer { persistence, handle: LinkHandle { tx } });
        tokio::spawn(event_loop(indexer.clone(), rx));
        indexer
    }

    pub fn handle(&self) -> LinkHandle {
        self.handle.clone()
    }

    /// Materialize the document's current text straight from Postgres (latest snapshot +
    /// full tail) — no dependency on a live room, so indexing never spawns one.
    async fn current_text(&self, document_id: Uuid) -> anyhow::Result<String> {
        let (snapshot, updates) = self.persistence.load_at(document_id, i64::MAX).await?;
        let doc = muesli_core::MuesliDoc::new();
        if let Some(snap) = snapshot {
            doc.apply_update(&snap).map_err(|e| anyhow::anyhow!("corrupt snapshot: {e}"))?;
        }
        for u in &updates {
            doc.apply_update(u).map_err(|e| anyhow::anyhow!("corrupt update: {e}"))?;
        }
        Ok(doc.materialize())
    }

    /// One indexing pass: extract from the current text and diff-update document_links.
    /// The search-text projection (migration 0009) rides the same pass — the text is
    /// already materialized here, so search stays in lockstep with the link rows.
    async fn reindex(&self, document_id: Uuid) -> anyhow::Result<()> {
        let text = self.current_text(document_id).await?;
        let links = extract_links(&text);
        let (inserted, deleted) =
            self.persistence.update_document_links(document_id, &links).await?;
        self.persistence.upsert_search_text(document_id, &text).await?;
        if inserted + deleted > 0 {
            debug!(%document_id, links = links.len(), inserted, deleted, "link index updated");
        }
        Ok(())
    }

    /// Hydration trigger: (a) unresolved links whose target slugifies to this document's
    /// slug now resolve (one indexed UPDATE); (b) documents that predate the link index
    /// get extracted once, lazily.
    async fn on_hydrated(&self, document_id: Uuid) -> anyhow::Result<()> {
        let Some(slug) = self.persistence.document_slug(document_id).await? else {
            return Ok(());
        };
        let resolved = self.persistence.resolve_links_to(document_id, &slug).await?;
        if resolved > 0 {
            debug!(%document_id, %slug, resolved, "unresolved links now point at this document");
        }
        if !self.persistence.has_links_from(document_id).await?
            || !self.persistence.has_search_text(document_id).await?
        {
            // Backfill: cheap no-op for genuinely link-less documents; the search-text
            // check additionally backfills projections for documents that predate
            // migration 0009 (one reindex writes both).
            self.handle.mark_dirty(document_id);
        }
        Ok(())
    }
}

/// Coalesce dirty pings per document (same pattern as storage::debounce_loop): a fresh
/// ping while a debounce task is pending restarts its window.
async fn event_loop(indexer: Arc<LinkIndexer>, mut rx: mpsc::UnboundedReceiver<LinkEvent>) {
    let mut pending: HashMap<Uuid, mpsc::UnboundedSender<()>> = HashMap::new();
    while let Some(event) = rx.recv().await {
        let doc_id = match event {
            LinkEvent::Hydrated(doc_id) => {
                let indexer = indexer.clone();
                tokio::spawn(async move {
                    if let Err(e) = indexer.on_hydrated(doc_id).await {
                        warn!(%doc_id, %e, "link re-resolution on hydration failed");
                    }
                });
                continue;
            }
            LinkEvent::Dirty(doc_id) => doc_id,
        };
        if let Some(tx) = pending.get(&doc_id) {
            if tx.send(()).is_ok() {
                continue; // an active debouncer absorbed the ping
            }
        }
        let (tx, mut reset) = mpsc::unbounded_channel();
        pending.insert(doc_id, tx);
        let indexer = indexer.clone();
        tokio::spawn(async move {
            loop {
                match tokio::time::timeout(LINK_DEBOUNCE, reset.recv()).await {
                    Ok(Some(())) => continue, // more edits — restart the window
                    _ => break,               // quiet (or shutdown): index now
                }
            }
            if let Err(e) = indexer.reindex(doc_id).await {
                warn!(%doc_id, %e, "link extraction failed (will retry on the next edit)");
            }
        });
    }
}

// ---------------------------------------------------------------------------
// REST: GET /api/graph and GET /api/documents/{slug}/links
// ---------------------------------------------------------------------------

const NO_DB: &str = "this endpoint requires DATABASE_URL (server is running volatile)";

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, msg.into()).into_response()
}

fn err500(e: anyhow::Error) -> Response {
    warn!(%e, "graph api error");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

/// GET /api/graph → { nodes, edges, unresolved }. Auth mirrors GET /api/documents:
/// open mode sees everything; OIDC mode scopes to documents visible to the principal
/// (ACL grant or workspace membership — list_documents_visible), so edges into documents
/// the caller can't see are omitted entirely (never leaked).
///
/// nodes:      [{document_id, slug, title, links_out, links_in}]  (counts = resolved edges)
/// edges:      [{src, dst, raw_target}]                            (both endpoints visible)
/// unresolved: [{src, raw_target}]                                 (ghost-node targets)
pub async fn graph(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let Some(p) = state.persistence.clone() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, NO_DB);
    };
    let (user, doc_restriction, ws_restriction) = match state.auth.as_ref() {
        None => (None, None, None),
        Some(auth) => match auth.authenticate(&jar, &headers).await {
            Some(pr) => (Some(pr.role_user), pr.document_restriction, pr.workspace_restriction),
            None => return err(StatusCode::UNAUTHORIZED, "sign in"),
        },
    };
    // trashed = false: documents in the trash never appear in the graph (migration 0008).
    let docs = match p
        .list_documents_visible(user, None, doc_restriction, ws_restriction, false)
        .await
    {
        Ok(d) => d,
        Err(e) => return err500(e),
    };
    let ids: Vec<Uuid> = docs.iter().map(|d| d.id).collect();
    let visible: HashSet<Uuid> = ids.iter().copied().collect();
    let rows = match p.links_among(&ids).await {
        Ok(r) => r,
        Err(e) => return err500(e),
    };

    let mut out_count: HashMap<Uuid, u64> = HashMap::new();
    let mut in_count: HashMap<Uuid, u64> = HashMap::new();
    let mut edges: Vec<Value> = Vec::new();
    let mut unresolved: Vec<Value> = Vec::new();
    for row in &rows {
        match row.dst {
            Some(dst) if visible.contains(&dst) => {
                *out_count.entry(row.src).or_default() += 1;
                *in_count.entry(dst).or_default() += 1;
                edges.push(json!({ "src": row.src, "dst": dst, "raw_target": row.raw_target }));
            }
            Some(_) => {} // resolved, but the caller can't see the target: omit
            None => unresolved.push(json!({ "src": row.src, "raw_target": row.raw_target })),
        }
    }
    let nodes: Vec<Value> = docs
        .iter()
        .map(|d| {
            json!({
                "document_id": d.id,
                "slug": d.slug,
                // The stored display title (rename, migration 0008); the slug stands in
                // when unset, matching GET /api/documents.
                "title": d.title.as_deref().unwrap_or(&d.slug),
                "links_out": out_count.get(&d.id).copied().unwrap_or(0),
                "links_in": in_count.get(&d.id).copied().unwrap_or(0),
            })
        })
        .collect();
    Json(json!({ "nodes": nodes, "edges": edges, "unresolved": unresolved })).into_response()
}

/// GET /api/documents/{slug}/links → { outgoing, incoming } for the backlinks panel.
/// Viewer+ on the document (session, share token, or open mode — same seam as comments).
pub async fn document_links(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match crate::api::ctx(&state, &slug, &jar, &headers, &params, crate::auth::Role::Viewer)
        .await
    {
        Ok(c) => c,
        Err(r) => return r,
    };
    let (outgoing, incoming) = match tokio::try_join!(
        c.persistence.links_from(c.document_id),
        c.persistence.links_to(c.document_id),
    ) {
        Ok(v) => v,
        Err(e) => return err500(e),
    };
    // Visibility filter (mirrors `graph`): an edge must never leak the slug/id of a
    // document the caller cannot see. Authenticated callers get their visible set (plus
    // this document, which ctx already authorized — possibly via a share token); a pure
    // share-link guest's scope is ONLY the shared document; open mode has no tenancy
    // (None = everything visible). Unresolved outgoing links carry no foreign identity
    // (raw_target is this document's own text) and always pass.
    let visible: Option<HashSet<Uuid>> = match state.auth.as_ref() {
        None => None,
        Some(auth) => match auth.authenticate(&jar, &headers).await {
            Some(pr) => {
                let docs = match c
                    .persistence
                    .list_documents_visible(
                        Some(pr.role_user),
                        None,
                        pr.document_restriction,
                        pr.workspace_restriction,
                        false,
                    )
                    .await
                {
                    Ok(d) => d,
                    Err(e) => return err500(e),
                };
                let mut set: HashSet<Uuid> = docs.iter().map(|d| d.id).collect();
                set.insert(c.document_id);
                Some(set)
            }
            None => Some(std::iter::once(c.document_id).collect()),
        },
    };
    let can_see = |id: Uuid| visible.as_ref().is_none_or(|v| v.contains(&id));
    Json(json!({
        "outgoing": outgoing
            .iter()
            .filter(|l| l.dst_id.is_none_or(|id| can_see(id)))
            .map(|l| json!({
                "raw_target": l.raw_target,
                "resolved": l.dst_id.is_some(),
                "document_id": l.dst_id,
                "slug": l.dst_slug,
            }))
            .collect::<Vec<_>>(),
        "incoming": incoming
            .iter()
            .filter(|l| can_see(l.src_id))
            .map(|l| json!({
                "document_id": l.src_id,
                "slug": l.src_slug,
                "raw_target": l.raw_target,
            }))
            .collect::<Vec<_>>(),
    }))
    .into_response()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Parity fixtures with apps/web/src/render.ts slugify — the SAME table is asserted
    /// in apps/web/scripts/render-test.mjs. Change one side and the other test fails.
    const SLUGIFY_FIXTURES: &[(&str, &str)] = &[
        ("The Slug", "the-slug"),
        ("  Spaces  Around  ", "spaces-around"),
        ("Crème Brûlée!", "crme-brle"),
        ("under_score-ok", "under_score-ok"),
        ("A  --  B", "a-b"),
        ("##Heading##", "heading"),
        ("MiXeD CaSe 42", "mixed-case-42"),
        ("Page#Section", "pagesection"),
        ("日本語", ""),
        ("tabs\tand\nnewlines", "tabs-and-newlines"),
        ("---", ""),
    ];

    #[test]
    fn slugify_matches_render_ts_fixtures() {
        for (input, expected) in SLUGIFY_FIXTURES {
            assert_eq!(slugify(input), *expected, "slugify({input:?})");
        }
    }

    fn raw_targets(text: &str) -> Vec<String> {
        extract_links(text).into_iter().map(|l| l.raw_target).collect()
    }

    #[test]
    fn extracts_wikilinks_with_labels_and_fragments() {
        let links = extract_links(
            "See [[Other Page|a label]] and [[The Slug]] and [[Guide#Setup]].\n",
        );
        assert_eq!(
            links.iter().map(|l| (l.raw_target.as_str(), l.target_slug.as_str())).collect::<Vec<_>>(),
            vec![
                ("Other Page", "other-page"),
                ("The Slug", "the-slug"),
                // The fragment stays in raw_target but resolution keys on the document.
                ("Guide#Setup", "guide"),
            ]
        );
        assert!(links.iter().all(|l| l.target_path.is_none()));
    }

    #[test]
    fn wikilink_md_extension_is_ignored_for_resolution() {
        let links = extract_links("[[notes.md]]");
        assert_eq!(links[0].raw_target, "notes.md");
        assert_eq!(links[0].target_slug, "notes");
    }

    #[test]
    fn path_style_wikilink_gets_a_rel_path_candidate() {
        let links = extract_links("[[docs/My Notes]]");
        assert_eq!(links[0].target_path.as_deref(), Some("docs/My Notes.md"));
        // Slug parity with render.ts: the whole target is slugified ('/' stripped).
        assert_eq!(links[0].target_slug, "docsmy-notes");
    }

    #[test]
    fn extracts_relative_md_links_only() {
        let text = "\
[a](./guide.md) [b](sub/dir/notes.md) [c](plain.md)
[abs](/abs/path.md) [frag](#section) [web](https://example.com/x.md)
[mail](mailto:x@y.z) [img](./pic.png) [upper](README.MD)
[titled](./titled.md \"a title\") [angled](<./has space.md>)
";
        let links = extract_links(text);
        let got: Vec<(&str, &str, Option<&str>)> = links
            .iter()
            .map(|l| (l.raw_target.as_str(), l.target_slug.as_str(), l.target_path.as_deref()))
            .collect();
        assert_eq!(
            got,
            vec![
                ("./guide.md", "guide", Some("guide.md")),
                ("sub/dir/notes.md", "notes", Some("sub/dir/notes.md")),
                ("plain.md", "plain", Some("plain.md")),
                ("README.MD", "readme", Some("README.md")),
                ("./titled.md", "titled", Some("titled.md")),
                ("./has space.md", "has-space", Some("has space.md")),
            ]
        );
    }

    #[test]
    fn md_link_fragments_resolve_to_the_document() {
        let links = extract_links("[x](./guide.md#setup)");
        assert_eq!(links[0].raw_target, "./guide.md#setup");
        assert_eq!(links[0].target_slug, "guide");
        assert_eq!(links[0].target_path.as_deref(), Some("guide.md"));
    }

    #[test]
    fn code_fences_and_spans_are_skipped_like_render_ts() {
        let text = "\
before [[Real Link]]

```
[[fenced]] and [also fenced](./fenced.md)
```

inline `[[span]]` and ``[[double span]]`` and `` `nested` [[still span]] ``

~~~markdown
[[tilde fenced]]
~~~

after [[Another Real]]
";
        assert_eq!(raw_targets(text), vec!["Real Link", "Another Real"]);
    }

    #[test]
    fn unclosed_fence_swallows_the_rest() {
        assert_eq!(raw_targets("```\n[[a]]\n[[b]]\n"), Vec::<String>::new());
    }

    #[test]
    fn unmatched_backtick_is_literal_text() {
        assert_eq!(raw_targets("a ` stray [[link]]"), vec!["link"]);
    }

    #[test]
    fn nested_fence_chars_do_not_close_longer_fences() {
        // ```` opened; a ``` line does NOT close it (CommonMark: closing run >= opening).
        assert_eq!(raw_targets("````\n```\n[[inside]]\n````\n[[outside]]\n"), vec!["outside"]);
    }

    #[test]
    fn deduplicates_by_raw_target() {
        assert_eq!(raw_targets("[[a]] [[a]] [[a|label]] [[b]]"), vec!["a", "b"]);
    }

    #[test]
    fn empty_or_bracketed_targets_are_not_links() {
        assert_eq!(raw_targets("[[]] [[ ]] [[##]] [[a[b]] [[a]b]]"), Vec::<String>::new());
        // ...but a valid one right after still parses.
        assert_eq!(raw_targets("[[a[b]] then [[fine]]"), vec!["fine"]);
    }

    #[test]
    fn schemes_are_detected_per_rfc3986() {
        assert!(has_scheme("https://x"));
        assert!(has_scheme("mailto:a@b"));
        assert!(has_scheme("vscode-insiders://x"));
        assert!(!has_scheme("./a:b.md")); // '.' before ':'? scheme = "./a" — invalid chars
        assert!(!has_scheme("foo/bar.md"));
        assert!(!has_scheme("no-colon"));
    }
}
