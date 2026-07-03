//! Google Drive storage connector (ADR 0013, kind "gdrive") — the launch backend that lets
//! users **store files on their own Drive and bear their own storage cost**.
//!
//! Unlike S3/GitHub, a Drive connection cannot be created by POSTing a config: it is born
//! from a per-workspace **OAuth dance** (the same axum patterns as auth.rs):
//!
//! 1. `GET /api/workspaces/{id}/storage/google/start` (admin, OIDC session) → 302 to
//!    Google's consent screen with scope `drive.file`, `access_type=offline`,
//!    `prompt=consent`, and a random `state` token bound to (workspace, user) with a
//!    10-minute TTL (mirroring the pending-login map in auth.rs).
//! 2. `GET /auth/storage/google/callback?code&state` → code→token exchange, then a
//!    find-or-create of the app folder **"Muesli"** in the user's Drive (which doubles as
//!    the connection probe), then a `storage_connections` row kind `gdrive` with config
//!    `{refresh_token, folder_id, folder_name}` and a redirect back to the web origin
//!    with `?storage=connected`.
//!
//! The refresh token is per-user — it cannot live in the server environment the way the
//! S3/GitHub secrets do, so it lives in the connection config; the workspace listing
//! endpoint redacts it. Access tokens are minted from the refresh token on demand and
//! cached in memory until 60s before expiry; a 401 from the Drive API forces one refresh
//! and one retry.
//!
//! **File mapping**: documents live FLAT in the connection's folder. The Drive file name
//! is the rel_path with every `/` replaced by `∕` (U+2215 DIVISION SLASH), so nested
//! rel_paths stay unique and round-trip losslessly (Drive itself has no real paths —
//! names are not unique and folders are just parents). Resolution is by
//! `files.list q="name='…' and '<folder>' in parents and trashed=false"`, with an
//! in-memory fileId cache per (folder, name), invalidated on 404.
//!
//! Endpoint override envs (MUESLI_GOOGLE_AUTH_URI / _TOKEN_URI / _API_BASE) exist as test
//! hooks so the whole dance can run against a mock Google (apps/web/scripts/gdrive-e2e.mjs).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Redirect, Response};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::storage::{uri_encode, StorageBackend};
use crate::AppState;

/// The one scope we ask for: per-file access to files the app created/opened — Muesli
/// never sees the rest of the user's Drive (ADR 0013).
pub const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
/// The app folder created (or found) at connect time; all attached documents live in it.
pub const FOLDER_NAME: &str = "Muesli";
const FOLDER_MIME: &str = "application/vnd.google-apps.folder";

const DEFAULT_AUTH_URI: &str = "https://accounts.google.com/o/oauth2/auth";
const DEFAULT_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
const DEFAULT_API_BASE: &str = "https://www.googleapis.com";

/// Pending OAuth-dance TTL (same as auth.rs login attempts).
const CONNECT_ATTEMPT_TTL: Duration = Duration::from_secs(600);
/// Cached access tokens are treated as expired this long before Google says so.
const TOKEN_EXPIRY_SLACK: Duration = Duration::from_secs(60);

static GOOGLE: OnceLock<Arc<GoogleCtx>> = OnceLock::new();

/// Resolve env/file config and install the global context. Returns whether Drive
/// connections are available. Called once from main().
pub fn init_from_env(public_url: &str) -> Result<bool> {
    match GoogleCtx::from_env(public_url)? {
        Some(ctx) => {
            let _ = GOOGLE.set(Arc::new(ctx));
            Ok(true)
        }
        None => Ok(false),
    }
}

fn google() -> Option<Arc<GoogleCtx>> {
    GOOGLE.get().cloned()
}

/// Whether the Drive OAuth client is configured — the readiness flag the storage
/// listing exposes as `google.configured` (settings.md §2.3) so the web UI can render
/// a "setup required" state instead of bouncing users off the start endpoint's 503.
pub fn configured() -> bool {
    GOOGLE.get().is_some()
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested): name mapping, Drive query building, multipart body
// ---------------------------------------------------------------------------

/// rel_path → Drive file name: documents live flat in the folder, `/` becomes `∕`
/// (U+2215 DIVISION SLASH) so nested rel_paths stay distinct and reversible.
pub(crate) fn drive_name(rel_path: &str) -> String {
    rel_path.trim_start_matches('/').replace('/', "\u{2215}")
}

/// Drive file name → rel_path (the inverse of [`drive_name`]).
#[allow(dead_code)]
// No production caller since the probe replaced connect-time list(); kept as the inverse of drive_name for the list surface + future health checks (1a-T10).
pub(crate) fn rel_from_name(name: &str) -> String {
    name.replace('\u{2215}', "/")
}

