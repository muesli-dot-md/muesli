//! HTTP calls: the Muesli server's CLI endpoints and the issuer's device-code flow
//! (internal/design/local-agent-cli.md, mcp-and-agent-auth.md).

use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use serde_json::json;
use tracing::{debug, warn};

use muesli_core::events::WorkspaceEventEnvelope;

use crate::store::http_base;

#[derive(Deserialize)]
pub struct AuthConfig {
    pub mode: String,
    pub issuer: Option<String>,
    pub cli_client_id: Option<String>,
}

pub async fn auth_config(server: &str) -> Result<AuthConfig> {
    let base = http_base(server);
    let url = format!("{base}/api/cli/auth-config");
    let resp = reqwest::get(&url)
        .await
        .with_context(|| format!("reaching {url}"))?;
    // A 404 here almost always means the address serves something else entirely
    // (a website, a proxy's default page) — surface that instead of the raw
    // reqwest status error, which reads like a bug rather than a wrong address.
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        bail!("{base} doesn't answer like a Muesli server (404 on /api/cli/auth-config). Check the server address.");
    }
    resp.error_for_status()?
        .json()
        .await
        .context("parsing auth-config")
}

#[derive(Deserialize)]
struct DiscoveryDoc {
    device_authorization_endpoint: Option<String>,
    token_endpoint: String,
}

#[derive(Deserialize)]
struct DeviceAuthorization {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    #[serde(default = "default_interval")]
    interval: u64,
}
fn default_interval() -> u64 {
    5
}

/// OIDC device-code flow against the issuer's public CLI client. Returns an `id_token`.
pub async fn device_flow(issuer: &str, client_id: &str) -> Result<String> {
    let http = reqwest::Client::new();
    let discovery: DiscoveryDoc = http
        .get(format!(
            "{}/.well-known/openid-configuration",
            issuer.trim_end_matches('/')
        ))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
        .context("issuer discovery")?;
    let device_endpoint = discovery
        .device_authorization_endpoint
        .ok_or_else(|| anyhow!("issuer does not support the device-code flow"))?;

    let auth: DeviceAuthorization = http
        .post(&device_endpoint)
        .form(&[("client_id", client_id), ("scope", "openid email profile")])
        .send()
        .await?
        .error_for_status()
        .context("device authorization request")?
        .json()
        .await?;

    let url = auth
        .verification_uri_complete
        .clone()
        .unwrap_or_else(|| auth.verification_uri.clone());
    println!("To sign in, visit:\n\n    {url}\n");
    if auth.verification_uri_complete.is_none() {
        println!("and enter the code: {}\n", auth.user_code);
    }
    open_browser(&url);
    println!("Waiting for you to approve…");

    let mut interval = auth.interval.max(1);
    loop {
        tokio::time::sleep(Duration::from_secs(interval)).await;
        let res = http
            .post(&discovery.token_endpoint)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("device_code", &auth.device_code),
                ("client_id", client_id),
            ])
            .send()
            .await?;
        let body: serde_json::Value = res.json().await?;
        if let Some(id_token) = body.get("id_token").and_then(|v| v.as_str()) {
            return Ok(id_token.to_string());
        }
        match body.get("error").and_then(|v| v.as_str()) {
            Some("authorization_pending") => continue,
            Some("slow_down") => interval += 5,
            Some(e) => bail!(
                "issuer refused: {e} {}",
                body.get("error_description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
            ),
            None => bail!("issuer returned no id_token: {body}"),
        }
    }
}

