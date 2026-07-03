//! Identity & authorization (ADR 0012, 0011). Muesli implements no auth of its own: it is an
//! OIDC relying party against a configurable issuer. With no `OIDC_ISSUER` configured the server
//! runs in **open mode** (the local-solo exception): every connection is an anonymous editor.
//!
//! **Multi-issuer (Phase 5, ADR 0012 "Per-Workspace IdP"):** beyond the env-configured PRIMARY
//! issuer, every workspace may register its own IdP (`workspaces.sso`). The [`IssuerRegistry`]
//! holds them all; logins pick an issuer via `/auth/login?issuer=` (usually reached through
//! `/auth/login/select?email=` which maps an email domain to its workspace's issuer), the login
//! state records which issuer so the callback validates against the right client, and the CLI
//! token verifier picks its issuer by the token's `iss` claim. Users are keyed by
//! (issuer, subject) since Phase 1, so identities from different issuers never collide.
//!
//! Sessions are opaque cookies stored in Redis (`REDIS_URL`) or in-memory (dev fallback),
//! per ADR 0017 — never in Postgres.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use openidconnect::core::{
    CoreAuthenticationFlow, CoreClient, CoreIdToken, CoreIdTokenClaims, CoreIdTokenVerifier,
    CoreJsonWebKeySet, CoreProviderMetadata,
};
use openidconnect::{
    AuthorizationCode, ClaimsVerificationError, ClientId, ClientSecret, CsrfToken,
    EndpointMaybeSet, EndpointNotSet, EndpointSet, IssuerUrl, JsonWebKeySet, JsonWebKeySetUrl,
    Nonce, NonceVerifier, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope,
    SignatureVerificationError, TokenResponse,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tracing::{info, warn};
use uuid::Uuid;

use crate::audit::{self, AuditEvent};
use crate::persistence::Persistence;
use crate::AppState;

pub const SESSION_COOKIE: &str = "muesli_session";
/// Binds an in-flight OIDC login to the browser that started it (login-CSRF guard):
/// `/auth/login` sets it to the attempt's `state`, `/auth/callback` requires the match.
const LOGIN_BIND_COOKIE: &str = "muesli_login_bind";
const SESSION_TTL_SECS: u64 = 30 * 24 * 3600;
const LOGIN_ATTEMPT_TTL: Duration = Duration::from_secs(600);

type OidcClient = CoreClient<
    EndpointSet,      // auth url (from discovery)
    EndpointNotSet,   // device auth
    EndpointNotSet,   // introspection
    EndpointNotSet,   // revocation
    EndpointMaybeSet, // token url
    EndpointMaybeSet, // userinfo url
>;

/// Document roles (ADR 0011). Commenter gains powers in Phase 2 (comments/suggestions);
/// for sync purposes only Editor may write.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Role {
    Viewer,
    Commenter,
    Editor,
}

impl Role {
    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "viewer" => Some(Role::Viewer),
            "commenter" => Some(Role::Commenter),
            "editor" => Some(Role::Editor),
            _ => None,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::Viewer => "viewer",
            Role::Commenter => "commenter",
            Role::Editor => "editor",
        }
    }
    pub fn can_edit(&self) -> bool {
        *self == Role::Editor
    }
}

/// What a resolved connection may do (the authorization seam, sync-protocol.md).
#[derive(Clone, Copy, Debug)]
pub struct Access {
    pub user_id: Option<Uuid>,
    pub role: Role,
    /// Whether the attributed author is an agent identity (users.kind = 'agent') — agents
    /// only ever authenticate via Bearer api_tokens. Rooms use this for ADR 0007
    /// presence-aware defaults (HumanPresent) and update-log origin.
    pub author_is_agent: bool,
}

struct PendingLogin {
    pkce_verifier: String,
    nonce: String,
    next: String,
    /// Which registered issuer this attempt runs against — the callback validates the
    /// code against THIS issuer's client, never whatever the response claims.
    issuer: String,
    created: Instant,
}

// ---------------------------------------------------------------------------
// Issuer registry (ADR 0012 "Multi-issuer / per-Workspace IdP", Phase 5)
// ---------------------------------------------------------------------------

/// Issuer comparison key: OIDC issuers are URLs and a trailing slash is the one cosmetic
/// difference worth forgiving between config and `iss` claims.
pub(crate) fn normalize_issuer(s: &str) -> String {
    s.trim_end_matches('/').to_string()
}

/// One configured issuer — the env-configured PRIMARY or a per-workspace one
/// (workspaces.sso). The relying-party client is built lazily on first use and cached,
/// so a dead corporate IdP can never block startup: discovery failures surface as 502
/// at SSO-config time (the probe) or at login time, not when the server boots.
pub struct IssuerHandle {
    pub issuer: String, // normalized
    pub(crate) client_id: String,
    client_secret: String,
    connected: Mutex<Option<Arc<ConnectedIssuer>>>,
}

impl IssuerHandle {
    fn new(issuer: &str, client_id: &str, client_secret: &str) -> Self {
        Self {
            issuer: normalize_issuer(issuer),
            client_id: client_id.to_string(),
            client_secret: client_secret.to_string(),
            connected: Mutex::new(None),
        }
    }
}

/// Minimum spacing between JWKS re-fetches. dex rotates keys roughly hourly, so a single
/// refresh covers the whole rotation; the floor exists purely so a flood of bogus tokens
/// (each with an unknown `kid`) can't turn into a fetch storm against the IdP.
const JWKS_MIN_REFRESH_INTERVAL: Duration = Duration::from_secs(60);

/// A refreshable cache of an issuer's JWKS (its public signing keys). The IdP rotates these
/// periodically; when a token arrives signed by a key we don't have cached, we re-fetch the
/// JWKS once (rate-limited) and retry, so a key rotation never requires a server restart.
///
/// Concurrency: the keys live behind a plain `RwLock`. We only ever hold the lock to clone
/// the key set out (readers) or to swap in a freshly-fetched set (the one writer) — never
/// across the network fetch itself, so the lock can't deadlock or stall on I/O.
pub(crate) struct JwksCache {
    jwks_uri: JsonWebKeySetUrl,
    inner: RwLock<JwksCacheInner>,
}

struct JwksCacheInner {
    keys: CoreJsonWebKeySet,
    /// When `keys` were last *re-fetched* via [`JwksCache::refresh`] — the rate-limiter
    /// reads this. `None` means "never re-fetched since discovery", so the first
    /// unknown-kid is always allowed to refresh (the initial keys came from discovery,
    /// which may already predate a rotation).
    last_refresh: Option<Instant>,
}

impl JwksCache {
    fn new(jwks_uri: JsonWebKeySetUrl, keys: CoreJsonWebKeySet) -> Self {
        Self {
            jwks_uri,
            inner: RwLock::new(JwksCacheInner {
                keys,
                last_refresh: None,
            }),
        }
    }

    /// Snapshot the currently cached key set (cheap clone; lock held only for the clone).
    fn current(&self) -> CoreJsonWebKeySet {
        self.inner.read().unwrap().keys.clone()
    }

    /// Re-fetch the JWKS from the IdP and swap it in, unless we refreshed within the last
    /// `JWKS_MIN_REFRESH_INTERVAL` (then it's a no-op and we keep the cached set). Returns
    /// the key set callers should now try. The lock is never held across the `.await`.
    async fn refresh(&self, http: &reqwest::Client) -> Result<CoreJsonWebKeySet> {
        // Rate-limit: bail early (keeping the lock-free fast path) if we refreshed recently.
        // The very first refresh after discovery is always allowed (last_refresh == None).
        {
            let inner = self.inner.read().unwrap();
            if inner
                .last_refresh
                .is_some_and(|at| at.elapsed() < JWKS_MIN_REFRESH_INTERVAL)
            {
                return Ok(inner.keys.clone());
            }
        }
        let fresh = JsonWebKeySet::fetch_async(&self.jwks_uri, http)
            .await
            .context("re-fetching JWKS after unknown-kid")?;
        let mut inner = self.inner.write().unwrap();
        // Another request may have refreshed while we were fetching; last writer wins and
        // both end up with an equally-fresh set, so this is fine.
        inner.keys = fresh.clone();
        inner.last_refresh = Some(Instant::now());
        Ok(fresh)
    }
}

/// A discovered issuer: the RP client plus what CLI token verification needs (a refreshable
/// JWKS). The JWKS lives behind [`JwksCache`] so id-token validation self-heals across the
/// IdP's signing-key rotations (see [`ConnectedIssuer::validate_id_token`]).
pub(crate) struct ConnectedIssuer {
    oidc: OidcClient,
    issuer_url: IssuerUrl,
    jwks: JwksCache,
    /// Stashed RP credentials so verifiers can be rebuilt against a freshly-fetched key set
    /// (the web callback verifies as a confidential client; both need the client_id).
    client_id: ClientId,
    client_secret: ClientSecret,
}

/// True iff a claims-verification failure was specifically "no key matched the token's
/// `kid`" — the stale-JWKS signal that warrants a re-fetch. Every other failure (expired,
/// bad audience, bad issuer, bad nonce, wrong signature with a *known* key) must fail fast
/// with NO network call.
fn is_unknown_kid(err: &ClaimsVerificationError) -> bool {
    matches!(
        err,
        ClaimsVerificationError::SignatureVerification(SignatureVerificationError::NoMatchingKey)
    )
}

