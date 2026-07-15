//! Account-level settings endpoints (internal/design/settings.md): the caller's own profile
//! overrides (PATCH /api/me), their delegated API keys (GET/POST /api/me/tokens,
//! DELETE /api/me/tokens/{id}), and the unauthenticated /api/meta version probe.
//!
//! Everything user-scoped here is **session-only**: agent principals (Bearer api_tokens)
//! are rejected with 403 — an agent must not edit its owner's profile or mint/revoke
//! keys on their behalf. Profile edits land in the override columns of migration 0010,
//! never the OIDC claim columns (which upsert_oidc_user coalesce-refreshes every login).
//! Key minting reuses the cli_login plumbing: an agent users row per key, `mua_` +
//! random secret, SHA-256 hash at rest, the raw secret shown exactly once.
//!
//! `caller_ctx`/`caller_ctx_write` below are the more permissive siblings of
//! `session_ctx`: they accept the desktop app's own device-login Bearer token too
//! (scoped to the human it delegates for), for endpoints that are personal but not
//! account-mutation — e.g. the notifications inbox, which the desktop app can only
//! ever reach over Bearer (its token lives in the OS Keychain, never a browser
//! session cookie). They still reject an ordinary delegated key (POST
//! /api/me/tokens), any restricted token, and — for the write variant — a read-only
//! scoped token; see `authorize_notifications`'s doc comment for the exact invariant.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde::{Deserialize, Deserializer};
use serde_json::json;
use tracing::{info, warn};
use uuid::Uuid;

use crate::audit::{self, AuditEvent};
use crate::auth::{hash_token, random_token, Principal};
use crate::persistence::Persistence;
use crate::AppState;

const OPEN_MODE: &str =
    "this endpoint requires identity (OIDC_ISSUER) — the server is running in open mode";
const NO_DB: &str = "this endpoint requires DATABASE_URL (server is running volatile)";
const AGENTS_REJECTED: &str =
    "API tokens cannot manage account settings — sign in with a browser session";

/// Display-name override ceiling (PATCH /api/me).
const MAX_DISPLAY_NAME_CHARS: usize = 120;
/// Avatar data-URL ceiling: a 128px WebP is typically 3–8 KB; 64 KB is generous.
const MAX_AVATAR_DATA_URL_BYTES: usize = 64 * 1024;
/// API-key label ceiling (it becomes the agent user's display_name).
const MAX_LABEL_CHARS: usize = 120;
/// Expiry ceiling for minted keys: ~10 years; "no expiry" is null, not a big number.
const MAX_EXPIRY_DAYS: i64 = 3650;

/// Storage quota for the meter (settings.md About section). PLACEHOLDER: there is no
/// per-workspace quota concept yet (workspaces.plan exists but nothing reads it for a
/// byte ceiling), so the meter shows usage against a fixed 2 GiB so the bar is meaningful.
/// Swap this for a plan-derived quota once billing lands.
const STORAGE_QUOTA_BYTES: i64 = 2 * 1024 * 1024 * 1024;

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, msg.into()).into_response()
}

fn err500(e: anyhow::Error) -> Response {
    warn!(%e, "account api error");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

/// The session-only seam shared by every /api/me* mutation: auth mode + DB + an
/// authenticated NON-agent principal. Returns (persistence, the human user id).
/// Profile edits and key minting/revocation stay behind this — a delegated token
/// must never touch its own owner's account settings.
pub(crate) async fn session_ctx(
    state: &AppState,
    jar: &CookieJar,
    headers: &axum::http::HeaderMap,
) -> Result<(Arc<Persistence>, Uuid), Response> {
    let Some(auth) = state.auth.clone() else {
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, OPEN_MODE));
    };
    let Some(persistence) = state.persistence.clone() else {
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, NO_DB));
    };
    let Some(principal) = auth.authenticate(jar, headers).await else {
        return Err(err(StatusCode::UNAUTHORIZED, "sign in"));
    };
    let Principal {
        is_agent: false,
        role_user,
        ..
    } = principal
    else {
        return Err(err(StatusCode::FORBIDDEN, AGENTS_REJECTED));
    };
    Ok((persistence, role_user))
}