fn open_browser(url: &str) {
    if std::env::var("MUESLI_NO_BROWSER").is_ok() {
        return; // headless / CI / tests
    }
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(not(target_os = "macos"))]
    let cmd = "xdg-open";
    let _ = std::process::Command::new(cmd)
        .arg(url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

#[derive(Deserialize)]
pub struct CliLoginResponse {
    pub token: String,
    pub owner_email: Option<String>,
}

/// Exchange the issuer's id_token for a Muesli delegated agent token.
pub async fn cli_login(server: &str, id_token: &str, label: &str) -> Result<CliLoginResponse> {
    let res = reqwest::Client::new()
        .post(format!("{}/api/cli/login", http_base(server)))
        .json(&json!({ "id_token": id_token, "label": label }))
        .send()
        .await?;
    if !res.status().is_success() {
        bail!(
            "server rejected login ({}): {}",
            res.status(),
            res.text().await.unwrap_or_default()
        );
    }
    res.json().await.context("parsing login response")
}

#[derive(Deserialize)]
pub struct MeUser {
    /// Stable user id (server UUID). The presence dedup/color key shared with the
    /// webapp, so the same person is one indicator across web + desktop.
    pub id: Option<String>,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    /// First-login onboarding stamp (ISO-8601) or null; absent on pre-0016
    /// servers (serde defaults the Option to None).
    pub onboarded_at: Option<String>,
}

#[derive(Deserialize)]
pub struct MeResponse {
    pub mode: String,
    pub user: Option<MeUser>,
}

pub async fn me(server: &str, token: Option<&str>) -> Result<MeResponse> {
    let mut req = reqwest::Client::new().get(format!("{}/api/me", http_base(server)));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    Ok(req.send().await?.error_for_status()?.json().await?)
}

#[derive(Deserialize)]
pub struct ShareLink {
    pub url: String,
    pub role: String,
}

pub async fn create_share(server: &str, token: &str, doc: &str, role: &str) -> Result<ShareLink> {
    let res = reqwest::Client::new()
        .post(format!("{}/api/documents/{}/share", http_base(server), doc))
        .bearer_auth(token)
        .json(&json!({ "role": role }))
        .send()
        .await?;
    if !res.status().is_success() {
        bail!(
            "share failed ({}): {}",
            res.status(),
            res.text().await.unwrap_or_default()
        );
    }
    res.json().await.context("parsing share response")
}

// ---------------------------------------------------------------------------
// Folder mirroring (the tray daemon recreates the local folder tree as Muesli
// folders and places each doc; migration 0008 folders + PATCH placement).
// ---------------------------------------------------------------------------

/// A folder row from `GET /api/documents` (the `folders` array).
#[derive(Deserialize, Clone)]
pub struct FolderInfo {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    /// The owning workspace (None in open mode / legacy rows).
    #[serde(default)]
    pub workspace_id: Option<String>,
}

/// A document row from `GET /api/documents` (only the fields placement/clone need).
#[derive(Deserialize, Clone)]
pub struct DocInfo {
    pub slug: String,
    pub title: Option<String>,
    pub folder_id: Option<String>,
    /// The owning workspace (None in open mode / legacy rows).
    #[serde(default)]
    pub workspace_id: Option<String>,
}

#[derive(Deserialize)]
struct ListResponse {
    #[serde(default)]
    documents: Vec<DocInfo>,
    #[serde(default)]
    folders: Vec<FolderInfo>,
}

fn auth(req: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
    match token {
        Some(t) => req.bearer_auth(t),
        None => req,
    }
}

/// Current documents + folders for the caller's default workspace.
pub async fn list_docs_and_folders(
    server: &str,
    token: Option<&str>,
) -> Result<(Vec<DocInfo>, Vec<FolderInfo>)> {
    let req = reqwest::Client::new().get(format!("{}/api/documents", http_base(server)));
    let res = auth(req, token).send().await?.error_for_status()?;
    let body: ListResponse = res.json().await.context("parsing documents list")?;
    Ok((body.documents, body.folders))
}

#[derive(Deserialize)]
struct CreatedFolder {
    id: String,
}

/// JSON body for `POST /api/folders` (factored out so the workspace wiring is unit-tested).
pub(crate) fn create_folder_body(
    name: &str,
    parent_id: Option<&str>,
    workspace_id: Option<&str>,
) -> serde_json::Value {
    json!({ "name": name, "parent_id": parent_id, "workspace_id": workspace_id })
}

/// Create a folder under `parent_id` (None = workspace root) in `workspace_id` (None =
/// caller's personal/default). Tags the request with `client_id` for the echo guard.
pub async fn create_folder(
    server: &str,
    token: Option<&str>,
    client_id: &str,
    workspace_id: Option<&str>,
    name: &str,
    parent_id: Option<&str>,
) -> Result<String> {
    let req = reqwest::Client::new()
        .post(format!("{}/api/folders", http_base(server)))
        .header("x-muesli-client-id", client_id)
        .json(&create_folder_body(name, parent_id, workspace_id));
    let res = auth(req, token).send().await?;
    if !res.status().is_success() {
        bail!(
            "create folder failed ({}): {}",
            res.status(),
            res.text().await.unwrap_or_default()
        );
    }
    Ok(res
        .json::<CreatedFolder>()
        .await
        .context("parsing created folder")?
        .id)
}

/// JSON body for `POST /api/documents` (factored out so the workspace/folder wiring is
/// unit-tested without a live server, exactly like `create_folder_body`).
pub(crate) fn create_document_body(
    workspace_id: &str,
    slug: &str,
    folder_id: Option<&str>,
    title: Option<&str>,
) -> serde_json::Value {
    json!({
        "workspace_id": workspace_id,
        "slug": slug,
        "folder_id": folder_id,
        "title": title,
    })
}

/// Create an empty server workspace named `name` and return its `WorkspaceInfo`.
/// `POST /api/workspaces` → 201 `{ id, name, role, is_personal }`.
pub async fn create_workspace(
    server: &str,
    token: Option<&str>,
    name: &str,
) -> Result<WorkspaceInfo> {
    let req = reqwest::Client::new()
        .post(format!("{}/api/workspaces", http_base(server)))
        .json(&json!({ "name": name }));
    let res = auth(req, token).send().await?;
    if !res.status().is_success() {
        bail!(
            "create workspace failed ({}): {}",
            res.status(),
            res.text().await.unwrap_or_default()
        );
    }
    res.json::<WorkspaceInfo>()
        .await
        .context("parsing created workspace")
}

/// Birth a document directly in `workspace_id` (structural row only — NO text; the daemon's
/// CRDT replica owns content). `folder_id` None = workspace root. Tags the request with
/// `client_id` for the echo guard, exactly like `create_folder`. HTTP 409 (the slug already
/// exists in this workspace) is treated as idempotent success — a retry after the doc was
/// already born in W.
pub async fn create_document(
    server: &str,
    token: Option<&str>,
    client_id: &str,
    workspace_id: &str,
    slug: &str,
    folder_id: Option<&str>,
    title: Option<&str>,
) -> Result<()> {
    let req = reqwest::Client::new()
        .post(format!("{}/api/documents", http_base(server)))
        .header("x-muesli-client-id", client_id)
        .json(&create_document_body(workspace_id, slug, folder_id, title));
    let res = auth(req, token).send().await?;
    if res.status() == reqwest::StatusCode::CONFLICT {
        debug!(%slug, %workspace_id, "create_document: 409 — doc already exists in workspace (idempotent)");
        return Ok(());
    }
    if !res.status().is_success() {
        bail!(
            "create document failed ({}): {}",
            res.status(),
            res.text().await.unwrap_or_default()
        );
    }
    Ok(())
}

/// Place a document: set its folder (None = root) and display title. Tags the request with
/// `client_id` so the server's emitted event carries our origin (the SSE consumer filters it).
pub async fn place_document(
    server: &str,
    token: Option<&str>,
    client_id: &str,
    slug: &str,
    folder_id: Option<&str>,
    title: &str,
) -> Result<()> {
    let req = reqwest::Client::new()
        .patch(format!("{}/api/documents/{}", http_base(server), slug))
        .header("x-muesli-client-id", client_id)
        .json(&json!({ "folder_id": folder_id, "title": title }));
    let res = auth(req, token).send().await?;
    if !res.status().is_success() {
        bail!(
            "place document failed ({}): {}",
            res.status(),
            res.text().await.unwrap_or_default()
        );
    }
    Ok(())
}

/// Soft-delete (trash) the server doc `slug` (reversible). `DELETE /api/documents/{slug}`.
/// Tags the request with `client_id` so the emitted delete event carries our origin.
pub async fn trash_document(
    server: &str,
    token: Option<&str>,
    client_id: &str,
    slug: &str,
) -> Result<()> {
    let req = reqwest::Client::new()
        .delete(format!("{}/api/documents/{}", http_base(server), slug))
        .header("x-muesli-client-id", client_id);
    let res = auth(req, token).send().await?;
    if !res.status().is_success() {
        bail!(
            "trash document failed ({}): {}",
            res.status(),
            res.text().await.unwrap_or_default()
        );
    }
    Ok(())
}

#[derive(Deserialize)]
struct DocText {
    text: String,
}

/// Fetch a document's current plain-text (`GET /api/documents/{slug}/text` → `{seq,text}`).
/// Used by the clone for the eager initial content pull; the daemon keeps it live after.
pub async fn doc_text(server: &str, token: Option<&str>, slug: &str) -> Result<String> {
    let req =
        reqwest::Client::new().get(format!("{}/api/documents/{}/text", http_base(server), slug));
    let res = auth(req, token).send().await?.error_for_status()?;
    Ok(res
        .json::<DocText>()
        .await
        .context("parsing document text")?
        .text)
}

/// A raw, authenticated REST call against the server, used by the desktop's
/// `api_request` Tauri command to drive the collaboration endpoints
/// (comments / suggestions / history) without ever exposing the Keychain token
/// to the webview. Models the bearer auth on `me`: the token (when present) is
/// sent as `Authorization: Bearer …`; in open mode (no token) the header is
/// omitted. Returns the HTTP status plus the parsed JSON body (an empty body
/// parses to `{}`), so the caller can map non-2xx to its own error type.
pub struct RawResponse {
    pub status: u16,
    pub body: serde_json::Value,
}

/// Validate that `path` is a same-origin, rooted request path and append it to
/// the server base, parsing the result through the URL parser. Rejects anything
/// that could re-point the authority (`@` userinfo tricks, `//host`, or `\` —
/// which the URL parser treats as `/` in http(s) URLs), so the bearer token can
/// never be sent off-origin.
fn join_api_path(base: &str, path: &str) -> Result<reqwest::Url> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains('\\') || path.contains('@')
    {
        bail!("invalid API path {path:?}: must start with a single '/' and contain no '\\' or '@'");
    }
    let base_url =
        reqwest::Url::parse(base).with_context(|| format!("invalid server URL {base:?}"))?;
    let url = reqwest::Url::parse(&format!("{base}{path}"))
        .with_context(|| format!("joining API path {path:?}"))?;
    // Belt and braces: appending a rooted path must never change the origin.
    if url.scheme() != base_url.scheme()
        || url.host_str() != base_url.host_str()
        || url.port_or_known_default() != base_url.port_or_known_default()
    {
        bail!("API path {path:?} escapes the server origin");
    }
    Ok(url)
}

