//! The Muesli-branded error page for BROWSER-facing failures.
//!
//! The `/auth/*` flows are full-page navigations (redirect dances through the IdP),
//! so their failures land in front of a person, not a fetch() — a bare
//! `internal error` string there reads as a broken product. This page is the
//! friendly face for those responses. JSON APIs must NOT use it: programmatic
//! clients keep their plain/JSON error bodies.
//!
//! Deliberately self-contained (inline CSS, no external assets) so it renders even
//! when the web app bundle itself is what's broken. Error details never appear on
//! the page — the caller logs the full chain server-side and the visitor gets only
//! the generic copy plus a retry link.

use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};

/// `{retry_href}` is substituted with an attribute-escaped retry target.
const TEMPLATE: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Muesli &mdash; something went wrong</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #fff; color: #18181b;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 26rem; padding: 2.5rem 1.5rem; text-align: center; }
  .mark { font-size: 2rem; font-weight: 700; letter-spacing: -0.02em; color: #3B82F6; margin: 0 0 1.5rem; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.5rem; }
  p { margin: 0 0 1.75rem; line-height: 1.55; opacity: 0.72; }
  .retry {
    display: inline-block; background: #3B82F6; color: #fff; text-decoration: none;
    padding: 0.6rem 1.5rem; border-radius: 0.5rem; font-weight: 600;
  }
  .retry:hover { background: #2563eb; }
  @media (prefers-color-scheme: dark) {
    body { background: #0E0E11; color: #e4e4e7; }
    .retry { color: #fff; }
  }
</style>
</head>
<body>
<main>
  <p class="mark">muesli</p>
  <h1>Looks like we spilled some muesli.</h1>
  <p>We're working on cleaning up the mess &mdash; give it a moment, then reload the page or try again.</p>
  <a class="retry" href="{retry_href}">Try again</a>
</main>
</body>
</html>
"#;

/// The branded error page as a full `Response`. `retry_href` is where "Try again"
/// points: `/` by default, or `/auth/login?next=…` when the failed flow knows its
/// post-login destination (the query value must already be URI-encoded).
pub(crate) fn browser_error_page(status: StatusCode, retry_href: &str) -> Response {
    // Attribute-escape the href; its query values are already percent-encoded, so
    // this only touches the literal separators we composed ourselves.
    let href = retry_href.replace('&', "&amp;").replace('"', "&quot;");
    (status, Html(TEMPLATE.replace("{retry_href}", &href))).into_response()
}