impl ConnectedIssuer {
    /// Validate an id token against the cached JWKS, self-healing across key rotations:
    /// build a verifier from the cached keys and try; if (and only if) that fails because
    /// no cached key matched the token's `kid`, re-fetch the JWKS once (rate-limited) and
    /// retry. `build_verifier` lets each call site keep its own verifier shape (the web
    /// callback is a confidential client; the CLI is a public client). Returns the verified
    /// claims, owned, so the borrow of the freshly-built verifier doesn't escape.
    pub(crate) async fn validate_id_token<BV, NV>(
        &self,
        http: &reqwest::Client,
        id_token: &CoreIdToken,
        build_verifier: BV,
        nonce_verifier: NV,
    ) -> Result<CoreIdTokenClaims, ClaimsVerificationError>
    where
        BV: Fn(CoreJsonWebKeySet) -> CoreIdTokenVerifier<'static>,
        NV: NonceVerifier + Copy,
    {
        let verifier = build_verifier(self.jwks.current());
        match id_token.claims(&verifier, nonce_verifier) {
            Ok(claims) => return Ok(claims.clone()),
            Err(e) if is_unknown_kid(&e) => {
                warn!("id token kid not in cached JWKS; refreshing keys (possible IdP rotation)");
            }
            Err(e) => return Err(e),
        }
        // Stale-JWKS path: re-fetch (rate-limited) and retry exactly once. A failed fetch
        // surfaces as the original NoMatchingKey error so the caller still returns a clean
        // 401 rather than a 5xx — a stale key set is an auth failure, not a server fault.
        let refreshed = match self.jwks.refresh(http).await {
            Ok(keys) => keys,
            Err(e) => {
                warn!(error = %format!("{e:#}"), "JWKS refresh failed; rejecting token");
                return Err(ClaimsVerificationError::SignatureVerification(
                    SignatureVerificationError::NoMatchingKey,
                ));
            }
        };
        let verifier = build_verifier(refreshed);
        id_token.claims(&verifier, nonce_verifier).cloned()
    }
}

/// Every issuer this deployment trusts: the primary (env; connected at startup, fail
/// fast) plus per-workspace issuers (loaded from `workspaces.sso` at startup and
/// reloaded on every config change). Lookup is by `iss` value — the login override and
/// the CLI token verifier both pick their issuer this way.
pub struct IssuerRegistry {
    primary: Arc<IssuerHandle>,
    extra: Mutex<HashMap<String, Arc<IssuerHandle>>>,
}

impl IssuerRegistry {
    fn new(primary: Arc<IssuerHandle>) -> Self {
        Self {
            primary,
            extra: Mutex::new(HashMap::new()),
        }
    }

    pub fn primary(&self) -> Arc<IssuerHandle> {
        self.primary.clone()
    }

    /// Pick a registered issuer by an `iss` value; None = this server does not trust it.
    pub fn lookup(&self, iss: &str) -> Option<Arc<IssuerHandle>> {
        let iss = normalize_issuer(iss);
        if self.primary.issuer == iss {
            return Some(self.primary.clone());
        }
        self.extra.lock().unwrap().get(&iss).cloned()
    }

    /// Replace the per-workspace issuer set with (issuer, client_id, client_secret)
    /// rows. Handles with unchanged credentials keep their cached client; the primary
    /// always wins over a workspace row claiming the same issuer (env is the operator).
    pub(crate) fn set_workspace_issuers(&self, rows: Vec<(String, String, String)>) {
        let mut extra = self.extra.lock().unwrap();
        let old = std::mem::take(&mut *extra);
        for (issuer, client_id, client_secret) in rows {
            let issuer = normalize_issuer(&issuer);
            if issuer == self.primary.issuer {
                continue;
            }
            let keep = old
                .get(&issuer)
                .filter(|h| h.client_id == client_id && h.client_secret == client_secret)
                .cloned();
            extra.insert(
                issuer.clone(),
                keep.unwrap_or_else(|| {
                    Arc::new(IssuerHandle::new(&issuer, &client_id, &client_secret))
                }),
            );
        }
    }
}

/// Pull (issuer, client_id, client_secret) out of one workspaces.sso jsonb.
pub(crate) fn sso_credentials(cfg: &Value) -> Option<(String, String, String)> {
    let s = |k: &str| {
        cfg.get(k)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    Some((s("issuer")?, s("client_id")?, s("client_secret")?))
}

/// The domain of an email address ("X@Y" → "y", lowercased); None when not email-shaped.
pub(crate) fn domain_of(email: &str) -> Option<String> {
    let (local, domain) = email.trim().rsplit_once('@')?;
    if local.is_empty() || domain.is_empty() || !domain.contains('.') {
        return None;
    }
    Some(domain.to_ascii_lowercase())
}

/// Which configured issuer claims this email domain (workspaces.sso email_domains).
/// A leading dot in a configured domain is forgiven (".corp.example" == "corp.example").
pub(crate) fn issuer_for_domain<'a>(
    configs: impl IntoIterator<Item = &'a Value>,
    domain: &str,
) -> Option<String> {
    for cfg in configs {
        let Some(issuer) = cfg.get("issuer").and_then(Value::as_str) else {
            continue;
        };
        let claims_domain = cfg
            .get("email_domains")
            .and_then(Value::as_array)
            .is_some_and(|ds| {
                ds.iter()
                    .filter_map(Value::as_str)
                    .any(|d| d.trim_start_matches('.').eq_ignore_ascii_case(domain))
            });
        if claims_domain {
            return Some(normalize_issuer(issuer));
        }
    }
    None
}

/// The `iss` claim of a JWT WITHOUT verifying it — used only to pick which registered
/// issuer's keys to verify against (an unregistered iss is rejected outright, and the
/// signature check then proves the claim).
pub(crate) fn unverified_iss(jwt: &str) -> Option<String> {
    use base64::Engine as _;
    let payload = jwt.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    Some(v.get("iss")?.as_str()?.to_string())
}

/// Everything auth-mode needs; absent entirely in open mode.
pub struct AuthCtx {
    http: reqwest::Client,
    sessions: SessionStore,
    pending: Mutex<HashMap<String, PendingLogin>>,
    /// Where the web app lives; used for the share URLs, CORS, and redirect validation.
    pub web_origin: String,
    persistence: Arc<Persistence>,
    /// Every issuer this deployment trusts (primary + per-workspace, Phase 5).
    pub issuers: IssuerRegistry,
    /// One redirect URI serves every issuer: {public_url}/auth/callback.
    redirect_uri: RedirectUrl,
    cli_client_id: String,
    /// Whether auth cookies carry the `Secure` attribute — true whenever the server's
    /// public URL is https. Only plain-http dev (MUESLI_PUBLIC_URL=http://localhost:…)
    /// runs without it, since browsers refuse Secure cookies over http.
    cookie_secure: bool,
}

impl AuthCtx {
    /// Discover the PRIMARY issuer and build its relying-party client — fails fast on a
    /// bad primary: a multi-user deployment without working identity should not come up
    /// half-open. Per-workspace issuers are then loaded from the DB but NOT contacted
    /// (lazy connect): a tenant's broken IdP must never block the whole deployment.
    pub async fn connect(
        issuer: &str,
        client_id: &str,
        client_secret: &str,
        public_url: &str,
        web_origin: &str,
        redis_url: Option<&str>,
        persistence: Arc<Persistence>,
    ) -> Result<Self> {
        let http = reqwest::ClientBuilder::new()
            // OIDC requires the RP to never follow token-endpoint redirects (SSRF guard).
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .context("building http client")?;

        let redirect_uri = RedirectUrl::new(format!(
            "{}/auth/callback",
            public_url.trim_end_matches('/')
        ))?;
        let cli_client_id =
            std::env::var("OIDC_CLI_CLIENT_ID").unwrap_or_else(|_| "muesli-cli".into());

        let sessions = match redis_url {
            Some(url) => {
                let client = redis::Client::open(url).context("redis url")?;
                let mgr = redis::aio::ConnectionManager::new(client)
                    .await
                    .context("connecting to redis")?;
                info!("sessions in redis");
                SessionStore::Redis(mgr)
            }
            None => {
                warn!("REDIS_URL not set — sessions are in-memory (lost on restart)");
                SessionStore::Memory(Mutex::new(HashMap::new()))
            }
        };

        let ctx = Self {
            http,
            sessions,
            pending: Mutex::new(HashMap::new()),
            web_origin: web_origin.trim_end_matches('/').to_string(),
            persistence,
            issuers: IssuerRegistry::new(Arc::new(IssuerHandle::new(
                issuer,
                client_id,
                client_secret,
            ))),
            redirect_uri,
            cli_client_id,
            cookie_secure: public_url.trim().starts_with("https://"),
        };
        // The primary connects NOW (fail fast, as before the registry existed).
        ctx.connect_issuer(&ctx.issuers.primary()).await?;
        // Per-workspace issuers register lazily — rows only, no discovery yet.
        ctx.reload_workspace_issuers().await?;
        Ok(ctx)
    }

    /// The cached RP client for a registered issuer, running discovery on first use.
    pub(crate) async fn connect_issuer(
        &self,
        handle: &Arc<IssuerHandle>,
    ) -> Result<Arc<ConnectedIssuer>> {
        if let Some(c) = handle.connected.lock().unwrap().clone() {
            return Ok(c);
        }
        let metadata = CoreProviderMetadata::discover_async(
            IssuerUrl::new(handle.issuer.clone())?,
            &self.http,
        )
        .await
        .with_context(|| format!("OIDC discovery against {}", handle.issuer))?;
        let issuer_url = metadata.issuer().clone();
        let jwks_uri = metadata.jwks_uri().clone();
        let jwks = JwksCache::new(jwks_uri, metadata.jwks().clone());
        let client_id = ClientId::new(handle.client_id.clone());
        let client_secret = ClientSecret::new(handle.client_secret.clone());
        let oidc = CoreClient::from_provider_metadata(
            metadata,
            client_id.clone(),
            Some(client_secret.clone()),
        )
        .set_redirect_uri(self.redirect_uri.clone());
        let connected = Arc::new(ConnectedIssuer {
            oidc,
            issuer_url,
            jwks,
            client_id,
            client_secret,
        });
        *handle.connected.lock().unwrap() = Some(connected.clone());
        Ok(connected)
    }

    /// Probe an issuer config by running discovery against it right now — the SSO
    /// config endpoint calls this so a typo'd issuer fails THAT request (502), never a
    /// later login or the next startup.
    pub async fn probe_issuer(
        &self,
        issuer: &str,
        client_id: &str,
        client_secret: &str,
    ) -> Result<()> {
        let handle = Arc::new(IssuerHandle::new(issuer, client_id, client_secret));
        self.connect_issuer(&handle).await?;
        Ok(())
    }