pub async fn api_request(
    server: &str,
    token: Option<&str>,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<RawResponse> {
    let url = join_api_path(&http_base(server), path)?;
    let m = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| anyhow!("invalid HTTP method {method:?}: {e}"))?;
    let mut req = reqwest::Client::new().request(m, url);
    req = auth(req, token);
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req.send().await?;
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    let value = if text.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text))
    };
    Ok(RawResponse {
        status,
        body: value,
    })
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    pub role: String,
    pub is_personal: bool,
    /// BYO storage (plan 1a): 'pending_storage' | 'active'. Optional so the CLI
    /// keeps parsing older servers' responses.
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(serde::Deserialize)]
struct WorkspacesEnvelope {
    workspaces: Vec<WorkspaceInfo>,
}

/// Whether an error from this module is an HTTP 401 (a stale or revoked token).
/// Lives here so callers (the desktop app) don't need their own reqwest
/// dependency just to inspect a status — downcasting only works against the
/// same reqwest version anyway.
pub fn is_unauthorized(e: &anyhow::Error) -> bool {
    e.chain().any(|c| {
        c.downcast_ref::<reqwest::Error>()
            .and_then(reqwest::Error::status)
            == Some(reqwest::StatusCode::UNAUTHORIZED)
    })
}

/// List the workspaces the authenticated caller belongs to.
/// `GET {server}/api/workspaces` → `{ workspaces: [...] }`.
pub async fn list_workspaces(server: &str, token: &str) -> anyhow::Result<Vec<WorkspaceInfo>> {
    let url = format!("{}/api/workspaces", crate::store::http_base(server));
    let env: WorkspacesEnvelope = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(env.workspaces)
}

