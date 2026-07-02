//! Muesli sync server: single-owner Doc Rooms (ADR 0010) behind a y-websocket endpoint,
//! Postgres persistence, and OIDC identity (ADR 0012). With no OIDC_ISSUER configured the
//! server runs in open mode (local-solo exception): anonymous editors, zero auth setup.

mod account;
mod api;
mod audit;
mod auth;
mod events;
mod folders;
mod gdrive;
mod links;
mod mcp;
mod mentions;
mod msgraph;
mod notifications;
mod notifications_api;
mod persistence;
mod room;
mod search;
mod secrets;
mod storage;
mod workspace;

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{header, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use axum_extra::extract::cookie::CookieJar;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tower_http::cors::CorsLayer;
use tracing::{info, warn};

use auth::{Access, AuthCtx};
use events::WorkspaceEvents;
use links::{LinkHandle, LinkIndexer};
use persistence::Persistence;
use room::{spawn_room, RoomMsg};
use storage::{StorageHandle, StorageManager};

/// The live room registry, shared by handlers and the storage manager.
pub type Rooms = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<RoomMsg>>>>;

#[derive(Clone, Default)]
pub struct AppState {
    rooms: Rooms,
    persistence: Option<Arc<Persistence>>,
    pub auth: Option<Arc<AuthCtx>>,
    /// Materialize/poll loops for backend-attached documents (ADR 0013); None when volatile.
    pub storage: Option<Arc<StorageManager>>,
    /// Link-graph indexer (ADR 0015); None when volatile (links silently skipped).
    pub links: Option<LinkHandle>,
    /// Per-workspace structure-change broadcast hub (Plan 4 SSE stream).
    pub workspace_events: WorkspaceEvents,
    /// Notification delivery (sub-project ④c): resolves enabled channels and delivers email
    /// off the request path. None when volatile (no DB → no notifications).
    pub dispatcher: Option<Arc<notifications::Dispatcher>>,
    /// The canonical webapp origin (MUESLI_WEB_ORIGIN); notification deep-links target it.
    pub web_origin: String,
}

static NEXT_CONN: AtomicU64 = AtomicU64::new(1);

// ---------------------------------------------------------------------------
// Per-IP rate limiting for the unauthenticated auth surface (security review
// finding 29). Deliberately minimal — a fixed 60-second window of counts in a
// Mutex<HashMap>, no new dependency. All auth secrets are 256-bit CSPRNG so
// brute force is infeasible regardless; this throttles DoS/amplification
// (agent-user creation via /api/cli/login, a DB hit per /auth/login/select call).
// ---------------------------------------------------------------------------

const AUTH_RATE_WINDOW: Duration = Duration::from_secs(60);
const AUTH_RATE_MAX: u32 = 30;

#[derive(Clone, Default)]
struct AuthRateLimiter {
    hits: Arc<Mutex<HashMap<IpAddr, (Instant, u32)>>>,
}

impl AuthRateLimiter {
    /// Count one request from `ip`; true = allowed. Fixed-window counting: the first
    /// request stamps the window, the 31st within it is refused. Expired windows are
    /// pruned on every call, so the map stays bounded by recently-active client IPs.
    fn allow(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut hits = self.hits.lock().unwrap();
        hits.retain(|_, (start, _)| now.duration_since(*start) < AUTH_RATE_WINDOW);
        let (_, count) = hits.entry(ip).or_insert((now, 0));
        *count += 1;
        *count <= AUTH_RATE_MAX
    }
}

/// Middleware layered onto /auth/* and /api/cli/login. Fail-open: when the connect-info
/// extension is absent (e.g. a router driven in-process without connect info) the request
/// passes unthrottled — the limiter is a DoS damper, never an authorization gate.
async fn auth_rate_limit(
    State(limiter): State<AuthRateLimiter>,
    req: axum::extract::Request,
    next: Next,
) -> Response {
    let ip = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip());
    match ip {
        Some(ip) if !limiter.allow(ip) => (
            StatusCode::TOO_MANY_REQUESTS,
            "too many requests, slow down",
        )
            .into_response(),
        _ => next.run(req).await,
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Load ./.env when present (ADR 0017: everything via env). Real env vars win.
    let env_file = dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "muesli_server=debug,info".into()),
        )
        .init();
    if let Some(path) = &env_file {
        tracing::info!("loaded environment from {}", path.display());
    }

    // Persistence is explicit config: DATABASE_URL set → must work (fail fast); unset → the
    // server runs volatile (dev/demo mode), loudly.
    let persistence = match std::env::var("DATABASE_URL") {
        Ok(url) => {
            let p = Persistence::connect(&url).await?;
            info!("postgres persistence enabled (migrations applied)");
            Some(Arc::new(p))
        }
        Err(_) => {
            warn!(
                "DATABASE_URL not set — running VOLATILE (in-memory only, edits lost on restart)"
            );
            None
        }
    };

    let web_origin =
        std::env::var("MUESLI_WEB_ORIGIN").unwrap_or_else(|_| "http://localhost:5173".into());
    let public_url =
        std::env::var("MUESLI_PUBLIC_URL").unwrap_or_else(|_| "http://localhost:8787".into());

    // Identity (ADR 0012): OIDC_ISSUER set → full relying-party mode (requires DATABASE_URL,
    // fail fast); unset → open mode, the local-solo exception.
    let auth = match std::env::var("OIDC_ISSUER") {
        Ok(issuer) => {
            let client_id = std::env::var("OIDC_CLIENT_ID")
                .map_err(|_| anyhow::anyhow!("OIDC_ISSUER is set but OIDC_CLIENT_ID is not"))?;
            let client_secret = std::env::var("OIDC_CLIENT_SECRET")
                .map_err(|_| anyhow::anyhow!("OIDC_ISSUER is set but OIDC_CLIENT_SECRET is not"))?;
            let persistence = persistence.clone().ok_or_else(|| {
                anyhow::anyhow!("OIDC auth requires DATABASE_URL (users/sharing live in postgres)")
            })?;
            let redis_url = std::env::var("REDIS_URL").ok();
            let ctx = AuthCtx::connect(
                &issuer,
                &client_id,
                &client_secret,
                &public_url,
                &web_origin,
                redis_url.as_deref(),
                persistence,
            )
            .await?;
            info!(%issuer, "oidc auth enabled");
            Some(Arc::new(ctx))
        }
        Err(_) => {
            warn!("OIDC_ISSUER not set — OPEN MODE (every connection is an anonymous editor)");
            None
        }
    };

    // The web app is a different origin in dev (vite on :5173); credentialed CORS for /api.
    let cors = CorsLayer::new()
        .allow_origin(web_origin.parse::<HeaderValue>()?)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
        ])
        // X-Muesli-Share: the header channel for share tokens (finding 28) — allowed
        // here so the browser client can move them out of query strings.
        .allow_headers([
            header::CONTENT_TYPE,
            HeaderName::from_static("x-muesli-share"),
        ])
        .allow_credentials(true);

    // Storage backends (ADR 0013): the manager runs whenever persistence does; documents
    // without an attached backend cost nothing. Backend secrets are env-only (never in
    // the DB): MUESLI_S3_* for kind "s3", MUESLI_GITHUB_TOKEN for kind "github".
    let rooms: Rooms = Default::default();
    // Per-workspace structure stream (Plan 4): created here so the storage manager (built
    // before the AppState literal) and the rooms it spawns share the same hub the state holds.
    let workspace_events = WorkspaceEvents::default();
    // Link-graph indexer (ADR 0015): runs whenever persistence does; volatile mode
    // simply has no indexer and rooms skip the pings.
    let links = persistence
        .as_ref()
        .map(|p| LinkIndexer::spawn(p.clone()).handle());
    let storage = match &persistence {
        Some(p) => {
            if !storage::s3_creds_configured() {
                warn!("MUESLI_S3_ACCESS_KEY/MUESLI_S3_SECRET_KEY not set — S3 storage connections will fail until configured");
            }
            if !storage::github_token_configured() {
                warn!("MUESLI_GITHUB_TOKEN not set — github storage connections will fail until configured");
            }
            // Google Drive (ADR 0013 user-borne storage): the OAuth client comes from
            // MUESLI_GOOGLE_CLIENT_ID/SECRET, MUESLI_GOOGLE_CLIENT_FILE, or ./muesli.json.
            match gdrive::init_from_env(&public_url) {
                Ok(true) => info!("google drive storage connector configured"),
                Ok(false) => warn!(
                    "MUESLI_GOOGLE_CLIENT_* not set — google drive storage connections unavailable"
                ),
                Err(e) => return Err(e),
            }
            // Microsoft Graph / SharePoint (BYO storage phase 2): base URLs + optional
            // server-level Entra app from MUESLI_MS_*. The ctx installs even without an
            // env app, because workspaces may bring their own Entra app credentials.
            match msgraph::init_from_env() {
                Ok(true) => info!("microsoft graph (sharepoint) app configured"),
                Ok(false) => warn!(
                    "MUESLI_MS_CLIENT_ID + MUESLI_MS_CLIENT_SECRET/MUESLI_MS_CLIENT_CERT_FILE not set — \
                     sharepoint connections require per-workspace app credentials"
                ),
                Err(e) => return Err(e),
            }
            Some(StorageManager::spawn(
                p.clone(),
                rooms.clone(),
                links.clone(),
                workspace_events.clone(),
            ))
        }
        None => None,
    };

    // BYO storage (plan 1a): garbage-collect wizard-abandoned pending workspaces.
    if let Some(p) = persistence.clone() {
        let ttl_hours: i64 = std::env::var("MUESLI_PENDING_WS_TTL_HOURS")
            .ok()
            .and_then(|s| s.parse().ok())
            .filter(|h| *h > 0)
            .unwrap_or(24);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(3600)).await;
                match p.purge_abandoned_pending_workspaces(ttl_hours).await {
                    Ok(0) => {}
                    Ok(n) => info!(purged = n, "purged abandoned pending workspaces"),
                    Err(e) => warn!(%e, "pending-workspace GC failed"),
                }
            }
        });
    }

    // Notification email transport (sub-project ④c): SMTP when MUESLI_SMTP_HOST is set,
    // otherwise the dev console sender (logs the rendered email). The dispatcher only runs
    // when persistence does — notifications live in postgres.
    let dispatcher = persistence.as_ref().map(|_| {
        let sender: Arc<dyn notifications::EmailSender> = match notifications::SmtpConfig::from_env()
        {
            Some(cfg) => match notifications::SmtpEmailSender::new(cfg) {
                Ok(s) => {
                    info!("notification email: SMTP transport configured");
                    Arc::new(s)
                }
                Err(e) => {
                    warn!(%e, "MUESLI_SMTP_* set but SMTP transport failed to build — falling back to console");
                    Arc::new(notifications::ConsoleEmailSender::default())
                }
            },
            None => {
                warn!("MUESLI_SMTP_HOST not set — notification emails log to the console (dev transport)");
                Arc::new(notifications::ConsoleEmailSender::default())
            }
        };
        Arc::new(notifications::Dispatcher::new(sender))
    });

    let state = AppState {
        persistence,
        auth,
        rooms,
        storage,
        links,
        workspace_events,
        dispatcher,
        web_origin: web_origin.clone(),
    };
    // Coarse per-IP throttle on the unauthenticated auth endpoints (finding 29).
    let auth_rl = axum::middleware::from_fn_with_state(AuthRateLimiter::default(), auth_rate_limit);

    let mut app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/ws/{doc_id}", get(ws_handler))
        .route("/auth/login", get(auth::login).layer(auth_rl.clone()))
        // Phase 5 multi-issuer SSO: email-domain → workspace IdP entry point (ADR 0012).
        .route(
            "/auth/login/select",
            get(auth::login_select).layer(auth_rl.clone()),
        )
        .route("/auth/callback", get(auth::callback).layer(auth_rl.clone()))
        .route("/auth/logout", post(auth::logout).layer(auth_rl.clone()))
        .route("/api/me", get(auth::me).patch(account::update_me))
        // Account settings (internal/design/settings.md): delegated API keys + version probe.
        .route(
            "/api/me/tokens",
            get(account::list_tokens).post(account::mint_token),
        )
        .route(
            "/api/me/tokens/{id}",
            axum::routing::delete(account::revoke_token),
        )
        .route("/api/me/storage", get(account::storage_usage))
        .route("/api/meta", get(account::meta))
        .route("/api/documents/{slug}/share", post(auth::create_share))
        // Phase 2 collaboration depth (ADR 0019/0007): comments, suggestions, history.
        .route(
            "/api/documents/{slug}/comments",
            get(api::list_comments).post(api::create_comment),
        )
        // @mention member picker (sub-project ④b): Viewer+ union of workspace members
        // and explicit share-grantees.
        .route("/api/documents/{slug}/members", get(api::list_members))
        .route(
            "/api/documents/{slug}/comments/{thread_id}/replies",
            post(api::reply_comment),
        )
        .route(
            "/api/documents/{slug}/comments/{thread_id}/resolve",
            post(api::resolve_thread),
        )
        .route(
            "/api/documents/{slug}/comments/{thread_id}/reopen",
            post(api::reopen_thread),
        )
        .route(
            "/api/documents/{slug}/suggestions",
            get(api::list_suggestions).post(api::create_suggestion),
        )
        .route(
            "/api/documents/{slug}/suggestions/{id}/accept",
            post(api::accept_suggestion),
        )
        .route(
            "/api/documents/{slug}/suggestions/{id}/reject",
            post(api::reject_suggestion),
        )
        .route(
            "/api/documents/{slug}/suggestions/changesets/{change_set_id}/accept",
            post(api::accept_change_set),
        )
        .route(
            "/api/documents/{slug}/suggestions/changesets/{change_set_id}/reject",
            post(api::reject_change_set),
        )
        .route("/api/documents/{slug}/history", get(api::history))
        .route("/api/documents/{slug}/text", get(api::text))
        // Notifications inbox + preferences (sub-project ④c): auth-only, scoped to the caller.
        .route(
            "/api/notifications",
            get(notifications_api::list_notifications),
        )
        .route(
            "/api/notifications/unread-count",
            get(notifications_api::unread_count),
        )
        .route(
            "/api/notifications/{id}/read",
            post(notifications_api::mark_read),
        )
        .route(
            "/api/notifications/read-all",
            post(notifications_api::read_all),
        )
        .route(
            "/api/notification-preferences",
            get(notifications_api::get_preferences).put(notifications_api::put_preference),
        )
        // Link graph (ADR 0015): the universe view + per-document backlinks.
        .route("/api/graph", get(links::graph))
        // Full-text + title search over the caller's visible documents (migration 0009).
        .route("/api/search", get(search::search))
        .route("/api/documents/{slug}/links", get(links::document_links))
        // Phase 2 workspace management (ADR 0011) + storage backends (ADR 0013).
        .route(
            "/api/documents",
            get(workspace::list_documents).post(folders::create_document),
        )
        // Folders, trash, rename (migration 0008; folders.rs).
        .route(
            "/api/documents/{slug}",
            axum::routing::patch(folders::update_document).delete(folders::delete_document),
        )
        .route(
            "/api/documents/{slug}/restore",
            post(folders::restore_document),
        )
        .route(
            "/api/documents/{slug}/purge",
            axum::routing::delete(folders::purge_document),
        )
        .route("/api/folders", post(folders::create_folder))
        .route(
            "/api/folders/{id}",
            axum::routing::patch(folders::update_folder).delete(folders::delete_folder),
        )
        .route("/api/folders/{id}/restore", post(folders::restore_folder))
        .route(
            "/api/documents/{slug}/storage",
            post(workspace::attach_document_storage),
        )
        .route(
            "/api/workspaces",
            get(workspace::list_workspaces).post(workspace::create_workspace),
        )
        .route(
            "/api/workspaces/{id}/events",
            get(events::workspace_events_sse),
        )
        .route(
            "/api/workspaces/{id}",
            get(workspace::get_workspace)
                .patch(workspace::rename_workspace)
                .delete(workspace::delete_workspace),
        )
        .route(
            "/api/workspaces/{id}/invites",
            post(workspace::create_invite),
        )
        .route(
            "/api/workspaces/{id}/invites/{invite_id}",
            axum::routing::delete(workspace::delete_invite),
        )
        .route(
            "/api/workspaces/{id}/members/{user_id}",
            axum::routing::patch(workspace::set_member_role).delete(workspace::remove_member),
        )
        .route(
            "/api/workspaces/{id}/storage",
            get(workspace::list_storage_connections).post(workspace::create_storage_connection),
        )
        .route(
            "/api/workspaces/{id}/storage/{conn_id}",
            axum::routing::delete(workspace::delete_storage_connection),
        )
        .route(
            "/api/workspaces/{id}/storage/status",
            get(workspace::storage_status),
        )
        // Least-privilege IAM policy for a bucket/prefix, shown by the wizard BEFORE the
        // customer creates their access key (plan 1a task 5). No workspace membership
        // required — it's a pure function of the query, authenticated only.
        .route("/api/storage/s3/policy", get(workspace::s3_policy))
        // SharePoint (BYO storage phase 2): setup metadata for the wizard (any
        // authenticated user — shown BEFORE a workspace exists, like s3/policy) and the
        // ephemeral site-resolve + library list (admin; persists nothing).
        .route("/api/storage/sharepoint/setup", get(msgraph::setup))
        .route(
            "/api/workspaces/{id}/storage/sharepoint/libraries",
            post(msgraph::list_libraries_endpoint),
        )
        // Phase 5 enterprise: per-workspace IdP config + the admin audit trail.
        .route(
            "/api/workspaces/{id}/sso",
            axum::routing::put(workspace::set_workspace_sso)
                .delete(workspace::delete_workspace_sso),
        )
        .route(
            "/api/workspaces/{id}/audit",
            get(audit::list_workspace_audit),
        )
        // Google Drive connections are born from an OAuth dance, not a config POST
        // (ADR 0013: the user's own Drive bears the storage cost).
        .route(
            "/api/workspaces/{id}/storage/google/start",
            get(gdrive::start),
        )
        .route(
            "/auth/storage/google/callback",
            get(gdrive::callback).layer(auth_rl.clone()),
        )
        // Singular convenience routes: operate on the caller's primary (personal) workspace.
        .route(
            "/api/workspace",
            get(workspace::current_workspace).patch(workspace::rename_current_workspace),
        )
        .route(
            "/api/workspace/invites",
            post(workspace::invite_to_current_workspace),
        )
        .route("/api/cli/auth-config", get(auth::cli_auth_config))
        .route(
            "/api/cli/login",
            post(auth::cli_login).layer(auth_rl.clone()),
        )
        // Phase 3 AI-native (ADR 0008): the MCP façade — POST = one JSON-RPC request.
        .route("/mcp", post(mcp::handle).get(mcp::method_not_allowed))
        .layer(cors)
        .with_state(state);

    // Single-image deploy (ADR 0017): serve the built web app when MUESLI_WEB_DIR is set.
    // The SPA owns every path the API doesn't (hash routing → index.html fallback).
    if let Ok(dir) = std::env::var("MUESLI_WEB_DIR") {
        info!(%dir, "serving the web app");
        let index = std::path::Path::new(&dir).join("index.html");
        app = app.fallback_service(
            tower_http::services::ServeDir::new(&dir)
                .fallback(tower_http::services::ServeFile::new(index)),
        );
    }

    let addr: SocketAddr = std::env::var("MUESLI_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:8787".into())
        .parse()?;
    info!(%addr, "muesli-server listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    // Connect info feeds the per-IP auth rate limiter (finding 29).
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(doc_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    // The authorization seam (sync-protocol.md): resolve role BEFORE the upgrade;
    // unauthorized connections never reach a room.
    // Share tokens: prefer the X-Muesli-Share header (keeps the secret out of URLs and
    // access logs, finding 28); the query param remains as the backward-compatible
    // fallback (browser WebSocket clients cannot set handshake headers).
    let share_token = headers
        .get("x-muesli-share")
        .and_then(|v| v.to_str().ok())
        .or_else(|| params.get("share").map(String::as_str));
    match auth::resolve_access(&state, &doc_id, &jar, &headers, share_token).await {
        Ok(access) => ws
            .on_upgrade(move |socket| handle_socket(socket, doc_id, state, access))
            .into_response(),
        Err(status) => status.into_response(),
    }
}

/// Get-or-spawn the room for a slug. REST handlers use this too, so collaboration
/// endpoints hydrate a room exactly like the ws path even when nobody is connected.
pub fn ensure_room(state: &AppState, slug: &str) -> mpsc::UnboundedSender<RoomMsg> {
    ensure_room_in(
        &state.rooms,
        &state.persistence,
        state.storage.as_ref().map(|m| m.handle()),
        state.links.clone(),
        state.workspace_events.clone(),
        slug,
    )
}

/// The registry-level get-or-spawn; the storage manager calls this directly so its rooms
/// are indistinguishable from connection-spawned ones.
pub fn ensure_room_in(
    rooms: &Rooms,
    persistence: &Option<Arc<Persistence>>,
    storage: Option<StorageHandle>,
    links: Option<LinkHandle>,
    workspace_events: WorkspaceEvents,
    slug: &str,
) -> mpsc::UnboundedSender<RoomMsg> {
    let mut rooms = rooms.lock().unwrap();
    rooms
        .entry(slug.to_string())
        .or_insert_with(|| {
            spawn_room(
                slug.to_string(),
                persistence.clone(),
                storage,
                links,
                workspace_events,
            )
        })
        .clone()
}

async fn handle_socket(socket: WebSocket, doc_id: String, state: AppState, access: Access) {
    let room = ensure_room(&state, &doc_id);

    let conn = NEXT_CONN.fetch_add(1, Ordering::Relaxed);
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let join = RoomMsg::Join {
        conn,
        tx: out_tx,
        can_edit: access.role.can_edit(),
        author_id: access.user_id,
        author_is_agent: access.author_is_agent,
    };
    if room.send(join).is_err() {
        return;
    }

    let (mut sink, mut stream) = socket.split();

    let writer = tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            if sink.send(Message::Binary(frame.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Binary(data) => {
                if room
                    .send(RoomMsg::Inbound {
                        conn,
                        data: data.into(),
                    })
                    .is_err()
                {
                    break;
                }
            }
            Message::Close(_) => break,
            // Ping/Pong handled by the underlying websocket impl; text frames are not
            // part of the y-websocket protocol.
            _ => {}
        }
    }

    let _ = room.send(RoomMsg::Leave { conn });
    writer.abort();
}