/// Escape a string literal for a Drive `q` query: backslashes and single quotes.
pub(crate) fn escape_q(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

/// The `q` that resolves one file by name inside the connection's folder.
pub(crate) fn q_file_in_folder(name: &str, folder_id: &str) -> String {
    format!(
        "name='{}' and '{}' in parents and trashed=false",
        escape_q(name),
        escape_q(folder_id)
    )
}

/// The `q` that finds the app folder at connect time.
pub(crate) fn q_app_folder() -> String {
    format!(
        "name='{}' and mimeType='{FOLDER_MIME}' and trashed=false",
        escape_q(FOLDER_NAME)
    )
}

/// A `multipart/related` upload body (metadata JSON + media), hand-built per the
/// constraint of no new dependencies. The caller sends it with
/// `Content-Type: multipart/related; boundary=<boundary>`.
pub(crate) fn multipart_body(metadata_json: &str, content: &[u8], boundary: &str) -> Vec<u8> {
    let mut body = Vec::with_capacity(metadata_json.len() + content.len() + 256);
    body.extend_from_slice(
        format!(
            "--{boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n{metadata_json}\r\n--{boundary}\r\ncontent-type: text/markdown; charset=UTF-8\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(content);
    body.extend_from_slice(format!("\r\n--{boundary}--").as_bytes());
    body
}

// ---------------------------------------------------------------------------
// Refresh-token encryption at rest (MUESLI_SECRET_KEY) — moved to secrets.rs
// (plan 1a task 3) because S3/GitHub credentials now share it.
// ---------------------------------------------------------------------------

pub(crate) use crate::secrets::{decrypt_secret, encrypt_secret};

// ---------------------------------------------------------------------------
// GoogleCtx: OAuth client config + pending dances + token & fileId caches
// ---------------------------------------------------------------------------

struct PendingConnect {
    workspace_id: Uuid,
    user_id: Uuid,
    created: Instant,
    /// Whether this dance started from the workspace-setup wizard (plan 1b) rather than
    /// Settings → Connections — determines where the callback redirects on completion.
    wizard: bool,
}

struct CachedToken {
    access_token: String,
    expires_at: Instant,
}

/// Everything the Drive connector needs, shared by the routes and every
/// [`GdriveBackend`] instance (backends are rebuilt per poll pass — per-instance
/// caches would be useless, so caches live here).
pub struct GoogleCtx {
    client_id: String,
    client_secret: String,
    auth_uri: String,
    token_uri: String,
    api_base: String,
    redirect_uri: String,
    http: reqwest::Client,
    /// state token → pending dance, 10-min TTL (the auth.rs pending-login pattern).
    pending: Mutex<HashMap<String, PendingConnect>>,
    /// refresh_token → cached access token (expiry minus 60s slack).
    tokens: Mutex<HashMap<String, CachedToken>>,
    /// (folder_id, drive file name) → fileId; invalidated on 404.
    file_ids: Mutex<HashMap<(String, String), String>>,
}

#[derive(Deserialize)]
struct ClientFileWeb {
    client_id: String,
    client_secret: String,
    auth_uri: Option<String>,
    token_uri: Option<String>,
}

#[derive(Deserialize)]
struct ClientFile {
    web: ClientFileWeb,
}

fn load_client_file(path: &str) -> Result<ClientFileWeb> {
    let raw = std::fs::read_to_string(path).with_context(|| format!("reading {path}"))?;
    let parsed: ClientFile = serde_json::from_str(&raw).with_context(|| {
        format!("parsing {path} (expected {{\"web\":{{client_id,client_secret,…}}}})")
    })?;
    Ok(parsed.web)
}

impl GoogleCtx {
    pub(crate) fn new(
        client_id: String,
        client_secret: String,
        auth_uri: String,
        token_uri: String,
        api_base: String,
        redirect_uri: String,
    ) -> Self {
        Self {
            client_id,
            client_secret,
            auth_uri,
            token_uri,
            api_base: api_base.trim_end_matches('/').to_string(),
            redirect_uri,
            http: reqwest::Client::new(),
            pending: Mutex::new(HashMap::new()),
            tokens: Mutex::new(HashMap::new()),
            file_ids: Mutex::new(HashMap::new()),
        }
    }

    /// Config sources, in order: MUESLI_GOOGLE_CLIENT_ID + MUESLI_GOOGLE_CLIENT_SECRET
    /// (highest), MUESLI_GOOGLE_CLIENT_FILE (a muesli.json-shaped file — fails fast when
    /// set but unreadable), an implicit ./muesli.json (ignored with a warning when
    /// malformed). MUESLI_GOOGLE_AUTH_URI / _TOKEN_URI / _API_BASE override the
    /// endpoints in every case (test hooks; defaults are the real Google endpoints).
    fn from_env(public_url: &str) -> Result<Option<Self>> {
        let env = |k: &str| std::env::var(k).ok().filter(|s| !s.is_empty());
        let mut client_id = env("MUESLI_GOOGLE_CLIENT_ID");
        let mut client_secret = env("MUESLI_GOOGLE_CLIENT_SECRET");
        let mut file_auth_uri = None;
        let mut file_token_uri = None;
        if client_id.is_none() || client_secret.is_none() {
            let explicit = env("MUESLI_GOOGLE_CLIENT_FILE");
            let path = explicit.clone().or_else(|| {
                std::path::Path::new("muesli.json")
                    .exists()
                    .then(|| "muesli.json".to_string())
            });
            if let Some(path) = path {
                match load_client_file(&path) {
                    Ok(web) => {
                        client_id = client_id.or(Some(web.client_id));
                        client_secret = client_secret.or(Some(web.client_secret));
                        file_auth_uri = web.auth_uri;
                        file_token_uri = web.token_uri;
                    }
                    Err(e) if explicit.is_some() => {
                        return Err(e.context("MUESLI_GOOGLE_CLIENT_FILE is set but unusable"))
                    }
                    Err(e) => {
                        warn!(%e, "ignoring unreadable ./muesli.json (google drive stays unconfigured)")
                    }
                }
            }
        }
        let (Some(client_id), Some(client_secret)) = (client_id, client_secret) else {
            return Ok(None);
        };
        let auth_uri = env("MUESLI_GOOGLE_AUTH_URI")
            .or(file_auth_uri)
            .unwrap_or_else(|| DEFAULT_AUTH_URI.into());
        let token_uri = env("MUESLI_GOOGLE_TOKEN_URI")
            .or(file_token_uri)
            .unwrap_or_else(|| DEFAULT_TOKEN_URI.into());
        let api_base = env("MUESLI_GOOGLE_API_BASE").unwrap_or_else(|| DEFAULT_API_BASE.into());
        let redirect_uri = format!(
            "{}/auth/storage/google/callback",
            public_url.trim_end_matches('/')
        );
        Ok(Some(Self::new(
            client_id,
            client_secret,
            auth_uri,
            token_uri,
            api_base,
            redirect_uri,
        )))
    }

    // --- the pending-dance map (state tokens) --------------------------------

    /// Mint a state token for a new dance; expired entries are swept on insert.
    fn begin(&self, workspace_id: Uuid, user_id: Uuid, wizard: bool) -> String {
        self.begin_at(workspace_id, user_id, Instant::now(), wizard)
    }

    pub(crate) fn begin_at(
        &self,
        workspace_id: Uuid,
        user_id: Uuid,
        created: Instant,
        wizard: bool,
    ) -> String {
        let token = crate::auth::random_token();
        let mut pending = self.pending.lock().unwrap();
        pending.retain(|_, p| p.created.elapsed() < CONNECT_ATTEMPT_TTL);
        pending.insert(
            token.clone(),
            PendingConnect {
                workspace_id,
                user_id,
                created,
                wizard,
            },
        );
        token
    }

    /// Consume a state token: Some((workspace, user, wizard)) exactly once, within the TTL.
    pub(crate) fn take_pending(&self, state: &str) -> Option<(Uuid, Uuid, bool)> {
        let p = self.pending.lock().unwrap().remove(state)?;
        (p.created.elapsed() < CONNECT_ATTEMPT_TTL).then_some((p.workspace_id, p.user_id, p.wizard))
    }

    /// The consent-screen URL: drive.file scope, offline access, forced consent (so a
    /// refresh_token is minted even on re-connects).
    pub(crate) fn auth_url(&self, state: &str) -> String {
        format!(
            "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent&state={}",
            self.auth_uri,
            uri_encode(&self.client_id, true),
            uri_encode(&self.redirect_uri, true),
            uri_encode(DRIVE_SCOPE, true),
            uri_encode(state, true),
        )
    }

    // --- token exchange & refresh cache --------------------------------------

    async fn token_request(&self, params: &[(&str, &str)]) -> Result<Value> {
        let res = self
            .http
            .post(&self.token_uri)
            .form(params)
            .send()
            .await
            .with_context(|| format!("POST {}", self.token_uri))?;
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        if !status.is_success() {
            // The raw upstream body must NOT be folded into this error — it propagates
            // to warn! logs, and token-endpoint responses are not ours to persist there.
            // The status code is enough to debug (invalid_grant vs 5xx etc. can be
            // reproduced out-of-band).
            return Err(anyhow!("google token endpoint answered {status}"));
        }
        serde_json::from_str(&body).context("google token endpoint returned non-JSON")
    }

    /// authorization_code → (access_token, refresh_token?, expires_in).
    pub(crate) async fn exchange_code(&self, code: &str) -> Result<(String, Option<String>, u64)> {
        let v = self
            .token_request(&[
                ("code", code),
                ("client_id", &self.client_id),
                ("client_secret", &self.client_secret),
                ("redirect_uri", &self.redirect_uri),
                ("grant_type", "authorization_code"),
            ])
            .await?;
        let access = v
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("token exchange returned no access_token"))?
            .to_string();
        let refresh = v
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string);
        let expires_in = v.get("expires_in").and_then(Value::as_u64).unwrap_or(3600);
        Ok((access, refresh, expires_in))
    }

    /// A still-valid cached access token for this refresh token, if any.
    pub(crate) fn cached_access(&self, refresh_token: &str) -> Option<String> {
        let map = self.tokens.lock().unwrap();
        let t = map.get(refresh_token)?;
        (Instant::now() < t.expires_at).then(|| t.access_token.clone())
    }

    /// Cache an access token; it reads as expired TOKEN_EXPIRY_SLACK before Google's
    /// expiry so in-flight requests never ride a token about to die.
    pub(crate) fn store_access(&self, refresh_token: &str, access_token: &str, expires_in: u64) {
        let usable = Duration::from_secs(expires_in.saturating_sub(TOKEN_EXPIRY_SLACK.as_secs()));
        self.tokens.lock().unwrap().insert(
            refresh_token.to_string(),
            CachedToken {
                access_token: access_token.to_string(),
                expires_at: Instant::now() + usable,
            },
        );
    }

    /// Refresh-token → access-token, through the cache. `force` drops the cached entry
    /// first (the 401-retry path).
    pub(crate) async fn access_token(&self, refresh_token: &str, force: bool) -> Result<String> {
        if force {
            self.tokens.lock().unwrap().remove(refresh_token);
        } else if let Some(tok) = self.cached_access(refresh_token) {
            return Ok(tok);
        }
        let v = self
            .token_request(&[
                ("client_id", &self.client_id),
                ("client_secret", &self.client_secret),
                ("refresh_token", refresh_token),
                ("grant_type", "refresh_token"),
            ])
            .await?;
        let access = v
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("token refresh returned no access_token"))?
            .to_string();
        let expires_in = v.get("expires_in").and_then(Value::as_u64).unwrap_or(3600);
        self.store_access(refresh_token, &access, expires_in);
        debug!("minted a fresh google access token (forced: {force})");
        Ok(access)
    }

    // --- fileId cache ----------------------------------------------------------

    fn cached_file_id(&self, folder_id: &str, name: &str) -> Option<String> {
        self.file_ids
            .lock()
            .unwrap()
            .get(&(folder_id.to_string(), name.to_string()))
            .cloned()
    }

    fn cache_file_id(&self, folder_id: &str, name: &str, id: &str) {
        self.file_ids
            .lock()
            .unwrap()
            .insert((folder_id.to_string(), name.to_string()), id.to_string());
    }

    fn invalidate_file_id(&self, folder_id: &str, name: &str) {
        self.file_ids
            .lock()
            .unwrap()
            .remove(&(folder_id.to_string(), name.to_string()));
    }
}