/// Split an SSE buffer into completed envelopes + the unconsumed tail. An event ends at a
/// blank line; within an event, every `data:` line's value is collected and joined with
/// '\n' (SSE spec), then parsed as one `WorkspaceEventEnvelope`. Comments (`:`…), `event:`,
/// `id:`, and unparseable payloads are skipped without breaking the stream.
pub(crate) fn parse_sse_chunk(buf: &str) -> (Vec<WorkspaceEventEnvelope>, String) {
    let mut out = Vec::new();
    // The last "\n\n" marks the end of the final complete event; everything after is tail.
    let split_at = buf.rfind("\n\n").map(|i| i + 2);
    let (complete, tail) = match split_at {
        Some(i) => (&buf[..i], buf[i..].to_string()),
        None => return (out, buf.to_string()),
    };
    for block in complete.split("\n\n") {
        if block.is_empty() {
            continue;
        }
        let mut data = String::new();
        for line in block.lines() {
            if let Some(rest) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
            }
            // `:`-comments, `event:`, `id:`, `retry:` → ignored.
        }
        if data.is_empty() {
            continue;
        }
        match serde_json::from_str::<WorkspaceEventEnvelope>(&data) {
            Ok(env) => out.push(env),
            Err(e) => warn!(%e, payload = %data, "skipping unparseable SSE event"),
        }
    }
    (out, tail)
}