/// Auth mode + DB + a principal that is allowed onto the notifications personal-data
/// endpoints (list/unread-count/preferences — read access), scoped to `role_user` — the
/// human behind the request even when a Bearer token's `author` is a separate agent
/// identity. Crate-visible so notifications_api.rs's read handlers use it. See
/// `authorize_notifications` for the exact invariant enforced (restriction rejection,
/// delegated-key rejection); this entry point requires only read access. Mutating
/// handlers must use [`caller_ctx_write`] instead.
pub(crate) async fn caller_ctx(
    state: &AppState,
    jar: &CookieJar,
    headers: &axum::http::HeaderMap,
) -> Result<(Arc<Persistence>, Uuid), Response> {
    caller_ctx_impl(state, jar, headers, false).await
}

/// Like [`caller_ctx`], but for the notifications endpoints that MUTATE state
/// (mark-read, read-all, put-preference): additionally rejects a principal whose
/// `role_cap` is read-only. See `authorize_notifications`.
pub(crate) async fn caller_ctx_write(
    state: &AppState,
    jar: &CookieJar,
    headers: &axum::http::HeaderMap,
) -> Result<(Arc<Persistence>, Uuid), Response> {
    caller_ctx_impl(state, jar, headers, true).await
}

async fn caller_ctx_impl(
    state: &AppState,
    jar: &CookieJar,
    headers: &axum::http::HeaderMap,
    require_write: bool,
) -> Result<(Arc<Persistence>, Uuid), Response> {
    let Some(auth) = state.auth.clone() else {
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, OPEN_MODE));
    };
    let Some(persistence) = state.persistence.clone() else {
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, NO_DB));
    };
    let principal = auth.authenticate(jar, headers).await;
    let user_id = authorize_notifications(principal.as_ref(), require_write)
        .map_err(|(status, msg)| err(status, msg))?;
    Ok((persistence, user_id))
}

/// The authorization decision behind [`caller_ctx`]/[`caller_ctx_write`] — pulled out
/// pure (no DB, no HTTP extraction, `principal: Option<&Principal>` mirroring exactly
/// what `AuthCtx::authenticate` returns) so the WHOLE boundary, guest case included, is
/// unit-tested directly without a database or OIDC provider. Invariant enforced,
/// mirroring `resolve_access`'s posture (auth.rs) but adapted for an endpoint family
/// that is personal rather than document-scoped:
///
///   - no principal at all (guest) is 401 — same as every other authenticated endpoint.
///   - a restricted token (`document_restriction`/`workspace_restriction` set) is
///     refused outright. Those restrictions exist to narrow a token to one document;
///     the inbox has no document to check the restriction against, so — unlike
///     `resolve_access`, which can compare the restriction to the document being
///     opened — there is no way to honor the restriction here except by refusing the
///     whole endpoint family (the `Some(doc)` branch of `resolve_access`, where it
///     computes `restricted` before consulting `user_role`, is the load-bearing
///     precedent this mirrors).
///   - an agent (Bearer-token) principal is admitted ONLY when its token is the
///     caller's own device-login token (`TokenKind::Device`, minted by cli_login — the
///     desktop app's only transport to this server). An ordinary delegated key minted
///     via POST /api/me/tokens is refused: admitting it would let any third-party agent
///     holding such a key read the owner's mention inbox and rewrite their preferences
///     over REST, defeating mcp.rs's `inbox_user` wall, which deliberately holds an
///     MCP-connected agent to its OWN identity's inbox rather than its owner's.
///   - when `require_write` is set (mark-read, read-all, put-preference), a principal
///     whose `role_cap` is `Viewer` — i.e. a token minted with the read-only scope
///     preset — is refused: it may read the inbox but not mutate it, the same
///     scope-ceiling `resolve_access` enforces via `r.min(p.role_cap)`.
///
/// A browser session always passes every check (`is_agent` false, no restriction,
/// `role_cap` is always `Editor`).
pub(crate) fn authorize_notifications(
    principal: Option<&Principal>,
    require_write: bool,
) -> Result<Uuid, (StatusCode, &'static str)> {
    let Some(principal) = principal else {
        return Err((StatusCode::UNAUTHORIZED, "sign in"));
    };
    if principal.document_restriction.is_some() || principal.workspace_restriction.is_some() {
        return Err((
            StatusCode::FORBIDDEN,
            "a restricted API token cannot reach the notifications inbox",
        ));
    }
    if principal.is_agent && principal.token_kind != Some(crate::auth::TokenKind::Device) {
        return Err((
            StatusCode::FORBIDDEN,
            "delegated API keys cannot reach the notifications inbox — sign in with a \
             browser session or the desktop app",
        ));
    }
    if require_write && principal.role_cap == crate::auth::Role::Viewer {
        return Err((
            StatusCode::FORBIDDEN,
            "a read-only token cannot modify notifications",
        ));
    }
    Ok(principal.role_user)
}

