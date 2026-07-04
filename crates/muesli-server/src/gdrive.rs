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
//! **File mapping**: documents live in REAL nested folders under the connection's
//! folder — every rel_path directory segment is a Drive folder, the last segment the
//! plain file name. Drive has no real paths (names are not unique; folders are just
//! parents), so each segment is resolved by
//! `files.list q="name='…' and '<parent>' in parents and trashed=false"` with a
//! deterministic lowest-id tiebreak for duplicates; folder ids are cached per
//! (parent_id, name) and file ids per (leaf_folder_id, filename), invalidated on 404.
//! Reads never create folders; writes find-or-create the chain.
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

/// Split a rel_path into (folder chain, filename).
fn split_rel(rel_path: &str) -> (Vec<&str>, &str) {
    let rel = rel_path.trim_start_matches('/');
    let mut parts: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    let name = parts.pop().unwrap_or("");
    (parts, name)
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

/// The `q` that resolves a child FOLDER by name under a parent.
pub(crate) fn q_child_folder(name: &str, parent_id: &str) -> String {
    format!(
        "name='{}' and mimeType='{FOLDER_MIME}' and '{}' in parents and trashed=false",
        escape_q(name),
        escape_q(parent_id)
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
    /// (parent_id, child folder name) -> folder id; invalidated on 404 (Task 7).
    folders: Mutex<HashMap<(String, String), String>>,
    /// Serializes folder CREATION so concurrent writes into a new folder don't each
    /// create a duplicate (Drive permits duplicate names). Held across the
    /// list-then-create await, so it is a tokio mutex, not the std ones above.
    folder_create_lock: tokio::sync::Mutex<()>,
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
            folders: Mutex::new(HashMap::new()),
            folder_create_lock: tokio::sync::Mutex::new(()),
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

    /// Evict a file-id cache entry by its Drive id rather than its `(folder, name)`
    /// key, for the rare case the caller no longer knows which leaf it was cached
    /// under (the whole folder chain vanished between the cache write and now). The
    /// file_ids cache is otherwise insert-only, so without this the stale entry
    /// would sit forever under a folder id nothing resolves to any more.
    fn invalidate_file_id_by_value(&self, id: &str) {
        self.file_ids.lock().unwrap().retain(|_, v| v != id);
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

    /// Resolve a rel_path to (fileId, md5Checksum): walk the folder chain (never
    /// creating), then find the plain filename in the leaf. Cached fileIds are verified
    /// with a metadata GET (and invalidated on 404/trashed); misses go through
    /// files.list scoped to the leaf.
    async fn resolve(&self, rel_path: &str) -> Result<Option<(String, String)>> {
        let (dirs, name) = split_rel(rel_path);
        let Some(leaf) = self.resolve_folder_path(&dirs).await? else {
            return Ok(None);
        };
        if let Some(id) = self.ctx.cached_file_id(&leaf, name) {
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
            self.ctx.invalidate_file_id(&leaf, name);
        }
        let url = format!(
            "{}?q={}&fields=files(id,md5Checksum)",
            self.files_url(),
            uri_encode(&q_file_in_folder(name, &leaf), true),
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
        self.ctx.cache_file_id(&leaf, name, &id);
        Ok(Some((id, md5)))
    }

    /// Create a new file: find-or-create the folder chain, then one multipart/related
    /// request carrying both the metadata {name, parents: [leaf]} and the content.
    ///
    /// A 404 on the create means the resolved leaf was hard-deleted between ensure
    /// and upload (a narrower window than the media-PATCH races elsewhere, but the
    /// same failure mode). Recovering on the *next* call isn't good enough here --
    /// there is no "next call" fallback the way write()'s media-update path has one
    /// (that path falls through to this very function) -- so this bounded, single
    /// retry mirrors send_authed's one-refresh-one-retry discipline: invalidate the
    /// stale chain, re-ensure it once (cache-misses and re-lists to a live or fresh
    /// folder), and retry the create exactly once. No loops.
    async fn create_multipart(&self, rel_path: &str, bytes: &[u8]) -> Result<String> {
        let (dirs, name) = split_rel(rel_path);
        let mut leaf = self.ensure_folder_path(&dirs).await?;
        for attempt in 0..2 {
            let metadata = json!({ "name": name, "parents": [leaf] }).to_string();
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
            if res.status() == reqwest::StatusCode::NOT_FOUND && attempt == 0 {
                debug!(
                    %rel_path,
                    "drive multipart create 404'd on the resolved leaf; re-ensuring the folder chain and retrying once"
                );
                self.invalidate_folder_chain(&dirs);
                leaf = self.ensure_folder_path(&dirs).await?;
                continue;
            }
            if !res.status().is_success() {
                let status = res.status();
                let body = res.text().await.unwrap_or_default();
                // Defensive: a failed create (the retry above also 404'd, or a
                // different failure) must not leave the stale chain cached, or
                // every later retry re-fails on the same dead leaf id.
                self.invalidate_folder_chain(&dirs);
                return Err(anyhow!(
                    "drive multipart create {rel_path}: {status} {body}"
                ));
            }
            let v: Value = res.json().await?;
            if let Some(id) = v.get("id").and_then(Value::as_str) {
                self.ctx.cache_file_id(&leaf, name, id);
            }
            return Ok(v
                .get("md5Checksum")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string());
        }
        unreachable!("the loop above always returns or errors within its two bounded attempts")
    }

    /// One folder-resolution list call: the lowest-id matching child folder, if any.
    /// Lowest-id is a deterministic tiebreak so a duplicate folder (from a prior race or
    /// a restart) can never make ensure and resolve disagree.
    async fn find_child_folder(&self, parent_id: &str, name: &str) -> Result<Option<String>> {
        if let Some(id) = self
            .ctx
            .folders
            .lock()
            .unwrap()
            .get(&(parent_id.to_string(), name.to_string()))
            .cloned()
        {
            return Ok(Some(id));
        }
        let url = format!(
            "{}?q={}&fields=files(id)&pageSize=1000",
            self.files_url(),
            uri_encode(&q_child_folder(name, parent_id), true),
        );
        let res = self.send_authed(reqwest::Method::GET, &url, None).await?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(anyhow!(
                "drive folder list {name:?} under {parent_id}: {status} {body}"
            ));
        }
        let v: Value = res.json().await?;
        let lowest = v
            .get("files")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|f| f.get("id").and_then(Value::as_str).map(str::to_string))
            .min(); // deterministic lowest-id tiebreak
        if let Some(id) = &lowest {
            self.ctx
                .folders
                .lock()
                .unwrap()
                .insert((parent_id.to_string(), name.to_string()), id.clone());
        }
        Ok(lowest)
    }

    /// Walk the folder chain from the app-folder root without creating anything.
    async fn resolve_folder_path(&self, dirs: &[&str]) -> Result<Option<String>> {
        let mut parent = self.folder_id.clone();
        for name in dirs {
            match self.find_child_folder(&parent, name).await? {
                Some(id) => parent = id,
                None => return Ok(None),
            }
        }
        Ok(Some(parent))
    }

    /// Walk the folder chain, find-or-creating each segment; returns the leaf folder id.
    async fn ensure_folder_path(&self, dirs: &[&str]) -> Result<String> {
        let mut parent = self.folder_id.clone();
        for name in dirs {
            if let Some(id) = self.find_child_folder(&parent, name).await? {
                parent = id;
                continue;
            }
            // Serialize creation so two concurrent writes don't both make this folder.
            let _guard = self.ctx.folder_create_lock.lock().await;
            if let Some(id) = self.find_child_folder(&parent, name).await? {
                parent = id;
                continue;
            }
            let res = self
                .send_authed(
                    reqwest::Method::POST,
                    &format!("{}?fields=id", self.files_url()),
                    Some((
                        "application/json".to_string(),
                        json!({ "name": name, "mimeType": FOLDER_MIME, "parents": [parent] })
                            .to_string()
                            .into_bytes(),
                    )),
                )
                .await?;
            if !res.status().is_success() {
                let status = res.status();
                let body = res.text().await.unwrap_or_default();
                return Err(anyhow!("drive folder create {name:?}: {status} {body}"));
            }
            let v: Value = res.json().await?;
            let id = v
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("drive folder create returned no id"))?
                .to_string();
            self.ctx
                .folders
                .lock()
                .unwrap()
                .insert((parent.clone(), name.to_string()), id.clone());
            parent = id;
        }
        Ok(parent)
    }

    /// Evict every cached `(parent, name)` entry along a folder chain, so the next
    /// resolve/ensure re-lists from Drive instead of trusting a possibly-trashed id.
    /// The folders cache is otherwise insert-only, so without this a leaf trashed
    /// externally keeps resolving to its stale id forever — parenting recreated
    /// files inside the trash. Best-effort: walks the cache as far as entries
    /// exist, removing each; a miss means the rest of the chain was cached under
    /// ids we no longer hold, so there is nothing more to evict.
    fn invalidate_folder_chain(&self, dirs: &[&str]) {
        let mut cache = self.ctx.folders.lock().unwrap();
        let mut parent = self.folder_id.clone();
        for name in dirs {
            match cache.remove(&(parent.clone(), name.to_string())) {
                Some(id) => parent = id, // keep walking with the id we just evicted
                None => break,           // chain diverges from cache here
            }
        }
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
            let (dirs, name) = split_rel(rel_path);
            if let Some(leaf) = self.resolve_folder_path(&dirs).await? {
                self.ctx.invalidate_file_id(&leaf, name);
            }
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
                // Deleted under us: invalidate, then recreate below (create_multipart
                // re-ensures the folder chain).
                let (dirs, name) = split_rel(rel_path);
                if let Some(leaf) = self.resolve_folder_path(&dirs).await? {
                    self.ctx.invalidate_file_id(&leaf, name);
                } else {
                    // The whole chain is already gone (e.g. a concurrent write
                    // evicted it), so we can't name the (leaf, name) cache key any
                    // more -- but `id` above is still the stale Drive file id, so
                    // evict by value instead of leaking the orphaned entry.
                    self.ctx.invalidate_file_id_by_value(&id);
                }
                // The 404 often means the FOLDER chain itself was trashed or deleted
                // (files go with their folder). Evict the cached chain too — after the
                // file-id invalidation above, which needed the stale leaf id — so the
                // re-ensure re-lists and finds the live folder (or recreates it)
                // instead of parenting the new file inside the trash.
                self.invalidate_folder_chain(&dirs);
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
        // `prefix` names a folder to walk (possibly "" — the whole subtree); it
        // is never itself a filename, so only the folder chain matters here.
        let (dirs, _leaf_name) = split_rel(prefix);
        // Anchored at the resolved prefix folder, not the app-folder root: a
        // missing segment stops the walk here (empty result) rather than falling
        // back to a wider scope that could bleed into a sibling container.
        let Some(start) = self.resolve_folder_path(&dirs).await? else {
            return Ok(Vec::new());
        };
        let base = if dirs.is_empty() {
            String::new()
        } else {
            format!("{}/", dirs.join("/"))
        };
        let mut out = Vec::new();
        // DFS via an explicit stack (rather than recursion) since this walks
        // async requests: each folder is one or more paginated list calls.
        let mut stack = vec![(start, base)];
        while let Some((folder_id, path_prefix)) = stack.pop() {
            let mut page_token: Option<String> = None;
            loop {
                let q = format!("'{}' in parents and trashed=false", escape_q(&folder_id));
                let mut url = format!(
                    "{}?q={}&fields=nextPageToken,files(id,name,md5Checksum,mimeType)&pageSize=1000",
                    self.files_url(),
                    uri_encode(&q, true),
                );
                if let Some(t) = &page_token {
                    url.push_str(&format!("&pageToken={}", uri_encode(t, true)));
                }
                let res = self.send_authed(reqwest::Method::GET, &url, None).await?;
                if !res.status().is_success() {
                    let status = res.status();
                    let body = res.text().await.unwrap_or_default();
                    return Err(anyhow!("drive files.list (tree): {status} {body}"));
                }
                let v: Value = res.json().await?;
                for f in v
                    .get("files")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let (Some(id), Some(name)) = (
                        f.get("id").and_then(Value::as_str),
                        f.get("name").and_then(Value::as_str),
                    ) else {
                        continue;
                    };
                    if f.get("mimeType").and_then(Value::as_str) == Some(FOLDER_MIME) {
                        stack.push((id.to_string(), format!("{path_prefix}{name}/")));
                    } else {
                        let md5 = f
                            .get("md5Checksum")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        self.ctx.cache_file_id(&folder_id, name, id);
                        out.push((format!("{path_prefix}{name}"), md5.to_string()));
                    }
                }
                match v.get("nextPageToken").and_then(Value::as_str) {
                    Some(t) => page_token = Some(t.to_string()),
                    None => break,
                }
            }
        }
        Ok(out)
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
        let (dirs, name) = split_rel(rel_path);
        if let Some(leaf) = self.resolve_folder_path(&dirs).await? {
            self.ctx.invalidate_file_id(&leaf, name);
        }
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
    fn split_rel_separates_folder_chain_from_filename() {
        assert_eq!(split_rel("doc.md"), (vec![], "doc.md"));
        assert_eq!(split_rel("notes/a/b.md"), (vec!["notes", "a"], "b.md"));
        assert_eq!(split_rel("/leading.md"), (vec![], "leading.md"));
        assert_eq!(split_rel("a//b.md"), (vec!["a"], "b.md"));
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
    /// "doc.md" has an empty dir chain, so resolve_folder_path(&[]) yields the root
    /// folder with no folder lookups and the file lists under the root — the mock's
    /// files.list under 'folder-1' is exactly that leaf list.
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

    // -----------------------------------------------------------------------
    // DriveMock: reusable mock-Google fixture (folders now; files in Tasks 6-8)
    //
    // One axum server answering POST /token (always mints "t1"), GET
    // /drive/v3/files (list: matches the q param against the entry table) and
    // POST /drive/v3/files (folder create: id is "<name>-id", echoing the
    // requested name, so expected ids are readable in assertions).
    //
    // All state lives in one shared Arc<Mutex<DriveMockState>> so later tasks
    // can add endpoints (multipart upload, media GET, trashed flips, tree
    // listing) against the same entry table without rewriting the harness.
    //
    // Variants:
    //   - DriveMock::empty()                    every list answers empty
    //   - DriveMock::dupes(name, parent, ids)   seeds duplicate same-name
    //     folders so the lowest-id tiebreak is observable
    //   - DriveMock::create_chain()             starts empty; folders created
    //     via POST resolve on subsequent lists
    //   - DriveMock::tree()                      seeds a nested folder/file
    //     tree so the recursive `list` walk has something to descend into
    //
    // spawn_drive_mock returns (base_url, DriveCalls); DriveCalls counts
    // create POSTs for "no duplicate create" assertions.
    // -----------------------------------------------------------------------

    #[derive(Clone)]
    struct MockEntry {
        id: String,
        name: String,
        parent: String,
        folder: bool,
        trashed: bool,
        /// Media bytes served by GET {id}?alt=media (empty for folders).
        content: Vec<u8>,
    }

    #[derive(Default)]
    struct DriveMockState {
        entries: Vec<MockEntry>,
    }

    struct DriveMock {
        state: Arc<Mutex<DriveMockState>>,
    }

    impl DriveMock {
        fn empty() -> Self {
            Self {
                state: Arc::new(Mutex::new(DriveMockState::default())),
            }
        }

        fn dupes(name: &str, parent: &str, ids: &[&str]) -> Self {
            let mock = Self::empty();
            mock.state
                .lock()
                .unwrap()
                .entries
                .extend(ids.iter().map(|id| MockEntry {
                    id: id.to_string(),
                    name: name.to_string(),
                    parent: parent.to_string(),
                    folder: true,
                    trashed: false,
                    content: Vec::new(),
                }));
            mock
        }

        /// Behaviorally the same start state as `empty()`; the name documents
        /// the scenario under test — lists answer empty until a create lands,
        /// then the created folder resolves.
        fn create_chain() -> Self {
            Self::empty()
        }

        /// Starts empty; the name documents the write-then-read scenario —
        /// folders are created via POST, the file via multipart upload, and
        /// media GET serves the recorded bytes back.
        fn files_and_folders() -> Self {
            Self::empty()
        }

        /// Starts empty with the media routes live; every lookup answers
        /// absent, so reads must resolve to Ok(None), never an error.
        fn empty_with_media() -> Self {
            Self::empty()
        }

        /// A folder tree for the recursive `list` walk: under the connection root,
        /// `A/` holds `a.md` and a child folder `B/`, which holds `b.md` — deep
        /// enough that a root-only listing would miss both nested entries.
        fn tree() -> Self {
            let mock = Self::empty();
            mock.state.lock().unwrap().entries.extend([
                MockEntry {
                    id: "A-id".into(),
                    name: "A".into(),
                    parent: "root-folder".into(),
                    folder: true,
                    trashed: false,
                    content: Vec::new(),
                },
                MockEntry {
                    id: "a-id".into(),
                    name: "a.md".into(),
                    parent: "A-id".into(),
                    folder: false,
                    trashed: false,
                    content: Vec::new(),
                },
                MockEntry {
                    id: "B-id".into(),
                    name: "B".into(),
                    parent: "A-id".into(),
                    folder: true,
                    trashed: false,
                    content: Vec::new(),
                },
                MockEntry {
                    id: "b-id".into(),
                    name: "b.md".into(),
                    parent: "B-id".into(),
                    folder: false,
                    trashed: false,
                    content: Vec::new(),
                },
            ]);
            mock
        }
    }

    #[derive(Clone)]
    struct DriveCalls {
        creates: Arc<std::sync::atomic::AtomicUsize>,
        /// (name, parents[0]) of the most recent multipart file create — the
        /// observable that proves a file landed in the leaf folder, not flat.
        last_file: Arc<Mutex<Option<(String, String)>>>,
    }

    impl DriveCalls {
        fn creates(&self) -> usize {
            self.creates.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn last_created_file_name(&self) -> String {
            self.last_file
                .lock()
                .unwrap()
                .as_ref()
                .expect("a multipart file create was recorded")
                .0
                .clone()
        }

        fn last_created_file_parent(&self) -> String {
            self.last_file
                .lock()
                .unwrap()
                .as_ref()
                .expect("a multipart file create was recorded")
                .1
                .clone()
        }
    }

    /// Parse the exact multipart/related shape [`multipart_body`] builds:
    /// (metadata JSON, media bytes). Good enough for the harness — test
    /// content never contains a bare "\r\n--" sequence.
    fn parse_multipart_upload(body: &str) -> Option<(Value, Vec<u8>)> {
        let mut sections = body.split("\r\n\r\n");
        sections.next()?; // metadata part headers
        let meta = sections.next()?.split("\r\n--").next()?;
        let content = sections.next()?.rsplit_once("\r\n--")?.0;
        Some((
            serde_json::from_str(meta).ok()?,
            content.as_bytes().to_vec(),
        ))
    }

    /// Extract (name, parent) from a child-lookup `q` (the shapes
    /// q_child_folder / q_file_in_folder build). Test fixtures use names
    /// without quotes, so no unescaping is needed.
    fn parse_child_q(q: &str) -> Option<(String, String)> {
        let name = q.split("name='").nth(1)?.split('\'').next()?.to_string();
        let parent = q
            .split("' in parents")
            .next()?
            .rsplit('\'')
            .next()?
            .to_string();
        Some((name, parent))
    }

    /// Extract the parent id from the recursive-list `q` shape (`'<id>' in
    /// parents and trashed=false`, no `name=` filter) — the query the tree
    /// walk issues per folder to list ALL of its live children.
    fn parse_parent_only_q(q: &str) -> Option<String> {
        if q.contains("name='") {
            return None; // a name-scoped lookup, handled by parse_child_q instead
        }
        q.split('\'').nth(1).map(str::to_string)
    }

    async fn spawn_drive_mock(mock: DriveMock) -> (String, DriveCalls) {
        let calls = DriveCalls {
            creates: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            last_file: Arc::new(Mutex::new(None)),
        };
        let list_state = mock.state.clone();
        let create_state = mock.state.clone();
        let upload_state = mock.state.clone();
        let media_state = mock.state.clone();
        let create_count = calls.creates.clone();
        let last_file = calls.last_file.clone();
        let app = axum::Router::new()
            .route(
                "/token",
                axum::routing::post(|| async {
                    axum::Json(json!({ "access_token": "t1", "expires_in": 3600 }))
                }),
            )
            .route(
                "/drive/v3/files",
                axum::routing::get(
                    move |axum::extract::Query(params): axum::extract::Query<
                        HashMap<String, String>,
                    >| {
                        let state = list_state.clone();
                        async move {
                            let q = params.get("q").cloned().unwrap_or_default();
                            let folders_only = q.contains(FOLDER_MIME);
                            if let Some(parent) = parse_parent_only_q(&q) {
                                // The recursive `list` walk's per-folder query (no
                                // name= filter): serve one entry per page so its
                                // nextPageToken loop is exercised for real, not
                                // short-circuited on a single page.
                                const PAGE_SIZE: usize = 1;
                                let offset: usize = params
                                    .get("pageToken")
                                    .and_then(|t| t.parse().ok())
                                    .unwrap_or(0);
                                let all: Vec<MockEntry> = state
                                    .lock()
                                    .unwrap()
                                    .entries
                                    .iter()
                                    .filter(|e| e.parent == parent && !e.trashed)
                                    .cloned()
                                    .collect();
                                let files: Vec<Value> = all
                                    .iter()
                                    .skip(offset)
                                    .take(PAGE_SIZE)
                                    .map(|e| {
                                        json!({
                                            "id": e.id,
                                            "name": e.name,
                                            "mimeType": if e.folder { FOLDER_MIME } else { "text/markdown" },
                                            "md5Checksum": if e.folder { Value::Null } else { json!(format!("md5-{}", e.id)) },
                                        })
                                    })
                                    .collect();
                                let next_offset = offset + files.len();
                                let next_page_token =
                                    (next_offset < all.len()).then(|| next_offset.to_string());
                                return axum::Json(
                                    json!({ "files": files, "nextPageToken": next_page_token }),
                                );
                            }
                            let files: Vec<Value> = match parse_child_q(&q) {
                                Some((name, parent)) => state
                                    .lock()
                                    .unwrap()
                                    .entries
                                    .iter()
                                    .filter(|e| {
                                        e.name == name
                                            && e.parent == parent
                                            && !e.trashed
                                            && (!folders_only || e.folder)
                                    })
                                    .map(|e| json!({ "id": e.id }))
                                    .collect(),
                                None => vec![],
                            };
                            axum::Json(json!({ "files": files }))
                        }
                    },
                )
                .post(move |axum::Json(body): axum::Json<Value>| {
                    let state = create_state.clone();
                    let count = create_count.clone();
                    async move {
                        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let name = body
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let parent = body
                            .pointer("/parents/0")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let folder =
                            body.get("mimeType").and_then(Value::as_str) == Some(FOLDER_MIME);
                        let id = format!("{name}-id");
                        state.lock().unwrap().entries.push(MockEntry {
                            id: id.clone(),
                            name,
                            parent,
                            folder,
                            trashed: false,
                            content: Vec::new(),
                        });
                        axum::Json(json!({ "id": id }))
                    }
                }),
            )
            .route(
                "/upload/drive/v3/files",
                axum::routing::post(move |body: axum::body::Bytes| {
                    let state = upload_state.clone();
                    let last = last_file.clone();
                    async move {
                        let text = String::from_utf8_lossy(&body).into_owned();
                        let (meta, content) =
                            parse_multipart_upload(&text).expect("multipart body parses");
                        let name = meta
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let parent = meta
                            .pointer("/parents/0")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        // The connection's own app-folder root is never itself an
                        // entry in the table; any other parent must be a live
                        // (non-trashed) folder, so a hard-deleted leaf 404s here
                        // exactly like real Drive would.
                        let parent_live = parent == "root-folder"
                            || state
                                .lock()
                                .unwrap()
                                .entries
                                .iter()
                                .any(|e| e.id == parent && e.folder && !e.trashed);
                        if !parent_live {
                            return (StatusCode::NOT_FOUND, axum::Json(json!({})));
                        }
                        *last.lock().unwrap() = Some((name.clone(), parent.clone()));
                        let id = format!("{name}-id");
                        state.lock().unwrap().entries.push(MockEntry {
                            id: id.clone(),
                            name,
                            parent,
                            folder: false,
                            trashed: false,
                            content,
                        });
                        (
                            StatusCode::OK,
                            axum::Json(json!({ "id": id, "md5Checksum": "md5-mock" })),
                        )
                    }
                }),
            )
            .route(
                "/drive/v3/files/{id}",
                axum::routing::get(
                    move |Path(id): Path<String>,
                          axum::extract::RawQuery(q): axum::extract::RawQuery| {
                        let state = media_state.clone();
                        async move {
                            let entry = state
                                .lock()
                                .unwrap()
                                .entries
                                .iter()
                                .find(|e| e.id == id)
                                .cloned();
                            let Some(e) = entry else {
                                return (StatusCode::NOT_FOUND, Vec::new());
                            };
                            if q.as_deref().unwrap_or_default().contains("alt=media") {
                                (StatusCode::OK, e.content.clone())
                            } else {
                                // metadata GET (the cached-fileId verification path)
                                let meta = json!({
                                    "id": e.id, "md5Checksum": "md5-mock", "trashed": e.trashed,
                                });
                                (StatusCode::OK, meta.to_string().into_bytes())
                            }
                        }
                    },
                ),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), calls)
    }

    #[test]
    fn q_child_folder_scopes_to_parent_and_folders_only() {
        assert_eq!(
            q_child_folder("Projects", "root1"),
            "name='Projects' and mimeType='application/vnd.google-apps.folder' and 'root1' in parents and trashed=false"
        );
    }

    #[tokio::test]
    async fn resolve_folder_path_returns_none_on_missing_segment() {
        // Mock: files.list always returns an empty set.
        let (base, _calls) = spawn_drive_mock(DriveMock::empty()).await;
        let ctx = test_ctx(&format!("{base}/token"), &base);
        let backend = GdriveBackend::for_tests(ctx, "rt", "root-folder");
        assert_eq!(
            backend.resolve_folder_path(&["A", "B"]).await.unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn resolve_folder_path_picks_lowest_id_on_duplicates() {
        // Mock: files.list for name='A' under 'root-folder' returns two folders, ids "f9","f1".
        let (base, _calls) =
            spawn_drive_mock(DriveMock::dupes("A", "root-folder", &["f9", "f1"])).await;
        let ctx = test_ctx(&format!("{base}/token"), &base);
        let backend = GdriveBackend::for_tests(ctx, "rt", "root-folder");
        assert_eq!(
            backend.resolve_folder_path(&["A"]).await.unwrap(),
            Some("f1".to_string())
        );
    }

    #[tokio::test]
    async fn ensure_folder_path_creates_missing_then_caches() {
        let (base, calls) = spawn_drive_mock(DriveMock::create_chain()).await;
        let ctx = test_ctx(&format!("{base}/token"), &base);
        let backend = GdriveBackend::for_tests(ctx, "rt", "root-folder");
        let leaf = backend.ensure_folder_path(&["A", "B"]).await.unwrap();
        assert_eq!(leaf, "B-id");
        // second call is fully cached: no additional create POSTs
        let creates_after_first = calls.creates();
        let leaf2 = backend.ensure_folder_path(&["A", "B"]).await.unwrap();
        assert_eq!(leaf2, "B-id");
        assert_eq!(
            calls.creates(),
            creates_after_first,
            "second ensure hits cache"
        );
    }

    #[tokio::test]
    async fn gdrive_write_then_read_uses_real_nested_folders() {
        let (base, calls) = spawn_drive_mock(DriveMock::files_and_folders()).await;
        let ctx = test_ctx(&format!("{base}/token"), &base);
        let backend = GdriveBackend::for_tests(ctx, "rt", "root-folder");

        backend.write("A/B/c.md", b"# hi\n").await.unwrap();
        // The file was created inside the leaf folder, not named "A∕B∕c.md".
        assert_eq!(calls.last_created_file_name(), "c.md");
        assert_eq!(calls.last_created_file_parent(), "B-id");

        let got = backend.read("A/B/c.md").await.unwrap().unwrap();
        assert_eq!(got.0, b"# hi\n");
    }

    /// The stale-leaf recovery path: the folders cache holds "A" → L1, but Drive
    /// has trashed L1 and a fresh list resolves "A" to L2. The write's media
    /// PATCH 404s (the file was deleted under us — the mock has no PATCH route,
    /// which models exactly that), and the recreate must land under the LIVE
    /// folder L2. That requires evicting the stale (root, "A") cache entry so
    /// ensure_folder_path re-lists instead of trusting the trashed L1.
    #[tokio::test]
    async fn gdrive_write_recovers_when_cached_leaf_was_trashed() {
        let mock = DriveMock::dupes("A", "root-folder", &["L1"]);
        let state = mock.state.clone();
        // An existing file under L1, so the write resolves it and takes the
        // media-update path (whose 404 is the deleted-under-us branch).
        state.lock().unwrap().entries.push(MockEntry {
            id: "F1".into(),
            name: "c.md".into(),
            parent: "L1".into(),
            folder: false,
            trashed: false,
            content: b"old".to_vec(),
        });
        let (base, calls) = spawn_drive_mock(mock).await;
        let ctx = test_ctx(&format!("{base}/token"), &base);
        let backend = GdriveBackend::for_tests(ctx, "rt", "root-folder");

        // Prime the folders cache: "A" resolves to L1.
        assert_eq!(
            backend.resolve_folder_path(&["A"]).await.unwrap(),
            Some("L1".to_string())
        );

        // Externally: L1 goes to the trash and "A" now lists as a fresh L2
        // (the trashed=false query filters L1 out of any uncached list).
        {
            let mut s = state.lock().unwrap();
            for e in s.entries.iter_mut().filter(|e| e.id == "L1") {
                e.trashed = true;
            }
            s.entries.push(MockEntry {
                id: "L2".into(),
                name: "A".into(),
                parent: "root-folder".into(),
                folder: true,
                trashed: false,
                content: Vec::new(),
            });
        }

        backend.write("A/c.md", b"x").await.unwrap();
        // The recreated file must parent under the live folder, not inside the
        // trash via the stale cached L1.
        assert_eq!(calls.last_created_file_parent(), "L2");
    }

    /// The create-path recovery: a fresh file's resolved leaf is cached, then
    /// hard-deleted (removed entirely, not merely trashed) before the multipart
    /// upload goes out, so the create POST 404s on the stale leaf. Unlike the
    /// media-PATCH 404 above (which recovers by falling through to a fresh
    /// create_multipart call), a 404 from create_multipart itself must recover
    /// IN-CALL: invalidate the chain, re-ensure it against the live replacement
    /// folder, and retry the create exactly once -- all within one write() call,
    /// not on the next poll tick.
    #[tokio::test]
    async fn gdrive_create_retries_in_call_when_leaf_hard_deleted() {
        let mock = DriveMock::dupes("A", "root-folder", &["L1"]);
        let state = mock.state.clone();
        let (base, calls) = spawn_drive_mock(mock).await;
        let ctx = test_ctx(&format!("{base}/token"), &base);
        let backend = GdriveBackend::for_tests(ctx, "rt", "root-folder");

        // Prime the folders cache: "A" resolves to L1.
        assert_eq!(
            backend.resolve_folder_path(&["A"]).await.unwrap(),
            Some("L1".to_string())
        );

        // Externally: L1 is hard-deleted (gone entirely, unlike the trashed-flag
        // case) and a fresh live L2 takes its place under the same name.
        {
            let mut s = state.lock().unwrap();
            s.entries.retain(|e| e.id != "L1");
            s.entries.push(MockEntry {
                id: "L2".into(),
                name: "A".into(),
                parent: "root-folder".into(),
                folder: true,
                trashed: false,
                content: Vec::new(),
            });
        }

        // A brand-new file: resolve() finds nothing under the (now-gone) L1, so
        // write() goes straight to create_multipart, which trusts the cached
        // stale L1 leaf, 404s creating under it, and must recover within this
        // one call rather than returning an error.
        backend.write("A/c.md", b"x").await.unwrap();
        assert_eq!(calls.last_created_file_parent(), "L2");
    }

    #[tokio::test]
    async fn gdrive_read_missing_folder_is_absent_not_an_error() {
        let (base, _calls) = spawn_drive_mock(DriveMock::empty_with_media()).await;
        let ctx = test_ctx(&format!("{base}/token"), &base);
        let backend = GdriveBackend::for_tests(ctx, "rt", "root-folder");
        assert!(backend.read("A/missing.md").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn gdrive_list_walks_the_tree_and_prefixes_paths() {
        // Mock tree under root-folder: A/ (folder) contains a.md and B/ (folder)
        // contains b.md. A root-only listing would surface neither.
        let (base, _calls) = spawn_drive_mock(DriveMock::tree()).await;
        let ctx = test_ctx(&format!("{base}/token"), &base);
        let backend = GdriveBackend::for_tests(ctx, "rt", "root-folder");
        let mut got: Vec<String> = backend
            .list("")
            .await
            .unwrap()
            .into_iter()
            .map(|(r, _)| r)
            .collect();
        got.sort();
        assert_eq!(got, vec!["A/B/b.md".to_string(), "A/a.md".to_string()]);
    }
}
