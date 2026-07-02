//! Microsoft Graph / SharePoint storage connector (BYO storage phase 2, spec
//! 2026-07-02): a workspace's documents live in a SharePoint document library the
//! customer owns, reached app-only via the `Sites.Selected` Graph permission — a
//! tenant admin grants the app write on exactly one site, then the server talks to
//! Graph as itself (client credentials; no per-user OAuth dance).
//!
//! Mirrors gdrive.rs's shape: a process-global [`MsCtx`] (env config + shared client +
//! token cache) and a [`SharePointBackend`] implementing `StorageBackend`. Unlike the
//! Google ctx, MsCtx is installed even when NO server-level app is configured, because
//! a workspace may bring its own Entra app (per-workspace credentials, encrypted).
//!
//! Endpoint override envs (MUESLI_MS_LOGIN_BASE / MUESLI_MS_GRAPH_BASE) exist for
//! sovereign clouds (.us, 21Vianet .cn) and as test hooks, the MUESLI_GOOGLE_API_BASE
//! trick. Auth is client secret OR certificate: the cert path signs an RS256
//! client-assertion JWT assembled by hand (house style, like SigV4) with the pure-Rust
//! `rsa` crate — no ring, no jsonwebtoken, no openssl.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use tracing::{debug, warn};

const DEFAULT_LOGIN_BASE: &str = "https://login.microsoftonline.com";
const DEFAULT_GRAPH_BASE: &str = "https://graph.microsoft.com/v1.0";

/// Cached access tokens are treated as expired this long before Entra says so.
const TOKEN_EXPIRY_SLACK: Duration = Duration::from_secs(60);

static MS: OnceLock<Arc<MsCtx>> = OnceLock::new();

/// Resolve env config and install the global context. ALWAYS installs (per-workspace
/// app credentials work without a server app); the bool reports whether a server-level
/// env app is configured. Called once from main().
pub fn init_from_env() -> Result<bool> {
    let ctx = MsCtx::from_env()?;
    let configured = ctx.env_app.is_some();
    let _ = MS.set(Arc::new(ctx));
    Ok(configured)
}

pub(crate) fn msctx() -> Option<Arc<MsCtx>> {
    MS.get().cloned()
}

/// Whether a server-level Entra app exists — the setup endpoint's `configured` flag,
/// and the connect handler's "no creds anywhere" fail-fast.
pub fn configured() -> bool {
    MS.get().is_some_and(|ctx| ctx.env_app.is_some())
}

#[cfg(test)]
// Only the dispatch test (storage.rs) installs a specific mock ctx this way; other
// tests construct their own MsCtx directly.
pub(crate) fn install_test_ctx(ctx: Arc<MsCtx>) {
    let _ = MS.set(ctx);
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested): PEM parsing, x5t thumbprint, RS256 client assertion
// ---------------------------------------------------------------------------

pub(crate) fn b64url(data: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

/// Split PEM armor into (label, DER) blocks. Hand-rolled (house style): strips the
/// BEGIN/END lines, joins the base64 body, ignores anything outside blocks.
pub(crate) fn pem_blocks(pem: &str) -> Vec<(String, Vec<u8>)> {
    use base64::Engine as _;
    let mut out = Vec::new();
    let mut label: Option<String> = None;
    let mut body = String::new();
    for line in pem.lines() {
        let line = line.trim();
        if let Some(l) = line
            .strip_prefix("-----BEGIN ")
            .and_then(|r| r.strip_suffix("-----"))
        {
            label = Some(l.to_string());
            body.clear();
        } else if line.starts_with("-----END ") {
            if let Some(l) = label.take() {
                if let Ok(der) = base64::engine::general_purpose::STANDARD.decode(body.as_bytes()) {
                    out.push((l, der));
                }
            }
            body.clear();
        } else if label.is_some() {
            body.push_str(line);
        }
    }
    out
}

/// The first CERTIFICATE block's DER — all x5t needs (SHA-1 over the DER); no x509
/// parsing required, so no x509 crate.
pub(crate) fn parse_cert_pem(pem: &str) -> Result<Vec<u8>> {
    pem_blocks(pem)
        .into_iter()
        .find(|(label, _)| label == "CERTIFICATE")
        .map(|(_, der)| der)
        .ok_or_else(|| anyhow!("no CERTIFICATE block found in the PEM input"))
}

/// An RSA private key from a PEM: PKCS#8 ("PRIVATE KEY") or PKCS#1 ("RSA PRIVATE KEY").
/// Password-protected keys are refused with an actionable message.
pub(crate) fn parse_private_key_pem(pem: &str) -> Result<rsa::RsaPrivateKey> {
    use rsa::pkcs1::DecodeRsaPrivateKey as _;
    use rsa::pkcs8::DecodePrivateKey as _;
    for (label, der) in pem_blocks(pem) {
        match label.as_str() {
            "PRIVATE KEY" => {
                return rsa::RsaPrivateKey::from_pkcs8_der(&der)
                    .context("PRIVATE KEY block is not an RSA PKCS#8 key")
            }
            "RSA PRIVATE KEY" => {
                return rsa::RsaPrivateKey::from_pkcs1_der(&der)
                    .context("RSA PRIVATE KEY block is not a PKCS#1 RSA key")
            }
            "ENCRYPTED PRIVATE KEY" => {
                return Err(anyhow!(
                    "the private key is password-protected — export it unencrypted"
                ))
            }
            _ => {}
        }
    }
    Err(anyhow!(
        "no PRIVATE KEY / RSA PRIVATE KEY block found in the PEM input"
    ))
}

/// JOSE x5t: base64url(SHA-1(certificate DER)), unpadded (RFC 7515 §4.1.7). Entra
/// matches it against the uploaded certificate; SHA-1 here is an identifier, not a
/// security boundary.
pub(crate) fn x5t(cert_der: &[u8]) -> String {
    use sha1::{Digest as _, Sha1};
    b64url(&Sha1::digest(cert_der))
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// The RS256 client-assertion JWT Entra's certificate flow demands — assembled by hand
/// (house style, like SigV4): header {alg, typ, x5t}, claims {aud = token endpoint,
/// iss = sub = client_id, jti = uuid, iat, nbf, exp = iat + 10 min}.
pub(crate) fn client_assertion(
    cert_der: &[u8],
    key: &rsa::RsaPrivateKey,
    client_id: &str,
    token_endpoint: &str,
    now_unix: u64,
) -> Result<String> {
    use sha2::{Digest as _, Sha256};
    let header = serde_json::json!({ "alg": "RS256", "typ": "JWT", "x5t": x5t(cert_der) });
    let claims = serde_json::json!({
        "aud": token_endpoint,
        "iss": client_id,
        "sub": client_id,
        "jti": uuid::Uuid::new_v4().to_string(),
        "iat": now_unix,
        "nbf": now_unix,
        "exp": now_unix + 600,
    });
    let signing_input = format!(
        "{}.{}",
        b64url(header.to_string().as_bytes()),
        b64url(claims.to_string().as_bytes()),
    );
    let digest = Sha256::digest(signing_input.as_bytes());
    let signature = key
        .sign(rsa::Pkcs1v15Sign::new::<Sha256>(), &digest)
        .context("RS256 signing failed (is the private key an RSA key?)")?;
    Ok(format!("{signing_input}.{}", b64url(&signature)))
}

// ---------------------------------------------------------------------------
// Per-connection credential resolution (spec: precedence order)
// ---------------------------------------------------------------------------

/// The credential a connection authenticates with. Precedence (spec, verbatim):
/// per-workspace cert → per-workspace secret → server env cert → server env secret —
/// cert wins over secret at the same level. The env level arrives pre-collapsed as
/// `env_app` (MsCtx::from_env already prefers the cert file). Per-workspace secret
/// material is encrypted at rest (secrets.rs, MUESLI_SECRET_KEY); the certificate
/// itself is public and stored plaintext.
pub(crate) fn resolve_credential(
    config: &Value,
    env_app: Option<&MsCredential>,
) -> Result<MsCredential> {
    let field = |name: &str| {
        config
            .get(name)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    if let Some(client_id) = field("client_id") {
        if let (Some(cert_pem), Some(key_enc)) = (
            field("client_certificate_pem"),
            field("client_private_key_enc"),
        ) {
            let cert_der = parse_cert_pem(cert_pem)?;
            let key_pem = crate::secrets::decrypt_secret(key_enc)?;
            let key = parse_private_key_pem(&key_pem)?;
            return Ok(MsCredential {
                client_id: client_id.to_string(),
                auth: MsAuth::Certificate {
                    cert_der,
                    key: Box::new(key),
                },
            });
        }
        if let Some(enc) = field("client_secret_enc") {
            let secret = crate::secrets::decrypt_secret(enc)?;
            return Ok(MsCredential {
                client_id: client_id.to_string(),
                auth: MsAuth::Secret(secret),
            });
        }
        return Err(anyhow!(
            "sharepoint config has client_id but neither client_secret_enc nor \
             client_certificate_pem + client_private_key_enc"
        ));
    }
    env_app.cloned().ok_or_else(|| {
        anyhow!(
            "no microsoft app credentials: set MUESLI_MS_CLIENT_ID + MUESLI_MS_CLIENT_SECRET \
             (or MUESLI_MS_CLIENT_CERT_FILE) on the server, or store per-workspace app \
             credentials on the connection"
        )
    })
}

/// How a client authenticates against the token endpoint. Certificate wins over secret
/// at the same level (spec: credential precedence).
#[derive(Clone)]
pub(crate) enum MsAuth {
    Secret(String),
    Certificate {
        cert_der: Vec<u8>,
        /// Boxed: RsaPrivateKey is large and would dwarf the Secret variant.
        key: Box<rsa::RsaPrivateKey>,
    },
}

// Hand-written (NOT derived) so Debug can never print the client secret or the private
// key — rsa::RsaPrivateKey's own Debug dumps the raw key material, and secrets are
// never logged.
impl std::fmt::Debug for MsAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MsAuth::Secret(_) => write!(f, "Secret(<redacted>)"),
            MsAuth::Certificate { cert_der, .. } => {
                write!(
                    f,
                    "Certificate {{ cert_der: <{} bytes>, key: <redacted> }}",
                    cert_der.len()
                )
            }
        }
    }
}

/// One Entra app identity: server-level (from env) or per-workspace (from config).
#[derive(Clone)]
pub(crate) struct MsCredential {
    pub(crate) client_id: String,
    pub(crate) auth: MsAuth,
}

// Hand-written (NOT derived) for secret redaction: prints only the client_id plus the
// auth variant's redacted form (see MsAuth's Debug above).
impl std::fmt::Debug for MsCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MsCredential")
            .field("client_id", &self.client_id)
            .field("auth", &self.auth)
            .finish()
    }
}

struct CachedToken {
    access_token: String,
    expires_at: Instant,
}

/// Everything the SharePoint connector shares: endpoint bases, the reqwest client, the
/// optional server-level app, and the token cache keyed by (tenant, client_id) —
/// backends are rebuilt per operation (the gdrive pattern), so caches live here.
pub struct MsCtx {
    pub(crate) login_base: String,
    pub(crate) graph_base: String,
    pub(crate) http: reqwest::Client,
    pub(crate) env_app: Option<MsCredential>,
    tokens: Mutex<HashMap<(String, String), CachedToken>>,
}