    /// Re-read every workspaces.sso row into the registry — called at startup and after
    /// every SSO config change (clients with unchanged credentials stay cached).
    pub async fn reload_workspace_issuers(&self) -> Result<()> {
        let rows = self.persistence.workspace_sso_configs().await?;
        let creds = rows
            .iter()
            .filter_map(|(_, cfg)| sso_credentials(cfg))
            .collect();
        self.issuers.set_workspace_issuers(creds);
        Ok(())
    }

    /// Resolve the session cookie to a user id, if any.
    pub async fn session_user(&self, jar: &CookieJar) -> Option<Uuid> {
        let token = jar.get(SESSION_COOKIE)?.value().to_string();
        self.sessions.get(&token).await
    }

    /// Resolve the calling principal: a session cookie (human) or a Bearer API token
    /// (agent, mcp-and-agent-auth.md). Bearer wins when both are present.
    pub async fn authenticate(
        &self,
        jar: &CookieJar,
        headers: &axum::http::HeaderMap,
    ) -> Option<Principal> {
        if let Some(value) = headers.get(axum::http::header::AUTHORIZATION) {
            let raw = value.to_str().ok()?.strip_prefix("Bearer ")?;
            let info = self
                .persistence
                .lookup_api_token(&hash_token(raw))
                .await
                .ok()??;
            return Some(Principal {
                // Delegated tokens act within the owner's permissions; service accounts
                // (no owner) hold their own roles.
                role_user: info.owner_user_id.unwrap_or(info.principal_id),
                author: info.principal_id,
                role_cap: scope_cap(&info.scopes),
                document_restriction: info.document_id,
                workspace_restriction: info.workspace_id,
                // API-token principals attribute to an agent identity (users.kind='agent',
                // created by cli_login / service-account minting).
                is_agent: true,
            });
        }
        let user_id = self.session_user(jar).await?;
        Some(Principal {
            role_user: user_id,
            author: user_id,
            role_cap: Role::Editor,
            document_restriction: None,
            workspace_restriction: None,
            is_agent: false,
        })
    }
}

/// An authenticated caller, however they authenticated.
#[derive(Clone, Copy, Debug)]
pub struct Principal {
    /// Whose Document roles apply (the human owner for delegated tokens).
    pub role_user: Uuid,
    /// Who edits are attributed to (the agent identity for tokens).
    pub author: Uuid,
    /// Ceiling imposed by token scopes; Editor for sessions.
    pub role_cap: Role,
    pub document_restriction: Option<Uuid>,
    pub workspace_restriction: Option<Uuid>,
    /// True when the attributed author is an agent identity (users.kind = 'agent').
    pub is_agent: bool,
}

/// Effective capability = token scopes ∩ Document role (mcp-and-agent-auth.md).
fn scope_cap(scopes: &[String]) -> Role {
    let has = |s: &str| scopes.iter().any(|x| x == s);
    if has("write") || has("admin") {
        Role::Editor
    } else if has("comment") || has("suggest") {
        Role::Commenter
    } else {
        Role::Viewer
    }
}