/// Subscribe to the workspace SSE stream; push every non-own-origin envelope onto `tx`.
/// Reconnects with capped exponential backoff; exits when `tx` is closed.
///
/// Returns immediately; the work runs on a spawned task until `tx` is closed or the process
/// ends. Wired into the daemon select loop in B4.
pub fn subscribe_workspace_events(
    server: String,
    token: Option<String>,
    workspace_id: String,
    client_id: String,
    tx: tokio::sync::mpsc::UnboundedSender<WorkspaceEventEnvelope>,
) {
    use futures_util::StreamExt;

    tokio::spawn(async move {
        let url = format!(
            "{}/api/workspaces/{}/events",
            http_base(&server),
            workspace_id
        );
        let client = reqwest::Client::new();
        let mut attempts: u32 = 0;
        loop {
            if tx.is_closed() {
                return;
            }
            let mut req = client.get(&url).header("x-muesli-client-id", &client_id);
            if let Some(t) = &token {
                req = req.bearer_auth(t);
            }
            match req.send().await.and_then(|r| r.error_for_status()) {
                Ok(resp) => {
                    attempts = 0;
                    let mut stream = resp.bytes_stream();
                    let mut buf = String::new();
                    while let Some(chunk) = stream.next().await {
                        let Ok(bytes) = chunk else { break }; // disconnect → reconnect
                        buf.push_str(&String::from_utf8_lossy(&bytes));
                        let (events, tail) = parse_sse_chunk(&buf);
                        buf = tail;
                        for env in events {
                            // Origin echo-guard (Contract 3): drop our own mutations.
                            if env.origin.as_deref() == Some(client_id.as_str()) {
                                continue;
                            }
                            if tx.send(env).is_err() {
                                return; // consumer gone
                            }
                        }
                    }
                }
                Err(e) => {
                    warn!(%e, %url, "workspace events stream error");
                }
            }
            // Backoff before reconnecting (2,4,…,30s).
            attempts = attempts.saturating_add(1);
            let delay = std::time::Duration::from_secs(2u64.pow(attempts.min(5)).min(30));
            tokio::time::sleep(delay).await;
        }
    });
}

#[cfg(test)]
mod api_path_tests {
    use super::join_api_path;