impl MsCtx {
    pub(crate) fn new(
        login_base: String,
        graph_base: String,
        env_app: Option<MsCredential>,
    ) -> Self {
        Self {
            login_base: login_base.trim_end_matches('/').to_string(),
            graph_base: graph_base.trim_end_matches('/').to_string(),
            http: reqwest::Client::new(),
            env_app,
            tokens: Mutex::new(HashMap::new()),
        }
    }

    /// Config from MUESLI_MS_CLIENT_ID + MUESLI_MS_CLIENT_SECRET, with
    /// MUESLI_MS_LOGIN_BASE / MUESLI_MS_GRAPH_BASE endpoint overrides (sovereign
    /// clouds + test hooks). Task 2 adds MUESLI_MS_CLIENT_CERT_FILE (cert wins).
    fn from_env() -> Result<Self> {
        let env = |k: &str| std::env::var(k).ok().filter(|s| !s.is_empty());
        let login_base = env("MUESLI_MS_LOGIN_BASE").unwrap_or_else(|| DEFAULT_LOGIN_BASE.into());
        let graph_base = env("MUESLI_MS_GRAPH_BASE").unwrap_or_else(|| DEFAULT_GRAPH_BASE.into());
        let client_id = env("MUESLI_MS_CLIENT_ID");
        // Certificate wins over secret at the server-env level (spec precedence). A
        // set-but-unusable cert file fails FAST (init_from_env propagates to main()),
        // the MUESLI_GOOGLE_CLIENT_FILE posture.
        let auth = if let Some(path) = env("MUESLI_MS_CLIENT_CERT_FILE") {
            let raw = std::fs::read_to_string(&path).with_context(|| {
                format!("MUESLI_MS_CLIENT_CERT_FILE is set but unreadable: {path}")
            })?;
            let cert_der = parse_cert_pem(&raw)
                .context("MUESLI_MS_CLIENT_CERT_FILE has no CERTIFICATE block")?;
            let key = parse_private_key_pem(&raw)
                .context("MUESLI_MS_CLIENT_CERT_FILE has no private key block")?;
            Some(MsAuth::Certificate {
                cert_der,
                key: Box::new(key),
            })
        } else {
            env("MUESLI_MS_CLIENT_SECRET").map(MsAuth::Secret)
        };
        let env_app = match (client_id, auth) {
            (Some(client_id), Some(auth)) => Some(MsCredential { client_id, auth }),
            (Some(_), None) => {
                warn!("MUESLI_MS_CLIENT_ID is set without MUESLI_MS_CLIENT_SECRET or MUESLI_MS_CLIENT_CERT_FILE; ignoring it");
                None
            }
            (None, Some(_)) => {
                warn!("MUESLI_MS_CLIENT_SECRET/MUESLI_MS_CLIENT_CERT_FILE is set without MUESLI_MS_CLIENT_ID; ignoring it");
                None
            }
            (None, None) => None,
        };
        Ok(Self::new(login_base, graph_base, env_app))
    }

    /// POST target for client-credentials grants: {login_base}/{tenant}/oauth2/v2.0/token.
    pub(crate) fn token_endpoint(&self, tenant: &str) -> String {
        format!("{}/{}/oauth2/v2.0/token", self.login_base, tenant)
    }

    /// The .default scope for whatever Graph cloud we're pointed at:
    /// "https://graph.microsoft.com/.default" for the default base.
    pub(crate) fn graph_scope(&self) -> String {
        match reqwest::Url::parse(&self.graph_base) {
            Ok(u) => format!("{}/.default", u.origin().ascii_serialization()),
            Err(_) => format!("{DEFAULT_GRAPH_BASE}/.default"),
        }
    }

    pub(crate) fn cached_access(&self, tenant: &str, client_id: &str) -> Option<String> {
        let map = self.tokens.lock().unwrap();
        let t = map.get(&(tenant.to_string(), client_id.to_string()))?;
        (Instant::now() < t.expires_at).then(|| t.access_token.clone())
    }

    /// Cache a token; it reads as expired TOKEN_EXPIRY_SLACK before Entra's expiry so
    /// in-flight requests never ride a token about to die (the gdrive pattern).
    pub(crate) fn store_access(
        &self,
        tenant: &str,
        client_id: &str,
        access_token: &str,
        expires_in: u64,
    ) {
        let usable = Duration::from_secs(expires_in.saturating_sub(TOKEN_EXPIRY_SLACK.as_secs()));
        self.tokens.lock().unwrap().insert(
            (tenant.to_string(), client_id.to_string()),
            CachedToken {
                access_token: access_token.to_string(),
                expires_at: Instant::now() + usable,
            },
        );
    }

    /// Client-credentials → access token, through the cache. `force` drops the cached
    /// entry first (the 401-retry path).
    pub(crate) async fn access_token(
        &self,
        tenant: &str,
        cred: &MsCredential,
        force: bool,
    ) -> Result<String> {
        if force {
            self.tokens
                .lock()
                .unwrap()
                .remove(&(tenant.to_string(), cred.client_id.clone()));
        } else if let Some(tok) = self.cached_access(tenant, &cred.client_id) {
            return Ok(tok);
        }
        let scope = self.graph_scope();
        let mut params: Vec<(&str, String)> = vec![
            ("grant_type", "client_credentials".into()),
            ("client_id", cred.client_id.clone()),
            ("scope", scope),
        ];
        let endpoint = self.token_endpoint(tenant);
        match &cred.auth {
            MsAuth::Secret(s) => params.push(("client_secret", s.clone())),
            MsAuth::Certificate { cert_der, key } => {
                params.push((
                    "client_assertion_type",
                    "urn:ietf:params:oauth:client-assertion-type:jwt-bearer".into(),
                ));
                params.push((
                    "client_assertion",
                    client_assertion(cert_der, key, &cred.client_id, &endpoint, now_unix())?,
                ));
            }
        }
        let res = self
            .http
            .post(&endpoint)
            .form(&params)
            .send()
            .await
            .with_context(|| format!("POST {endpoint}"))?;
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        if !status.is_success() {
            // Surface the AADSTS code + a truncated description (the debugging key the
            // spec's error table demands), NEVER the raw body — it is not ours to log.
            let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let code = v.get("error").and_then(Value::as_str).unwrap_or("");
            let desc: String = v
                .get("error_description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .chars()
                .take(200)
                .collect();
            return Err(anyhow!(
                "microsoft token endpoint answered {status} {code}: {desc}"
            ));
        }
        let v: Value =
            serde_json::from_str(&body).context("microsoft token endpoint returned non-JSON")?;
        let access = v
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("token response has no access_token"))?
            .to_string();
        let expires_in = v.get("expires_in").and_then(Value::as_u64).unwrap_or(3599);
        self.store_access(tenant, &cred.client_id, &access, expires_in);
        debug!(%tenant, "minted a fresh microsoft graph access token (forced: {force})");
        Ok(access)
    }
}

// ---------------------------------------------------------------------------
// SharePointBackend — the fourth AnyBackend variant
// ---------------------------------------------------------------------------

use crate::storage::{
    read_body_capped, uri_encode, validate_list_prefix, validate_rel_path, StorageBackend,
    MAX_INGEST_BYTES,
};

/// Graph's simple-upload ceiling: documented as "4 MB". Read conservatively as decimal
/// (4,000,000 bytes, not 4 * 1024 * 1024 = 4,194,304) — sovereign clouds (.us, 21Vianet
/// .cn) lag the worldwide cloud's higher limits, and a write that lands 194 KB above
/// whatever a given cloud actually enforces fails outright rather than falling back.
/// Above it (and our ingest cap is 5 MiB, so this is a real path) writes go through
/// createUploadSession + chunked PUTs instead.
pub(crate) const SIMPLE_UPLOAD_MAX: usize = 4_000_000;
/// Upload-session chunk size — Graph requires multiples of 320 KiB; 10 × 327 680.
const UPLOAD_CHUNK: usize = 10 * 320 * 1024;

/// The item's version tag: cTag (changes only when content changes) with eTag as the
/// fallback — some Graph responses omit cTag (spec: cTag-fallback-eTag).
pub(crate) fn item_tag(item: &Value) -> String {
    item.get("cTag")
        .and_then(Value::as_str)
        .or_else(|| item.get("eTag").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string()
}

/// One authenticated Graph request with the transparent-expiry path: a 401 forces ONE
/// token refresh and one retry (the gdrive send_authed pattern). A free function so
/// the site-resolve/library-list helpers (which run before any backend exists) share it.
pub(crate) async fn send_authed_with(
    ctx: &MsCtx,
    cred: &MsCredential,
    tenant: &str,
    method: reqwest::Method,
    url: &str,
    body: Option<(String, Vec<u8>)>,
) -> Result<reqwest::Response> {
    let mut last: Option<reqwest::Response> = None;
    for attempt in 0..2 {
        let token = ctx.access_token(tenant, cred, attempt > 0).await?;
        let mut req = ctx.http.request(method.clone(), url).bearer_auth(&token);
        if let Some((ct, bytes)) = &body {
            req = req.header("content-type", ct).body(bytes.clone());
        }
        let res = req.send().await?;
        if res.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            debug!(%url, "graph answered 401; refreshing the access token and retrying once");
            last = Some(res);
            continue;
        }
        return Ok(res);
    }
    Ok(last.expect("loop ran"))
}

/// Read a response's error detail, capped — Graph error bodies are JSON and small, but
/// never trust that; 300 chars is plenty for the health line (which caps again at 500).
async fn err_detail(res: reqwest::Response) -> String {
    res.text()
        .await
        .unwrap_or_default()
        .chars()
        .take(300)
        .collect()
}

pub struct SharePointBackend {
    ctx: Arc<MsCtx>,
    cred: MsCredential,
    tenant: String,
    drive_id: String,
    prefix: String, // "" or "a/b/" style, like S3Backend
}

impl SharePointBackend {
    /// Build from a storage_connections row's config jsonb: {tenant_id, site_url,
    /// site_id, drive_id, drive_name, prefix?, + optional per-workspace app creds}.
    /// Only tenant_id/drive_id/prefix/credentials matter at runtime — site fields are
    /// display/reconnect metadata.
    pub fn from_conn(kind: &str, config: &Value) -> Result<Self> {
        if kind != "sharepoint" {
            return Err(anyhow!(
                "SharePointBackend cannot serve storage kind {kind:?}"
            ));
        }
        let ctx = msctx()
            .ok_or_else(|| anyhow!("microsoft graph support is not initialized on this server"))?;
        let field = |name: &str| -> Result<String> {
            config
                .get(name)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .ok_or_else(|| anyhow!("sharepoint storage config has no {name}"))
        };
        let mut prefix = config
            .get("prefix")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim_matches('/')
            .to_string();
        if !prefix.is_empty() {
            validate_rel_path(&prefix)?;
            prefix.push('/');
        }
        let cred = resolve_credential(config, ctx.env_app.as_ref())?;
        Ok(Self {
            cred,
            tenant: field("tenant_id")?,
            drive_id: field("drive_id")?,
            prefix,
            ctx,
        })
    }