pub fn hash_token(raw: &str) -> String {
    let digest = Sha256::digest(raw.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

enum SessionStore {
    Memory(Mutex<HashMap<String, (Uuid, Instant)>>),
    Redis(redis::aio::ConnectionManager),
}

impl SessionStore {
    /// Sessions are keyed by `hash_token(token)` — never the raw token — so read access
    /// to Redis (backup, exposed port) or process memory yields no replayable cookie
    /// values, mirroring how API tokens are stored (`lookup_api_token(&hash_token(..))`).
    /// The raw token lives only in the client's cookie.
    async fn put(&self, token: &str, user_id: Uuid) -> Result<()> {
        let key = hash_token(token);
        match self {
            SessionStore::Memory(map) => {
                let mut map = map.lock().unwrap();
                map.retain(|_, (_, at)| at.elapsed().as_secs() < SESSION_TTL_SECS);
                map.insert(key, (user_id, Instant::now()));
                Ok(())
            }
            SessionStore::Redis(mgr) => {
                let mut conn = mgr.clone();
                redis::cmd("SET")
                    .arg(format!("muesli:session:{key}"))
                    .arg(user_id.to_string())
                    .arg("EX")
                    .arg(SESSION_TTL_SECS)
                    .query_async::<()>(&mut conn)
                    .await?;
                Ok(())
            }
        }
    }

    async fn get(&self, token: &str) -> Option<Uuid> {
        let key = hash_token(token);
        match self {
            SessionStore::Memory(map) => {
                let map = map.lock().unwrap();
                let (user_id, at) = map.get(&key)?;
                (at.elapsed().as_secs() < SESSION_TTL_SECS).then_some(*user_id)
            }
            SessionStore::Redis(mgr) => {
                let mut conn = mgr.clone();
                let v: Option<String> = redis::cmd("GET")
                    .arg(format!("muesli:session:{key}"))
                    .query_async(&mut conn)
                    .await
                    .ok()?;
                v.and_then(|s| Uuid::parse_str(&s).ok())
            }
        }
    }

    async fn delete(&self, token: &str) {
        let key = hash_token(token);
        match self {
            SessionStore::Memory(map) => {
                map.lock().unwrap().remove(&key);
            }
            SessionStore::Redis(mgr) => {
                let mut conn = mgr.clone();
                let _: Result<(), _> = redis::cmd("DEL")
                    .arg(format!("muesli:session:{key}"))
                    .query_async::<()>(&mut conn)
                    .await;
            }
        }
    }
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn err500(e: anyhow::Error) -> Response {
    // `{:#}` logs the FULL anyhow chain ("context: …: root cause"), not just the
    // outermost context — "id token validation" alone once hid the real cause (a
    // Zitadel audience mismatch) and made a production outage needlessly opaque.
    warn!(error = %format!("{e:#}"), "auth error");
    (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
}

/// Like [`err500`] but for BROWSER navigations (the /auth/* redirect dances): the
/// person gets the branded error page; the full error chain stays in the log.
fn err500_browser(e: anyhow::Error, retry_href: &str) -> Response {
    warn!(error = %format!("{e:#}"), "auth error");
    crate::error_page::browser_error_page(StatusCode::INTERNAL_SERVER_ERROR, retry_href)
}

/// The "Try again" target for a failed login flow: restart /auth/login with the
/// original post-login destination when we know it, else land on the app root.
fn login_retry_href(next: Option<&str>) -> String {
    match next {
        Some(n) => format!("/auth/login?next={}", crate::storage::uri_encode(n, true)),
        None => "/".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/// Open-redirect guard for the post-login `next` target: accept only a same-origin
/// absolute path (a single leading `/` — `//host` is a protocol-relative URL and `/\host`
/// its backslash twin, both rejected) or an absolute URL whose origin (scheme+host+port)
/// EQUALS the web app's origin. Prefix matching is deliberately avoided:
/// `https://app.example.com.evil.example` starts with the origin string but is not it.
fn safe_next(next: &str, web_origin: &str) -> bool {
    if let Some(rest) = next.strip_prefix('/') {
        return !rest.starts_with('/') && !rest.starts_with('\\');
    }
    match (reqwest::Url::parse(next), reqwest::Url::parse(web_origin)) {
        (Ok(n), Ok(o)) => {
            n.scheme() == o.scheme()
                && n.host_str() == o.host_str()
                && n.port_or_known_default() == o.port_or_known_default()
        }
        _ => false,
    }
}

/// GET /auth/login?next=<url>&issuer=<registered issuer> — start the code+PKCE flow.
/// Without `issuer` the PRIMARY is used; with it, the issuer must be registered (the
/// primary or a workspace's SSO issuer) — /auth/login/select is how browsers find it.
pub async fn login(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(auth) = state.auth.as_ref() else {
        warn!("/auth/login hit but auth is not configured (open mode)");
        return crate::error_page::browser_error_page(StatusCode::NOT_FOUND, "/");
    };

    // Only redirect back to ourselves or the web app (open-redirect guard, safe_next).
    let next = params
        .get("next")
        .filter(|n| safe_next(n, &auth.web_origin))
        .cloned()
        .unwrap_or_else(|| auth.web_origin.clone());

    let handle = match params.get("issuer") {
        None => auth.issuers.primary(),
        Some(iss) => match auth.issuers.lookup(iss) {
            Some(h) => h,
            None => {
                warn!(issuer = %iss, "login against an issuer not registered with this server");
                return crate::error_page::browser_error_page(StatusCode::NOT_FOUND, "/");
            }
        },
    };
    let issuer = match auth.connect_issuer(&handle).await {
        Ok(c) => c,
        Err(e) => {
            warn!(error = %format!("{e:#}"), issuer = %handle.issuer, "issuer discovery failed at login");
            return crate::error_page::browser_error_page(
                StatusCode::BAD_GATEWAY,
                &login_retry_href(Some(&next)),
            );
        }
    };

    let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
    let (url, csrf, nonce) = issuer
        .oidc
        .authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            CsrfToken::new_random,
            Nonce::new_random,
        )
        .add_scope(Scope::new("email".into()))
        .add_scope(Scope::new("profile".into()))
        .set_pkce_challenge(pkce_challenge)
        .url();

    {
        let mut pending = auth.pending.lock().unwrap();
        pending.retain(|_, p| p.created.elapsed() < LOGIN_ATTEMPT_TTL);
        pending.insert(
            csrf.secret().clone(),
            PendingLogin {
                pkce_verifier: pkce_verifier.secret().clone(),
                nonce: nonce.secret().clone(),
                next,
                issuer: handle.issuer.clone(),
                created: Instant::now(),
            },
        );
    }
    // Login-CSRF binding: tie this attempt to THIS browser. The callback rejects any
    // `state` that doesn't match this cookie, so an attacker can't complete a login
    // flow of their own inside a victim's browser (forced-login / session fixation).
    // SameSite=Lax still sends it on the IdP's top-level redirect back to the callback;
    // no max_age — the server-side pending entry expires after LOGIN_ATTEMPT_TTL and
    // the cookie alone grants nothing.
    let bind = Cookie::build((LOGIN_BIND_COOKIE, csrf.secret().clone()))
        .http_only(true)
        .secure(auth.cookie_secure)
        .same_site(SameSite::Lax)
        .path("/auth")
        .build();
    (jar.add(bind), Redirect::to(url.as_str())).into_response()
}

/// GET /auth/login/select?email=you@corp.example&next= — the "sign in with your
/// organization" entry point: map the email's domain to the workspace SSO issuer that
/// claims it (workspaces.sso.email_domains) and bounce to /auth/login?issuer=…
/// 404 when no workspace claims the domain (the web UI shows a toast).
pub async fn login_select(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(auth) = state.auth.as_ref() else {
        warn!("/auth/login/select hit but auth is not configured (open mode)");
        return crate::error_page::browser_error_page(StatusCode::NOT_FOUND, "/");
    };
    let Some(domain) = params.get("email").and_then(|e| domain_of(e)) else {
        warn!("/auth/login/select called without a usable ?email=");
        return crate::error_page::browser_error_page(StatusCode::BAD_REQUEST, "/");
    };
    let configs = match auth.persistence.workspace_sso_configs().await {
        Ok(c) => c,
        Err(e) => return err500_browser(e, "/"),
    };
    let Some(issuer) = issuer_for_domain(configs.iter().map(|(_, c)| c), &domain) else {
        // Enumeration tradeoff (accepted): success is a 302 into the issuer's login and
        // an unclaimed domain is this 404 (the web UI probes the status and shows a
        // toast), so the response does reveal which email domains have SSO configured
        // here. A uniform response is not feasible — there is nowhere to redirect an
        // unclaimed domain without breaking the login flow. Mitigations: the body is
        // generic (never echoes the domain), and the per-IP rate limit on /auth/*
        // keeps bulk harvesting slow.
        return crate::error_page::browser_error_page(StatusCode::NOT_FOUND, "/");
    };
    let mut target = format!(
        "/auth/login?issuer={}",
        crate::storage::uri_encode(&issuer, true)
    );
    if let Some(next) = params.get("next") {
        target.push_str("&next=");
        target.push_str(&crate::storage::uri_encode(next, true));
    }
    Redirect::to(&target).into_response()
}

#[derive(Deserialize)]
pub struct CallbackParams {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// GET /auth/callback — exchange the code against the issuer the login STARTED with
/// (recorded in the pending state), validate the ID token, upsert the User (keyed by
/// issuer+subject, ADR 0012), ensure a personal Workspace (ADR 0011) plus any
/// SSO-implied memberships (Phase 5), set session.
pub async fn callback(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(params): Query<CallbackParams>,
) -> Response {
    // Every error below faces a PERSON mid-navigation (the IdP just redirected their
    // browser here), so failures render the branded error page; the specifics stay
    // in the log (never on the page — don't leak internals to an unauthenticated UA).
    let Some(auth) = state.auth.as_ref() else {
        warn!("/auth/callback hit but auth is not configured (open mode)");
        return crate::error_page::browser_error_page(StatusCode::NOT_FOUND, "/");
    };
    if let Some(err) = params.error {
        let desc = params.error_description.unwrap_or_default();
        warn!(error = %err, description = %desc, "issuer returned an error to the callback");
        return crate::error_page::browser_error_page(StatusCode::BAD_REQUEST, "/");
    }
    let (Some(code), Some(csrf_state)) = (params.code, params.state) else {
        warn!("callback missing code/state");
        return crate::error_page::browser_error_page(StatusCode::BAD_REQUEST, "/");
    };
    // Login-CSRF binding: the state must match the cookie /auth/login set in THIS
    // browser — a callback URL captured from another browser's flow (classic login
    // CSRF: forcing the victim into the attacker's session) dies here, before any
    // code exchange. PKCE/nonce checks below are unchanged.
    if jar.get(LOGIN_BIND_COOKIE).map(|c| c.value()) != Some(csrf_state.as_str()) {
        warn!("callback state does not match the login-bind cookie (login CSRF or stale attempt)");
        return crate::error_page::browser_error_page(StatusCode::BAD_REQUEST, "/");
    }
    // The binding cookie is one-shot: clear it however the rest of the callback goes.
    let jar = jar.remove(Cookie::build((LOGIN_BIND_COOKIE, "")).path("/auth").build());
    let Some(pending) = auth.pending.lock().unwrap().remove(&csrf_state) else {
        warn!("callback for an unknown or expired login attempt");
        return (
            jar,
            crate::error_page::browser_error_page(StatusCode::BAD_REQUEST, "/"),
        )
            .into_response();
    };
    // A failed exchange restarts the login with the original destination intact.
    let retry_href = login_retry_href(Some(&pending.next));
    // Bind the callback to the issuer the attempt started with — its client credentials
    // and its jwks validate this code, nothing else.
    let Some(handle) = auth.issuers.lookup(&pending.issuer) else {
        warn!(issuer = %pending.issuer, "the issuer for this login attempt is no longer registered");
        return (
            jar,
            crate::error_page::browser_error_page(StatusCode::BAD_REQUEST, &retry_href),
        )
            .into_response();
    };
    let issuer = match auth.connect_issuer(&handle).await {
        Ok(c) => c,
        Err(e) => return (jar, err500_browser(e, &retry_href)).into_response(),
    };

    match finish_login(auth, &issuer, code, pending).await {
        Ok((session_token, next)) => {
            // No max_age: a browser-session cookie; real expiry is the server-side
            // session TTL, which is enforced on every lookup.
            let cookie = Cookie::build((SESSION_COOKIE, session_token))
                .http_only(true)
                .secure(auth.cookie_secure)
                .same_site(SameSite::Lax)
                .path("/")
                .build();
            (jar.add(cookie), Redirect::to(&next)).into_response()
        }
        Err(e) => (jar, err500_browser(e, &retry_href)).into_response(),
    }
}

async fn finish_login(
    auth: &AuthCtx,
    issuer: &Arc<ConnectedIssuer>,
    code: String,
    pending: PendingLogin,
) -> Result<(String, String)> {
    let token_response = issuer
        .oidc
        .exchange_code(AuthorizationCode::new(code))?
        .set_pkce_verifier(PkceCodeVerifier::new(pending.pkce_verifier))
        .request_async(&auth.http)
        .await
        .context("token exchange")?;
    let id_token = token_response
        .id_token()
        .ok_or_else(|| anyhow!("issuer returned no id_token"))?;
    let nonce = Nonce::new(pending.nonce);
    // Validate as a confidential client, self-healing across dex key rotations: if the cached
    // JWKS lacks the token's signing key, the keys are re-fetched once and validation retried.
    let claims = issuer
        .validate_id_token(
            &auth.http,
            id_token,
            |keys| {
                CoreIdTokenVerifier::new_confidential_client(
                    issuer.client_id.clone(),
                    issuer.client_secret.clone(),
                    issuer.issuer_url.clone(),
                    keys,
                )
                // Zitadel-style IdPs mint id tokens whose `aud` lists every app of the
                // project (web + CLI + project id), not just the requesting client. Our
                // client_id must still be among the audiences (the crate enforces that
                // regardless of this hook), and issuer/signature/expiry/nonce all still
                // verify — the extra audiences are sibling apps of the same trusted
                // issuer, so accepting them is safe and expected.
                .set_other_audience_verifier_fn(|_aud| true)
            },
            &nonce,
        )
        .await
        .context("id token validation")?;

    let iss = claims.issuer().as_str();
    let subject = claims.subject().as_str();
    let email = claims.email().map(|e| e.as_str());
    let name = claims.name().and_then(|n| n.get(None)).map(|n| n.as_str());
    let picture = claims
        .picture()
        .and_then(|p| p.get(None))
        .map(|p| p.as_str());

    let user_id = auth
        .persistence
        .upsert_oidc_user(iss, subject, email, name, picture)
        .await?;
    // Invites (ADR 0011): unclaimed invites matching this email become memberships now.
    if let Some(email) = email {
        claim_and_audit_invites(auth, user_id, email).await;
    }
    // The per-workspace IdP invariant (Phase 5): this issuer's workspaces gain a member.
    ensure_sso_memberships(auth, iss, user_id).await;
    audit::record(
        &auth.persistence,
        AuditEvent::new("login")
            .workspace(None)
            .actor(Some(user_id))
            .detail(json!({ "method": "web", "issuer": iss })),
    );

    let session_token = random_token();
    auth.sessions.put(&session_token, user_id).await?;
    info!(%user_id, subject, issuer = iss, "user signed in");
    Ok((session_token, pending.next))
}

/// Claim pending invites (ADR 0011) and audit each claim against its workspace.
/// Best-effort: an invite failure must not fail the login.
async fn claim_and_audit_invites(auth: &AuthCtx, user_id: Uuid, email: &str) {
    match auth.persistence.claim_invites(user_id, email).await {
        Ok(claimed) => {
            for (workspace_id, role) in claimed {
                info!(%user_id, %workspace_id, "claimed workspace invite");
                audit::record(
                    &auth.persistence,
                    AuditEvent::new("invite_claimed")
                        .workspace(Some(workspace_id))
                        .actor(Some(user_id))
                        .detail(json!({ "email": email, "role": role })),
                );
            }
        }
        Err(e) => warn!(%e, "claiming workspace invites failed"),
    }
}

/// THE per-workspace IdP invariant (Phase 5): a user who authenticated via workspace W's
/// issuer is auto-ensured as a member of W (role 'member') — that is the point of a
/// workspace bringing its own IdP. Best-effort: a failure logs but never fails the login.
async fn ensure_sso_memberships(auth: &AuthCtx, iss: &str, user_id: Uuid) {
    let iss = normalize_issuer(iss);
    let configs = match auth.persistence.workspace_sso_configs().await {
        Ok(c) => c,
        Err(e) => {
            warn!(%e, "loading workspace sso configs failed; skipping sso memberships");
            return;
        }
    };
    for (workspace_id, cfg) in configs {
        let matches = cfg
            .get("issuer")
            .and_then(Value::as_str)
            .map(normalize_issuer)
            .as_deref()
            == Some(&iss);
        if !matches {
            continue;
        }
        match auth.persistence.workspace_role(workspace_id, user_id).await {
            Ok(Some(_)) => {} // already a member, nothing to ensure
            Ok(None) => {
                if let Err(e) = auth
                    .persistence
                    .add_membership(workspace_id, user_id, "member")
                    .await
                {
                    warn!(%e, %workspace_id, "sso login membership failed");
                    continue;
                }
                info!(%workspace_id, %user_id, issuer = %iss, "sso login: membership ensured");
                audit::record(
                    &auth.persistence,
                    AuditEvent::new("sso_login_membership")
                        .workspace(Some(workspace_id))
                        .actor(Some(user_id))
                        .detail(json!({ "issuer": iss, "role": "member" })),
                );
            }
            Err(e) => warn!(%e, %workspace_id, "sso membership check failed"),
        }
    }
}

/// POST /auth/logout
pub async fn logout(State(state): State<AppState>, jar: CookieJar) -> Response {
    let Some(auth) = state.auth.as_ref() else {
        return StatusCode::NO_CONTENT.into_response();
    };
    if let Some(c) = jar.get(SESSION_COOKIE) {
        auth.sessions.delete(c.value()).await;
    }
    // Attributes must mirror the set cookie (callback) so browsers match-and-remove it.
    let removal = Cookie::build((SESSION_COOKIE, ""))
        .http_only(true)
        .secure(auth.cookie_secure)
        .same_site(SameSite::Lax)
        .path("/")
        .build();
    (jar.remove(removal), StatusCode::NO_CONTENT).into_response()
}

#[derive(Serialize)]
struct MeResponse {
    mode: &'static str,
    user: Option<UserJson>,
    /// Which storage backends a connect attempt can actually succeed for on this
    /// server (env-derived at boot). The workspace wizard's storage picker disables
    /// the kinds this server cannot serve instead of surfacing the connect
    /// endpoint's raw config error.
    storage: crate::storage::StorageCapabilities,
}

#[derive(Serialize)]
pub struct UserJson {
    pub id: Uuid,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    /// First-login onboarding stamp (migration 0016), ISO-8601 or null =
    /// show onboarding. Stamped via PATCH /api/me {onboarded: true}.
    pub onboarded_at: Option<String>,
}

/// GET /api/me — who am I (session or bearer), and is this server in open or oidc mode.
pub async fn me(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let Some(auth) = state.auth.as_ref() else {
        return Json(MeResponse {
            mode: "open",
            user: None,
            storage: crate::storage::storage_capabilities(),
        })
        .into_response();
    };
    let user = match auth.authenticate(&jar, &headers).await {
        // For delegated agent tokens, report the human OWNER (role_user), not the
        // synthetic agent identity (author). "/api/me" answers "who am I" for the
        // person driving a native client, not the agent the token mints.
        Some(p) => match auth.persistence.get_user(p.role_user).await {
            Ok(u) => u,
            Err(e) => return err500(e),
        },
        None => None,
    };
    Json(MeResponse {
        mode: "oidc",
        user,
        storage: crate::storage::storage_capabilities(),
    })
    .into_response()
}

#[derive(Serialize)]
struct CliAuthConfig {
    mode: &'static str,
    issuer: Option<String>,
    cli_client_id: Option<String>,
}

/// GET /api/cli/auth-config — what the CLI needs to run the device-code flow
/// (local-agent-cli.md). Public: it only reveals the issuer, which discovery exposes anyway.
pub async fn cli_auth_config(State(state): State<AppState>) -> Response {
    match state.auth.as_ref() {
        None => Json(CliAuthConfig {
            mode: "open",
            issuer: None,
            cli_client_id: None,
        })
        .into_response(),
        Some(auth) => Json(CliAuthConfig {
            mode: "oidc",
            issuer: Some(auth.issuers.primary().issuer.clone()),
            cli_client_id: Some(auth.cli_client_id.clone()),
        })
        .into_response(),
    }
}

#[derive(Deserialize)]
pub struct CliLoginRequest {
    id_token: String,
    label: Option<String>,
}

#[derive(Serialize)]
struct CliLoginResponse {
    token: String,
    agent: UserJson,
    owner_email: Option<String>,
}

/// POST /api/cli/login — exchange a freshly minted ID token (device-code flow against the
/// issuer's public CLI client) for a Muesli **delegated agent token** (mcp-and-agent-auth.md):
/// a new agent identity attributed in edits, acting within the owner's permissions.
/// The verifying issuer is picked from the registry by the token's `iss` claim, so CLI
/// logins work against per-workspace issuers too (the signature check proves the claim).
pub async fn cli_login(
    State(state): State<AppState>,
    Json(req): Json<CliLoginRequest>,
) -> Response {
    let Some(auth) = state.auth.as_ref() else {
        return (StatusCode::BAD_REQUEST, "open mode: no login needed").into_response();
    };

    let result: Result<CliLoginResponse> = async {
        let id_token: CoreIdToken = req.id_token.parse().context("malformed id_token")?;
        let iss = unverified_iss(&req.id_token)
            .ok_or_else(|| anyhow!("id_token carries no iss claim"))?;
        let handle = auth
            .issuers
            .lookup(&iss)
            .ok_or_else(|| anyhow!("token issuer {iss} is not registered with this server"))?;
        let issuer = auth
            .connect_issuer(&handle)
            .await
            .context("issuer discovery")?;
        let cli_client_id = ClientId::new(auth.cli_client_id.clone());
        let issuer_url = issuer.issuer_url.clone();
        // Device-code flow binds no nonce; signature/issuer/audience/expiry still verify.
        // Self-heals across dex key rotations (re-fetches JWKS once on an unknown kid).
        let claims = issuer
            .validate_id_token(
                &auth.http,
                &id_token,
                move |keys| {
                    CoreIdTokenVerifier::new_public_client(
                        cli_client_id.clone(),
                        issuer_url.clone(),
                        keys,
                    )
                    // Same multi-audience stance as the web callback: Zitadel-style
                    // IdPs list every project app in `aud`. The CLI client_id must
                    // still be present; issuer/signature/expiry all still verify.
                    .set_other_audience_verifier_fn(|_aud| true)
                },
                |_: Option<&Nonce>| Ok(()),
            )
            .await
            .context("id token validation")?;

        let email = claims.email().map(|e| e.as_str());
        let owner_id = auth
            .persistence
            .upsert_oidc_user(
                claims.issuer().as_str(),
                claims.subject().as_str(),
                email,
                claims.name().and_then(|n| n.get(None)).map(|n| n.as_str()),
                None,
            )
            .await?;
        // The CLI login is an OIDC login too — claim any pending invites (ADR 0011) and
        // honor the per-workspace IdP membership invariant (Phase 5).
        if let Some(email) = email {
            claim_and_audit_invites(auth, owner_id, email).await;
        }
        ensure_sso_memberships(auth, claims.issuer().as_str(), owner_id).await;
        audit::record(
            &auth.persistence,
            AuditEvent::new("login")
                .workspace(None)
                .actor(Some(owner_id))
                .detail(json!({ "method": "cli", "issuer": claims.issuer().as_str() })),
        );

        let label = req.label.as_deref().unwrap_or("muesli-cli");
        let agent_id = auth.persistence.create_agent_user(label).await?;
        let secret = format!("mua_{}", random_token());
        auth.persistence
            .insert_api_token(
                &hash_token(&secret),
                agent_id,
                Some(owner_id),
                &["read", "write"],
                None,
            )
            .await?;
        info!(%owner_id, %agent_id, label, "minted delegated agent token");
        audit::record(
            &auth.persistence,
            AuditEvent::new("agent_token_minted")
                .workspace(None)
                .actor(Some(owner_id))
                .detail(
                    json!({ "agent_id": agent_id, "label": label, "scopes": ["read", "write"] }),
                ),
        );

        let agent = auth
            .persistence
            .get_user(agent_id)
            .await?
            .ok_or_else(|| anyhow!("agent vanished"))?;
        Ok(CliLoginResponse {
            token: secret,
            agent,
            owner_email: email.map(String::from),
        })
    }
    .await;

    match result {
        Ok(r) => Json(r).into_response(),
        Err(e) => {
            // The full anyhow chain (issuer URLs, discovery/DB error text) stays in the
            // log ({:#} prints every layer); an unauthenticated caller gets only the
            // generic verdict.
            warn!(error = %format!("{e:#}"), "cli login rejected");
            (StatusCode::UNAUTHORIZED, "login rejected").into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct ShareRequest {
    role: String,
    expires_in_secs: Option<i64>,
}

#[derive(Serialize)]
struct ShareResponse {
    url: String,
    token: String,
    role: String,
}

/// POST /api/documents/{slug}/share — mint a role-scoped guest link (ADR 0011).
/// Requires an authenticated Editor on the document.
pub async fn create_share(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<ShareRequest>,
) -> Response {
    let Some(auth) = state.auth.as_ref() else {
        return (
            StatusCode::BAD_REQUEST,
            "open mode: the document URL itself is the share link",
        )
            .into_response();
    };
    let Some(role) = Role::parse(&req.role) else {
        return (
            StatusCode::BAD_REQUEST,
            "role must be viewer|commenter|editor",
        )
            .into_response();
    };
    let Some(principal) = auth.authenticate(&jar, &headers).await else {
        return (StatusCode::UNAUTHORIZED, "sign in to share").into_response();
    };

    let result: Result<ShareResponse> = async {
        // BYO storage: same shape as resolve_access's doc-creation branch — a brand-new
        // user has no workspace until the wizard runs, and ensure_document_owned's "no
        // workspace yet" error would otherwise surface here as a 500.
        if auth
            .persistence
            .primary_workspace_of(principal.role_user)
            .await?
            .is_none()
        {
            return Err(anyhow!("no workspace"));
        }
        // The sharer must be (or become, by creating the doc) an Editor — and a token
        // principal additionally needs the write scope.
        let doc = auth
            .persistence
            .ensure_document_owned(&slug, principal.role_user, principal.author)
            .await?;
        if doc.created {
            audit::record(
                &auth.persistence,
                AuditEvent::new("document_created")
                    .workspace(doc.workspace_id)
                    .document(Some(doc.id))
                    .actor(Some(principal.author))
                    .detail(json!({ "slug": slug })),
            );
            // BYO storage (plan 1a task 8): documents born in a bound workspace attach +
            // write through to the backend immediately. Failure is non-fatal — creation
            // stands, the poll/debounce loops retry.
            if let Some(mgr) = state.storage.clone() {
                if let Err(e) = mgr.attach_new_document(doc.id).await {
                    warn!(doc_id = %doc.id, %e, "auto-attach on create failed");
                }
            }
        }
        let granted = auth
            .persistence
            .user_role(doc.id, principal.role_user)
            .await?
            .map(|r| r.min(principal.role_cap));
        if granted != Some(Role::Editor) {
            return Err(anyhow!("forbidden"));
        }
        let token = random_token();
        auth.persistence
            .create_share_link(
                doc.id,
                &token,
                role.as_str(),
                req.expires_in_secs,
                principal.role_user,
            )
            .await?;
        audit::record(
            &auth.persistence,
            AuditEvent::new("share_link_created")
                .workspace(doc.workspace_id)
                .document(Some(doc.id))
                .actor(Some(principal.role_user))
                .detail(json!({
                    "role": role.as_str(),
                    "expires_in_secs": req.expires_in_secs,
                })),
        );
        Ok(ShareResponse {
            url: format!("{}/#{}?share={}", auth.web_origin, slug, token),
            token,
            role: role.as_str().to_string(),
        })
    }
    .await;

    match result {
        Ok(r) => Json(r).into_response(),
        Err(e) if e.to_string() == "forbidden" => {
            (StatusCode::FORBIDDEN, "only editors can share").into_response()
        }
        Err(e) if e.to_string() == "no workspace" => {
            (StatusCode::FORBIDDEN, "create a workspace first").into_response()
        }
        Err(e) => err500(e),
    }
}

// ---------------------------------------------------------------------------
// The authorization seam (sync-protocol.md): resolve a connection's Access
// before the websocket upgrade.
// ---------------------------------------------------------------------------

pub async fn resolve_access(
    state: &AppState,
    slug: &str,
    jar: &CookieJar,
    headers: &axum::http::HeaderMap,
    share_token: Option<&str>,
) -> Result<Access, StatusCode> {
    // Trashed documents refuse new connections in EVERY mode (410 Gone): a room open
    // would resurrect get-or-create semantics and edit a document the trash hides.
    let doc = match state.persistence.as_ref() {
        Some(p) => p
            .find_document(slug)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        None => None,
    };
    if doc.as_ref().is_some_and(|d| d.deleted) {
        return Err(StatusCode::GONE);
    }

    let Some(auth) = state.auth.as_ref() else {
        // Open mode (ADR 0012 local-solo exception): anonymous editor (a human session).
        return Ok(Access {
            user_id: None,
            role: Role::Editor,
            author_is_agent: false,
        });
    };

    let principal = auth.authenticate(jar, headers).await;

    let mut role: Option<Role> = None;

    match &doc {
        None => {
            // New document: an authenticated principal creates it, owned by the role user.
            if let Some(p) = &principal {
                // BYO storage: a brand-new user has no workspace until the creation
                // wizard runs (create_workspace leaves it 'pending_storage', which
                // primary_workspace_of now excludes). Check up front so that expected,
                // user-facing case reads as 403, not a 500 from ensure_document_owned's
                // internal "no workspace yet" error.
                let has_workspace = auth
                    .persistence
                    .primary_workspace_of(p.role_user)
                    .await
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
                    .is_some();
                if !has_workspace {
                    return Err(StatusCode::FORBIDDEN);
                }
                let created = auth
                    .persistence
                    .ensure_document_owned(slug, p.role_user, p.author)
                    .await
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
                if created.created {
                    audit::record(
                        &auth.persistence,
                        AuditEvent::new("document_created")
                            .workspace(created.workspace_id)
                            .document(Some(created.id))
                            .actor(Some(p.author))
                            .detail(json!({ "slug": slug })),
                    );
                    // BYO storage (plan 1a task 8): documents born in a bound workspace
                    // attach + write through to the backend immediately. Failure is
                    // non-fatal — creation stands, the poll/debounce loops retry.
                    if let Some(mgr) = state.storage.clone() {
                        if let Err(e) = mgr.attach_new_document(created.id).await {
                            warn!(doc_id = %created.id, %e, "auto-attach on create failed");
                        }
                    }
                }
                role = Some(Role::Editor);
            }
        }
        Some(doc) => {
            if let Some(p) = &principal {
                // Token restrictions narrow access to one document / one workspace.
                let restricted = p.document_restriction.is_some_and(|d| d != doc.id)
                    || p.workspace_restriction
                        .is_some_and(|w| doc.workspace_id != Some(w));
                if !restricted {
                    role = auth
                        .persistence
                        .user_role(doc.id, p.role_user)
                        .await
                        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
                }
            }
            if let Some(token) = share_token {
                let link_role = auth
                    .persistence
                    .share_link_role(doc.id, token)
                    .await
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
                role = role.max(link_role);
            }
        }
    }

    // Scope ceiling: a read-only token never edits, whatever the role says.
    if let (Some(r), Some(p)) = (role, &principal) {
        role = Some(r.min(p.role_cap));
    }

    match role {
        Some(r) => Ok(Access {
            user_id: principal.as_ref().map(|p| p.author),
            role: r,
            author_is_agent: principal.as_ref().is_some_and(|p| p.is_agent),
        }),
        None if principal.is_some() => Err(StatusCode::FORBIDDEN),
        None => Err(StatusCode::UNAUTHORIZED),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// GET /api/me carries the storage capability flags (flat booleans under
    /// "storage") the web wizard's picker consumes — in open mode too, where
    /// `user` is null but storage still works.
    #[test]
    fn me_response_exposes_storage_capabilities() {
        let v = serde_json::to_value(MeResponse {
            mode: "open",
            user: None,
            storage: crate::storage::storage_capabilities(),
        })
        .unwrap();
        assert_eq!(v["mode"], "open");
        let storage = v["storage"].as_object().expect("storage object");
        for kind in ["s3", "github", "gdrive", "sharepoint"] {
            assert!(storage[kind].is_boolean(), "storage.{kind} is a boolean");
        }
    }

    #[test]
    fn next_redirect_guard() {
        let origin = "https://app.example.com";
        // same-origin paths pass
        assert!(safe_next("/", origin));
        assert!(safe_next("/doc/abc?x=1#frag", origin));
        // exact-origin absolute URLs pass
        assert!(safe_next("https://app.example.com", origin));
        assert!(safe_next("https://app.example.com/doc/abc", origin));
        // protocol-relative and backslash tricks are rejected
        assert!(!safe_next("//evil.example/phish", origin));
        assert!(!safe_next("/\\evil.example", origin));
        // prefix confusion: starts with the origin string but is NOT the origin
        assert!(!safe_next("https://app.example.com.evil.example/", origin));
        assert!(!safe_next("https://app.example.com@evil.example/", origin));
        // wrong origin / scheme downgrade / non-http schemes / junk
        assert!(!safe_next("https://evil.example/", origin));
        assert!(!safe_next("http://app.example.com/", origin));
        assert!(!safe_next("javascript:alert(1)", origin));
        assert!(!safe_next("", origin));
        // explicit default port still equals the origin
        assert!(safe_next("https://app.example.com:443/x", origin));
        assert!(!safe_next("https://app.example.com:8443/x", origin));
    }

    #[test]
    fn email_domain_extraction() {
        assert_eq!(domain_of("user@Corp.Example"), Some("corp.example".into()));
        assert_eq!(
            domain_of("  padded@corp.example  "),
            Some("corp.example".into())
        );
        // a second @ belongs to the local part (rsplit)
        assert_eq!(domain_of("we@rd@corp.example"), Some("corp.example".into()));
        assert_eq!(domain_of("no-at-sign"), None);
        assert_eq!(domain_of("@corp.example"), None);
        assert_eq!(domain_of("user@"), None);
        assert_eq!(domain_of("user@nodot"), None);
    }

    #[test]
    fn domain_to_issuer_lookup() {
        let corp = json!({
            "issuer": "http://localhost:5558/dex/",
            "client_id": "muesli",
            "client_secret": "s",
            "email_domains": ["corpdomain.example", ".dotted.example"],
        });
        let other = json!({
            "issuer": "https://idp.other.example",
            "client_id": "muesli",
            "client_secret": "s",
            "email_domains": ["other.example"],
        });
        let configs = [&corp, &other];
        // match, case-insensitive, issuer normalized (trailing slash dropped)
        assert_eq!(
            issuer_for_domain(configs.iter().copied(), "CorpDomain.Example"),
            Some("http://localhost:5558/dex".into())
        );
        // a configured leading dot is forgiven
        assert_eq!(
            issuer_for_domain(configs.iter().copied(), "dotted.example"),
            Some("http://localhost:5558/dex".into())
        );
        assert_eq!(
            issuer_for_domain(configs.iter().copied(), "other.example"),
            Some("https://idp.other.example".into())
        );
        assert_eq!(
            issuer_for_domain(configs.iter().copied(), "unknown.example"),
            None
        );
        // malformed configs are skipped, never matched
        let broken = json!({ "email_domains": ["x.example"] }); // no issuer
        assert_eq!(issuer_for_domain([&broken], "x.example"), None);
    }

    #[test]
    fn issuer_registry_picks_by_iss() {
        let primary = Arc::new(IssuerHandle::new(
            "http://primary.example/dex",
            "muesli",
            "s1",
        ));
        let reg = IssuerRegistry::new(primary);
        reg.set_workspace_issuers(vec![(
            "http://corp.example/dex/".into(), // trailing slash normalizes away
            "corp-client".into(),
            "s2".into(),
        )]);

        // primary resolves, with and without a trailing slash on the iss claim
        assert_eq!(
            reg.lookup("http://primary.example/dex").unwrap().client_id,
            "muesli"
        );
        assert_eq!(
            reg.lookup("http://primary.example/dex/").unwrap().client_id,
            "muesli"
        );
        // workspace issuer resolves both ways too
        assert_eq!(
            reg.lookup("http://corp.example/dex").unwrap().client_id,
            "corp-client"
        );
        assert_eq!(
            reg.lookup("http://corp.example/dex/").unwrap().client_id,
            "corp-client"
        );
        // unknown issuers are not trusted
        assert!(reg.lookup("http://evil.example/dex").is_none());

        // a workspace row claiming the PRIMARY issuer never shadows the env config
        reg.set_workspace_issuers(vec![(
            "http://primary.example/dex".into(),
            "evil".into(),
            "x".into(),
        )]);
        assert_eq!(
            reg.lookup("http://primary.example/dex").unwrap().client_id,
            "muesli"
        );
        // and the previous workspace registration was replaced wholesale
        assert!(reg.lookup("http://corp.example/dex").is_none());
    }

    #[test]
    fn workspace_issuer_reload_keeps_unchanged_clients() {
        let reg = IssuerRegistry::new(Arc::new(IssuerHandle::new("http://p.example", "m", "s")));
        reg.set_workspace_issuers(vec![(
            "http://corp.example".into(),
            "c".into(),
            "s2".into(),
        )]);
        let first = reg.lookup("http://corp.example").unwrap();
        // same credentials → same handle (cached discovery survives a reload)
        reg.set_workspace_issuers(vec![(
            "http://corp.example".into(),
            "c".into(),
            "s2".into(),
        )]);
        assert!(Arc::ptr_eq(
            &first,
            &reg.lookup("http://corp.example").unwrap()
        ));
        // changed secret → a fresh handle (stale client must not be reused)
        reg.set_workspace_issuers(vec![(
            "http://corp.example".into(),
            "c".into(),
            "s3".into(),
        )]);
        assert!(!Arc::ptr_eq(
            &first,
            &reg.lookup("http://corp.example").unwrap()
        ));
    }

    #[test]
    fn unverified_iss_reads_the_payload_only() {
        use base64::Engine as _;
        let b64 = |v: &Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string().as_bytes())
        };
        let jwt = format!(
            "{}.{}.signature",
            b64(&json!({ "alg": "RS256" })),
            b64(&json!({ "iss": "http://localhost:5558/dex", "sub": "abc" })),
        );
        assert_eq!(
            unverified_iss(&jwt),
            Some("http://localhost:5558/dex".into())
        );
        assert_eq!(unverified_iss("not-a-jwt"), None);
        assert_eq!(unverified_iss(""), None);
    }

    // ---- JWKS self-heal on key rotation (the bug this module fixes) ----------------
    //
    // These tests exercise [`JwksCache`] / [`ConnectedIssuer::validate_id_token`] directly:
    // a token signed by a key the cache doesn't have must trigger a single rate-limited
    // re-fetch and then validate, with no server, DB, or external network involved (the
    // mock JWKS endpoint is a loopback TCP listener on an ephemeral port).

    use chrono::{TimeZone, Utc};
    use openidconnect::core::{
        CoreIdTokenClaims, CoreJsonWebKey, CoreJwsSigningAlgorithm, CoreRsaPrivateSigningKey,
    };
    use openidconnect::{
        Audience, JsonWebKeyId, JsonWebKeySetUrl, StandardClaims, SubjectIdentifier,
    };

    // A throwaway 2048-bit RSA key (openidconnect's own test fixture) — TEST ONLY.
    const TEST_RSA_PRIV_KEY: &str = "-----BEGIN RSA PRIVATE KEY-----\n\
         MIIEowIBAAKCAQEAn4EPtAOCc9AlkeQHPzHStgAbgs7bTZLwUBZdR8/KuKPEHLd4\n\
         rHVTeT+O+XV2jRojdNhxJWTDvNd7nqQ0VEiZQHz/AJmSCpMaJMRBSFKrKb2wqVwG\n\
         U/NsYOYL+QtiWN2lbzcEe6XC0dApr5ydQLrHqkHHig3RBordaZ6Aj+oBHqFEHYpP\n\
         e7Tpe+OfVfHd1E6cS6M1FZcD1NNLYD5lFHpPI9bTwJlsde3uhGqC0ZCuEHg8lhzw\n\
         OHrtIQbS0FVbb9k3+tVTU4fg/3L/vniUFAKwuCLqKnS2BYwdq/mzSnbLY7h/qixo\n\
         R7jig3//kRhuaxwUkRz5iaiQkqgc5gHdrNP5zwIDAQABAoIBAG1lAvQfhBUSKPJK\n\
         Rn4dGbshj7zDSr2FjbQf4pIh/ZNtHk/jtavyO/HomZKV8V0NFExLNi7DUUvvLiW7\n\
         0PgNYq5MDEjJCtSd10xoHa4QpLvYEZXWO7DQPwCmRofkOutf+NqyDS0QnvFvp2d+\n\
         Lov6jn5C5yvUFgw6qWiLAPmzMFlkgxbtjFAWMJB0zBMy2BqjntOJ6KnqtYRMQUxw\n\
         TgXZDF4rhYVKtQVOpfg6hIlsaoPNrF7dofizJ099OOgDmCaEYqM++bUlEHxgrIVk\n\
         wZz+bg43dfJCocr9O5YX0iXaz3TOT5cpdtYbBX+C/5hwrqBWru4HbD3xz8cY1TnD\n\
         qQa0M8ECgYEA3Slxg/DwTXJcb6095RoXygQCAZ5RnAvZlno1yhHtnUex/fp7AZ/9\n\
         nRaO7HX/+SFfGQeutao2TDjDAWU4Vupk8rw9JR0AzZ0N2fvuIAmr/WCsmGpeNqQn\n\
         ev1T7IyEsnh8UMt+n5CafhkikzhEsrmndH6LxOrvRJlsPp6Zv8bUq0kCgYEAuKE2\n\
         dh+cTf6ERF4k4e/jy78GfPYUIaUyoSSJuBzp3Cubk3OCqs6grT8bR/cu0Dm1MZwW\n\
         mtdqDyI95HrUeq3MP15vMMON8lHTeZu2lmKvwqW7anV5UzhM1iZ7z4yMkuUwFWoB\n\
         vyY898EXvRD+hdqRxHlSqAZ192zB3pVFJ0s7pFcCgYAHw9W9eS8muPYv4ZhDu/fL\n\
         2vorDmD1JqFcHCxZTOnX1NWWAj5hXzmrU0hvWvFC0P4ixddHf5Nqd6+5E9G3k4E5\n\
         2IwZCnylu3bqCWNh8pT8T3Gf5FQsfPT5530T2BcsoPhUaeCnP499D+rb2mTnFYeg\n\
         mnTT1B/Ue8KGLFFfn16GKQKBgAiw5gxnbocpXPaO6/OKxFFZ+6c0OjxfN2PogWce\n\
         TU/k6ZzmShdaRKwDFXisxRJeNQ5Rx6qgS0jNFtbDhW8E8WFmQ5urCOqIOYk28EBi\n\
         At4JySm4v+5P7yYBh8B8YD2l9j57z/s8hJAxEbn/q8uHP2ddQqvQKgtsni+pHSk9\n\
         XGBfAoGBANz4qr10DdM8DHhPrAb2YItvPVz/VwkBd1Vqj8zCpyIEKe/07oKOvjWQ\n\
         SgkLDH9x2hBgY01SbP43CvPk0V72invu2TGkI/FXwXWJLLG7tDSgw4YyfhrYrHmg\n\
         1Vre3XB9HH8MYBVB6UIexaAq4xSeoemRKTBesZro7OKjKT8/GmiO\n\
         -----END RSA PRIVATE KEY-----";

    const TEST_ISSUER: &str = "https://idp.test.example";
    const TEST_CLIENT_ID: &str = "muesli-cli";

    /// Sign a minimal id token (far-future `exp`, so it never expires under the real clock)
    /// with the given `aud` list and return it alongside its public verification JWK.
    fn signed_id_token_with_audiences(
        kid: &str,
        audiences: Vec<Audience>,
    ) -> (CoreIdToken, CoreJsonWebKey) {
        let key = CoreRsaPrivateSigningKey::from_pem(
            TEST_RSA_PRIV_KEY,
            Some(JsonWebKeyId::new(kid.to_string())),
        )
        .expect("test rsa key");
        use openidconnect::PrivateSigningKey;
        let jwk = key.as_verification_key();
        let token = CoreIdToken::new(
            CoreIdTokenClaims::new(
                IssuerUrl::new(TEST_ISSUER.to_string()).unwrap(),
                audiences,
                Utc.timestamp_opt(4_102_444_800, 0).single().unwrap(), // year 2100
                Utc.timestamp_opt(1_700_000_000, 0).single().unwrap(),
                StandardClaims::new(SubjectIdentifier::new("subject-1".to_string())),
                Default::default(),
            ),
            &key,
            CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha256,
            None,
            None,
        )
        .expect("sign id token");
        (token, jwk)
    }

    fn signed_id_token_with_jwk(kid: &str) -> (CoreIdToken, CoreJsonWebKey) {
        signed_id_token_with_audiences(kid, vec![Audience::new(TEST_CLIENT_ID.to_string())])
    }

    fn public_verifier(keys: CoreJsonWebKeySet) -> CoreIdTokenVerifier<'static> {
        CoreIdTokenVerifier::new_public_client(
            ClientId::new(TEST_CLIENT_ID.to_string()),
            IssuerUrl::new(TEST_ISSUER.to_string()).unwrap(),
            keys,
        )
    }

    /// A one-shot-per-connection loopback HTTP server that serves `body` as JSON at any path
    /// and counts how many times it was hit. Returns (url, hit_counter, join_handle).
    async fn spawn_jwks_server(
        body: String,
    ) -> (
        String,
        Arc<std::sync::atomic::AtomicUsize>,
        tokio::task::JoinHandle<()>,
    ) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits2 = hits.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                hits2.fetch_add(1, Ordering::SeqCst);
                let body = body.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    let _ = sock.read(&mut buf).await;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        (format!("http://{addr}/jwks"), hits, handle)
    }

    /// THE regression test: the cache holds key set A, but a token signed by key B (a
    /// rotated key) arrives. Validation must re-fetch the JWKS (now serving B) and succeed —
    /// proving a dex key rotation no longer needs a server restart.
    #[tokio::test]
    async fn validate_refetches_jwks_on_unknown_kid() {
        let (token, fresh_jwk) = signed_id_token_with_jwk("rotated-key-B");
        let fresh_jwks = CoreJsonWebKeySet::new(vec![fresh_jwk]);
        let body = serde_json::to_string(&fresh_jwks).unwrap();
        let (url, hits, _srv) = spawn_jwks_server(body).await;

        // Cache starts STALE: a different key id ("old-key-A"), so the token's kid is unknown.
        let (_old_token, stale_jwk) = signed_id_token_with_jwk("old-key-A");
        let stale = CoreJsonWebKeySet::new(vec![stale_jwk]);
        let issuer = ConnectedIssuer {
            oidc: dummy_oidc(),
            issuer_url: IssuerUrl::new(TEST_ISSUER.to_string()).unwrap(),
            jwks: JwksCache::new(JsonWebKeySetUrl::new(url).unwrap(), stale),
            client_id: ClientId::new(TEST_CLIENT_ID.to_string()),
            client_secret: ClientSecret::new(String::new()),
        };
        let http = reqwest::Client::new();

        let claims = issuer
            .validate_id_token(&http, &token, public_verifier, |_: Option<&Nonce>| Ok(()))
            .await
            .expect("should self-heal and validate after refetch");
        assert_eq!(claims.subject().as_str(), "subject-1");
        assert_eq!(
            hits.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "exactly one refetch"
        );

        // The refreshed key set is now cached, so a second validation needs NO further fetch.
        issuer
            .validate_id_token(&http, &token, public_verifier, |_: Option<&Nonce>| Ok(()))
            .await
            .expect("second validation uses the now-fresh cache");
        assert_eq!(
            hits.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "fresh cache must not refetch again"
        );
    }

    /// A burst of unknown-kid tokens must not turn into a fetch storm: the second bad token
    /// arriving within the min-refresh interval reuses the just-fetched (still-empty-of-its-
    /// kid) set without a second network call, and fails fast.
    #[tokio::test]
    async fn refresh_is_rate_limited_against_fetch_storms() {
        // Serve a JWKS that NEVER contains the token's kid, so every attempt "misses".
        let (_t, unrelated) = signed_id_token_with_jwk("server-key");
        let body = serde_json::to_string(&CoreJsonWebKeySet::new(vec![unrelated])).unwrap();
        let (url, hits, _srv) = spawn_jwks_server(body).await;

        let (token, _) = signed_id_token_with_jwk("victim-kid");
        let issuer = ConnectedIssuer {
            oidc: dummy_oidc(),
            issuer_url: IssuerUrl::new(TEST_ISSUER.to_string()).unwrap(),
            jwks: JwksCache::new(
                JsonWebKeySetUrl::new(url).unwrap(),
                CoreJsonWebKeySet::new(vec![]),
            ),
            client_id: ClientId::new(TEST_CLIENT_ID.to_string()),
            client_secret: ClientSecret::new(String::new()),
        };
        let http = reqwest::Client::new();

        for _ in 0..5 {
            let r = issuer
                .validate_id_token(&http, &token, public_verifier, |_: Option<&Nonce>| Ok(()))
                .await;
            assert!(matches!(
                r,
                Err(ClaimsVerificationError::SignatureVerification(
                    SignatureVerificationError::NoMatchingKey
                ))
            ));
        }
        // Five bad tokens, but the min-refresh interval collapses them to a single fetch.
        assert_eq!(
            hits.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "rate-limited to one fetch"
        );
    }

    /// PRODUCTION-DOWN regression (Zitadel): id tokens whose `aud` lists every app of the
    /// IdP project (requesting client + sibling clients + project id) must validate. The
    /// crate's default verifier rejects any audience beyond the client_id; both real call
    /// sites opt into accepting the extras via `set_other_audience_verifier_fn` — while
    /// still requiring OUR client_id to be among the audiences (second half of the test).
    #[tokio::test]
    async fn multi_audience_id_tokens_validate() {
        let multi_aud = || {
            vec![
                Audience::new(TEST_CLIENT_ID.to_string()),
                Audience::new("web-client-id".to_string()),
                Audience::new("project-id".to_string()),
            ]
        };
        let (token, jwk) = signed_id_token_with_audiences("key-1", multi_aud());
        let issuer = ConnectedIssuer {
            oidc: dummy_oidc(),
            issuer_url: IssuerUrl::new(TEST_ISSUER.to_string()).unwrap(),
            jwks: JwksCache::new(
                JsonWebKeySetUrl::new(format!("{TEST_ISSUER}/keys")).unwrap(),
                CoreJsonWebKeySet::new(vec![jwk]),
            ),
            client_id: ClientId::new(TEST_CLIENT_ID.to_string()),
            client_secret: ClientSecret::new(String::new()),
        };
        let http = reqwest::Client::new();

        // The verifier shape both production call sites use: extra audiences accepted.
        let accepting = |keys: CoreJsonWebKeySet| {
            public_verifier(keys).set_other_audience_verifier_fn(|_aud| true)
        };
        let claims = issuer
            .validate_id_token(&http, &token, accepting, |_: Option<&Nonce>| Ok(()))
            .await
            .expect("multi-audience token must validate");
        assert_eq!(claims.subject().as_str(), "subject-1");

        // Sanity: the default verifier is what broke production — pin that behavior so
        // a future crate upgrade changing it is noticed.
        let r = issuer
            .validate_id_token(&http, &token, public_verifier, |_: Option<&Nonce>| Ok(()))
            .await;
        assert!(matches!(
            r,
            Err(ClaimsVerificationError::InvalidAudience(_))
        ));

        // The lenient hook is NOT a blank check: a token that omits our client_id from
        // its audiences is still rejected.
        let (foreign, jwk2) = signed_id_token_with_audiences(
            "key-1",
            vec![
                Audience::new("web-client-id".to_string()),
                Audience::new("project-id".to_string()),
            ],
        );
        let issuer2 = ConnectedIssuer {
            oidc: dummy_oidc(),
            issuer_url: IssuerUrl::new(TEST_ISSUER.to_string()).unwrap(),
            jwks: JwksCache::new(
                JsonWebKeySetUrl::new(format!("{TEST_ISSUER}/keys")).unwrap(),
                CoreJsonWebKeySet::new(vec![jwk2]),
            ),
            client_id: ClientId::new(TEST_CLIENT_ID.to_string()),
            client_secret: ClientSecret::new(String::new()),
        };
        let r = issuer2
            .validate_id_token(&http, &foreign, accepting, |_: Option<&Nonce>| Ok(()))
            .await;
        assert!(matches!(
            r,
            Err(ClaimsVerificationError::InvalidAudience(_))
        ));
    }

    /// A non-key failure (here: wrong issuer) must fail fast with NO network call — proving
    /// the refetch is gated on unknown-kid specifically, not on every validation error.
    #[tokio::test]
    async fn non_key_failures_do_not_refetch() {
        let (token, jwk) = signed_id_token_with_jwk("key-1");
        // The cache HAS the signing key, so the signature verifies; but we point the verifier
        // at a different issuer URL, so issuer validation fails after a good signature check.
        let (url, hits, _srv) =
            spawn_jwks_server(serde_json::to_string(&CoreJsonWebKeySet::new(vec![])).unwrap())
                .await;
        let issuer = ConnectedIssuer {
            oidc: dummy_oidc(),
            issuer_url: IssuerUrl::new(TEST_ISSUER.to_string()).unwrap(),
            jwks: JwksCache::new(
                JsonWebKeySetUrl::new(url).unwrap(),
                CoreJsonWebKeySet::new(vec![jwk]),
            ),
            client_id: ClientId::new(TEST_CLIENT_ID.to_string()),
            client_secret: ClientSecret::new(String::new()),
        };
        let http = reqwest::Client::new();
        let wrong_issuer = |keys: CoreJsonWebKeySet| {
            CoreIdTokenVerifier::new_public_client(
                ClientId::new(TEST_CLIENT_ID.to_string()),
                IssuerUrl::new("https://someone-else.example".to_string()).unwrap(),
                keys,
            )
        };
        let r = issuer
            .validate_id_token(&http, &token, wrong_issuer, |_: Option<&Nonce>| Ok(()))
            .await;
        assert!(matches!(r, Err(ClaimsVerificationError::InvalidIssuer(_))));
        assert_eq!(
            hits.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "no network call on non-kid failure"
        );
    }

    /// A `ConnectedIssuer.oidc` field we never call in these unit tests — built once from a
    /// stub provider metadata so the struct can be constructed without real discovery.
    fn dummy_oidc() -> OidcClient {
        use openidconnect::core::{
            CoreProviderMetadata, CoreResponseType, CoreSubjectIdentifierType,
        };
        use openidconnect::{
            AuthUrl, EmptyAdditionalProviderMetadata, JsonWebKeySetUrl, ResponseTypes,
        };
        let metadata = CoreProviderMetadata::new(
            IssuerUrl::new(TEST_ISSUER.to_string()).unwrap(),
            AuthUrl::new(format!("{TEST_ISSUER}/auth")).unwrap(),
            JsonWebKeySetUrl::new(format!("{TEST_ISSUER}/keys")).unwrap(),
            vec![ResponseTypes::new(vec![CoreResponseType::Code])],
            vec![CoreSubjectIdentifierType::Public],
            vec![CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha256],
            EmptyAdditionalProviderMetadata {},
        );
        CoreClient::from_provider_metadata(
            metadata,
            ClientId::new(TEST_CLIENT_ID.to_string()),
            Some(ClientSecret::new(String::new())),
        )
    }

    #[test]
    fn sso_credentials_require_all_three_fields() {
        let full = json!({ "issuer": "http://i", "client_id": "c", "client_secret": "s" });
        assert_eq!(
            sso_credentials(&full),
            Some(("http://i".into(), "c".into(), "s".into()))
        );
        for missing in ["issuer", "client_id", "client_secret"] {
            let mut cfg = full.clone();
            cfg.as_object_mut().unwrap().remove(missing);
            assert_eq!(
                sso_credentials(&cfg),
                None,
                "missing {missing} must not register"
            );
        }
        let empty = json!({ "issuer": "", "client_id": "c", "client_secret": "s" });
        assert_eq!(sso_credentials(&empty), None);
    }
}
