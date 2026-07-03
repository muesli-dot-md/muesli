//! Workspace audit log (Phase 5 enterprise; migration 0007).
//!
//! Security-relevant events (logins, sharing, membership changes, SSO config, agent
//! actions) land in the append-only `audit_log` table. Writes are **fire-and-forget**:
//! [`record`] spawns the insert and returns immediately — the audit trail must NEVER
//! block or fail the action it describes. A failed insert drops the entry with a loud
//! warning (ADR 0021: surface, never silently resolve).
//!
//! Reads are the admin-only `GET /api/workspaces/{id}/audit`, newest-first and paged by
//! id exactly like document history.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde_json::{json, Value};
use tracing::warn;
use uuid::Uuid;

use crate::persistence::Persistence;
use crate::AppState;

/// One auditable event, built where the action happens. `workspace_id` may be left unset
/// for document-scoped events — the insert resolves it from the document (the natural
/// owner); both stay null for events with no workspace context (login/select probes).
pub struct AuditEvent {
    pub(crate) action: &'static str,
    pub(crate) workspace_id: Option<Uuid>,
    pub(crate) document_id: Option<Uuid>,
    pub(crate) actor_user_id: Option<Uuid>,
    pub(crate) actor_label: Option<String>,
    pub(crate) detail: Value,
}

impl AuditEvent {
    pub fn new(action: &'static str) -> Self {
        Self {
            action,
            workspace_id: None,
            document_id: None,
            actor_user_id: None,
            actor_label: None,
            detail: json!({}),
        }
    }
    pub fn workspace(mut self, id: Option<Uuid>) -> Self {
        self.workspace_id = id;
        self
    }
    pub fn document(mut self, id: Option<Uuid>) -> Self {
        self.document_id = id;
        self
    }
    pub fn actor(mut self, user_id: Option<Uuid>) -> Self {
        self.actor_user_id = user_id;
        self
    }
    /// A label for non-user actors (system jobs); shown when `actor` is absent.
    #[allow(dead_code)] // part of the audit contract; no system-job writer yet
    pub fn label(mut self, label: impl Into<String>) -> Self {
        self.actor_label = Some(label.into());
        self
    }
    pub fn detail(mut self, detail: Value) -> Self {
        self.detail = detail;
        self
    }
}

/// Record an event, fire-and-forget. Returns immediately; the insert runs on its own
/// task and a failure is logged (warn) and dropped — never propagated to the caller.
pub fn record(persistence: &Arc<Persistence>, event: AuditEvent) {
    let p = persistence.clone();
    tokio::spawn(async move {
        if let Err(e) = p.insert_audit(&event).await {
            warn!(%e, action = event.action, "audit insert failed — entry dropped");
        }
    });
}

// ---------------------------------------------------------------------------
// The admin read API
// ---------------------------------------------------------------------------

/// GET /api/workspaces/{id}/audit?limit=50&before_id= — admin only. Entries newest-first;
/// page by passing the last entry's id back as before_id (the history convention).
pub async fn list_workspace_audit(
    State(state): State<AppState>,
    Path(workspace_id): Path<Uuid>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match crate::workspace::ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Err(r) = c.require_admin(workspace_id).await {
        return r;
    }
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(50)
        .clamp(1, 500);
    let before_id = params.get("before_id").and_then(|s| s.parse::<i64>().ok());
    match c.persistence.list_audit(workspace_id, limit, before_id).await {
        Ok(rows) => Json(json!({
            "entries": rows.iter().map(|r| json!({
                "id": r.id,
                "action": r.action,
                "actor": r.actor,
                "actor_label": r.actor_label,
                "document_id": r.document_id,
                "detail": r.detail,
                "created_at": r.created_at,
            })).collect::<Vec<_>>()
        }))
        .into_response(),
        Err(e) => {
            warn!(%e, "audit list failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// The never-fails contract: even against a database that cannot be reached, the
    /// underlying insert errors but `record` returns immediately and swallows the
    /// failure — the calling handler is never blocked and never sees an error.
    #[tokio::test]
    async fn record_never_fails_or_blocks_the_caller() {
        // A lazy pool to a port nothing listens on: every query fails fast.
        let p = Arc::new(Persistence::lazy_for_tests("postgres://nobody@127.0.0.1:1/nope"));
        // The raw insert really does fail …
        assert!(p.insert_audit(&AuditEvent::new("probe")).await.is_err());

        // … but record() is fire-and-forget: synchronous, infallible, instant.
        let started = Instant::now();
        record(
            &p,
            AuditEvent::new("login")
                .actor(Some(Uuid::now_v7()))
                .detail(json!({ "method": "web" })),
        );
        assert!(started.elapsed() < Duration::from_millis(50), "record() must not block");
        // Let the spawned task hit (and log) the failure — nothing may panic or leak out.
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    #[test]
    fn event_builder_carries_every_field() {
        let ws = Uuid::now_v7();
        let doc = Uuid::now_v7();
        let actor = Uuid::now_v7();
        let e = AuditEvent::new("share_link_created")
            .workspace(Some(ws))
            .document(Some(doc))
            .actor(Some(actor))
            .label("system")
            .detail(json!({ "role": "viewer" }));
        assert_eq!(e.action, "share_link_created");
        assert_eq!(e.workspace_id, Some(ws));
        assert_eq!(e.document_id, Some(doc));
        assert_eq!(e.actor_user_id, Some(actor));
        assert_eq!(e.actor_label.as_deref(), Some("system"));
        assert_eq!(e.detail["role"], json!("viewer"));
    }
}