    #[cfg(test)]
    pub(crate) fn for_tests(
        ctx: Arc<MsCtx>,
        cred: MsCredential,
        tenant: &str,
        drive_id: &str,
        prefix: &str,
    ) -> Self {
        let mut prefix = prefix.trim_matches('/').to_string();
        if !prefix.is_empty() {
            prefix.push('/');
        }
        Self {
            ctx,
            cred,
            tenant: tenant.into(),
            drive_id: drive_id.into(),
            prefix,
        }
    }

    /// Path-addressed driveItem URL: {graph}/drives/{id}/root:/{prefix/rel} — segments
    /// percent-encoded, '/' kept as the separator. Suffix operations append ":/content"
    /// etc. (Graph's colon syntax).
    fn item_url(&self, rel_path: &str) -> String {
        format!(
            "{}/drives/{}/root:/{}",
            self.ctx.graph_base,
            uri_encode(&self.drive_id, true),
            uri_encode(
                &format!("{}{}", self.prefix, rel_path.trim_start_matches('/')),
                false
            ),
        )
    }

    async fn send_authed(
        &self,
        method: reqwest::Method,
        url: &str,
        body: Option<(String, Vec<u8>)>,
    ) -> Result<reqwest::Response> {
        send_authed_with(&self.ctx, &self.cred, &self.tenant, method, url, body).await
    }

    /// The > 4 MB path: createUploadSession, then 320-KiB-aligned chunks PUT to the
    /// session's pre-authenticated uploadUrl (NO bearer — Graph rejects it there).
    /// Intermediate chunks answer 202; the final 200/201 carries the driveItem.
    async fn write_via_session(&self, rel_path: &str, bytes: &[u8]) -> Result<String> {
        let url = format!("{}:/createUploadSession", self.item_url(rel_path));
        let body =
            serde_json::json!({ "item": { "@microsoft.graph.conflictBehavior": "replace" } });
        let res = self
            .send_authed(
                reqwest::Method::POST,
                &url,
                Some(("application/json".to_string(), serde_json::to_vec(&body)?)),
            )
            .await?;
        if !res.status().is_success() {
            let status = res.status();
            return Err(anyhow!(
                "sharepoint createUploadSession {rel_path}: {status} {}",
                err_detail(res).await
            ));
        }
        let v: Value = res.json().await?;
        let upload_url = v
            .get("uploadUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("createUploadSession returned no uploadUrl"))?
            .to_string();
        let total = bytes.len();
        let mut item: Option<Value> = None;
        for (i, chunk) in bytes.chunks(UPLOAD_CHUNK).enumerate() {
            let start = i * UPLOAD_CHUNK;
            let end = start + chunk.len() - 1;
            let res = self
                .ctx
                .http
                .put(&upload_url)
                .header("content-range", format!("bytes {start}-{end}/{total}"))
                .body(chunk.to_vec())
                .send()
                .await
                // uploadUrl is a pre-authenticated write endpoint (no bearer needed) — a
                // transport-level reqwest::Error's Display embeds the full request URL,
                // which would leak that live credential into HealthRegistry / warn! logs.
                // without_url() strips it before the error ever enters the chain.
                .map_err(|e| {
                    anyhow!(
                        "sharepoint chunk upload {rel_path} ({start}-{end}): {}",
                        e.without_url()
                    )
                })?;
            let status = res.status();
            if !status.is_success() {
                return Err(anyhow!(
                    "sharepoint chunk upload {rel_path} ({start}-{end}): {status} {}",
                    err_detail(res).await
                ));
            }
            if status == reqwest::StatusCode::OK || status == reqwest::StatusCode::CREATED {
                // A decode/transport error here also embeds the pre-authenticated
                // uploadUrl in its Display — strip it, same as the send above.
                item = Some(res.json().await.map_err(|e| {
                    anyhow!(
                        "sharepoint upload session driveItem for {rel_path}: {}",
                        e.without_url()
                    )
                })?);
            }
        }
        let item = item
            .ok_or_else(|| anyhow!("upload session for {rel_path} never returned the driveItem"))?;
        Ok(item_tag(&item))
    }

    /// Connection probe: prove write+read+byte-compare+delete under the prefix in the
    /// chosen library (the exact S3Backend::probe cycle). The rel_path stays inside
    /// .muesli/ so a colliding real document is impossible.
    pub async fn probe(&self) -> Result<()> {
        let rel = format!(".muesli/probe-{}", uuid::Uuid::new_v4());
        let payload = b"muesli storage probe";
        self.write(&rel, payload)
            .await
            .context("probe write failed")?;
        let read = self
            .read(&rel)
            .await
            .context("probe read failed")?
            .ok_or_else(|| anyhow!("probe object vanished between write and read"))?;
        if read.0 != payload {
            return Err(anyhow!("probe read returned different bytes than written"));
        }
        self.delete(&rel).await.context("probe delete failed")?;
        Ok(())
    }
}

impl StorageBackend for SharePointBackend {
    async fn read(&self, rel_path: &str) -> Result<Option<(Vec<u8>, String)>> {
        validate_rel_path(rel_path)?;
        // 1) metadata: version tag + size guard, WITHOUT downloading anything yet.
        let res = self
            .send_authed(reqwest::Method::GET, &self.item_url(rel_path), None)
            .await?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !res.status().is_success() {
            let status = res.status();
            return Err(anyhow!(
                "sharepoint GET {rel_path}: {status} {}",
                err_detail(res).await
            ));
        }
        let v: Value = res.json().await?;
        let size = v.get("size").and_then(Value::as_u64).unwrap_or(0);
        if size > MAX_INGEST_BYTES {
            return Err(anyhow!(
                "sharepoint GET {rel_path}: object is {size} bytes, over the \
                 {MAX_INGEST_BYTES}-byte ingest cap; skipping"
            ));
        }
        let tag = item_tag(&v);
        // 2) content via the pre-authenticated downloadUrl — no bearer, no 302 dance.
        let download = v
            .get("@microsoft.graph.downloadUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                anyhow!("sharepoint GET {rel_path}: driveItem has no downloadUrl (is it a folder?)")
            })?;
        // @microsoft.graph.downloadUrl carries a live tempauth token in its query string —
        // a transport-level reqwest::Error's Display embeds the full request URL, so map
        // it through without_url() before it can reach HealthRegistry / warn! logs.
        let res = self.ctx.http.get(download).send().await.map_err(|e| {
            anyhow!(
                "sharepoint content download for {rel_path}: {}",
                e.without_url()
            )
        })?;
        if !res.status().is_success() {
            let status = res.status();
            return Err(anyhow!("sharepoint download {rel_path}: {status}"));
        }
        let bytes = read_body_capped(res, &format!("sharepoint download {rel_path}")).await?;
        Ok(Some((bytes, tag)))
    }

    async fn write(&self, rel_path: &str, bytes: &[u8]) -> Result<String> {
        validate_rel_path(rel_path)?;
        if bytes.len() <= SIMPLE_UPLOAD_MAX {
            // Simple upload: one PUT to …:/content (creates or replaces).
            let url = format!("{}:/content", self.item_url(rel_path));
            let res = self
                .send_authed(
                    reqwest::Method::PUT,
                    &url,
                    Some(("text/markdown; charset=UTF-8".to_string(), bytes.to_vec())),
                )
                .await?;
            if !res.status().is_success() {
                let status = res.status();
                return Err(anyhow!(
                    "sharepoint PUT {rel_path}: {status} {}",
                    err_detail(res).await
                ));
            }
            let v: Value = res.json().await?;
            return Ok(item_tag(&v));
        }
        self.write_via_session(rel_path, bytes).await
    }

    async fn list(&self, prefix: &str) -> Result<Vec<(String, String)>> {
        validate_list_prefix(prefix)?;
        let rel_prefix = prefix.trim_matches('/').to_string();
        let full = format!("{}{}", self.prefix, rel_prefix)
            .trim_matches('/')
            .to_string();
        let mut url = if full.is_empty() {
            format!(
                "{}/drives/{}/root/children",
                self.ctx.graph_base,
                uri_encode(&self.drive_id, true)
            )
        } else {
            format!(
                "{}/drives/{}/root:/{}:/children",
                self.ctx.graph_base,
                uri_encode(&self.drive_id, true),
                uri_encode(&full, false)
            )
        };
        let mut out = Vec::new();
        loop {
            let res = self.send_authed(reqwest::Method::GET, &url, None).await?;
            if res.status() == reqwest::StatusCode::NOT_FOUND {
                return Ok(Vec::new()); // folder doesn't exist yet — nothing listed
            }
            if !res.status().is_success() {
                let status = res.status();
                return Err(anyhow!(
                    "sharepoint LIST {prefix}: {status} {}",
                    err_detail(res).await
                ));
            }
            let v: Value = res.json().await?;
            for item in v
                .get("value")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if item.get("file").is_none() {
                    continue; // folders — file-only listing, GithubBackend parity
                }
                let Some(name) = item.get("name").and_then(Value::as_str) else {
                    continue;
                };
                let rel = if rel_prefix.is_empty() {
                    name.to_string()
                } else {
                    format!("{rel_prefix}/{name}")
                };
                out.push((rel, item_tag(item)));
            }
            // @odata.nextLink is absolute and pre-built by Graph; follow it verbatim.
            match v.get("@odata.nextLink").and_then(Value::as_str) {
                Some(next) => url = next.to_string(),
                None => return Ok(out),
            }
        }
    }

    async fn delete(&self, rel_path: &str) -> Result<()> {
        validate_rel_path(rel_path)?;
        let res = self
            .send_authed(reqwest::Method::DELETE, &self.item_url(rel_path), None)
            .await?;
        // Already absent = done (idempotent, matching the trait contract).
        if !res.status().is_success() && res.status() != reqwest::StatusCode::NOT_FOUND {
            let status = res.status();
            return Err(anyhow!(
                "sharepoint DELETE {rel_path}: {status} {}",
                err_detail(res).await
            ));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Site resolve + library list (the wizard's "Find libraries" call)
// ---------------------------------------------------------------------------

pub(crate) struct SiteInfo {
    pub site_id: String,
    pub site_name: String,
}

pub(crate) struct LibraryInfo {
    pub drive_id: String,
    pub name: String,
    pub is_default: bool,
}

/// (hostname, server-relative path) from a user-entered site URL. PARSE ONLY — the
/// server never fetches this URL; both parts go to Graph's site resolver, whose host
/// comes from server env. Hence no validate_storage_url (spec: SSRF section).
///
/// The path is checked against the ORIGINAL input text, not just `Url::path()` —
/// reqwest's URL parser silently collapses "." / ".." segments while parsing (so
/// `site_url=https://host/sites/../../v1.0/anything` would otherwise resolve to a
/// harmless-looking `/v1.0/anything`, hiding the traversal attempt rather than refusing
/// it), and it leaves EMPTY segments from "//" untouched either way. This path is
/// interpolated verbatim into `/sites/{host}:{path}` by [`resolve_site`], reachable from
/// the admin-only libraries endpoint — reject empty, ".", or ".." segments outright
/// (mirrors validate_rel_path's rule, storage.rs:131) rather than silently normalizing.
pub(crate) fn site_path_of(site_url: &str) -> Result<(String, String)> {
    let url =
        reqwest::Url::parse(site_url).with_context(|| format!("invalid site url {site_url:?}"))?;
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("site url {site_url:?} has no host"))?
        .to_string();
    // The path as the user actually typed it: everything after "scheme://authority",
    // before any '?' query or '#' fragment, trailing '/' trimmed (a bare root URL like
    // "https://host" or "https://host/" has an empty, and valid, site path).
    let raw_path = site_url
        .split_once("://")
        .and_then(|(_, rest)| rest.split_once('/'))
        .map_or("", |(_, p)| p);
    let raw_path = raw_path
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim_end_matches('/');
    // "".split('/') yields a single empty element, not zero — an empty (root) path is
    // valid and must not be mistaken for an empty segment.
    if !raw_path.is_empty()
        && raw_path
            .split('/')
            .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return Err(anyhow!(
            "site url {site_url:?} path contains invalid segments (empty, '.', or '..')"
        ));
    }
    let path = url.path().trim_end_matches('/').to_string();
    Ok((host, path))
}

/// GET /sites/{hostname}:{server-relative-path} (or /sites/{hostname} for the root
/// site) → the composite site id + display name.
pub(crate) async fn resolve_site(
    ctx: &MsCtx,
    cred: &MsCredential,
    tenant: &str,
    site_url: &str,
) -> Result<SiteInfo> {
    let (host, path) = site_path_of(site_url)?;
    let url = if path.is_empty() {
        format!("{}/sites/{}", ctx.graph_base, uri_encode(&host, true))
    } else {
        format!(
            "{}/sites/{}:{}",
            ctx.graph_base,
            uri_encode(&host, true),
            uri_encode(&path, false)
        )
    };
    let res = send_authed_with(ctx, cred, tenant, reqwest::Method::GET, &url, None).await?;
    if !res.status().is_success() {
        let status = res.status();
        return Err(anyhow!(
            "graph site resolve {site_url}: {status} {}",
            err_detail(res).await
        ));
    }
    let v: Value = res.json().await?;
    let site_id = v
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("graph site resolve returned no id"))?
        .to_string();
    let site_name = v
        .get("displayName")
        .and_then(Value::as_str)
        .or_else(|| v.get("name").and_then(Value::as_str))
        .unwrap_or(&site_id)
        .to_string();
    Ok(SiteInfo { site_id, site_name })
}