// ---------------------------------------------------------------------------
// Pure validation helpers (unit-tested below)
// ---------------------------------------------------------------------------

/// Normalize a display-name override: absent → unchanged is the caller's business;
/// here Some(value) is trimmed, an empty result clears the override (= None), and
/// anything over the ceiling is rejected.
pub(crate) fn normalize_display_name(value: Option<&str>) -> Result<Option<String>, &'static str> {
    match value {
        None => Ok(None),
        Some(v) => {
            let v = v.trim();
            if v.is_empty() {
                return Ok(None);
            }
            if v.chars().count() > MAX_DISPLAY_NAME_CHARS {
                return Err("display_name must be at most 120 characters");
            }
            Ok(Some(v.to_string()))
        }
    }
}

/// Validate an avatar override: a base64 data URL of an image type every browser
/// renders (webp/png/jpeg), at most 64 KB total. The server never decodes the image —
/// the value is only ever used as an <img src>.
pub(crate) fn validate_avatar_data_url(value: &str) -> Result<(), &'static str> {
    const PREFIXES: [&str; 3] = [
        "data:image/webp;base64,",
        "data:image/png;base64,",
        "data:image/jpeg;base64,",
    ];
    if !PREFIXES.iter().any(|p| value.starts_with(p)) {
        return Err("avatar_url must be a data:image/webp|png|jpeg;base64, URL");
    }
    if value.len() > MAX_AVATAR_DATA_URL_BYTES {
        return Err("avatar_url must be at most 64 KB — resize to 128px before uploading");
    }
    Ok(())
}

/// The two v1 scope presets (settings.md §2.2): read-only and read+write. Order is
/// forgiven, anything else (extra scopes, duplicates, unknown scopes) is rejected.
pub(crate) fn scope_preset(scopes: &[String]) -> Option<&'static [&'static str]> {
    let mut sorted: Vec<&str> = scopes.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    match sorted.as_slice() {
        ["read"] => Some(&["read"]),
        ["read", "write"] => Some(&["read", "write"]),
        _ => None,
    }
}

/// Expiry in days: null = never, otherwise a positive number of days within reason.
pub(crate) fn validate_expiry_days(days: Option<i64>) -> Result<Option<i64>, &'static str> {
    match days {
        None => Ok(None),
        Some(d) if (1..=MAX_EXPIRY_DAYS).contains(&d) => Ok(Some(d)),
        Some(_) => Err("expires_in_days must be between 1 and 3650 (or null for no expiry)"),
    }
}

/// Mint-key label: trimmed, required, bounded (it becomes the agent's display_name).
pub(crate) fn normalize_label(label: &str) -> Result<String, &'static str> {
    let label = label.trim();
    if label.is_empty() {
        return Err("label is required");
    }
    if label.chars().count() > MAX_LABEL_CHARS {
        return Err("label must be at most 120 characters");
    }
    Ok(label.to_string())
}

/// True when the body is EXACTLY the onboarding stamp — the only PATCH /api/me
/// shape agent principals may send (the desktop app's Keychain bearer token is a
/// delegated agent token; the stamp applies to its role_user, the same human
/// GET /api/me reports). Everything else stays the 403 profile-edit rejection.
pub(crate) fn onboard_only(req: &UpdateMeReq) -> bool {
    // Exhaustive destructure (no `..`): adding a field to UpdateMeReq must
    // fail compilation here so the agent gate is consciously re-decided.
    let UpdateMeReq {
        display_name,
        avatar_url,
        onboarded,
    } = req;
    display_name.is_none() && avatar_url.is_none() && *onboarded == Some(true)
}

/// The onboarded field's contract (spec §1): only `true` is accepted — false is
/// a 400, un-onboarding is not a feature. Absent = untouched.
pub(crate) fn validate_onboarded(v: Option<bool>) -> Result<(), &'static str> {
    match v {
        Some(false) => Err("onboarded can only be set to true — un-onboarding is not a feature"),
        _ => Ok(()),
    }
}

/// serde helper distinguishing an ABSENT field (outer None — leave unchanged) from an
/// explicit null (Some(None) — clear the override). Use with #[serde(default)].
fn double_option<'de, T, D>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(de).map(Some)
}