/// Find-or-create the "Muesli" app folder. Runs at connect time on the fresh access
/// token and doubles as the connection probe (a Drive we cannot touch → 502, no row).
pub(crate) async fn ensure_app_folder(ctx: &GoogleCtx, access_token: &str) -> Result<String> {
    let url = format!(
        "{}/drive/v3/files?q={}&fields=files(id,name)",
        ctx.api_base,
        uri_encode(&q_app_folder(), true),
    );
    let res = ctx.http.get(&url).bearer_auth(access_token).send().await?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(anyhow!("drive files.list (folder probe): {status} {body}"));
    }
    let v: Value = res.json().await?;
    if let Some(id) = v.pointer("/files/0/id").and_then(Value::as_str) {
        return Ok(id.to_string());
    }
    let res = ctx
        .http
        .post(format!("{}/drive/v3/files?fields=id", ctx.api_base))
        .bearer_auth(access_token)
        .json(&json!({ "name": FOLDER_NAME, "mimeType": FOLDER_MIME }))
        .send()
        .await?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(anyhow!("drive files.create (app folder): {status} {body}"));
    }
    let v: Value = res.json().await?;
    v.get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow!("drive files.create returned no id"))
}

// ---------------------------------------------------------------------------
// GdriveBackend — the third AnyBackend variant
// ---------------------------------------------------------------------------

pub struct GdriveBackend {
    ctx: Arc<GoogleCtx>,
    refresh_token: String,
    folder_id: String,
}