/// GET /sites/{id}/drives (all document libraries) + GET /sites/{id}/drive (the
/// default one, for the wizard's preselection — tolerated to fail: no default marked).
pub(crate) async fn list_libraries(
    ctx: &MsCtx,
    cred: &MsCredential,
    tenant: &str,
    site_id: &str,
) -> Result<Vec<LibraryInfo>> {
    let url = format!(
        "{}/sites/{}/drives",
        ctx.graph_base,
        uri_encode(site_id, true)
    );
    let res = send_authed_with(ctx, cred, tenant, reqwest::Method::GET, &url, None).await?;
    if !res.status().is_success() {
        let status = res.status();
        return Err(anyhow!(
            "graph drive list {site_id}: {status} {}",
            err_detail(res).await
        ));
    }
    let v: Value = res.json().await?;
    let drives = v
        .get("value")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let default_id = async {
        let url = format!(
            "{}/sites/{}/drive",
            ctx.graph_base,
            uri_encode(site_id, true)
        );
        let res = send_authed_with(ctx, cred, tenant, reqwest::Method::GET, &url, None)
            .await
            .ok()?;
        if !res.status().is_success() {
            return None;
        }
        res.json::<Value>()
            .await
            .ok()?
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
    }
    .await;
    Ok(drives
        .iter()
        .filter_map(|d| {
            let id = d.get("id").and_then(Value::as_str)?;
            let name = d.get("name").and_then(Value::as_str).unwrap_or(id);
            Some(LibraryInfo {
                drive_id: id.to_string(),
                name: name.to_string(),
                is_default: default_id.as_deref() == Some(id),
            })
        })
        .collect())
}

// ---------------------------------------------------------------------------
// HTTP endpoints: setup metadata + ephemeral library list (admin)
// ---------------------------------------------------------------------------

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use uuid::Uuid;

use crate::AppState;

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, msg.into()).into_response()
}

/// Spec: the tenant must be a GUID or match [A-Za-z0-9.-]+ — it is interpolated into
/// the login URL path, so nothing else may pass. GUIDs are a subset of the class.
pub(crate) fn valid_tenant(t: &str) -> bool {
    !t.is_empty()
        && t.len() <= 128
        && t.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

/// A human hint keyed on the common Graph/Entra failures (the probe_hint pattern;
/// spec: error-handling table).
pub(crate) fn graph_hint(e: &anyhow::Error) -> &'static str {
    let s = e.to_string();
    if s.contains("AADSTS") {
        " — check the app credentials and tenant (is admin consent completed?)"
    } else if s.contains("403") || s.contains("accessDenied") || s.contains("Forbidden") {
        " — the app has no grant on this site; run the site-grant snippet as a tenant admin"
    } else if s.contains("404") || s.contains("itemNotFound") {
        " — not found; check the site URL"
    } else {
        ""
    }
}

/// The Graph site-grant snippet the wizard shows verbatim. {client_id} is substituted
/// client-side (server app or the workspace's own app); {hostname}/{site_path}/{site_id}
/// stay for the admin, who runs this with their own privileges (the app can't see the
/// site before the grant exists — that's the point of Sites.Selected).
pub(crate) const GRANT_SNIPPET_GRAPH: &str = r#"# 1. As a tenant admin (e.g. in Graph Explorer), resolve the site id:
GET https://graph.microsoft.com/v1.0/sites/{hostname}:/{site_path}?$select=id

# 2. Grant the app write access to exactly this site:
POST https://graph.microsoft.com/v1.0/sites/{site_id}/permissions
Content-Type: application/json

{
  "roles": ["write"],
  "grantedToIdentities": [
    { "application": { "id": "{client_id}", "displayName": "Muesli" } }
  ]
}"#;

/// The PnP PowerShell equivalent (takes the site URL directly).
pub(crate) const GRANT_SNIPPET_POWERSHELL: &str =
    "Grant-PnPAzureADAppSitePermission -AppId {client_id} -DisplayName Muesli -Site {site_url} -Permissions Write";