// ---------------------------------------------------------------------------
// PATCH /api/me — profile overrides
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct UpdateMeReq {
    /// Absent = unchanged; null = clear the override (fall back to the IdP claim).
    #[serde(default, deserialize_with = "double_option")]
    display_name: Option<Option<String>>,
    /// Absent = unchanged; null = clear; otherwise a ≤64 KB image data URL.
    #[serde(default, deserialize_with = "double_option")]
    avatar_url: Option<Option<String>>,
    /// First-login onboarding stamp (spec 2026-07-02 §1): true stamps
    /// users.onboarded_at idempotently; false is rejected with 400 —
    /// un-onboarding is not a feature. Absent = untouched.
    onboarded: Option<bool>,
}

/// PATCH /api/me {display_name?, avatar_url?, onboarded?} — set/clear the caller's
/// profile override columns (migration 0010) and/or stamp first-login onboarding
/// (migration 0016). Overrides NEVER touch the claim columns the OIDC upsert
/// refreshes. Sessions may patch everything; AGENT principals may send exactly
/// {onboarded: true} (see onboard_only) and stay 403 for every profile field.
/// Returns the updated user as GET /api/me would.
pub async fn update_me(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<UpdateMeReq>,
) -> Response {
    let Some(auth) = state.auth.clone() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, OPEN_MODE);
    };
    let Some(p) = state.persistence.clone() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, NO_DB);
    };
    let Some(principal) = auth.authenticate(&jar, &headers).await else {
        return err(StatusCode::UNAUTHORIZED, "sign in");
    };
    if principal.is_agent && !onboard_only(&req) {
        return err(StatusCode::FORBIDDEN, AGENTS_REJECTED);
    }
    let user_id = principal.role_user;

    if req.display_name.is_none() && req.avatar_url.is_none() && req.onboarded.is_none() {
        return err(
            StatusCode::BAD_REQUEST,
            "pass display_name, avatar_url and/or onboarded",
        );
    }

    // Validate the profile fields BEFORE stamping anything, so a rejected body
    // has no side effects.
    let set_display = req.display_name.is_some();
    let display_name = match &req.display_name {
        None | Some(None) => None,
        Some(Some(v)) => match normalize_display_name(Some(v)) {
            Ok(n) => n,
            Err(msg) => return err(StatusCode::BAD_REQUEST, msg),
        },
    };
    let set_avatar = req.avatar_url.is_some();
    let avatar_url = match &req.avatar_url {
        None | Some(None) => None,
        Some(Some(v)) => {
            if let Err(msg) = validate_avatar_data_url(v) {
                return err(StatusCode::BAD_REQUEST, msg);
            }
            Some(v.as_str())
        }
    };

    // Onboarding stamp (spec 2026-07-02 §1): idempotent — the first stamp wins
    // (set_user_onboarded coalesces); false is a 400, un-onboarding is not a feature.
    if let Err(msg) = validate_onboarded(req.onboarded) {
        return err(StatusCode::BAD_REQUEST, msg);
    }
    if req.onboarded == Some(true) {
        match p.set_user_onboarded(user_id).await {
            Ok(true) => {}
            Ok(false) => return err(StatusCode::NOT_FOUND, "no such user"),
            Err(e) => return err500(e),
        }
    }

    if set_display || set_avatar {
        match p
            .update_user_overrides(
                user_id,
                set_display,
                display_name.as_deref(),
                set_avatar,
                avatar_url,
            )
            .await
        {
            Ok(true) => {}
            Ok(false) => return err(StatusCode::NOT_FOUND, "no such user"),
            Err(e) => return err500(e),
        }

        // Audited against the user's primary workspace when one exists (None
        // otherwise, same convention login uses). Avatar bytes stay out of the
        // log — only which fields changed. The onboarding stamp is deliberately
        // NOT audited: it is a courtesy-flow flag, not a profile edit.
        let workspace = p.primary_workspace_of(user_id).await.ok().flatten();
        audit::record(
            &p,
            AuditEvent::new("profile_updated")
                .workspace(workspace)
                .actor(Some(user_id))
                .detail(json!({
                    "display_name": req.display_name.as_ref().map(|v| match v {
                        Some(_) => "set",
                        None => "cleared",
                    }),
                    "avatar": req.avatar_url.as_ref().map(|v| match v {
                        Some(_) => "set",
                        None => "cleared",
                    }),
                })),
        );
    }

    match p.get_user(user_id).await {
        Ok(Some(user)) => Json(user).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "no such user"),
        Err(e) => err500(e),
    }
}