    #[test]
    fn accepts_rooted_same_origin_paths() {
        let u = join_api_path(
            "http://localhost:8787",
            "/api/documents/notes/comments?mentions=me",
        )
        .unwrap();
        assert_eq!(
            u.as_str(),
            "http://localhost:8787/api/documents/notes/comments?mentions=me"
        );
    }

    #[test]
    fn preserves_a_base_path_prefix() {
        let u = join_api_path("https://example.com/muesli", "/api/me").unwrap();
        assert_eq!(u.as_str(), "https://example.com/muesli/api/me");
    }

    #[test]
    fn rejects_authority_repointing_paths() {
        for p in [
            "@evil.com/x",   // userinfo trick: base@evil.com
            "//evil.com/x",  // protocol-relative authority
            "/\\evil.com/x", // '\' parses as '/' in http(s) → //evil.com
            "/x@evil.com",   // '@' anywhere is off-limits
            "api/me",        // not rooted
            "",              // empty
        ] {
            assert!(
                join_api_path("http://localhost:8787", p).is_err(),
                "{p:?} must be rejected"
            );
        }
    }
}

#[cfg(test)]
mod outbound_tests {
    use super::create_folder_body;
    #[test]
    fn create_folder_body_includes_workspace() {
        let b = create_folder_body("Inbox", Some("parent-1"), Some("ws-7"));
        assert_eq!(b["name"], "Inbox");
        assert_eq!(b["parent_id"], "parent-1");
        assert_eq!(b["workspace_id"], "ws-7");
        // open mode: workspace omitted entirely (null), parent null at root
        let b2 = create_folder_body("Top", None, None);
        assert!(b2["parent_id"].is_null());
        assert!(b2["workspace_id"].is_null());
    }

    use super::create_document_body;

    #[test]
    fn create_document_body_carries_workspace_folder_and_title() {
        // foldered doc in W
        let b = create_document_body("ws-7", "my-note", Some("f-3"), Some("My Note"));
        assert_eq!(b["workspace_id"], "ws-7");
        assert_eq!(b["slug"], "my-note");
        assert_eq!(b["folder_id"], "f-3");
        assert_eq!(b["title"], "My Note");

        // root-level doc: folder_id null but workspace_id + slug still present (the gap we close)
        let b2 = create_document_body("ws-7", "root-doc", None, None);
        assert_eq!(b2["workspace_id"], "ws-7");
        assert_eq!(b2["slug"], "root-doc");
        assert!(b2["folder_id"].is_null());
        assert!(b2["title"].is_null());
    }
}

#[cfg(test)]
mod plan2_tests {
    use super::{DocInfo, FolderInfo};

    #[test]
    fn doc_and_folder_rows_carry_workspace_id() {
        let doc: DocInfo = serde_json::from_str(
            r#"{"slug":"notes","title":"Notes","folder_id":"f1","workspace_id":"w1"}"#,
        )
        .unwrap();
        assert_eq!(doc.workspace_id.as_deref(), Some("w1"));
        assert_eq!(doc.folder_id.as_deref(), Some("f1"));

        // workspace_id is optional: open-mode / legacy rows may omit it.
        let doc2: DocInfo =
            serde_json::from_str(r#"{"slug":"x","title":null,"folder_id":null}"#).unwrap();
        assert_eq!(doc2.workspace_id, None);

        let folder: FolderInfo = serde_json::from_str(
            r#"{"id":"f1","parent_id":null,"name":"Inbox","workspace_id":"w1"}"#,
        )
        .unwrap();
        assert_eq!(folder.workspace_id.as_deref(), Some("w1"));
        assert_eq!(folder.name, "Inbox");
    }
}

#[cfg(test)]
mod workspace_list_tests {
    use super::WorkspacesEnvelope;