/// GET /api/storage/sharepoint/setup — any authenticated user (the wizard shows this
/// BEFORE a workspace exists, like /api/storage/s3/policy). `configured:false` +
/// `client_id:null` when the server has no Entra app: the wizard then REQUIRES the
/// bring-your-own-app path (spec: error-handling table, last row).
pub async fn setup(
    State(state): State<AppState>,
    jar: axum_extra::extract::cookie::CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(r) = crate::workspace::ctx(&state, &jar, &headers).await {
        return r;
    }
    let (configured, client_id, login_base) = match msctx() {
        Some(ctx) => (
            ctx.env_app.is_some(),
            ctx.env_app.as_ref().map(|a| a.client_id.clone()),
            ctx.login_base.clone(),
        ),
        None => (false, None, DEFAULT_LOGIN_BASE.to_string()),
    };
    Json(serde_json::json!({
        "configured": configured,
        "client_id": client_id,
        "consent_url_template": format!("{login_base}/{{tenant}}/adminconsent?client_id={{client_id}}"),
        "grant_snippet_graph": GRANT_SNIPPET_GRAPH,
        "grant_snippet_powershell": GRANT_SNIPPET_POWERSHELL,
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct LibrariesReq {
    pub(crate) tenant: String,
    pub(crate) site_url: String,
    pub(crate) client_id: Option<String>,
    pub(crate) client_secret: Option<String>,
    pub(crate) client_certificate_pem: Option<String>,
    pub(crate) client_private_key_pem: Option<String>,
}

/// Request-borne credentials for the library-list endpoint: used for THIS lookup only,
/// never persisted — so no MUESLI_SECRET_KEY requirement here (nothing is stored).
/// Cert wins over secret; env app is the fallback.
pub(crate) fn ephemeral_credential(
    client_id: Option<&str>,
    client_secret: Option<&str>,
    cert_pem: Option<&str>,
    key_pem: Option<&str>,
    env_app: Option<&MsCredential>,
) -> Result<MsCredential> {
    // A plain fn (not a closure) so it's generic over each call's input lifetime
    // (HRTB) — client_id/client_secret/cert_pem/key_pem each borrow from a different
    // request field, so a closure fixed to one concrete lifetime won't typecheck.
    fn non_empty(s: Option<&str>) -> Option<&str> {
        s.map(str::trim).filter(|s| !s.is_empty())
    }
    if let Some(client_id) = non_empty(client_id) {
        if let (Some(cert), Some(key)) = (non_empty(cert_pem), non_empty(key_pem)) {
            return Ok(MsCredential {
                client_id: client_id.to_string(),
                auth: MsAuth::Certificate {
                    cert_der: parse_cert_pem(cert)?,
                    key: Box::new(parse_private_key_pem(key)?),
                },
            });
        }
        if let Some(secret) = non_empty(client_secret) {
            return Ok(MsCredential {
                client_id: client_id.to_string(),
                auth: MsAuth::Secret(secret.to_string()),
            });
        }
        return Err(anyhow!(
            "client_id was sent without a client_secret or certificate + private key"
        ));
    }
    env_app.cloned().ok_or_else(|| {
        anyhow!(
            "this server has no Microsoft app configured — provide your own Entra app credentials"
        )
    })
}

/// POST /api/workspaces/{id}/storage/sharepoint/libraries — admin-only, EPHEMERAL
/// (persists nothing): resolve the site, list its document libraries. Failures map
/// through graph_hint (consent missing / no site grant / bad site URL — spec table).
pub async fn list_libraries_endpoint(
    State(state): State<AppState>,
    Path(workspace_id): Path<Uuid>,
    jar: axum_extra::extract::cookie::CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<LibrariesReq>,
) -> Response {
    let c = match crate::workspace::ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Err(r) = c.require_admin(workspace_id).await {
        return r;
    }
    let Some(ctx) = msctx() else {
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "microsoft graph support is not initialized",
        );
    };
    let tenant = req.tenant.trim().to_string();
    if !valid_tenant(&tenant) {
        return err(
            StatusCode::BAD_REQUEST,
            "tenant must be a GUID or a domain ([A-Za-z0-9.-]+)",
        );
    }
    let cred = match ephemeral_credential(
        req.client_id.as_deref(),
        req.client_secret.as_deref(),
        req.client_certificate_pem.as_deref(),
        req.client_private_key_pem.as_deref(),
        ctx.env_app.as_ref(),
    ) {
        Ok(c) => c,
        Err(e) => return err(StatusCode::BAD_REQUEST, e.to_string()),
    };
    let site = match resolve_site(&ctx, &cred, &tenant, req.site_url.trim()).await {
        Ok(s) => s,
        Err(e) => {
            // The real upstream error survives; the hint points at the fix (grant
            // snippet / site URL / credentials). Spec error table: a site URL that
            // doesn't resolve is the CALLER's error → 4xx "check the site URL";
            // everything else upstream is 502 (the probe-failure pattern).
            let s = e.to_string();
            let msg = format!("site lookup failed: {e:#}{}", graph_hint(&e));
            return if s.contains("invalid site url")
                || s.contains("has no host")
                || s.contains("404")
                || s.contains("itemNotFound")
            {
                err(StatusCode::BAD_REQUEST, msg)
            } else {
                err(StatusCode::BAD_GATEWAY, msg)
            };
        }
    };
    let libraries = match list_libraries(&ctx, &cred, &tenant, &site.site_id).await {
        Ok(l) => l,
        Err(e) => {
            return err(
                StatusCode::BAD_GATEWAY,
                format!("library list failed: {e:#}{}", graph_hint(&e)),
            )
        }
    };
    Json(serde_json::json!({
        "site_id": site.site_id,
        "site_name": site.site_name,
        "libraries": libraries.iter().map(|l| serde_json::json!({
            "drive_id": l.drive_id, "name": l.name, "is_default": l.is_default,
        })).collect::<Vec<_>>(),
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// MUESLI_MS_* env vars are process-global; tests that mutate them serialize on
    /// this lock (the storage.rs S3_ENV_LOCK pattern — that lock is private to
    /// storage::tests, so this module carries its own).
    static MS_ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Unsets an env var when dropped — including on panic unwind (the
    /// storage.rs EnvVarGuard pattern, private there, redefined here).
    struct EnvVarGuard(&'static str);
    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            std::env::remove_var(self.0);
        }
    }

    /// Bind a mock server on an ephemeral port; returns its http base URL.
    async fn serve(app: axum::Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    #[test]
    fn from_env_reads_the_ms_client() {
        let _guard = MS_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _g1 = EnvVarGuard("MUESLI_MS_CLIENT_ID");
        let _g2 = EnvVarGuard("MUESLI_MS_CLIENT_SECRET");
        let _g3 = EnvVarGuard("MUESLI_MS_LOGIN_BASE");
        let _g4 = EnvVarGuard("MUESLI_MS_GRAPH_BASE");
        for k in [
            "MUESLI_MS_CLIENT_ID",
            "MUESLI_MS_CLIENT_SECRET",
            "MUESLI_MS_LOGIN_BASE",
            "MUESLI_MS_GRAPH_BASE",
            "MUESLI_MS_CLIENT_CERT_FILE",
        ] {
            std::env::remove_var(k);
        }
        // Unconfigured: the ctx STILL exists (per-workspace apps must work), env_app is None.
        let ctx = MsCtx::from_env().unwrap();
        assert!(ctx.env_app.is_none());
        assert_eq!(ctx.login_base, "https://login.microsoftonline.com");
        assert_eq!(ctx.graph_base, "https://graph.microsoft.com/v1.0");
        assert_eq!(ctx.graph_scope(), "https://graph.microsoft.com/.default");
        // Configured with a secret + sovereign-cloud overrides (trailing slashes trimmed).
        std::env::set_var("MUESLI_MS_CLIENT_ID", "cid");
        std::env::set_var("MUESLI_MS_CLIENT_SECRET", "cs");
        std::env::set_var("MUESLI_MS_LOGIN_BASE", "https://login.microsoftonline.us/");
        std::env::set_var("MUESLI_MS_GRAPH_BASE", "https://graph.microsoft.us/v1.0/");
        let ctx = MsCtx::from_env().unwrap();
        let app = ctx.env_app.as_ref().expect("configured");
        assert_eq!(app.client_id, "cid");
        assert!(matches!(app.auth, MsAuth::Secret(ref s) if s == "cs"));
        assert_eq!(
            ctx.token_endpoint("11111111-2222-3333-4444-555555555555"),
            "https://login.microsoftonline.us/11111111-2222-3333-4444-555555555555/oauth2/v2.0/token"
        );
        assert_eq!(ctx.graph_scope(), "https://graph.microsoft.us/.default");
    }

    #[test]
    fn token_cache_expiry_slack_and_keying() {
        let ctx = MsCtx::new("http://unused".into(), "http://unused/v1.0".into(), None);
        // a healthy 1h token is served from cache
        ctx.store_access("t1", "cid", "tok-a", 3600);
        assert_eq!(ctx.cached_access("t1", "cid"), Some("tok-a".into()));
        // the cache is keyed by (tenant, client_id) — a different tenant or app misses
        assert_eq!(ctx.cached_access("t2", "cid"), None);
        assert_eq!(ctx.cached_access("t1", "other"), None);
        // a token within the 60s slack reads as already expired
        ctx.store_access("t1", "cid", "tok-b", 30);
        assert_eq!(ctx.cached_access("t1", "cid"), None);
    }

    /// Secret-auth token acquisition against a mock login server: correct form fields,
    /// cached on success, force=true re-mints, distinct tenants mint separately.
    #[tokio::test]
    async fn secret_token_acquisition_and_cache() {
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let app = axum::Router::new().route(
            "/{tenant}/oauth2/v2.0/token",
            axum::routing::post(
                move |axum::extract::Path(tenant): axum::extract::Path<String>, body: String| {
                    let c = c.clone();
                    async move {
                        assert!(body.contains("grant_type=client_credentials"), "{body}");
                        assert!(body.contains("client_id=cid"), "{body}");
                        assert!(body.contains("client_secret=cs"), "{body}");
                        assert!(body.contains("scope="), "{body}");
                        let n = c.fetch_add(1, Ordering::SeqCst) + 1;
                        axum::Json(json!({
                            "access_token": format!("tok-{tenant}-{n}"),
                            "expires_in": 3600,
                        }))
                    }
                },
            ),
        );
        let base = serve(app).await;
        let ctx = MsCtx::new(base.clone(), format!("{base}/v1.0"), None);
        let cred = MsCredential {
            client_id: "cid".into(),
            auth: MsAuth::Secret("cs".into()),
        };
        assert_eq!(
            ctx.access_token("tenant-a", &cred, false).await.unwrap(),
            "tok-tenant-a-1"
        );
        // cached: no second POST
        assert_eq!(
            ctx.access_token("tenant-a", &cred, false).await.unwrap(),
            "tok-tenant-a-1"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // another tenant is a separate cache entry
        assert_eq!(
            ctx.access_token("tenant-b", &cred, false).await.unwrap(),
            "tok-tenant-b-2"
        );
        // force drops the cached entry first (the 401-retry path)
        assert_eq!(
            ctx.access_token("tenant-a", &cred, true).await.unwrap(),
            "tok-tenant-a-3"
        );
    }

    /// AADSTS failures surface the error code + description (truncated), never the raw body.
    #[tokio::test]
    async fn token_errors_surface_the_aadsts_code() {
        let app = axum::Router::new().route(
            "/{tenant}/oauth2/v2.0/token",
            axum::routing::post(|| async {
                (
                    axum::http::StatusCode::UNAUTHORIZED,
                    axum::Json(json!({
                        "error": "invalid_client",
                        "error_description": "AADSTS7000215: Invalid client secret provided.",
                    })),
                )
            }),
        );
        let base = serve(app).await;
        let ctx = MsCtx::new(base.clone(), format!("{base}/v1.0"), None);
        let cred = MsCredential {
            client_id: "cid".into(),
            auth: MsAuth::Secret("bad".into()),
        };
        let err = ctx
            .access_token("t", &cred, false)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("invalid_client"), "{err}");
        assert!(err.contains("AADSTS7000215"), "{err}");
    }

    /// PEM wrapper for test fixtures (64-char base64 lines, BEGIN/END armor).
    fn pem_wrap(label: &str, der: &[u8]) -> String {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(der);
        let lines: Vec<String> = b64
            .as_bytes()
            .chunks(64)
            .map(|c| String::from_utf8_lossy(c).to_string())
            .collect();
        format!(
            "-----BEGIN {label}-----\n{}\n-----END {label}-----\n",
            lines.join("\n")
        )
    }

    #[test]
    fn pem_parsing_and_x5t() {
        use rsa::pkcs8::EncodePrivateKey as _;
        let key = rsa::RsaPrivateKey::new(&mut rand::thread_rng(), 2048).expect("keygen");
        let key_der = key.to_pkcs8_der().unwrap();
        // x5t only hashes the DER bytes — a real x509 body is not needed for the test.
        let cert_der = b"dummy-cert-der-bytes".to_vec();
        let pem = format!(
            "{}\n{}",
            pem_wrap("CERTIFICATE", &cert_der),
            pem_wrap("PRIVATE KEY", key_der.as_bytes()),
        );
        assert_eq!(parse_cert_pem(&pem).unwrap(), cert_der);
        let parsed = parse_private_key_pem(&pem).unwrap();
        assert_eq!(parsed.to_public_key(), key.to_public_key());
        // x5t = base64url(SHA-1(cert DER)), unpadded (RFC 7515 §4.1.7).
        let t = x5t(&cert_der);
        assert!(!t.is_empty() && !t.contains('=') && !t.contains('+') && !t.contains('/'));
        // PKCS#1 keys ("RSA PRIVATE KEY") parse too.
        use rsa::pkcs1::EncodeRsaPrivateKey as _;
        let pkcs1 = pem_wrap("RSA PRIVATE KEY", key.to_pkcs1_der().unwrap().as_bytes());
        assert_eq!(
            parse_private_key_pem(&pkcs1).unwrap().to_public_key(),
            key.to_public_key()
        );
        // Encrypted keys are refused with an actionable message.
        let enc = pem_wrap("ENCRYPTED PRIVATE KEY", b"whatever");
        let err = parse_private_key_pem(&enc).unwrap_err().to_string();
        assert!(err.contains("password-protected"), "{err}");
        // No key at all is a clean error.
        assert!(parse_private_key_pem(&pem_wrap("CERTIFICATE", &cert_der)).is_err());
    }

    /// The assembled client assertion is a real RS256 JWT: header {alg,typ,x5t}, claims
    /// {aud,iss,sub,jti,iat,nbf,exp=iat+600}, signature verifiable with the cert's
    /// public key (here: the keypair's public half, which IS the cert's key).
    #[test]
    fn client_assertion_is_a_valid_rs256_jwt() {
        use base64::Engine as _;
        use rsa::Pkcs1v15Sign;
        use sha2::{Digest as _, Sha256};
        let key = rsa::RsaPrivateKey::new(&mut rand::thread_rng(), 2048).expect("keygen");
        let cert_der = b"dummy-cert-der-bytes".to_vec();
        let now = 1_750_000_000u64;
        let endpoint = "https://login.microsoftonline.com/t1/oauth2/v2.0/token";
        let jwt = client_assertion(&cert_der, &key, "app-123", endpoint, now).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let header: Value = serde_json::from_slice(&b64.decode(parts[0]).unwrap()).unwrap();
        assert_eq!(header["alg"], "RS256");
        assert_eq!(header["typ"], "JWT");
        assert_eq!(header["x5t"], json!(x5t(&cert_der)));
        let claims: Value = serde_json::from_slice(&b64.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["aud"], json!(endpoint));
        assert_eq!(claims["iss"], "app-123");
        assert_eq!(claims["sub"], "app-123");
        assert_eq!(claims["iat"], json!(now));
        assert_eq!(claims["nbf"], json!(now));
        assert_eq!(claims["exp"], json!(now + 600));
        assert!(claims["jti"]
            .as_str()
            .is_some_and(|j| uuid::Uuid::parse_str(j).is_ok()));
        // RS256 verification against the public key.
        let signing_input = format!("{}.{}", parts[0], parts[1]);
        let digest = Sha256::digest(signing_input.as_bytes());
        let sig = b64.decode(parts[2]).unwrap();
        key.to_public_key()
            .verify(Pkcs1v15Sign::new::<Sha256>(), &digest, &sig)
            .expect("signature verifies");
        // jti is fresh per assertion
        let jwt2 = client_assertion(&cert_der, &key, "app-123", endpoint, now).unwrap();
        assert_ne!(jwt, jwt2, "jti must differ between assertions");
    }

    /// Env config: MUESLI_MS_CLIENT_CERT_FILE wins over MUESLI_MS_CLIENT_SECRET (server
    /// env cert → server env secret); an unusable cert file fails FAST, not at runtime.
    #[test]
    fn from_env_prefers_certificate_over_secret_and_fails_fast() {
        use rsa::pkcs8::EncodePrivateKey as _;
        let _guard = MS_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _g1 = EnvVarGuard("MUESLI_MS_CLIENT_ID");
        let _g2 = EnvVarGuard("MUESLI_MS_CLIENT_SECRET");
        let _g3 = EnvVarGuard("MUESLI_MS_CLIENT_CERT_FILE");
        let key = rsa::RsaPrivateKey::new(&mut rand::thread_rng(), 2048).expect("keygen");
        let pem = format!(
            "{}\n{}",
            pem_wrap("CERTIFICATE", b"dummy-cert-der-bytes"),
            pem_wrap("PRIVATE KEY", key.to_pkcs8_der().unwrap().as_bytes()),
        );
        let path =
            std::env::temp_dir().join(format!("muesli-ms-cert-{}.pem", uuid::Uuid::new_v4()));
        std::fs::write(&path, pem).unwrap();
        std::env::set_var("MUESLI_MS_CLIENT_ID", "cid");
        std::env::set_var("MUESLI_MS_CLIENT_SECRET", "cs");
        std::env::set_var("MUESLI_MS_CLIENT_CERT_FILE", &path);
        let ctx = MsCtx::from_env().unwrap();
        assert!(
            matches!(
                ctx.env_app.as_ref().unwrap().auth,
                MsAuth::Certificate { .. }
            ),
            "cert wins over secret at the env level"
        );
        // Unreadable cert file: fail fast (init_from_env propagates to main()).
        std::env::set_var("MUESLI_MS_CLIENT_CERT_FILE", "/nonexistent/muesli-cert.pem");
        assert!(MsCtx::from_env().is_err());
        std::fs::remove_file(&path).ok();
    }

    /// Certificate-auth token request carries a client assertion, not a secret.
    #[tokio::test]
    async fn certificate_token_acquisition_sends_a_client_assertion() {
        let app = axum::Router::new().route(
            "/{tenant}/oauth2/v2.0/token",
            axum::routing::post(|body: String| async move {
                assert!(
                    body.contains("client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer"),
                    "{body}"
                );
                assert!(body.contains("client_assertion="), "{body}");
                assert!(!body.contains("client_secret="), "{body}");
                axum::Json(json!({ "access_token": "tok-cert", "expires_in": 3600 }))
            }),
        );
        let base = serve(app).await;
        let ctx = MsCtx::new(base.clone(), format!("{base}/v1.0"), None);
        let key = rsa::RsaPrivateKey::new(&mut rand::thread_rng(), 2048).expect("keygen");
        let cred = MsCredential {
            client_id: "cid".into(),
            auth: MsAuth::Certificate {
                cert_der: b"dummy-cert-der-bytes".to_vec(),
                key: Box::new(key),
            },
        };
        assert_eq!(
            ctx.access_token("t", &cred, false).await.unwrap(),
            "tok-cert"
        );
    }

    /// Credential precedence (spec, verbatim): per-workspace cert → per-workspace
    /// secret → server env cert → server env secret. Cert wins over secret at the same
    /// level. The env level is exercised through `env_app` directly (from_env already
    /// collapses env cert-over-secret, locked by
    /// `from_env_prefers_certificate_over_secret_and_fails_fast`).
    #[test]
    fn credential_resolution_precedence_matrix() {
        use rsa::pkcs8::EncodePrivateKey as _;
        let _guard = MS_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // MUESLI_SECRET_KEY is mutated below; serialize with every other module's
        // secret-key tests (module lock first, then the shared secret-key lock —
        // consistent order, so the two locks can never deadlock).
        let _sk_guard = crate::secrets::SECRET_KEY_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // Decrypting per-workspace secrets needs MUESLI_SECRET_KEY. Use the SAME key
        // value as storage.rs's s3_credentials_resolution_config_then_env so even a
        // cross-module race sets an identical value (locks are module-local).
        let key_hex = "0101010101010101010101010101010101010101010101010101010101010101";
        std::env::set_var("MUESLI_SECRET_KEY", key_hex);
        let _key_guard = EnvVarGuard("MUESLI_SECRET_KEY");
        let master = crate::secrets::parse_secret_key(key_hex).unwrap();

        let rsa_key = rsa::RsaPrivateKey::new(&mut rand::thread_rng(), 2048).expect("keygen");
        let key_pem = pem_wrap("PRIVATE KEY", rsa_key.to_pkcs8_der().unwrap().as_bytes());
        let cert_pem = pem_wrap("CERTIFICATE", b"dummy-cert-der-bytes");
        let key_enc = crate::secrets::encrypt_secret_with_key(&master, &key_pem);
        let secret_enc = crate::secrets::encrypt_secret_with_key(&master, "ws-secret");
        let env_secret = MsCredential {
            client_id: "env-cid".into(),
            auth: MsAuth::Secret("env-s".into()),
        };

        // 1) per-workspace cert wins even when a per-workspace secret is ALSO present.
        let config = json!({
            "client_id": "ws-cid",
            "client_certificate_pem": cert_pem,
            "client_private_key_enc": key_enc,
            "client_secret_enc": secret_enc,
        });
        let cred = resolve_credential(&config, Some(&env_secret)).unwrap();
        assert_eq!(cred.client_id, "ws-cid");
        assert!(matches!(cred.auth, MsAuth::Certificate { .. }));

        // 2) per-workspace secret beats the server env app.
        let config = json!({ "client_id": "ws-cid", "client_secret_enc": secret_enc });
        let cred = resolve_credential(&config, Some(&env_secret)).unwrap();
        assert_eq!(cred.client_id, "ws-cid");
        assert!(matches!(cred.auth, MsAuth::Secret(ref s) if s == "ws-secret"));
        // Debug output is hand-redacted — it must never contain the secret itself.
        let dbg = format!("{cred:?}");
        assert!(!dbg.contains("ws-secret"), "{dbg}");
        assert!(dbg.contains("<redacted>"), "{dbg}");

        // 3) no per-workspace creds → the server env app.
        let cred = resolve_credential(&json!({}), Some(&env_secret)).unwrap();
        assert_eq!(cred.client_id, "env-cid");

        // 4) client_id without any usable secret material is a loud error…
        assert!(resolve_credential(&json!({"client_id": "ws-cid"}), Some(&env_secret)).is_err());
        // 5) …and nothing anywhere is too.
        let err = resolve_credential(&json!({}), None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("MUESLI_MS_CLIENT_ID"), "{err}");
    }

    use axum::http::StatusCode;

    fn test_cred() -> MsCredential {
        MsCredential {
            client_id: "cid".into(),
            auth: MsAuth::Secret("cs".into()),
        }
    }

    /// A stateless mock Graph for read/delete/list: token endpoint + fixed items.
    /// `flaky_401` makes the FIRST bearer token invalid (the refresh-retry path).
    async fn read_mock(flaky_401: bool) -> (String, Arc<AtomicUsize>) {
        let token_calls = Arc::new(AtomicUsize::new(0));
        let tc = token_calls.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let b = base.clone();
        let app = axum::Router::new().fallback(move |req: axum::extract::Request| {
            let base = b.clone();
            let tc = tc.clone();
            async move {
                use axum::response::IntoResponse as _;
                let method = req.method().clone();
                let path = req.uri().path().to_string();
                let auth = req
                    .headers()
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                if method == axum::http::Method::POST && path == "/t1/oauth2/v2.0/token" {
                    let n = tc.fetch_add(1, Ordering::SeqCst) + 1;
                    return axum::Json(
                        json!({ "access_token": format!("t{n}"), "expires_in": 3600 }),
                    )
                    .into_response();
                }
                // Everything below is Graph: enforce the bearer (t2 when flaky, else any t*).
                let ok = if flaky_401 {
                    auth == "Bearer t2"
                } else {
                    auth.starts_with("Bearer t")
                };
                if path.starts_with("/v1.0/") && !path.starts_with("/v1.0/dl/") && !ok {
                    return (StatusCode::UNAUTHORIZED, "expired").into_response();
                }
                match (method.as_str(), path.as_str()) {
                    ("GET", "/v1.0/drives/d1/root:/pre/doc.md") => axum::Json(json!({
                        "size": 13,
                        "cTag": "ctag-1",
                        "eTag": "etag-1",
                        "file": {},
                        "@microsoft.graph.downloadUrl": format!("{base}/v1.0/dl/doc.md"),
                    }))
                    .into_response(),
                    // downloadUrl is PRE-AUTHENTICATED: served without any bearer check.
                    ("GET", "/v1.0/dl/doc.md") => "# from graph\n".into_response(),
                    ("GET", "/v1.0/drives/d1/root:/pre/huge.md") => axum::Json(json!({
                        "size": 6 * 1024 * 1024,
                        "cTag": "ctag-huge",
                        "file": {},
                        "@microsoft.graph.downloadUrl": format!("{base}/v1.0/dl/doc.md"),
                    }))
                    .into_response(),
                    ("GET", "/v1.0/drives/d1/root:/pre/missing.md") => {
                        (StatusCode::NOT_FOUND, "").into_response()
                    }
                    ("DELETE", "/v1.0/drives/d1/root:/pre/doc.md") => {
                        StatusCode::NO_CONTENT.into_response()
                    }
                    ("DELETE", "/v1.0/drives/d1/root:/pre/missing.md") => {
                        (StatusCode::NOT_FOUND, "").into_response()
                    }
                    ("GET", "/v1.0/drives/d1/root:/pre:/children") => axum::Json(json!({
                        "value": [
                            { "name": "a.md", "file": {}, "cTag": "c-a" },
                            { "name": "subfolder", "folder": {} },
                        ],
                        "@odata.nextLink": format!("{base}/v1.0/next-page"),
                    }))
                    .into_response(),
                    ("GET", "/v1.0/next-page") => axum::Json(json!({
                        "value": [ { "name": "b.md", "file": {}, "eTag": "e-b" } ],
                    }))
                    .into_response(),
                    _ => {
                        (StatusCode::NOT_FOUND, format!("unmocked {method} {path}")).into_response()
                    }
                }
            }
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (base, token_calls)
    }

    fn backend_at(base: &str) -> SharePointBackend {
        let ctx = Arc::new(MsCtx::new(base.to_string(), format!("{base}/v1.0"), None));
        SharePointBackend::for_tests(ctx, test_cred(), "t1", "d1", "pre")
    }

    #[tokio::test]
    async fn sharepoint_read_uses_metadata_tag_and_download_url() {
        use crate::storage::StorageBackend as _;
        let (base, _) = read_mock(false).await;
        let backend = backend_at(&base);
        let (bytes, tag) = backend.read("doc.md").await.unwrap().expect("exists");
        assert_eq!(bytes, b"# from graph\n");
        assert_eq!(tag, "ctag-1", "cTag wins over eTag");
        // absent item: Ok(None), not an error
        assert!(backend.read("missing.md").await.unwrap().is_none());
        // path traversal is refused before any request
        assert!(backend.read("../escape.md").await.is_err());
    }

    #[tokio::test]
    async fn sharepoint_read_enforces_the_ingest_cap_from_metadata() {
        use crate::storage::StorageBackend as _;
        let (base, _) = read_mock(false).await;
        let err = backend_at(&base)
            .read("huge.md")
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("ingest cap"), "{err}");
    }

    /// Fix wave (SharePoint phase 2 final review): `@microsoft.graph.downloadUrl` is a
    /// pre-authenticated URL — its query string carries a live tempauth token. A
    /// transport-level failure hitting that URL (connection refused here, standing in
    /// for any network error) must NOT leak the URL — reqwest::Error's Display embeds
    /// the full request URL by default, so `read` must strip it via `without_url()`
    /// before the error can reach HealthRegistry / warn! logs.
    #[tokio::test]
    async fn sharepoint_download_transport_failure_never_leaks_the_preauth_url() {
        use crate::storage::StorageBackend as _;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = axum::Router::new().fallback(|req: axum::extract::Request| async move {
            use axum::response::IntoResponse as _;
            if req.uri().path() == "/t1/oauth2/v2.0/token" {
                return axum::Json(json!({ "access_token": "t1", "expires_in": 3600 }))
                    .into_response();
            }
            if req.uri().path() == "/v1.0/drives/d1/root:/pre/doc.md" {
                // Nothing listens on port 1 — the download GET fails at the transport
                // layer (connection refused), not with an HTTP error status.
                return axum::Json(json!({
                    "size": 4,
                    "cTag": "c1",
                    "file": {},
                    "@microsoft.graph.downloadUrl": "http://127.0.0.1:1/dl?tempauth=SUPERSECRETTOKEN",
                }))
                .into_response();
            }
            (StatusCode::NOT_FOUND, "").into_response()
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let backend = backend_at(&base);
        let err = backend.read("doc.md").await.unwrap_err().to_string();
        assert!(!err.contains("tempauth"), "{err}");
        assert!(!err.contains("SUPERSECRETTOKEN"), "{err}");
        assert!(
            !err.contains('?'),
            "the pre-authenticated query string must not survive: {err}"
        );
    }

    /// The 401-retry path: first token is revoked, ONE forced refresh, then success.
    #[tokio::test]
    async fn sharepoint_read_refreshes_and_retries_on_401() {
        use crate::storage::StorageBackend as _;
        let (base, token_calls) = read_mock(true).await;
        let backend = backend_at(&base);
        let (bytes, _) = backend.read("doc.md").await.unwrap().expect("exists");
        assert_eq!(bytes, b"# from graph\n");
        assert_eq!(
            token_calls.load(Ordering::SeqCst),
            2,
            "one mint + one forced refresh"
        );
        // the working token is cached: another read costs no further token calls
        backend.read("doc.md").await.unwrap().unwrap();
        assert_eq!(token_calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn sharepoint_delete_is_idempotent() {
        use crate::storage::StorageBackend as _;
        let (base, _) = read_mock(false).await;
        let backend = backend_at(&base);
        backend.delete("doc.md").await.unwrap();
        backend.delete("missing.md").await.unwrap(); // 404 = already gone = Ok
    }

    #[tokio::test]
    async fn sharepoint_list_pages_through_next_links_and_skips_folders() {
        use crate::storage::StorageBackend as _;
        let (base, _) = read_mock(false).await;
        let listed = backend_at(&base).list("").await.unwrap();
        assert_eq!(
            listed,
            vec![("a.md".into(), "c-a".into()), ("b.md".into(), "e-b".into())]
        );
    }

    #[test]
    fn sharepoint_from_conn_reads_config_and_encodes_paths() {
        let ctx = Arc::new(MsCtx::new(
            "http://unused".into(),
            "http://unused/v1.0".into(),
            Some(test_cred()),
        ));
        // for_tests bypasses the global; from_conn is exercised through the global in
        // storage.rs's dispatch test (task 6). Here: field validation + URL building.
        let backend = SharePointBackend::for_tests(ctx, test_cred(), "t1", "d1", "notes");
        assert_eq!(
            backend.item_url("a b/c.md"),
            "http://unused/v1.0/drives/d1/root:/notes/a%20b/c.md"
        );
    }

    /// A stateful mock Graph: PUT :/content stores bytes, metadata GET + downloadUrl
    /// serve them back, DELETE removes — enough for write + the full probe cycle.
    /// Also serves createUploadSession + the chunked upload URL, recording ranges.
    async fn write_mock() -> (
        String,
        Arc<std::sync::Mutex<HashMap<String, Vec<u8>>>>,
        Arc<std::sync::Mutex<Vec<String>>>,
    ) {
        let store: Arc<std::sync::Mutex<HashMap<String, Vec<u8>>>> = Default::default();
        let ranges: Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let session_buf: Arc<std::sync::Mutex<Vec<u8>>> = Default::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (b, s, r, sb) = (
            base.clone(),
            store.clone(),
            ranges.clone(),
            session_buf.clone(),
        );
        let app = axum::Router::new().fallback(move |req: axum::extract::Request| {
            let (base, store, ranges, session_buf) = (b.clone(), s.clone(), r.clone(), sb.clone());
            async move {
                use axum::response::IntoResponse as _;
                let method = req.method().clone();
                let path = req.uri().path().to_string();
                let range = req
                    .headers()
                    .get("content-range")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string);
                let body = axum::body::to_bytes(req.into_body(), usize::MAX)
                    .await
                    .unwrap();
                if method == axum::http::Method::POST && path == "/t1/oauth2/v2.0/token" {
                    return axum::Json(json!({ "access_token": "t1", "expires_in": 3600 }))
                        .into_response();
                }
                const ITEM: &str = "/v1.0/drives/d1/root:/";
                if let Some(rest) = path.strip_prefix(ITEM) {
                    if method == axum::http::Method::PUT {
                        let key = rest.strip_suffix(":/content").unwrap_or(rest).to_string();
                        store.lock().unwrap().insert(key.clone(), body.to_vec());
                        return (
                            StatusCode::CREATED,
                            axum::Json(json!({ "cTag": format!("c-{key}") })),
                        )
                            .into_response();
                    }
                    if method == axum::http::Method::POST && rest.ends_with(":/createUploadSession")
                    {
                        return axum::Json(
                            json!({ "uploadUrl": format!("{base}/upload/session-1") }),
                        )
                        .into_response();
                    }
                    if method == axum::http::Method::DELETE {
                        store.lock().unwrap().remove(rest);
                        return StatusCode::NO_CONTENT.into_response();
                    }
                    if method == axum::http::Method::GET {
                        let stored = store.lock().unwrap().get(rest).cloned();
                        return match stored {
                            Some(bytes) => axum::Json(json!({
                                "size": bytes.len(),
                                "cTag": format!("c-{rest}"),
                                "file": {},
                                "@microsoft.graph.downloadUrl": format!("{base}/v1.0/dl/{rest}"),
                            }))
                            .into_response(),
                            None => (StatusCode::NOT_FOUND, "").into_response(),
                        };
                    }
                }
                if let Some(rest) = path.strip_prefix("/v1.0/dl/") {
                    let stored = store.lock().unwrap().get(rest).cloned();
                    return match stored {
                        Some(bytes) => bytes.into_response(),
                        None => (StatusCode::NOT_FOUND, "").into_response(),
                    };
                }
                if method == axum::http::Method::PUT && path == "/upload/session-1" {
                    let range = range.expect("chunk PUT carries Content-Range");
                    ranges.lock().unwrap().push(range.clone());
                    session_buf.lock().unwrap().extend_from_slice(&body);
                    // "bytes {start}-{end}/{total}": final chunk answers 201 + driveItem.
                    let (span, total) = range
                        .strip_prefix("bytes ")
                        .and_then(|r| r.split_once('/'))
                        .expect("well-formed range");
                    let end: usize = span.split_once('-').unwrap().1.parse().unwrap();
                    let total: usize = total.parse().unwrap();
                    return if end + 1 == total {
                        let assembled = session_buf.lock().unwrap().clone();
                        store.lock().unwrap().insert("pre/big.md".into(), assembled);
                        (
                            StatusCode::CREATED,
                            axum::Json(json!({ "cTag": "c-session" })),
                        )
                            .into_response()
                    } else {
                        (
                            StatusCode::ACCEPTED,
                            axum::Json(json!({ "nextExpectedRanges": [format!("{}-", end + 1)] })),
                        )
                            .into_response()
                    };
                }
                (StatusCode::NOT_FOUND, format!("unmocked {method} {path}")).into_response()
            }
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (base, store, ranges)
    }

    #[tokio::test]
    async fn sharepoint_small_write_uses_the_simple_put() {
        use crate::storage::StorageBackend as _;
        let (base, store, ranges) = write_mock().await;
        let backend = backend_at(&base);
        let tag = backend.write("doc.md", b"# hello\n").await.unwrap();
        assert_eq!(tag, "c-pre/doc.md");
        assert_eq!(
            store.lock().unwrap().get("pre/doc.md").unwrap(),
            b"# hello\n"
        );
        assert!(
            ranges.lock().unwrap().is_empty(),
            "no upload session for small writes"
        );
    }

    /// > 4 MB: createUploadSession + 320-KiB-aligned chunks with exact Content-Range
    /// headers; the final chunk's driveItem carries the tag. Our cap is 5 MiB, so this
    /// path is REAL, not theoretical (spec: 4MB boundary vs MAX_INGEST_BYTES).
    #[tokio::test]
    async fn sharepoint_large_write_uses_an_upload_session() {
        use crate::storage::StorageBackend as _;
        let (base, store, ranges) = write_mock().await;
        let backend = backend_at(&base);
        let payload = vec![7u8; SIMPLE_UPLOAD_MAX + 3]; // 4 000 003 bytes
        let tag = backend.write("big.md", &payload).await.unwrap();
        assert_eq!(tag, "c-session");
        assert_eq!(
            *ranges.lock().unwrap(),
            vec![
                "bytes 0-3276799/4000003".to_string(),
                "bytes 3276800-4000002/4000003".to_string(),
            ],
        );
        assert_eq!(store.lock().unwrap().get("pre/big.md").unwrap(), &payload);
    }

    /// Fix wave (SharePoint phase 2 final review): SIMPLE_UPLOAD_MAX is a conservative
    /// 4 000 000-byte reading of Graph's "4 MB" simple-upload ceiling. Exactly that many
    /// bytes must still take the single PUT :/content path; one byte more must switch to
    /// createUploadSession — verified against what the mock server actually saw, not
    /// just the returned tag.
    #[tokio::test]
    async fn sharepoint_write_boundary_at_simple_upload_max() {
        use crate::storage::StorageBackend as _;

        let (base, store, ranges) = write_mock().await;
        let backend = backend_at(&base);
        let at_max = vec![7u8; SIMPLE_UPLOAD_MAX];
        backend.write("at-max.md", &at_max).await.unwrap();
        assert!(
            ranges.lock().unwrap().is_empty(),
            "exactly SIMPLE_UPLOAD_MAX must use the simple PUT"
        );
        assert_eq!(store.lock().unwrap().get("pre/at-max.md").unwrap(), &at_max);

        let (base, store, ranges) = write_mock().await;
        let backend = backend_at(&base);
        let over_max = vec![7u8; SIMPLE_UPLOAD_MAX + 1];
        // write_mock's session handler always assembles the final item under
        // "pre/big.md" regardless of the createUploadSession item path (see write_mock).
        backend.write("big.md", &over_max).await.unwrap();
        assert!(
            !ranges.lock().unwrap().is_empty(),
            "SIMPLE_UPLOAD_MAX + 1 must go through the upload session"
        );
        assert_eq!(store.lock().unwrap().get("pre/big.md").unwrap(), &over_max);
    }

    /// The connection probe: write, read back, byte-compare, delete — under .muesli/.
    #[tokio::test]
    async fn sharepoint_probe_round_trips_and_cleans_up() {
        let (base, store, _) = write_mock().await;
        let backend = backend_at(&base);
        backend.probe().await.expect("probe cycle");
        assert!(
            store.lock().unwrap().is_empty(),
            "the probe object must be deleted afterwards"
        );
    }

    #[tokio::test]
    async fn site_resolve_and_library_list() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = axum::Router::new().fallback(|req: axum::extract::Request| async move {
            use axum::response::IntoResponse as _;
            let path = req.uri().path().to_string();
            match path.as_str() {
                "/t1/oauth2/v2.0/token" => {
                    axum::Json(json!({ "access_token": "t1", "expires_in": 3600 })).into_response()
                }
                // GET /sites/{hostname}:{server-relative-path}
                "/v1.0/sites/contoso.sharepoint.com:/sites/eng" => axum::Json(json!({
                    "id": "contoso.sharepoint.com,g1,g2",
                    "displayName": "Engineering",
                }))
                .into_response(),
                // site ids carry commas — uri_encode(_, true) turns them into %2C
                "/v1.0/sites/contoso.sharepoint.com%2Cg1%2Cg2/drives" => axum::Json(json!({
                    "value": [
                        { "id": "drv-docs", "name": "Documents" },
                        { "id": "drv-arch", "name": "Archive" },
                    ],
                }))
                .into_response(),
                "/v1.0/sites/contoso.sharepoint.com%2Cg1%2Cg2/drive" => {
                    axum::Json(json!({ "id": "drv-docs" })).into_response()
                }
                _ => (StatusCode::NOT_FOUND, format!("unmocked {path}")).into_response(),
            }
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let ctx = MsCtx::new(base.clone(), format!("{base}/v1.0"), None);
        let cred = test_cred();
        let site = resolve_site(
            &ctx,
            &cred,
            "t1",
            "https://contoso.sharepoint.com/sites/eng/",
        )
        .await
        .unwrap();
        assert_eq!(site.site_id, "contoso.sharepoint.com,g1,g2");
        assert_eq!(site.site_name, "Engineering");
        let libs = list_libraries(&ctx, &cred, "t1", &site.site_id)
            .await
            .unwrap();
        assert_eq!(libs.len(), 2);
        assert!(libs[0].is_default && libs[0].drive_id == "drv-docs");
        assert!(!libs[1].is_default && libs[1].name == "Archive");
    }

    #[test]
    fn site_url_parsing_is_parse_only() {
        assert_eq!(
            site_path_of("https://contoso.sharepoint.com/sites/eng/").unwrap(),
            ("contoso.sharepoint.com".into(), "/sites/eng".into()),
        );
        // the tenant-root site has an empty server-relative path
        assert_eq!(
            site_path_of("https://contoso.sharepoint.com").unwrap(),
            ("contoso.sharepoint.com".into(), "".into()),
        );
        assert!(site_path_of("not a url").is_err());
        assert!(site_path_of("mailto:x@y").is_err());
        // nested site paths are fine too — only the segment shape matters.
        assert_eq!(
            site_path_of("https://contoso.sharepoint.com/sites/a/b").unwrap(),
            ("contoso.sharepoint.com".into(), "/sites/a/b".into()),
        );
    }

    /// Fix wave (SharePoint phase 2 final review): dot/dotdot/empty segments in the site
    /// URL's path are rejected outright rather than silently normalized — reqwest's own
    /// URL parser collapses "." / ".." during parsing, which would otherwise turn an
    /// attacker-shaped `site_url=https://host/sites/../../v1.0/anything` into a
    /// harmless-looking resolved path instead of refusing the malformed input. Checked
    /// against the RAW input text, since by the time `Url::path()` is read those dot
    /// segments are already gone.
    #[test]
    fn site_path_of_rejects_dot_and_empty_segments() {
        let err = site_path_of("https://host/sites/../../v1.0/anything")
            .unwrap_err()
            .to_string();
        assert!(err.contains("invalid segments"), "{err}");
        let err = site_path_of("https://host/sites/./eng")
            .unwrap_err()
            .to_string();
        assert!(err.contains("invalid segments"), "{err}");
        let err = site_path_of("https://host/sites//eng")
            .unwrap_err()
            .to_string();
        assert!(err.contains("invalid segments"), "{err}");
        let err = site_path_of("https://host/sites/a/../b")
            .unwrap_err()
            .to_string();
        assert!(err.contains("invalid segments"), "{err}");
        // normal paths — including nested ones — are unaffected.
        assert!(site_path_of("https://host/sites/TeamName").is_ok());
        assert!(site_path_of("https://host/sites/a/b").is_ok());
        assert!(site_path_of("https://host").is_ok());
        assert!(site_path_of("https://host/").is_ok());
    }

    /// Spec: tenant must be a GUID or match [A-Za-z0-9.-]+ — it is interpolated into
    /// the login URL path. GUID characters are a subset, so one class covers both.
    #[test]
    fn tenant_validation_guid_or_domain() {
        assert!(valid_tenant("11111111-2222-3333-4444-555555555555"));
        assert!(valid_tenant("contoso.onmicrosoft.com"));
        assert!(valid_tenant("contoso-inc.example"));
        assert!(!valid_tenant(""));
        assert!(!valid_tenant("bad/tenant"));
        assert!(!valid_tenant("bad tenant"));
        assert!(!valid_tenant("bad?tenant"));
        assert!(!valid_tenant("bad#tenant"));
        assert!(
            !valid_tenant(&"x".repeat(300)),
            "absurd lengths are refused"
        );
    }

    /// Ephemeral (request-borne, never persisted) credentials for the library-list
    /// endpoint: body creds (cert over secret) → env app → error. No MUESLI_SECRET_KEY
    /// involvement — nothing is stored.
    #[test]
    fn ephemeral_credential_matrix() {
        use rsa::pkcs8::EncodePrivateKey as _;
        let rsa_key = rsa::RsaPrivateKey::new(&mut rand::thread_rng(), 2048).expect("keygen");
        let key_pem = pem_wrap("PRIVATE KEY", rsa_key.to_pkcs8_der().unwrap().as_bytes());
        let cert_pem = pem_wrap("CERTIFICATE", b"dummy-cert-der-bytes");
        let env = test_cred();

        // cert wins over secret at the same level
        let cred = ephemeral_credential(
            Some("body-cid"),
            Some("body-secret"),
            Some(&cert_pem),
            Some(&key_pem),
            Some(&env),
        )
        .unwrap();
        assert_eq!(cred.client_id, "body-cid");
        assert!(matches!(cred.auth, MsAuth::Certificate { .. }));

        // secret-only body creds
        let cred = ephemeral_credential(
            Some("body-cid"),
            Some("body-secret"),
            None,
            None,
            Some(&env),
        )
        .unwrap();
        assert!(matches!(cred.auth, MsAuth::Secret(ref s) if s == "body-secret"));

        // no body creds → env app
        assert_eq!(
            ephemeral_credential(None, None, None, None, Some(&env))
                .unwrap()
                .client_id,
            "cid"
        );

        // client_id without material / nothing at all → errors
        assert!(ephemeral_credential(Some("body-cid"), None, None, None, Some(&env)).is_err());
        assert!(ephemeral_credential(None, None, None, None, None).is_err());
    }

    /// The probe_hint analogue for Graph failures (spec: error-handling table).
    #[test]
    fn graph_hint_maps_the_spec_error_table() {
        let aadsts = anyhow!("microsoft token endpoint answered 401 invalid_client: AADSTS7000215");
        assert!(graph_hint(&aadsts).contains("check the app credentials"));
        let forbidden = anyhow!("graph site resolve https://x: 403 Forbidden accessDenied");
        assert!(graph_hint(&forbidden).contains("grant"));
        let missing = anyhow!("graph site resolve https://x: 404 itemNotFound");
        assert!(graph_hint(&missing).contains("site URL"));
        assert_eq!(graph_hint(&anyhow!("something else")), "");
    }

    /// The grant snippets keep client-substitutable placeholders and carry the two
    /// admin actions (consent + site grant) the wizard shows verbatim.
    #[test]
    fn grant_snippets_carry_the_placeholders() {
        assert!(GRANT_SNIPPET_GRAPH.contains("{client_id}"));
        assert!(GRANT_SNIPPET_GRAPH.contains("/permissions"));
        assert!(GRANT_SNIPPET_GRAPH.contains("\"roles\": [\"write\"]"));
        assert!(GRANT_SNIPPET_POWERSHELL.contains("Grant-PnPAzureADAppSitePermission"));
        assert!(GRANT_SNIPPET_POWERSHELL.contains("{client_id}"));
        assert!(GRANT_SNIPPET_POWERSHELL.contains("{site_url}"));
        assert!(GRANT_SNIPPET_POWERSHELL.contains("-Permissions Write"));
    }

    /// Handlers refuse open mode / no-DB exactly like every other workspace surface.
    #[tokio::test]
    async fn sharepoint_endpoints_require_identity() {
        use axum::extract::{Path, State};
        let state = crate::AppState::default(); // no auth, no persistence
        let jar = axum_extra::extract::cookie::CookieJar::default();
        let res = setup(
            State(state.clone()),
            jar.clone(),
            axum::http::HeaderMap::new(),
        )
        .await;
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
        let res = list_libraries_endpoint(
            State(state),
            Path(uuid::Uuid::now_v7()),
            jar,
            axum::http::HeaderMap::new(),
            axum::Json(LibrariesReq {
                tenant: "t".into(),
                site_url: "https://x".into(),
                client_id: None,
                client_secret: None,
                client_certificate_pem: None,
                client_private_key_pem: None,
            }),
        )
        .await;
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