// ---------------------------------------------------------------------------
// /api/me/tokens — the GitHub-PAT-style key list (settings.md §2.2)
// ---------------------------------------------------------------------------

/// GET /api/me/tokens → { tokens: [{id, label, scopes, created_at, expires_at}] } —
/// the caller's unrevoked delegated keys. Hashes never appear; neither does the secret.
pub async fn list_tokens(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let (p, user_id) = match session_ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    match p.list_owned_api_tokens(user_id).await {
        Ok(tokens) => Json(json!({
            "tokens": tokens.iter().map(|t| json!({
                "id": t.id,
                "label": t.label,
                "scopes": t.scopes,
                "created_at": t.created_at,
                "expires_at": t.expires_at,
            })).collect::<Vec<_>>()
        }))
        .into_response(),
        Err(e) => err500(e),
    }
}

#[derive(Deserialize)]
pub struct MintTokenReq {
    label: String,
    /// Exactly ["read"] or ["read","write"] (the v1 presets; order forgiven).
    scopes: Vec<String>,
    /// Days until expiry; absent/null = never expires.
    expires_in_days: Option<i64>,
}

/// POST /api/me/tokens {label, scopes, expires_in_days?} — mint a delegated agent key:
/// a fresh agent identity (users.kind='agent', display_name = label) plus a `mua_`
/// secret whose SHA-256 is stored. The response is the ONLY place the raw secret ever
/// appears. Reuses the cli_login plumbing end to end.
pub async fn mint_token(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<MintTokenReq>,
) -> Response {
    let (p, user_id) = match session_ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let label = match normalize_label(&req.label) {
        Ok(l) => l,
        Err(msg) => return err(StatusCode::BAD_REQUEST, msg),
    };
    let Some(scopes) = scope_preset(&req.scopes) else {
        return err(
            StatusCode::BAD_REQUEST,
            r#"scopes must be ["read"] or ["read","write"]"#,
        );
    };
    let expires_in_days = match validate_expiry_days(req.expires_in_days) {
        Ok(d) => d,
        Err(msg) => return err(StatusCode::BAD_REQUEST, msg),
    };

    let result: anyhow::Result<Response> = async {
        let agent_id = p.create_agent_user(&label).await?;
        let secret = format!("mua_{}", random_token());
        // kind = "delegated": this is exactly the third-party-key case (settings.md §2.2)
        // the notifications REST surface must NOT admit — see TokenKind's doc comment.
        let (token_id, expires_at) = p
            .insert_api_token(
                &hash_token(&secret),
                agent_id,
                Some(user_id),
                scopes,
                expires_in_days,
                crate::auth::TokenKind::Delegated.as_db(),
            )
            .await?;
        info!(%user_id, %agent_id, %token_id, label, "minted delegated agent token (settings)");
        // Primary workspace when one exists; None otherwise (BYO storage: nothing may
        // auto-create workspaces anymore).
        let workspace = p.primary_workspace_of(user_id).await.ok().flatten();
        audit::record(
            &p,
            AuditEvent::new("agent_token_minted")
                .workspace(workspace)
                .actor(Some(user_id))
                .detail(json!({
                    "agent_id": agent_id,
                    "token_id": token_id,
                    "label": label,
                    "scopes": scopes,
                    "expires_at": expires_at,
                })),
        );
        Ok(Json(json!({
            "token": secret,
            "id": token_id,
            "label": label,
            "scopes": scopes,
            "expires_at": expires_at,
        }))
        .into_response())
    }
    .await;
    result.unwrap_or_else(err500)
}

/// DELETE /api/me/tokens/{id} — revoke (sets revoked_at; lookup_api_token filters it out
/// immediately). Owner-scoped: someone else's token id answers 404, not 403.
pub async fn revoke_token(
    State(state): State<AppState>,
    Path(token_id): Path<Uuid>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let (p, user_id) = match session_ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    match p.revoke_api_token(token_id, user_id).await {
        Ok(true) => {
            // Primary workspace when one exists; None otherwise (BYO storage: nothing may
            // auto-create workspaces anymore).
            let workspace = p.primary_workspace_of(user_id).await.ok().flatten();
            audit::record(
                &p,
                AuditEvent::new("agent_token_revoked")
                    .workspace(workspace)
                    .actor(Some(user_id))
                    .detail(json!({ "token_id": token_id })),
            );
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(false) => err(StatusCode::NOT_FOUND, "no such API key"),
        Err(e) => err500(e),
    }
}

// ---------------------------------------------------------------------------
// GET /api/meta — the About probe
// ---------------------------------------------------------------------------

/// GET /api/meta → { version, commit?, mode } — unauthenticated, no secrets: the
/// version is public by definition (it ships in the binary name), the mode is already
/// exposed by GET /api/me. `commit` is set when the binary was built with
/// MUESLI_COMMIT in the build environment (the release pipeline), null in dev.
pub async fn meta(State(state): State<AppState>) -> Response {
    Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "commit": option_env!("MUESLI_COMMIT"),
        "mode": if state.auth.is_some() { "oidc" } else { "open" },
    }))
    .into_response()
}