impl GdriveBackend {
    /// Build from a storage_connections row's config jsonb: {refresh_token, folder_id}.
    /// Requires the server-level Google OAuth client (init_from_env) for the token dance.
    pub fn from_conn(kind: &str, config: &Value) -> Result<Self> {
        if kind != "gdrive" {
            return Err(anyhow!("GdriveBackend cannot serve storage kind {kind:?}"));
        }
        let ctx = google().ok_or_else(|| {
            anyhow!("google drive is not configured on the server (MUESLI_GOOGLE_CLIENT_ID/SECRET or MUESLI_GOOGLE_CLIENT_FILE)")
        })?;
        let field = |name: &str| -> Result<String> {
            config
                .get(name)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .ok_or_else(|| anyhow!("gdrive storage config has no {name}"))
        };
        // Prefer the encrypted field (written when MUESLI_SECRET_KEY is set); legacy
        // rows carrying a plaintext refresh_token keep working.
        let refresh_token = match config.get("refresh_token_enc").and_then(Value::as_str) {
            Some(enc) => decrypt_secret(enc)?,
            None => field("refresh_token")?,
        };
        Ok(Self {
            ctx,
            refresh_token,
            folder_id: field("folder_id")?,
        })
    }

    #[cfg(test)]
    fn for_tests(ctx: Arc<GoogleCtx>, refresh_token: &str, folder_id: &str) -> Self {
        Self {
            ctx,
            refresh_token: refresh_token.into(),
            folder_id: folder_id.into(),
        }
    }

    fn files_url(&self) -> String {
        format!("{}/drive/v3/files", self.ctx.api_base)
    }

    fn upload_url(&self) -> String {
        format!("{}/upload/drive/v3/files", self.ctx.api_base)
    }

    /// One authenticated request with the transparent expiry path: a 401 forces ONE
    /// token refresh and one retry (Drive access tokens last ~1h; the cache's 60s slack
    /// makes this rare, but server clocks drift and Google revokes).
    async fn send_authed(
        &self,
        method: reqwest::Method,
        url: &str,
        body: Option<(String, Vec<u8>)>,
    ) -> Result<reqwest::Response> {
        let mut last: Option<reqwest::Response> = None;
        for attempt in 0..2 {
            let token = self
                .ctx
                .access_token(&self.refresh_token, attempt > 0)
                .await?;
            let mut req = self
                .ctx
                .http
                .request(method.clone(), url)
                .bearer_auth(&token);
            if let Some((ct, bytes)) = &body {
                req = req.header("content-type", ct).body(bytes.clone());
            }
            let res = req.send().await?;
            if res.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                debug!(%url, "drive api answered 401; refreshing the access token and retrying once");
                last = Some(res);
                continue;
            }
            return Ok(res);
        }
        Ok(last.expect("loop ran"))
    }

    /// Resolve a rel_path to (fileId, md5Checksum). Cached fileIds are verified with a
    /// metadata GET (and invalidated on 404/trashed); misses go through files.list.
    async fn resolve(&self, rel_path: &str) -> Result<Option<(String, String)>> {
        let name = drive_name(rel_path);
        if let Some(id) = self.ctx.cached_file_id(&self.folder_id, &name) {
            let url = format!(
                "{}/{}?fields=id,md5Checksum,trashed",
                self.files_url(),
                uri_encode(&id, true)
            );
            let res = self.send_authed(reqwest::Method::GET, &url, None).await?;
            if res.status().is_success() {
                let v: Value = res.json().await?;
                if v.get("trashed").and_then(Value::as_bool) != Some(true) {
                    let md5 = v
                        .get("md5Checksum")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    return Ok(Some((id, md5)));
                }
            } else if res.status() != reqwest::StatusCode::NOT_FOUND {
                let status = res.status();
                let body = res.text().await.unwrap_or_default();
                return Err(anyhow!("drive files.get {rel_path}: {status} {body}"));
            }
            self.ctx.invalidate_file_id(&self.folder_id, &name);
        }
        let url = format!(
            "{}?q={}&fields=files(id,md5Checksum)",
            self.files_url(),
            uri_encode(&q_file_in_folder(&name, &self.folder_id), true),
        );
        let res = self.send_authed(reqwest::Method::GET, &url, None).await?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(anyhow!("drive files.list {rel_path}: {status} {body}"));
        }
        let v: Value = res.json().await?;
        let Some(file) = v.pointer("/files/0") else {
            return Ok(None);
        };
        let id = file
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("drive files.list entry has no id"))?
            .to_string();
        let md5 = file
            .get("md5Checksum")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        self.ctx.cache_file_id(&self.folder_id, &name, &id);
        Ok(Some((id, md5)))
    }

    /// Create a new file in the folder: one multipart/related request carrying both the
    /// metadata {name, parents} and the content.
    async fn create_multipart(&self, rel_path: &str, bytes: &[u8]) -> Result<String> {
        let name = drive_name(rel_path);
        let metadata = json!({ "name": name, "parents": [self.folder_id] }).to_string();
        let boundary = format!("muesli-{}", crate::auth::random_token());
        let body = multipart_body(&metadata, bytes, &boundary);
        let url = format!(
            "{}?uploadType=multipart&fields=id,md5Checksum",
            self.upload_url()
        );
        let res = self
            .send_authed(
                reqwest::Method::POST,
                &url,
                Some((format!("multipart/related; boundary={boundary}"), body)),
            )
            .await?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(anyhow!(
                "drive multipart create {rel_path}: {status} {body}"
            ));
        }
        let v: Value = res.json().await?;
        if let Some(id) = v.get("id").and_then(Value::as_str) {
            self.ctx.cache_file_id(&self.folder_id, &name, id);
        }
        Ok(v.get("md5Checksum")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string())
    }
}

