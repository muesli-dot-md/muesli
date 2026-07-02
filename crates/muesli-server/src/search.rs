//! Server-side search: GET /api/search (migration 0009).
//!
//! Content comes from the `document_texts` projection the link indexer maintains on the
//! mark_dirty seam (links.rs reindex); titles match directly on documents. Visibility is
//! identical to GET /api/documents (open mode sees everything; OIDC mode needs an ACL
//! grant or workspace membership; token restrictions narrow further; the trash never
//! matches). Ranking tiers: title prefix > title substring > content FTS (via
//! plainto_tsquery/ts_rank) > content ILIKE (the short/partial-token fallback) — the SQL
//! computes the tier, this module turns rows into the response shape and builds snippets.

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde_json::{json, Value};
use tracing::warn;

use crate::AppState;

const NO_DB: &str = "this endpoint requires DATABASE_URL (server is running volatile)";

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, msg.into()).into_response()
}

fn err500(e: anyhow::Error) -> Response {
    warn!(%e, "search api error");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

/// GET /api/search?q=<str>&limit=<n=20> →
///   { results: [{document_id, slug, title, folder_id, workspace_id, updated_at,
///                source:{kind,label}, owner:{id,display_name}|null, is_owner,
///                match:{field:"title"|"content", snippet}}] }
pub async fn search(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let Some(p) = state.persistence.clone() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, NO_DB);
    };
    let (user, doc_restriction, ws_restriction) = match state.auth.as_ref() {
        None => (None, None, None),
        Some(auth) => match auth.authenticate(&jar, &headers).await {
            Some(pr) => (
                Some(pr.role_user),
                pr.document_restriction,
                pr.workspace_restriction,
            ),
            None => return err(StatusCode::UNAUTHORIZED, "sign in"),
        },
    };
    let q = params.get("q").map(|s| s.trim()).unwrap_or("");
    if q.is_empty() {
        return Json(json!({ "results": [] })).into_response();
    }
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(20)
        .clamp(1, 100);
    let rows = match p
        .search_documents(
            user,
            doc_restriction,
            ws_restriction,
            q,
            &escape_like(q),
            limit,
        )
        .await
    {
        Ok(r) => r,
        Err(e) => return err500(e),
    };
    let results: Vec<Value> = rows
        .iter()
        .map(|r| {
            let title = r.title.as_deref().unwrap_or(&r.slug);
            // Tiers 0/1 matched the title; 2/3 matched the projected content.
            let (field, snip) = if r.tier <= 1 {
                ("title", title.to_string())
            } else {
                ("content", snippet(r.content.as_deref().unwrap_or(""), q))
            };
            let (kind, label) = source_of(r.conn_kind.as_deref(), r.conn_config.as_ref());
            json!({
                "document_id": r.id,
                "slug": r.slug,
                "title": title,
                "folder_id": r.folder_id,
                "workspace_id": r.workspace_id,
                "updated_at": r.updated_at,
                "source": { "kind": kind, "label": label },
                "owner": r.owner_id.map(|id| json!({
                    "id": id, "display_name": r.owner_name,
                })),
                // Open mode and ownerless (pre-auth) documents read as the caller's own —
                // "Shared with me" is exactly the is_owner=false set.
                "is_owner": user.is_none() || r.owner_id.is_none() || r.owner_id == user,
                "match": { "field": field, "snippet": snip },
            })
        })
        .collect();
    Json(json!({ "results": results })).into_response()
}

