//! Notifications REST surface (sub-project ④c): the inbox (list / unread-count / mark-read /
//! read-all) and the per-user preference matrix (get / put). All auth-only and scoped to the
//! CALLING user — every query binds the authenticated user's id, so a caller can only ever
//! read or modify their OWN notifications and preferences. Guests get 401; agents get 403
//! (these are a human's personal inbox), mirroring the /api/me* posture via `account::session_ctx`.

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use serde_json::json;
use tracing::warn;
use uuid::Uuid;

use crate::account::session_ctx;
use crate::notifications::{
    channel_is_toggleable, resolve_channels, ALL_CHANNELS, CHANNEL_EMAIL, CHANNEL_IN_APP,
    EVENT_MENTION,
};
use crate::AppState;

/// The event types a user can hold preferences for. v1 = just the mention; adding a type here
/// (and a `default_enabled` arm) surfaces it in the settings matrix automatically.
const KNOWN_EVENT_TYPES: &[&str] = &[EVENT_MENTION];

/// Inbox page size (newest-first). Generous — the inbox is small in v1; pagination via
/// `before`. Crate-visible: the MCP notification tools page identically (mcp.rs).
pub(crate) const INBOX_LIMIT: i64 = 100;

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, msg.into()).into_response()
}

fn err500(e: anyhow::Error) -> Response {
    warn!(%e, "notifications api error");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

/// GET /api/notifications?unread=<bool>&before=<ts> — the caller's notifications, newest first.
pub async fn list_notifications(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let (p, user_id) = match session_ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let unread_only = params.get("unread").map(|v| v == "true").unwrap_or(false);
    let before = params.get("before").map(String::as_str);
    // Validate the client-supplied cursor up front so a malformed timestamp is a 400, not a
    // 500 from Postgres rejecting the `$3::timestamptz` cast mid-query. Validation uses the
    // SAME `::timestamptz` cast, so it accepts exactly what the listing query accepts.
    if let Some(raw) = before {
        match p.is_valid_timestamptz(raw).await {
            Ok(true) => {}
            Ok(false) => return err(StatusCode::BAD_REQUEST, "malformed before cursor"),
            Err(e) => return err500(e),
        }
    }
    match p.list_notifications(user_id, unread_only, before, INBOX_LIMIT).await {
        Ok(rows) => Json(json!({ "notifications": rows })).into_response(),
        Err(e) => err500(e),
    }
}

/// GET /api/notifications/unread-count — the badge count for the caller.
pub async fn unread_count(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let (p, user_id) = match session_ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    match p.unread_notification_count(user_id).await {
        Ok(count) => Json(json!({ "count": count })).into_response(),
        Err(e) => err500(e),
    }
}

/// POST /api/notifications/{id}/read — mark one read. 404 when the id isn't the caller's
/// (ownership enforced by the recipient-scoped update affecting zero rows).
pub async fn mark_read(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let (p, user_id) = match session_ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    match p.mark_notification_read(id, user_id).await {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => err(StatusCode::NOT_FOUND, "no such notification"),
        Err(e) => err500(e),
    }
}

/// POST /api/notifications/read-all — mark every unread notification read for the caller.
pub async fn read_all(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let (p, user_id) = match session_ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    match p.mark_all_notifications_read(user_id).await {
        Ok(n) => Json(json!({ "marked": n })).into_response(),
        Err(e) => err500(e),
    }
}

/// GET /api/notification-preferences — the full event-type × channel matrix for the caller,
/// resolved from stored rows over the coded defaults. Each entry carries `toggleable`; in v1
/// every channel (in-app and email) is toggleable, so the UI lets the user turn each off.
pub async fn get_preferences(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let (p, user_id) = match session_ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let stored = match p.list_notification_preferences(user_id).await {
        Ok(s) => s,
        Err(e) => return err500(e),
    };
    let mut out = Vec::new();
    for &event_type in KNOWN_EVENT_TYPES {
        // resolve_channels gives the *effective* enabled set (in-app always in it); for the UI
        // we report every known channel with its resolved enabled value + toggleability.
        let enabled = resolve_channels(event_type, &stored);
        for &channel in ALL_CHANNELS {
            out.push(json!({
                "event_type": event_type,
                "channel": channel,
                "enabled": enabled.iter().any(|c| c == channel),
                "toggleable": channel_is_toggleable(channel),
            }));
        }
    }
    Json(json!({ "preferences": out })).into_response()
}

#[derive(Deserialize)]
pub struct PutPreferenceReq {
    event_type: String,
    channel: String,
    enabled: bool,
}

/// PUT /api/notification-preferences — upsert one toggle for the caller. Rejects unknown event
/// types/channels. Both in-app and email are toggleable, so either can be turned off here
/// (disabling both for an event mutes it entirely).
pub async fn put_preference(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<PutPreferenceReq>,
) -> Response {
    let (p, user_id) = match session_ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if !KNOWN_EVENT_TYPES.contains(&req.event_type.as_str()) {
        return err(StatusCode::BAD_REQUEST, "unknown event type");
    }
    if req.channel != CHANNEL_EMAIL && req.channel != CHANNEL_IN_APP {
        return err(StatusCode::BAD_REQUEST, "unknown channel");
    }
    match p
        .set_notification_preference(user_id, &req.event_type, &req.channel, req.enabled)
        .await
    {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => err500(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notifications::default_enabled;

    // The handler builds the settings matrix from resolve_channels; this proves the matrix it
    // emits for a fresh user (no stored prefs) is in-app=on + email=on, both now toggleable.
    #[test]
    fn default_matrix_for_mention_is_in_app_on_email_on_both_toggleable() {
        let enabled = resolve_channels(EVENT_MENTION, &[]);
        // in-app defaults on and is now toggleable (the UI unlocks it).
        assert!(enabled.iter().any(|c| c == CHANNEL_IN_APP));
        assert!(channel_is_toggleable(CHANNEL_IN_APP));
        assert!(default_enabled(EVENT_MENTION, CHANNEL_IN_APP));
        // email defaults on, toggleable
        assert!(enabled.iter().any(|c| c == CHANNEL_EMAIL));
        assert!(channel_is_toggleable(CHANNEL_EMAIL));
        assert!(default_enabled(EVENT_MENTION, CHANNEL_EMAIL));
    }
}