impl StorageBackend for GdriveBackend {
    async fn read(&self, rel_path: &str) -> Result<Option<(Vec<u8>, String)>> {
        let Some((id, md5)) = self.resolve(rel_path).await? else {
            return Ok(None);
        };
        let url = format!("{}/{}?alt=media", self.files_url(), uri_encode(&id, true));
        let res = self.send_authed(reqwest::Method::GET, &url, None).await?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            // Deleted between resolve and read: drop the stale id, report absent.
            self.ctx
                .invalidate_file_id(&self.folder_id, &drive_name(rel_path));
            return Ok(None);
        }
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(anyhow!("drive media GET {rel_path}: {status} {body}"));
        }
        // Cap the download (mirrors the GitHub >1 MiB guard): an attacker-placed huge
        // Drive file must not exhaust memory on the next poll tick.
        let bytes =
            crate::storage::read_body_capped(res, &format!("drive media GET {rel_path}")).await?;
        Ok(Some((bytes, md5)))
    }

    async fn write(&self, rel_path: &str, bytes: &[u8]) -> Result<String> {
        if let Some((id, _)) = self.resolve(rel_path).await? {
            // Existing file: media update (PATCH …/upload/…/{id}?uploadType=media).
            let url = format!(
                "{}/{}?uploadType=media&fields=id,md5Checksum",
                self.upload_url(),
                uri_encode(&id, true),
            );
            let res = self
                .send_authed(
                    reqwest::Method::PATCH,
                    &url,
                    Some(("text/markdown; charset=UTF-8".to_string(), bytes.to_vec())),
                )
                .await?;
            if res.status() == reqwest::StatusCode::NOT_FOUND {
                // Deleted under us: invalidate and recreate below.
                self.ctx
                    .invalidate_file_id(&self.folder_id, &drive_name(rel_path));
            } else if !res.status().is_success() {
                let status = res.status();
                let body = res.text().await.unwrap_or_default();
                return Err(anyhow!("drive media PATCH {rel_path}: {status} {body}"));
            } else {
                let v: Value = res.json().await?;
                return Ok(v
                    .get("md5Checksum")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string());
            }
        }
        self.create_multipart(rel_path, bytes).await
    }

    async fn list(&self, prefix: &str) -> Result<Vec<(String, String)>> {
        let q = format!(
            "'{}' in parents and trashed=false",
            escape_q(&self.folder_id)
        );
        let url = format!(
            "{}?q={}&fields=files(id,name,md5Checksum,mimeType)&pageSize=1000",
            self.files_url(),
            uri_encode(&q, true),
        );
        let res = self.send_authed(reqwest::Method::GET, &url, None).await?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(anyhow!("drive files.list (folder): {status} {body}"));
        }
        let v: Value = res.json().await?;
        let files = v
            .get("files")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(files
            .iter()
            .filter(|f| f.get("mimeType").and_then(Value::as_str) != Some(FOLDER_MIME))
            .filter_map(|f| {
                let name = f.get("name").and_then(Value::as_str)?;
                let rel = rel_from_name(name);
                if !rel.starts_with(prefix) {
                    return None;
                }
                let md5 = f
                    .get("md5Checksum")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if let Some(id) = f.get("id").and_then(Value::as_str) {
                    self.ctx.cache_file_id(&self.folder_id, name, id);
                }
                Some((rel, md5.to_string()))
            })
            .collect())
    }

    async fn delete(&self, rel_path: &str) -> Result<()> {
        // Already absent = done (idempotent, like the other backends).
        let Some((id, _md5)) = self.resolve(rel_path).await? else {
            return Ok(());
        };
        let url = format!("{}/{}", self.files_url(), uri_encode(&id, true));
        let res = self
            .send_authed(reqwest::Method::DELETE, &url, None)
            .await?;
        self.ctx
            .invalidate_file_id(&self.folder_id, &drive_name(rel_path));
        if !res.status().is_success() && res.status() != reqwest::StatusCode::NOT_FOUND {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(anyhow!("drive files.delete {rel_path}: {status} {body}"));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Routes: the per-workspace OAuth dance
// ---------------------------------------------------------------------------

const OPEN_MODE: &str =
    "this endpoint requires identity (OIDC_ISSUER) — the server is running in open mode";
const NO_DB: &str = "this endpoint requires DATABASE_URL (server is running volatile)";
const NOT_CONFIGURED: &str = "google drive is not configured on the server \
     (set MUESLI_GOOGLE_CLIENT_ID + MUESLI_GOOGLE_CLIENT_SECRET or MUESLI_GOOGLE_CLIENT_FILE)";

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, msg.into()).into_response()
}

fn err500(e: anyhow::Error) -> Response {
    warn!(%e, "gdrive connect error");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

/// The rebind guard's decision, extended from the REST connect handler
/// ([`crate::workspace::create_storage_connection`]) to the OAuth flow — the OAuth
/// dance is the ONLY path that creates gdrive connections, so without this an admin of
/// an (e.g.) S3-bound workspace could click "Connect Drive" and silently rebind,
/// orphaning the attached documents. True when the workspace already has storage bound.
/// A pending wizard workspace has `storage_conn_id: None`, so the wizard flow passes
/// untouched — as do grandfathered workspaces (connections exist, never bound) and a
/// missing workspace (downstream code surfaces that its own way).
fn workspace_already_bound(meta: Option<&crate::persistence::WorkspaceMeta>) -> bool {
    meta.is_some_and(|m| m.storage_conn_id.is_some())
}

const ALREADY_BOUND: &str = "this workspace already has storage bound; disconnect it first";

/// GET /api/workspaces/{id}/storage/google/start — admin with an OIDC session; 302 to
/// the consent screen. The state token binds the eventual callback to this exact
/// (workspace, user) for 10 minutes.
pub async fn start(
    State(state): State<AppState>,
    Path(workspace_id): Path<Uuid>,
    Query(params): Query<HashMap<String, String>>,
    jar: axum_extra::extract::cookie::CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let Some(auth) = state.auth.as_ref() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, OPEN_MODE);
    };
    let Some(p) = state.persistence.clone() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, NO_DB);
    };
    let Some(google) = google() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, NOT_CONFIGURED);
    };
    let Some(principal) = auth.authenticate(&jar, &headers).await else {
        return err(StatusCode::UNAUTHORIZED, "sign in");
    };
    if principal
        .workspace_restriction
        .is_some_and(|w| w != workspace_id)
    {
        return err(
            StatusCode::FORBIDDEN,
            "your token is restricted to another workspace",
        );
    }
    match p.workspace_role(workspace_id, principal.role_user).await {
        Ok(Some(role)) if role == "admin" => {}
        Ok(_) => {
            return err(
                StatusCode::FORBIDDEN,
                "requires the admin role on this workspace",
            )
        }
        Err(e) => return err500(e),
    }
    // Rebind guard (mirrors the REST connect handler): fail fast, BEFORE redirecting the
    // user to Google — a bound workspace must disconnect first. Pending wizard workspaces
    // have storage_conn_id: None, so the wizard flow is unaffected.
    match p.workspace_meta(workspace_id).await {
        Ok(meta) if workspace_already_bound(meta.as_ref()) => {
            return err(StatusCode::CONFLICT, ALREADY_BOUND);
        }
        Ok(_) => {}
        Err(e) => return err500(e),
    }
    let wizard = params.get("wizard").map(String::as_str) == Some("1");
    let state_token = google.begin(workspace_id, principal.role_user, wizard);
    Redirect::to(&google.auth_url(&state_token)).into_response()
}