/// Escape LIKE/ILIKE metacharacters (Postgres' default escape char is `\`), so the user's
/// query only ever matches literally.
pub fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The storage-connection identity of a search hit: (kind, human label). No connection →
/// native Muesli storage. Labels come from the config jsonb locations (never secrets).
pub fn source_of(kind: Option<&str>, config: Option<&Value>) -> (String, String) {
    let Some(kind) = kind else {
        return ("native".into(), "Muesli Cloud".into());
    };
    let get = |k: &str| {
        config
            .and_then(|c| c.get(k))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let label = match kind {
        "s3" => {
            let bucket = get("bucket");
            if bucket.is_empty() {
                "S3".into()
            } else {
                bucket
            }
        }
        "github" => {
            let (owner, repo) = (get("owner"), get("repo"));
            if owner.is_empty() || repo.is_empty() {
                "GitHub".into()
            } else {
                format!("{owner}/{repo}")
            }
        }
        "gdrive" => {
            let folder = get("folder_name");
            if folder.is_empty() {
                "Google Drive".into()
            } else {
                folder
            }
        }
        other => other.to_string(),
    };
    (kind.to_string(), label)
}

/// How many characters of context to keep on each side of the first hit.
const SNIPPET_RADIUS: usize = 60;

/// Case folding for [`find_ci`]: first lowercase char only (a deliberate approximation —
/// multi-char expansions like ß→ss are rare and only cost a missed snippet anchor).
fn fold(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

/// Byte offset of the first case-insensitive occurrence of `needle` in `haystack`.
fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    let n: Vec<char> = needle.chars().map(fold).collect();
    if n.is_empty() {
        return None;
    }
    let h: Vec<(usize, char)> = haystack.char_indices().collect();
    if h.len() < n.len() {
        return None;
    }
    (0..=h.len() - n.len())
        .find(|&i| (0..n.len()).all(|j| fold(h[i + j].1) == n[j]))
        .map(|i| h[i].0)
}

/// A ±[`SNIPPET_RADIUS`]-char window around the first hit of `query` (whole query first,
/// then any of its whitespace-split tokens, else the start of the text), newlines
/// flattened, space runs collapsed, `…` marking truncation. Char-boundary safe.
pub fn snippet(text: &str, query: &str) -> String {
    let hit = find_ci(text, query)
        .or_else(|| query.split_whitespace().find_map(|tok| find_ci(text, tok)))
        .unwrap_or(0);
    let mut start = hit;
    for _ in 0..SNIPPET_RADIUS {
        match text[..start].char_indices().next_back() {
            Some((i, _)) => start = i,
            None => break,
        }
    }
    let mut end = hit;
    for _ in 0..SNIPPET_RADIUS + query.chars().count() {
        match text[end..].chars().next() {
            Some(c) => end += c.len_utf8(),
            None => break,
        }
    }
    let window = text[start..end].replace(['\n', '\r', '\t'], " ");
    let mut out = String::with_capacity(window.len() + 6);
    if start > 0 {
        out.push('…');
    }
    let mut prev_space = false;
    for c in window.trim().chars() {
        if c == ' ' {
            if !prev_space {
                out.push(c);
            }
            prev_space = true;
        } else {
            out.push(c);
            prev_space = false;
        }
    }
    if end < text.len() {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn like_escaping_is_literal() {
        assert_eq!(escape_like("plain"), "plain");
        assert_eq!(escape_like("50%_done\\x"), "50\\%\\_done\\\\x");
    }

    #[test]
    fn source_labels_per_kind() {
        assert_eq!(
            source_of(None, None),
            ("native".into(), "Muesli Cloud".into())
        );
        assert_eq!(
            source_of(
                Some("s3"),
                Some(&json!({"endpoint": "http://m:9000", "bucket": "muesli-dev"}))
            ),
            ("s3".into(), "muesli-dev".into())
        );
        assert_eq!(
            source_of(
                Some("github"),
                Some(&json!({"owner": "acme", "repo": "docs", "branch": "main"}))
            ),
            ("github".into(), "acme/docs".into())
        );
        assert_eq!(
            source_of(
                Some("gdrive"),
                Some(&json!({"folder_id": "f1", "folder_name": "Muesli"}))
            ),
            ("gdrive".into(), "Muesli".into())
        );
        // degraded configs still label by kind rather than panicking or leaking
        assert_eq!(
            source_of(Some("s3"), Some(&json!({}))),
            ("s3".into(), "S3".into())
        );
        assert_eq!(
            source_of(Some("gdrive"), None),
            ("gdrive".into(), "Google Drive".into())
        );
    }

    #[test]
    fn snippet_centers_on_the_first_case_insensitive_hit() {
        let text = format!("{}NEEDLE in a haystack{}", "x".repeat(200), "y".repeat(200));
        let s = snippet(&text, "needle");
        assert!(s.contains("NEEDLE in a haystack"), "{s}");
        assert!(s.starts_with('…') && s.ends_with('…'), "{s}");
        // ±60 chars + the hit + ellipses: comfortably bounded
        assert!(s.chars().count() <= 2 * SNIPPET_RADIUS + 30, "{s}");
    }

    #[test]
    fn snippet_strips_newlines_and_collapses_spaces() {
        let s = snippet("alpha\nbeta\r\n\tgamma  delta", "gamma");
        assert_eq!(s, "alpha beta gamma delta");
    }

    #[test]
    fn snippet_is_multibyte_safe() {
        let text = format!(
            "{}これは日本語のコンテンツです{}",
            "あ".repeat(100),
            "ん".repeat(100)
        );
        let s = snippet(&text, "日本語");
        assert!(s.contains("日本語のコンテンツ"), "{s}");
        // counted in chars, not bytes — the window never splits a code point
        assert!(s.chars().count() <= 2 * SNIPPET_RADIUS + 10, "{s}");
    }

    #[test]
    fn snippet_falls_back_to_token_then_start() {
        // whole query absent, but one token present
        let s = snippet("the flamingo dances", "purple flamingo");
        assert!(s.contains("flamingo"), "{s}");
        // nothing matches: lead with the start of the text
        let s = snippet("opening words of the document", "zzz");
        assert!(s.starts_with("opening words"), "{s}");
    }
}