    #[test]
    fn parses_workspaces_envelope() {
        let json = r#"{"workspaces":[
            {"id":"w1","name":"Personal","role":"admin","is_personal":true},
            {"id":"w2","name":"Team A","role":"member","is_personal":false}
        ]}"#;
        let env: WorkspacesEnvelope = serde_json::from_str(json).unwrap();
        assert_eq!(env.workspaces.len(), 2);
        assert_eq!(env.workspaces[0].name, "Personal");
        assert!(env.workspaces[0].is_personal);
        assert_eq!(env.workspaces[1].role, "member");
    }

    #[test]
    fn parses_single_created_workspace() {
        use super::WorkspaceInfo;
        let info: WorkspaceInfo = serde_json::from_str(
            r#"{"id":"w9","name":"Team B","role":"admin","is_personal":false}"#,
        )
        .unwrap();
        assert_eq!(info.id, "w9");
        assert_eq!(info.role, "admin");
        assert!(!info.is_personal);
    }
}

#[cfg(test)]
mod sse_tests {
    use super::parse_sse_chunk;

    #[test]
    fn parses_complete_events_and_keeps_partial_tail() {
        // two complete events + a partial third still accumulating
        let raw = "data: {\"origin\":\"c1\",\"kind\":\"doc_renamed\",\"slug\":\"notes\",\"title\":\"Notes\"}\n\n\
                   : keep-alive comment\n\n\
                   data: {\"kind\":\"folder_created\",\"id\":\"f1\",\"parent_id\":null,\"name\":\"Inbox\"}\n\n\
                   data: {\"kind\":\"doc_upda";
        let (events, tail) = parse_sse_chunk(raw);
        assert_eq!(
            events.len(),
            2,
            "two complete events; the comment and partial are not events"
        );
        assert_eq!(events[0].origin.as_deref(), Some("c1"));
        use muesli_core::events::WorkspaceEvent;
        assert_eq!(
            events[0].event,
            WorkspaceEvent::DocRenamed {
                slug: "notes".into(),
                title: Some("Notes".into())
            }
        );
        assert_eq!(events[1].origin, None);
        assert_eq!(
            events[1].event,
            WorkspaceEvent::FolderCreated {
                id: "f1".into(),
                parent_id: None,
                name: "Inbox".into()
            }
        );
        assert!(
            tail.starts_with("data: {\"kind\":\"doc_upda"),
            "partial event is returned as tail"
        );
    }

    #[test]
    fn concatenates_multiline_data_and_skips_blank_payloads() {
        // SSE allows multiple data: lines in one event; they join with '\n'. Here the JSON
        // is split across two data: lines.
        let raw = "data: {\"kind\":\"doc_deleted\",\n\
                   data: \"slug\":\"gone\"}\n\n";
        let (events, tail) = parse_sse_chunk(raw);
        assert_eq!(tail, "");
        use muesli_core::events::WorkspaceEvent;
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].event,
            WorkspaceEvent::DocDeleted {
                slug: "gone".into()
            }
        );
    }

    #[test]
    fn ignores_unparseable_data_lines_without_losing_the_stream() {
        let raw = "data: not json\n\n\
                   data: {\"kind\":\"doc_updated\",\"slug\":\"live\"}\n\n";
        let (events, _tail) = parse_sse_chunk(raw);
        use muesli_core::events::WorkspaceEvent;
        assert_eq!(
            events.len(),
            1,
            "a malformed event is dropped, the stream survives"
        );
        assert_eq!(
            events[0].event,
            WorkspaceEvent::DocUpdated {
                slug: "live".into()
            }
        );
    }

    #[test]
    fn own_origin_is_dropped_others_kept() {
        let raw = "data: {\"origin\":\"me\",\"kind\":\"doc_updated\",\"slug\":\"x\"}\n\n\
                   data: {\"origin\":\"peer\",\"kind\":\"doc_updated\",\"slug\":\"y\"}\n\n\
                   data: {\"kind\":\"doc_updated\",\"slug\":\"z\"}\n\n";
        let (events, _) = parse_sse_chunk(raw);
        let me = "me";
        let kept: Vec<_> = events
            .into_iter()
            .filter(|e| e.origin.as_deref() != Some(me))
            .collect();
        assert_eq!(kept.len(), 2, "own-origin dropped; peer + UI(None) kept");
    }
}