#[derive(Deserialize)]
pub struct GoogleCallbackParams {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// GET /auth/storage/google/callback?code&state — finish the dance: exchange the code,
/// find-or-create the "Muesli" folder (the probe), store the connection, bounce back to
/// the web app with ?storage=connected.
pub async fn callback(
    State(state): State<AppState>,
    Query(params): Query<GoogleCallbackParams>,
) -> Response {
    // The callback is a BROWSER navigation (Google just redirected the user here), so
    // failures render the branded error page; the operator detail stays in the log.
    let Some(auth) = state.auth.as_ref() else {
        warn!("gdrive callback: {OPEN_MODE}");
        return crate::error_page::browser_error_page(StatusCode::SERVICE_UNAVAILABLE, "/");
    };
    let Some(p) = state.persistence.clone() else {
        warn!("gdrive callback: {NO_DB}");
        return crate::error_page::browser_error_page(StatusCode::SERVICE_UNAVAILABLE, "/");
    };
    let Some(google) = google() else {
        warn!("gdrive callback: {NOT_CONFIGURED}");
        return crate::error_page::browser_error_page(StatusCode::SERVICE_UNAVAILABLE, "/");
    };
    // The user-journey failure (consent denied at Google) lands back wherever the dance
    // started: the wizard if it was wizard-initiated, else Settings → Connections
    // (settings.md §2.3). Resolve (and consume) the pending entry FIRST — deciding this
    // from the state token, not just defaulting to Settings, is what makes a wizard user
    // who denies consent land back in the wizard instead of getting bounced.
    if let Some(e) = params.error {
        warn!(error = %e, "google drive connect: consent screen returned an error");
        let pending = params.state.as_deref().and_then(|s| google.take_pending(s));
        let target = error_redirect(
            &auth.web_origin,
            pending.map(|(ws, _user, wizard)| (ws, wizard)),
        );
        return Redirect::to(&target).into_response();
    }
    let (Some(code), Some(state_token)) = (params.code, params.state) else {
        warn!("gdrive callback: missing code/state");
        return crate::error_page::browser_error_page(StatusCode::BAD_REQUEST, "/");
    };
    let Some((workspace_id, user_id, wizard)) = google.take_pending(&state_token) else {
        warn!("gdrive callback: unknown or expired connect attempt");
        return crate::error_page::browser_error_page(StatusCode::BAD_REQUEST, "/");
    };
    // Cloned BEFORE the async block: `state` itself isn't captured by it, and
    // bind_workspace() (plan 1a task 7) is the single place the pending→active
    // transition happens — the REST connect handler calls the same method.
    let storage_mgr = state.storage.clone();

    let result: Result<Uuid> = async {
        let (access, refresh, expires_in) = google.exchange_code(&code).await?;
        let refresh = refresh.ok_or_else(|| {
            anyhow!(
                "google returned no refresh_token (access_type=offline + prompt=consent expected)"
            )
        })?;
        // The probe: a Drive we cannot create our folder in is not a connection.
        let folder_id = ensure_app_folder(&google, &access).await?;
        google.store_access(&refresh, &access, expires_in);
        // The long-lived refresh token is encrypted at rest when MUESLI_SECRET_KEY is
        // set (see the encryption section above); plaintext only as a warned fallback.
        let mut config = json!({
            "folder_id": folder_id,
            "folder_name": FOLDER_NAME,
        });
        match encrypt_secret(&refresh) {
            Some(enc) => config["refresh_token_enc"] = Value::String(enc),
            None => {
                warn!(
                    "MUESLI_SECRET_KEY is not set; storing the google drive refresh token \
                     in plaintext — set a 32-byte key to encrypt it at rest"
                );
                config["refresh_token"] = Value::String(refresh);
            }
        }
        // Defense in depth: start() already refuses bound workspaces, but a binding can
        // race in during the Google round-trip (another admin connecting concurrently),
        // or the dance may have been started before the guard existed. Skip the creation
        // — the Err lands in the wizard/settings error redirect below, which warns.
        let meta = p.workspace_meta(workspace_id).await?;
        if workspace_already_bound(meta.as_ref()) {
            return Err(anyhow!(
                "{ALREADY_BOUND} (bound during the oauth round-trip)"
            ));
        }
        let id = p
            .create_storage_connection(workspace_id, "gdrive", &config)
            .await?;
        info!(%workspace_id, %user_id, conn = %id, folder = %folder_id,
              "google drive storage connection created");
        crate::audit::record(
            &p,
            crate::audit::AuditEvent::new("storage_connection_created")
                .workspace(Some(workspace_id))
                .actor(Some(user_id))
                .detail(json!({
                    "kind": "gdrive", "storage_conn_id": id, "folder_id": folder_id,
                })),
        );
        // Bind now (plan 1a task 7): activates a pending workspace, or bulk-attaches a
        // grandfathered active one's unattached documents. Never fails the connection —
        // a bind failure is logged and a later re-connect/bind retries.
        if let Some(mgr) = storage_mgr {
            if let Err(e) = mgr.bind_workspace(workspace_id, id).await {
                warn!(%e, "workspace bind after gdrive connect failed");
            }
        }
        Ok(id)
    }
    .await;

    match result {
        Ok(_) if wizard => Redirect::to(&wizard_redirect(
            &auth.web_origin,
            workspace_id,
            "connected",
        ))
        .into_response(),
        Ok(_) => Redirect::to(&settings_redirect(&auth.web_origin, "connected")).into_response(),
        Err(e) if wizard => {
            // Exchange/probe failures also land back in the wizard: the user just came
            // from a full-page Google round-trip and a bare 502 page would strand them.
            warn!(%e, "google drive connect failed");
            Redirect::to(&wizard_redirect(&auth.web_origin, workspace_id, "error")).into_response()
        }
        Err(e) => {
            // Non-wizard dances (Settings → Connections) keep the existing redirect.
            warn!(%e, "google drive connect failed");
            Redirect::to(&settings_redirect(&auth.web_origin, "error")).into_response()
        }
    }
}

/// Where the OAuth dance lands the browser: Settings → Connections, with the outcome
/// in the query (BEFORE the hash, so the hash-route grammar is untouched). The web app
/// reads ?storage= once at boot, toasts, and strips it via history.replaceState.
fn settings_redirect(web_origin: &str, outcome: &str) -> String {
    format!("{web_origin}/?storage={outcome}#~settings/connections")
}

/// Where the OAuth dance lands the browser when it started from the workspace-setup
/// wizard (plan 1b) instead of Settings → Connections: back to the wizard's step
/// machine, which resumes on `workspace_setup` and reads the outcome from `storage`.
fn wizard_redirect(web_origin: &str, workspace_id: Uuid, outcome: &str) -> String {
    format!("{web_origin}/?workspace_setup={workspace_id}&storage={outcome}")
}

/// Where an errored dance (consent denied, or a missing/unknown/expired state token)
/// should land: back in the wizard if the pending entry says it was wizard-started,
/// else Settings → Connections. `pending` is `Some((workspace_id, wizard))` when the
/// state token resolved to a pending entry; `None` when it was absent/unknown/expired.
fn error_redirect(web_origin: &str, pending: Option<(Uuid, bool)>) -> String {
    match pending {
        Some((workspace_id, true)) => wizard_redirect(web_origin, workspace_id, "error"),
        _ => settings_redirect(web_origin, "error"),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_ctx(token_uri: &str, api_base: &str) -> Arc<GoogleCtx> {
        Arc::new(GoogleCtx::new(
            "cid".into(),
            "csecret".into(),
            "http://unused/auth".into(),
            token_uri.into(),
            api_base.into(),
            "http://localhost:8787/auth/storage/google/callback".into(),
        ))
    }

    /// Fix 5 extension: the OAuth flow's rebind-guard decision, factored pure so it is
    /// testable without AppState/session plumbing. Only a workspace with storage bound
    /// (`storage_conn_id: Some`) blocks — pending wizard workspaces, grandfathered
    /// workspaces, and missing workspaces all pass. The persistence-level states this
    /// predicate reads are locked separately by persistence.rs's
    /// `workspace_meta_distinguishes_bound_from_grandfathered`.
    #[test]
    fn rebind_guard_blocks_only_bound_workspaces() {
        use crate::persistence::WorkspaceMeta;
        let meta = |status: &str, conn: Option<Uuid>| WorkspaceMeta {
            status: status.into(),
            storage_conn_id: conn,
            retention: None,
        };
        // Pending wizard workspace: no binding yet — the wizard's own Drive connect
        // must NOT be blocked.
        assert!(!workspace_already_bound(Some(&meta(
            "pending_storage",
            None
        ))));
        // Grandfathered active workspace: connections may exist, but none is bound.
        assert!(!workspace_already_bound(Some(&meta("active", None))));
        // Missing workspace: not this guard's problem (downstream surfaces it).
        assert!(!workspace_already_bound(None));
        // Bound workspace: blocked — disconnect first.
        assert!(workspace_already_bound(Some(&meta(
            "active",
            Some(Uuid::now_v7())
        ))));
    }

    #[test]
    fn callback_lands_in_settings_connections() {
        // Query BEFORE the hash: the hash-route grammar must stay untouched.
        assert_eq!(
            settings_redirect("http://localhost:5173", "connected"),
            "http://localhost:5173/?storage=connected#~settings/connections"
        );
        assert_eq!(
            settings_redirect("https://app.example", "error"),
            "https://app.example/?storage=error#~settings/connections"
        );
    }

    #[test]
    fn callback_wizard_dance_lands_back_in_the_wizard() {
        // A wizard-started dance resumes the step machine instead of Settings →
        // Connections — no hash route, and workspace_id round-trips in the query.
        let ws = Uuid::now_v7();
        assert_eq!(
            wizard_redirect("http://localhost:5173", ws, "connected"),
            format!("http://localhost:5173/?workspace_setup={ws}&storage=connected")
        );
        assert_eq!(
            wizard_redirect("https://app.example", ws, "error"),
            format!("https://app.example/?workspace_setup={ws}&storage=error")
        );
    }

    #[test]
    fn error_redirect_sends_wizard_denials_back_to_the_wizard() {
        // A wizard-started dance that the user denies at Google's consent screen must
        // land back in the wizard, not bounce to Settings → Connections (the bug: the
        // consent-denied branch used to run before take_pending resolved this).
        let ws = Uuid::now_v7();
        assert_eq!(
            error_redirect("http://localhost:5173", Some((ws, true))),
            wizard_redirect("http://localhost:5173", ws, "error")
        );
    }

    #[test]
    fn error_redirect_falls_back_to_settings_when_not_wizard_or_unknown() {
        let ws = Uuid::now_v7();
        // Known pending entry, but not wizard-started: Settings → Connections as before.
        assert_eq!(
            error_redirect("http://localhost:5173", Some((ws, false))),
            settings_redirect("http://localhost:5173", "error")
        );
        // No state / unknown / expired token: same fallback.
        assert_eq!(
            error_redirect("http://localhost:5173", None),
            settings_redirect("http://localhost:5173", "error")
        );
    }

    #[test]
    fn drive_name_round_trips_nested_paths() {
        assert_eq!(drive_name("doc.md"), "doc.md");
        assert_eq!(drive_name("notes/a/b.md"), "notes\u{2215}a\u{2215}b.md");
        assert_eq!(drive_name("/leading.md"), "leading.md");
        assert_eq!(rel_from_name(&drive_name("notes/a/b.md")), "notes/a/b.md");
        assert_eq!(rel_from_name("plain.md"), "plain.md");
    }

    #[test]
    fn drive_query_building_and_escaping() {
        assert_eq!(
            q_file_in_folder("a.md", "folder123"),
            "name='a.md' and 'folder123' in parents and trashed=false"
        );
        // single quotes and backslashes in names must be escaped for the q grammar
        assert_eq!(escape_q(r"it's a \ path"), r"it\'s a \\ path");
        assert_eq!(
            q_file_in_folder("it's.md", "f"),
            r"name='it\'s.md' and 'f' in parents and trashed=false"
        );
        assert_eq!(
            q_app_folder(),
            "name='Muesli' and mimeType='application/vnd.google-apps.folder' and trashed=false"
        );
    }

    #[test]
    fn multipart_body_shape() {
        let body = multipart_body(r#"{"name":"a.md","parents":["f1"]}"#, b"# Hello\n", "BNDRY");
        let s = String::from_utf8(body).unwrap();
        assert_eq!(
            s,
            "--BNDRY\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n\
             {\"name\":\"a.md\",\"parents\":[\"f1\"]}\r\n\
             --BNDRY\r\ncontent-type: text/markdown; charset=UTF-8\r\n\r\n\
             # Hello\n\r\n--BNDRY--"
        );
    }

    #[test]
    fn state_token_round_trip_and_ttl() {
        let ctx = test_ctx("http://unused/token", "http://unused");
        let ws = Uuid::now_v7();
        let user = Uuid::now_v7();
        let token = ctx.begin_at(ws, user, Instant::now(), false);
        assert!(ctx.auth_url(&token).contains("access_type=offline"));
        assert!(ctx.auth_url(&token).contains("prompt=consent"));
        assert!(ctx.auth_url(&token).contains("drive.file"));
        // single use
        assert_eq!(ctx.take_pending(&token), Some((ws, user, false)));
        assert_eq!(ctx.take_pending(&token), None);
        // unknown state
        assert_eq!(ctx.take_pending("bogus"), None);
        // expired (created 11 minutes ago)
        let old = Instant::now()
            .checked_sub(Duration::from_secs(11 * 60))
            .expect("clock supports the past");
        let stale = ctx.begin_at(ws, user, old, false);
        assert_eq!(ctx.take_pending(&stale), None);
    }

    #[test]
    fn state_token_carries_the_wizard_flag() {
        // The wizard flag round-trips through the pending map — it's how the callback
        // decides whether to resume the wizard or fall back to the settings redirect.
        let ctx = test_ctx("http://unused/token", "http://unused");
        let ws = Uuid::now_v7();
        let user = Uuid::now_v7();
        let token = ctx.begin_at(ws, user, Instant::now(), true);
        assert_eq!(ctx.take_pending(&token), Some((ws, user, true)));
    }

    #[test]
    fn refresh_cache_expiry_slack() {
        let ctx = test_ctx("http://unused/token", "http://unused");
        // a healthy 1h token is served from cache
        ctx.store_access("rt", "tok-a", 3600);
        assert_eq!(ctx.cached_access("rt"), Some("tok-a".into()));
        // a token within the 60s slack reads as already expired
        ctx.store_access("rt", "tok-b", 30);
        assert_eq!(ctx.cached_access("rt"), None);
        // unknown refresh token
        assert_eq!(ctx.cached_access("other"), None);
    }

    /// The expiry path, deterministically: the token endpoint mints t1 then t2; the
    /// Drive API 401s t1 (revoked) and serves t2. A read must (a) refresh once for the
    /// empty cache, (b) hit the 401, (c) force-refresh, (d) succeed — 2 token calls.
    #[tokio::test]
    async fn gdrive_read_refreshes_and_retries_on_401() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let token_calls = Arc::new(AtomicUsize::new(0));
        let tc = token_calls.clone();
        let bearer_ok = |headers: &axum::http::HeaderMap| {
            headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .map(|v| v == "Bearer t2")
                .unwrap_or(false)
        };
        let app = axum::Router::new()
            .route(
                "/token",
                axum::routing::post(move || {
                    let tc = tc.clone();
                    async move {
                        let n = tc.fetch_add(1, Ordering::SeqCst) + 1;
                        axum::Json(json!({ "access_token": format!("t{n}"), "expires_in": 3600 }))
                    }
                }),
            )
            .route(
                "/drive/v3/files",
                axum::routing::get(move |headers: axum::http::HeaderMap| async move {
                    if !bearer_ok(&headers) {
                        return (StatusCode::UNAUTHORIZED, axum::Json(json!({})));
                    }
                    (
                        StatusCode::OK,
                        axum::Json(json!({ "files": [{ "id": "f1", "md5Checksum": "m1" }] })),
                    )
                }),
            )
            .route(
                "/drive/v3/files/f1",
                axum::routing::get(
                    move |axum::extract::RawQuery(q): axum::extract::RawQuery,
                          headers: axum::http::HeaderMap| async move {
                        if !bearer_ok(&headers) {
                            return (StatusCode::UNAUTHORIZED, "".to_string());
                        }
                        if q.as_deref().unwrap_or("").contains("alt=media") {
                            (StatusCode::OK, "# from drive\n".to_string())
                        } else {
                            // metadata GET (the cached-fileId verification path)
                            (
                                StatusCode::OK,
                                json!({ "id": "f1", "md5Checksum": "m1", "trashed": false })
                                    .to_string(),
                            )
                        }
                    },
                ),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let base = format!("http://{addr}");
        let ctx = test_ctx(&format!("{base}/token"), &base);
        let backend = GdriveBackend::for_tests(ctx.clone(), "rt-1", "folder-1");
        let (bytes, etag) = backend.read("doc.md").await.unwrap().expect("file exists");
        assert_eq!(bytes, b"# from drive\n");
        assert_eq!(etag, "m1");
        assert_eq!(
            token_calls.load(Ordering::SeqCst),
            2,
            "one initial mint + exactly one forced refresh"
        );
        // the working token is now cached: another read costs no further token calls
        let again = backend.read("doc.md").await.unwrap().unwrap();
        assert_eq!(again.0, b"# from drive\n");
        assert_eq!(token_calls.load(Ordering::SeqCst), 2);
    }
}