// ---------------------------------------------------------------------------
// GET /api/me/storage — the Drive-style usage meter (settings.md About)
// ---------------------------------------------------------------------------

/// GET /api/me/storage → { used_bytes, quota_bytes } — total bytes the caller's documents
/// occupy (the CRDT update log + snapshots, summed across everything they can open) against
/// a placeholder quota. Session only; agents are rejected, matching the rest of /api/me*.
/// `quota_bytes` is a fixed constant until a real plan-derived quota exists.
pub async fn storage_usage(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let (p, user_id) = match session_ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    match p.storage_used_bytes(Some(user_id)).await {
        Ok(used_bytes) => Json(json!({
            "used_bytes": used_bytes,
            "quota_bytes": STORAGE_QUOTA_BYTES,
        }))
        .into_response(),
        Err(e) => err500(e),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_name_normalization() {
        assert_eq!(normalize_display_name(None), Ok(None));
        assert_eq!(
            normalize_display_name(Some("  Ada  ")),
            Ok(Some("Ada".into()))
        );
        // whitespace-only clears the override rather than storing emptiness
        assert_eq!(normalize_display_name(Some("   ")), Ok(None));
        assert_eq!(normalize_display_name(Some("")), Ok(None));
        // the ceiling counts characters, not bytes
        let max = "ä".repeat(120);
        assert_eq!(normalize_display_name(Some(&max)), Ok(Some(max.clone())));
        assert!(normalize_display_name(Some(&"ä".repeat(121))).is_err());
    }

    #[test]
    fn avatar_data_url_validation() {
        for mime in ["webp", "png", "jpeg"] {
            assert_eq!(
                validate_avatar_data_url(&format!("data:image/{mime};base64,AAAA")),
                Ok(())
            );
        }
        // wrong/missing prefixes
        assert!(validate_avatar_data_url("https://cdn.example/me.png").is_err());
        assert!(validate_avatar_data_url("data:image/gif;base64,AAAA").is_err());
        assert!(
            validate_avatar_data_url("data:image/svg+xml;base64,AAAA").is_err(),
            "svg can script"
        );
        assert!(
            validate_avatar_data_url("data:image/png,AAAA").is_err(),
            "must be base64"
        );
        assert!(validate_avatar_data_url("").is_err());
        // the 64 KB ceiling is on the WHOLE data URL
        let just_fits = format!("data:image/webp;base64,{}", "A".repeat(64 * 1024 - 23));
        assert_eq!(just_fits.len(), 64 * 1024);
        assert_eq!(validate_avatar_data_url(&just_fits), Ok(()));
        assert!(validate_avatar_data_url(&format!("{just_fits}A")).is_err());
    }

    #[test]
    fn scope_presets_only() {
        let s = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(scope_preset(&s(&["read"])), Some(&["read"][..]));
        assert_eq!(
            scope_preset(&s(&["read", "write"])),
            Some(&["read", "write"][..])
        );
        // order is forgiven; everything else is not
        assert_eq!(
            scope_preset(&s(&["write", "read"])),
            Some(&["read", "write"][..])
        );
        assert_eq!(scope_preset(&s(&[])), None);
        assert_eq!(
            scope_preset(&s(&["write"])),
            None,
            "write-only is not a preset"
        );
        assert_eq!(scope_preset(&s(&["admin"])), None);
        assert_eq!(scope_preset(&s(&["read", "admin"])), None);
        assert_eq!(
            scope_preset(&s(&["read", "read"])),
            None,
            "duplicates rejected"
        );
        assert_eq!(scope_preset(&s(&["read", "write", "comment"])), None);
    }

    #[test]
    fn expiry_day_bounds() {
        assert_eq!(validate_expiry_days(None), Ok(None));
        assert_eq!(validate_expiry_days(Some(1)), Ok(Some(1)));
        assert_eq!(validate_expiry_days(Some(30)), Ok(Some(30)));
        assert_eq!(validate_expiry_days(Some(365)), Ok(Some(365)));
        assert_eq!(validate_expiry_days(Some(3650)), Ok(Some(3650)));
        assert!(validate_expiry_days(Some(0)).is_err());
        assert!(validate_expiry_days(Some(-7)).is_err());
        assert!(validate_expiry_days(Some(3651)).is_err());
    }

    #[test]
    fn label_normalization() {
        assert_eq!(normalize_label("  my agent  "), Ok("my agent".into()));
        assert!(normalize_label("").is_err());
        assert!(normalize_label("   ").is_err());
        assert!(normalize_label(&"x".repeat(121)).is_err());
    }

    /// The PATCH body must distinguish "field absent" (unchanged) from "field: null"
    /// (clear the override) — the double_option deserializer is what makes that work.
    #[test]
    fn patch_body_absent_vs_null_vs_value() {
        let parse = |s: &str| serde_json::from_str::<UpdateMeReq>(s).unwrap();
        let absent = parse("{}");
        assert_eq!(absent.display_name, None);
        assert_eq!(absent.avatar_url, None);

        let cleared = parse(r#"{"display_name": null}"#);
        assert_eq!(cleared.display_name, Some(None));
        assert_eq!(cleared.avatar_url, None);

        let set = parse(r#"{"display_name": "Ada", "avatar_url": null}"#);
        assert_eq!(set.display_name, Some(Some("Ada".into())));
        assert_eq!(set.avatar_url, Some(None));
    }

    /// The onboarding stamp field (spec 2026-07-02 §1): absent = untouched,
    /// true = stamp, false = the 400 the handler enforces. Coexists with the
    /// double_option profile fields in one body.
    #[test]
    fn patch_body_parses_the_onboarded_stamp() {
        let parse = |s: &str| serde_json::from_str::<UpdateMeReq>(s).unwrap();
        assert_eq!(parse("{}").onboarded, None);
        assert_eq!(parse(r#"{"onboarded": true}"#).onboarded, Some(true));
        assert_eq!(parse(r#"{"onboarded": false}"#).onboarded, Some(false));
        let both = parse(r#"{"display_name": "Ada", "onboarded": true}"#);
        assert_eq!(both.display_name, Some(Some("Ada".into())));
        assert_eq!(both.onboarded, Some(true));
    }

    /// Agent principals (the desktop's delegated bearer token) may send EXACTLY
    /// {"onboarded": true} — anything else stays the 403 profile-edit rejection.
    /// Note an explicit `"avatar_url": null` counts as a profile edit (it clears
    /// the override), so it is NOT stamp-only.
    #[test]
    fn onboard_only_is_exactly_the_stamp_body() {
        let parse = |s: &str| serde_json::from_str::<UpdateMeReq>(s).unwrap();
        assert!(onboard_only(&parse(r#"{"onboarded": true}"#)));
        assert!(!onboard_only(&parse(r#"{"onboarded": false}"#)));
        assert!(!onboard_only(&parse("{}")));
        assert!(!onboard_only(&parse(
            r#"{"onboarded": true, "display_name": "Ada"}"#
        )));
        assert!(!onboard_only(&parse(
            r#"{"onboarded": true, "avatar_url": null}"#
        )));
    }

    /// Spec §1: onboarded:false is a 400 — un-onboarding is not a feature.
    /// True and absent pass through.
    #[test]
    fn onboarded_false_is_rejected() {
        assert_eq!(validate_onboarded(None), Ok(()));
        assert_eq!(validate_onboarded(Some(true)), Ok(()));
        let err = validate_onboarded(Some(false)).unwrap_err();
        assert!(err.contains("only be set to true"), "{err}");
    }

    // -----------------------------------------------------------------------
    // authorize_notifications — the notifications inbox/preferences boundary.
    // -----------------------------------------------------------------------

    use crate::auth::{Role, TokenKind};

    fn session_principal() -> Principal {
        Principal {
            role_user: Uuid::nil(),
            author: Uuid::nil(),
            role_cap: Role::Editor,
            document_restriction: None,
            workspace_restriction: None,
            is_agent: false,
            token_kind: None,
        }
    }

    fn token_principal(kind: TokenKind, role_cap: Role) -> Principal {
        Principal {
            role_user: Uuid::nil(),
            author: Uuid::nil(),
            role_cap,
            document_restriction: None,
            workspace_restriction: None,
            is_agent: true,
            token_kind: Some(kind),
        }
    }

    /// A guest (no principal at all) is 401 for both the read and write variants —
    /// the notifications endpoints require identity like everything else in this file.
    #[test]
    fn anonymous_is_rejected_with_401() {
        assert_eq!(
            authorize_notifications(None, false).unwrap_err().0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            authorize_notifications(None, true).unwrap_err().0,
            StatusCode::UNAUTHORIZED
        );
    }

    /// A browser session passes every check, read or write, regardless of role_cap
    /// (sessions are always Editor — see `AuthCtx::authenticate`).
    #[test]
    fn session_is_accepted_for_read_and_write() {
        let p = session_principal();
        assert!(authorize_notifications(Some(&p), false).is_ok());
        assert!(authorize_notifications(Some(&p), true).is_ok());
    }

    /// The desktop's own device-login token (cli_login, TokenKind::Device) with full
    /// read+write scope is accepted for both read and write — this is the exact case
    /// the original fix exists for.
    #[test]
    fn device_token_with_write_scope_is_accepted_for_read_and_write() {
        let p = token_principal(TokenKind::Device, Role::Editor);
        assert!(authorize_notifications(Some(&p), false).is_ok());
        assert!(authorize_notifications(Some(&p), true).is_ok());
    }

    /// A read-scoped device token (role_cap Viewer, from the ["read"] scope preset) may
    /// GET the inbox/preferences but may NOT mutate them — the scope ceiling
    /// `resolve_access` enforces via `r.min(p.role_cap)`, mirrored here.
    #[test]
    fn read_scoped_device_token_can_read_but_not_write() {
        let p = token_principal(TokenKind::Device, Role::Viewer);
        assert!(authorize_notifications(Some(&p), false).is_ok());
        let err = authorize_notifications(Some(&p), true).unwrap_err();
        assert_eq!(err.0, StatusCode::FORBIDDEN);
        assert!(err.1.contains("read-only"), "{}", err.1);
    }

    /// An ordinary delegated key (POST /api/me/tokens) is rejected outright — for read
    /// AND write — even with full read+write scope. This is the hole finding #2 closes:
    /// a third-party agent holding such a key must not reach the owner's inbox over
    /// REST, matching mcp.rs's `inbox_user` wall.
    #[test]
    fn delegated_token_is_rejected_even_with_write_scope() {
        let p = token_principal(TokenKind::Delegated, Role::Editor);
        let read_err = authorize_notifications(Some(&p), false).unwrap_err();
        assert_eq!(read_err.0, StatusCode::FORBIDDEN);
        let write_err = authorize_notifications(Some(&p), true).unwrap_err();
        assert_eq!(write_err.0, StatusCode::FORBIDDEN);
    }

    /// A restricted token (narrowed to one document or workspace) is rejected outright,
    /// even a device token with full scope — the inbox has no single document to check
    /// the restriction against, so it is refused entirely rather than silently ignored.
    #[test]
    fn restricted_token_is_rejected_even_when_otherwise_eligible() {
        let mut doc_restricted = token_principal(TokenKind::Device, Role::Editor);
        doc_restricted.document_restriction = Some(Uuid::nil());
        assert_eq!(
            authorize_notifications(Some(&doc_restricted), false)
                .unwrap_err()
                .0,
            StatusCode::FORBIDDEN
        );

        let mut ws_restricted = token_principal(TokenKind::Device, Role::Editor);
        ws_restricted.workspace_restriction = Some(Uuid::nil());
        assert_eq!(
            authorize_notifications(Some(&ws_restricted), false)
                .unwrap_err()
                .0,
            StatusCode::FORBIDDEN
        );

        // A restricted SESSION principal cannot occur in practice (sessions never carry
        // a restriction), but the check is unconditional — proven here for completeness.
        let mut restricted_session = session_principal();
        restricted_session.document_restriction = Some(Uuid::nil());
        assert_eq!(
            authorize_notifications(Some(&restricted_session), true)
                .unwrap_err()
                .0,
            StatusCode::FORBIDDEN
        );
    }

    /// authorize_notifications returns the ROLE_USER (the human whose inbox this is),
    /// not the author — the same distinction Principal documents for delegated tokens.
    #[test]
    fn ok_result_carries_role_user() {
        let mut p = token_principal(TokenKind::Device, Role::Editor);
        let human = Uuid::now_v7();
        let agent = Uuid::now_v7();
        p.role_user = human;
        p.author = agent;
        assert_eq!(authorize_notifications(Some(&p), false), Ok(human));
    }
}
