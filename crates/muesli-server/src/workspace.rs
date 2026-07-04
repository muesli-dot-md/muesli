//! Workspace management REST surface (ADR 0011) + storage-connection endpoints (ADR 0013).
//!
//! Everything here is identity-dependent: in open mode (no OIDC_ISSUER) these endpoints
//! return 503, mirroring how the collaboration endpoints answer 503 when the server runs
//! volatile (api.rs NO_DB). Membership roles are 'admin' | 'member'; admins manage members,
//! invites, the workspace name, and storage connections (ADR 0011).

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::warn;
use uuid::Uuid;

use crate::audit::{self, AuditEvent};
use crate::auth::{resolve_access, Principal, Role};
use crate::persistence::Persistence;
use crate::AppState;

const OPEN_MODE: &str =
    "this endpoint requires identity (OIDC_ISSUER) — the server is running in open mode";
const NO_DB: &str = "this endpoint requires DATABASE_URL (server is running volatile)";

/// Fold the fixed `Muesli` root segment onto the admin-supplied prefix. The literal
/// segment makes shared buckets self-documenting and matches the Drive app folder. The
/// per-workspace container is added later by the Scoped decorator; this is only the root.
pub(crate) fn muesli_prefix(user_prefix: &str) -> String {
    let user = user_prefix.trim_matches('/');
    if user.is_empty() {
        "Muesli".to_string()
    } else {
        format!("{user}/Muesli")
    }
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, msg.into()).into_response()
}

fn err500(e: anyhow::Error) -> Response {
    warn!(%e, "workspace api error");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

/// An authenticated workspace-API caller. `user_id` is the principal's role user (the
/// human owner for delegated agent tokens), so workspace permissions follow the human.
/// Crate-visible so sibling workspace-scoped surfaces (audit.rs) share the same seam.
pub(crate) struct WsCtx {
    pub(crate) persistence: Arc<Persistence>,
    principal: Principal,
    user_id: Uuid,
}

pub(crate) async fn ctx(
    state: &AppState,
    jar: &CookieJar,
    headers: &axum::http::HeaderMap,
) -> Result<WsCtx, Response> {
    let Some(auth) = state.auth.clone() else {
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, OPEN_MODE));
    };
    let Some(persistence) = state.persistence.clone() else {
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, NO_DB));
    };
    let Some(principal) = auth.authenticate(jar, headers).await else {
        return Err(err(StatusCode::UNAUTHORIZED, "sign in"));
    };
    Ok(WsCtx {
        persistence,
        user_id: principal.role_user,
        principal,
    })
}

impl WsCtx {
    /// The caller's membership role in the workspace; 403 when not a member (or when a
    /// workspace-restricted token points elsewhere), so existence isn't leaked.
    async fn member_role(&self, workspace_id: Uuid) -> Result<String, Response> {
        if self
            .principal
            .workspace_restriction
            .is_some_and(|w| w != workspace_id)
        {
            return Err(err(
                StatusCode::FORBIDDEN,
                "your token is restricted to another workspace",
            ));
        }
        match self
            .persistence
            .workspace_role(workspace_id, self.user_id)
            .await
        {
            Ok(Some(role)) => Ok(role),
            Ok(None) => Err(err(
                StatusCode::FORBIDDEN,
                "you are not a member of this workspace",
            )),
            Err(e) => Err(err500(e)),
        }
    }

    pub(crate) async fn require_admin(&self, workspace_id: Uuid) -> Result<(), Response> {
        if self.member_role(workspace_id).await? != "admin" {
            return Err(err(
                StatusCode::FORBIDDEN,
                "requires the admin role on this workspace",
            ));
        }
        Ok(())
    }

    /// The caller's primary workspace (the personal one, else the oldest membership) —
    /// what the singular /api/workspace routes operate on.
    async fn primary_workspace(&self) -> Result<Uuid, Response> {
        let list = self
            .persistence
            .list_workspaces(self.user_id)
            .await
            .map_err(err500)?;
        list.first()
            .map(|w| w.id)
            .ok_or_else(|| err(StatusCode::NOT_FOUND, "you have no workspace yet"))
    }
}

/// The "cannot orphan a workspace" guard (ADR 0011): changing or removing an admin is
/// rejected when they are the last one. `new_role` None = removal.
pub(crate) fn last_admin_violation(
    target_role: &str,
    new_role: Option<&str>,
    admin_count: i64,
) -> bool {
    target_role == "admin" && new_role != Some("admin") && admin_count <= 1
}

fn parse_member_role(s: &str) -> Option<&'static str> {
    match s {
        "admin" => Some("admin"),
        "member" => Some("member"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/// GET /api/workspaces → { workspaces: [{id, name, role, is_personal}] }
pub async fn list_workspaces(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    match c.persistence.list_workspaces(c.user_id).await {
        Ok(list) => Json(json!({
            "workspaces": list
                .iter()
                .filter(|w| c.principal.workspace_restriction.is_none_or(|r| r == w.id))
                .map(|w| json!({
                    "id": w.id, "name": w.name, "role": w.role, "is_personal": w.is_personal,
                }))
                .collect::<Vec<_>>()
        }))
        .into_response(),
        Err(e) => err500(e),
    }
}

#[derive(Deserialize)]
pub struct CreateWorkspaceReq {
    name: String,
}

/// POST /api/workspaces {name} → 201 { id, name, role: "admin", is_personal: false }.
/// Creates a brand-new shared workspace owned by the caller (Plan 5 create-remote / promote).
/// Requires identity (ctx() 503s in open mode / no-DB, 401 unauthenticated) — there is no
/// require_admin because the workspace has no members until this call grants the owner admin.
pub async fn create_workspace(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<CreateWorkspaceReq>,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let name = req.name.trim();
    if crate::persistence::blank_name(name) {
        return err(StatusCode::BAD_REQUEST, "name is empty");
    }
    match c.persistence.create_workspace(name, c.user_id).await {
        Ok(workspace_id) => {
            audit::record(
                &c.persistence,
                AuditEvent::new("workspace_created")
                    .workspace(Some(workspace_id))
                    .actor(Some(c.user_id))
                    .detail(json!({ "name": name })),
            );
            (
                StatusCode::CREATED,
                Json(json!({
                    "id": workspace_id,
                    "name": name,
                    "role": "admin",
                    "is_personal": false,
                    "status": "pending_storage",
                })),
            )
                .into_response()
        }
        Err(e) => err500(e),
    }
}

/// The detail payload for one workspace; invites included only for admins (ADR 0011).
async fn workspace_detail(c: &WsCtx, workspace_id: Uuid, role: &str) -> Result<Value, Response> {
    let name = match c.persistence.workspace_name(workspace_id).await {
        Ok(Some(n)) => n,
        Ok(None) => return Err(err(StatusCode::NOT_FOUND, "no such workspace")),
        Err(e) => return Err(err500(e)),
    };
    let members = c
        .persistence
        .list_members(workspace_id)
        .await
        .map_err(err500)?;
    let mut out = json!({
        "id": workspace_id,
        "name": name,
        "role": role,
        "members": members.iter().map(|m| json!({
            "user_id": m.user_id,
            "display_name": m.display_name,
            "email": m.email,
            "kind": m.kind,
            "role": m.role,
        })).collect::<Vec<_>>(),
    });
    match c.persistence.workspace_meta(workspace_id).await {
        Ok(Some(meta)) => {
            out["status"] = json!(meta.status);
            out["storage_conn_id"] = json!(meta.storage_conn_id);
            if role == "admin" {
                out["retention"] = json!(meta.retention);
            }
        }
        Ok(None) => {}
        Err(e) => return Err(err500(e)),
    }
    if role == "admin" {
        let invites = c
            .persistence
            .list_invites(workspace_id)
            .await
            .map_err(err500)?;
        out["invites"] = json!(invites
            .iter()
            .map(|i| json!({
                "id": i.id, "email": i.email, "role": i.role, "created_at": i.created_at,
            }))
            .collect::<Vec<_>>());
        // The workspace IdP config, secret redacted (Phase 5; see public_sso).
        if let Some(sso) = c
            .persistence
            .workspace_sso(workspace_id)
            .await
            .map_err(err500)?
        {
            out["sso"] = public_sso(&sso);
        }
    }
    Ok(out)
}

/// GET /api/workspaces/{id} → {id, name, role, members:[…], invites:[…] (admins only)}
pub async fn get_workspace(
    State(state): State<AppState>,
    Path(workspace_id): Path<Uuid>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let role = match c.member_role(workspace_id).await {
        Ok(r) => r,
        Err(r) => return r,
    };
    match workspace_detail(&c, workspace_id, &role).await {
        Ok(v) => Json(v).into_response(),
        Err(r) => r,
    }
}

#[derive(Deserialize)]
pub struct RenameReq {
    name: String,
}

/// PATCH /api/workspaces/{id} {name} — admin.
pub async fn rename_workspace(
    State(state): State<AppState>,
    Path(workspace_id): Path<Uuid>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<RenameReq>,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Err(r) = c.require_admin(workspace_id).await {
        return r;
    }
    rename_in(&c, workspace_id, &req.name).await
}

async fn rename_in(c: &WsCtx, workspace_id: Uuid, name: &str) -> Response {
    let name = name.trim();
    if name.is_empty() {
        return err(StatusCode::BAD_REQUEST, "name is empty");
    }
    match c.persistence.rename_workspace(workspace_id, name).await {
        Ok(()) => {
            audit::record(
                &c.persistence,
                AuditEvent::new("workspace_renamed")
                    .workspace(Some(workspace_id))
                    .actor(Some(c.user_id))
                    .detail(json!({ "name": name })),
            );
            Json(json!({ "id": workspace_id, "name": name })).into_response()
        }
        Err(e) => err500(e),
    }
}

/// DELETE /api/workspaces/{id} — admin-only, irreversible. Purges every document in the
/// workspace (live and trashed) and the workspace itself; the client is expected to have
/// confirmed the destruction with the user. The audit entry survives (workspace_id goes
/// null via the FK, the id lives on in `detail`).
pub async fn delete_workspace(
    State(state): State<AppState>,
    Path(workspace_id): Path<Uuid>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Err(r) = c.require_admin(workspace_id).await {
        return r;
    }
    let slugs = match c.persistence.delete_workspace(workspace_id).await {
        Ok(s) => s,
        Err(e) => return err500(e),
    };
    // Evict the purged documents' live rooms so open editors stop persisting.
    {
        let mut rooms = state.rooms.lock().unwrap();
        for slug in &slugs {
            rooms.remove(slug);
        }
    }
    audit::record(
        &c.persistence,
        AuditEvent::new("workspace_deleted")
            .actor(Some(c.user_id))
            .detail(json!({ "workspace_id": workspace_id, "documents_purged": slugs.len() })),
    );
    Json(json!({ "deleted": true, "id": workspace_id })).into_response()
}

// ---------------------------------------------------------------------------
// Invites & members
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct InviteReq {
    email: String,
    role: String,
}

/// POST /api/workspaces/{id}/invites {email, role} — admin. If a user with that email
/// already exists (any issuer) the membership is created immediately → {status:"added"};
/// otherwise an invite row waits for their first OIDC login → {status:"invited"}.
pub async fn create_invite(
    State(state): State<AppState>,
    Path(workspace_id): Path<Uuid>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<InviteReq>,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Err(r) = c.require_admin(workspace_id).await {
        return r;
    }
    invite_in(&c, workspace_id, &req).await
}

async fn invite_in(c: &WsCtx, workspace_id: Uuid, req: &InviteReq) -> Response {
    let Some(role) = parse_member_role(&req.role) else {
        return err(
            StatusCode::BAD_REQUEST,
            "role must be \"admin\" or \"member\"",
        );
    };
    let email = req.email.trim().to_lowercase();
    if email.is_empty() || !email.contains('@') {
        return err(StatusCode::BAD_REQUEST, "email looks invalid");
    }
    match c.persistence.find_user_by_email(&email).await {
        Err(e) => err500(e),
        Ok(Some(user_id)) => match c
            .persistence
            .add_membership(workspace_id, user_id, role)
            .await
        {
            Ok(()) => {
                audit::record(
                    &c.persistence,
                    AuditEvent::new("invite_created")
                        .workspace(Some(workspace_id))
                        .actor(Some(c.user_id))
                        .detail(json!({
                            "status": "added", "email": email, "role": role, "user_id": user_id,
                        })),
                );
                Json(json!({ "status": "added", "user_id": user_id, "role": role })).into_response()
            }
            Err(e) => err500(e),
        },
        Ok(None) => {
            match c
                .persistence
                .create_invite(workspace_id, &email, role, c.user_id)
                .await
            {
                Ok(invite_id) => {
                    audit::record(
                        &c.persistence,
                        AuditEvent::new("invite_created")
                            .workspace(Some(workspace_id))
                            .actor(Some(c.user_id))
                            .detail(json!({
                                "status": "invited", "email": email, "role": role,
                                "invite_id": invite_id,
                            })),
                    );
                    Json(json!({
                        "status": "invited",
                        "invite_id": invite_id,
                        "email": email,
                        "role": role,
                    }))
                    .into_response()
                }
                Err(e) => err500(e),
            }
        }
    }
}

/// DELETE /api/workspaces/{id}/invites/{invite_id} — admin.
pub async fn delete_invite(
    State(state): State<AppState>,
    Path((workspace_id, invite_id)): Path<(Uuid, Uuid)>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Err(r) = c.require_admin(workspace_id).await {
        return r;
    }
    match c.persistence.delete_invite(workspace_id, invite_id).await {
        Ok(true) => {
            audit::record(
                &c.persistence,
                AuditEvent::new("invite_revoked")
                    .workspace(Some(workspace_id))
                    .actor(Some(c.user_id))
                    .detail(json!({ "invite_id": invite_id })),
            );
            Json(json!({ "deleted": true })).into_response()
        }
        Ok(false) => err(
            StatusCode::NOT_FOUND,
            "no such pending invite on this workspace",
        ),
        Err(e) => err500(e),
    }
}

#[derive(Deserialize)]
pub struct MemberRoleReq {
    role: String,
}

/// PATCH /api/workspaces/{id}/members/{user_id} {role} — admin; demoting the last admin
/// is a 409 (the workspace must keep one).
pub async fn set_member_role(
    State(state): State<AppState>,
    Path((workspace_id, member_id)): Path<(Uuid, Uuid)>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<MemberRoleReq>,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Err(r) = c.require_admin(workspace_id).await {
        return r;
    }
    let Some(role) = parse_member_role(&req.role) else {
        return err(
            StatusCode::BAD_REQUEST,
            "role must be \"admin\" or \"member\"",
        );
    };
    let target_role = match c.persistence.workspace_role(workspace_id, member_id).await {
        Ok(Some(r)) => r,
        Ok(None) => return err(StatusCode::NOT_FOUND, "no such member in this workspace"),
        Err(e) => return err500(e),
    };
    let admins = match c.persistence.admin_count(workspace_id).await {
        Ok(n) => n,
        Err(e) => return err500(e),
    };
    if last_admin_violation(&target_role, Some(role), admins) {
        return err(
            StatusCode::CONFLICT,
            "cannot demote the last admin of a workspace",
        );
    }
    match c
        .persistence
        .set_member_role(workspace_id, member_id, role)
        .await
    {
        Ok(true) => {
            audit::record(
                &c.persistence,
                AuditEvent::new("member_role_changed")
                    .workspace(Some(workspace_id))
                    .actor(Some(c.user_id))
                    .detail(json!({
                        "user_id": member_id, "role": role, "previous_role": target_role,
                    })),
            );
            Json(json!({
                "workspace_id": workspace_id, "user_id": member_id, "role": role,
            }))
            .into_response()
        }
        Ok(false) => err(StatusCode::NOT_FOUND, "no such member in this workspace"),
        Err(e) => err500(e),
    }
}

/// DELETE /api/workspaces/{id}/members/{user_id} — admin, or self-leave; removing the
/// last admin is a 409.
pub async fn remove_member(
    State(state): State<AppState>,
    Path((workspace_id, member_id)): Path<(Uuid, Uuid)>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let caller_role = match c.member_role(workspace_id).await {
        Ok(r) => r,
        Err(r) => return r,
    };
    if caller_role != "admin" && member_id != c.user_id {
        return err(
            StatusCode::FORBIDDEN,
            "members may only remove themselves (leave)",
        );
    }
    let target_role = match c.persistence.workspace_role(workspace_id, member_id).await {
        Ok(Some(r)) => r,
        Ok(None) => return err(StatusCode::NOT_FOUND, "no such member in this workspace"),
        Err(e) => return err500(e),
    };
    let admins = match c.persistence.admin_count(workspace_id).await {
        Ok(n) => n,
        Err(e) => return err500(e),
    };
    if last_admin_violation(&target_role, None, admins) {
        return err(
            StatusCode::CONFLICT,
            "cannot remove the last admin of a workspace",
        );
    }
    match c.persistence.remove_member(workspace_id, member_id).await {
        Ok(true) => {
            audit::record(
                &c.persistence,
                AuditEvent::new("member_removed")
                    .workspace(Some(workspace_id))
                    .actor(Some(c.user_id))
                    .detail(json!({
                        "user_id": member_id,
                        "self_leave": member_id == c.user_id,
                    })),
            );
            Json(json!({ "removed": true, "user_id": member_id })).into_response()
        }
        Ok(false) => err(StatusCode::NOT_FOUND, "no such member in this workspace"),
        Err(e) => err500(e),
    }
}

// ---------------------------------------------------------------------------
// Singular convenience routes (the caller's primary workspace)
// ---------------------------------------------------------------------------

/// GET /api/workspace — detail of the caller's primary (personal) workspace.
pub async fn current_workspace(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let ws = match c.primary_workspace().await {
        Ok(w) => w,
        Err(r) => return r,
    };
    let role = match c.member_role(ws).await {
        Ok(r) => r,
        Err(r) => return r,
    };
    match workspace_detail(&c, ws, &role).await {
        Ok(v) => Json(v).into_response(),
        Err(r) => r,
    }
}

/// PATCH /api/workspace {name} — admin of the primary workspace.
pub async fn rename_current_workspace(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<RenameReq>,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let ws = match c.primary_workspace().await {
        Ok(w) => w,
        Err(r) => return r,
    };
    if let Err(r) = c.require_admin(ws).await {
        return r;
    }
    rename_in(&c, ws, &req.name).await
}

/// POST /api/workspace/invites {email, role} — admin of the primary workspace.
pub async fn invite_to_current_workspace(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<InviteReq>,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let ws = match c.primary_workspace().await {
        Ok(w) => w,
        Err(r) => return r,
    };
    if let Err(r) = c.require_admin(ws).await {
        return r;
    }
    invite_in(&c, ws, &req).await
}

// ---------------------------------------------------------------------------
// Documents listing (the web UI's doc list)
// ---------------------------------------------------------------------------

/// GET /api/documents?query=&trashed=true →
///   { documents: [{document_id, slug, title, folder_id, updated_at, workspace_id,
///                  deleted_at}],
///     folders:   [{id, workspace_id, parent_id, name, updated_at, deleted_at}] }
/// — documents visible to the caller (ACL grant or workspace membership; reuses the MCP
/// visibility query) plus the folder tree (migration 0008). `trashed=true` flips both
/// lists to the trash. Works in open mode too (everything is visible there, ADR 0012).
pub async fn list_documents(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let Some(p) = state.persistence.clone() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, NO_DB);
    };
    let (user, doc_restriction, ws_restriction) = match state.auth.as_ref() {
        None => (None, None, None),
        Some(auth) => match auth.authenticate(&jar, &headers).await {
            Some(pr) => (
                Some(pr.role_user),
                pr.document_restriction,
                pr.workspace_restriction,
            ),
            None => return err(StatusCode::UNAUTHORIZED, "sign in"),
        },
    };
    let query = params.get("query").map(String::as_str);
    let trashed = params
        .get("trashed")
        .is_some_and(|v| v == "true" || v == "1");
    let docs = match p
        .list_documents_visible(user, query, doc_restriction, ws_restriction, trashed)
        .await
    {
        Ok(d) => d,
        Err(e) => return err500(e),
    };
    // A document-restricted token sees one document and no tree.
    let folders = if doc_restriction.is_some() {
        Vec::new()
    } else {
        match p.list_folders_visible(user, ws_restriction, trashed).await {
            Ok(f) => f,
            Err(e) => return err500(e),
        }
    };
    Json(json!({
        "documents": docs.iter().map(|d| json!({
            "document_id": d.id,
            "slug": d.slug,
            // The stored display title (rename, migration 0008); the slug still stands
            // in when unset — a deliberate deviation from ADR 0013's derived titles
            // (the slug/room identity never changes on rename).
            "title": d.title.as_deref().unwrap_or(&d.slug),
            "folder_id": d.folder_id,
            "updated_at": d.updated_at,
            "workspace_id": d.workspace_id,
            "deleted_at": d.deleted_at,
            // Starred / favourite (migration 0011); drives the "~starred" view + card star.
            "starred": d.starred,
            // The creating user's ACL grant (ensure_document_owned); null for pre-auth
            // documents. is_owner=false is the client's "Shared with me" set; open mode
            // and ownerless documents read as the caller's own.
            "owner": d.owner_id.map(|id| json!({
                "id": id, "display_name": d.owner_name,
            })),
            "is_owner": user.is_none() || d.owner_id.is_none() || d.owner_id == user,
        })).collect::<Vec<_>>(),
        "folders": folders.iter().map(|f| json!({
            "id": f.id,
            "workspace_id": f.workspace_id,
            "parent_id": f.parent_id,
            "name": f.name,
            "updated_at": f.updated_at,
            "deleted_at": f.deleted_at,
        })).collect::<Vec<_>>(),
    }))
    .into_response()
}

// ---------------------------------------------------------------------------
// Storage connections & document attachment (ADR 0013)
// ---------------------------------------------------------------------------

/// Is this address one the server must never be pointed at (loopback, RFC1918,
/// link-local, unique-local, unspecified)? SSRF guard for admin-supplied endpoints.
pub(crate) fn ip_is_internal(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()      // 127.0.0.0/8
                || v4.is_private()     // 10/8, 172.16/12, 192.168/16
                || v4.is_link_local()  // 169.254/16
                || v4.is_unspecified() // 0.0.0.0
                || v4.is_broadcast()
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return ip_is_internal(IpAddr::V4(v4));
            }
            v6.is_loopback()      // ::1
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // fc00::/7 unique local
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // fe80::/10 link local
        }
    }
}

/// SSRF guard for admin-supplied storage endpoints (S3 `endpoint`, GitHub `api_base`).
/// The server immediately probes these URLs carrying server-wide secrets
/// (MUESLI_GITHUB_TOKEN / a SigV4 Credential), so a malicious value could exfiltrate
/// credentials or reach internal services (169.254.169.254, admin ports). Policy:
///
/// - `MUESLI_STORAGE_HOST_ALLOWLIST` set (comma-separated hostnames): the URL's host
///   must be on the list, exact and case-insensitive. Listed hosts are the operator's
///   explicit choice, so scheme/address checks are theirs (self-hosted MinIO over
///   plain http on a private address, dev forges, …).
/// - Otherwise: https only; the host must not be localhost, a literal internal
///   address, or a name resolving to one ([`ip_is_internal`]).
///
/// Err carries a caller-safe message (the handlers answer 400 with it).
async fn validate_storage_url(raw: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(raw).map_err(|e| format!("invalid url {raw:?}: {e}"))?;
    let host = url
        .host_str()
        .ok_or_else(|| format!("url {raw:?} has no host"))?
        .to_ascii_lowercase();
    // reqwest/url serializes IPv6 literal hosts in brackets; strip for parsing/matching.
    let bare = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();

    let allowlist = std::env::var("MUESLI_STORAGE_HOST_ALLOWLIST")
        .ok()
        .filter(|s| !s.trim().is_empty());
    if let Some(list) = allowlist {
        let allowed = list
            .split(',')
            .map(|h| h.trim().to_ascii_lowercase())
            .any(|h| !h.is_empty() && (h == host || h == bare));
        return if allowed {
            Ok(())
        } else {
            Err(format!(
                "storage host {host:?} is not on MUESLI_STORAGE_HOST_ALLOWLIST"
            ))
        };
    }

    // Self-host escape hatch (spec §3): a fully-private deployment (docker-compose LAN)
    // may opt out of the public-https posture wholesale. Hosted deployments never set this.
    if std::env::var("MUESLI_STORAGE_ALLOW_PRIVATE").is_ok_and(|v| v == "true" || v == "1") {
        return Ok(());
    }

    if url.scheme() != "https" {
        return Err("storage endpoints must use https (or the host must be on \
             MUESLI_STORAGE_HOST_ALLOWLIST)"
            .into());
    }
    if bare == "localhost" || bare.ends_with(".localhost") {
        return Err("storage endpoints must not point at localhost".into());
    }
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        if ip_is_internal(ip) {
            return Err(format!(
                "storage endpoint address {bare} is private/loopback"
            ));
        }
        return Ok(());
    }
    // Resolve the name and refuse if ANY address is internal (DNS-rebinding-shaped
    // configs are rejected outright; a TOCTOU window remains, but redirects are
    // disabled on these clients and the allowlist is the strict operator posture).
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs = tokio::net::lookup_host((bare.as_str(), port))
        .await
        .map_err(|e| format!("cannot resolve storage host {bare:?}: {e}"))?;
    for addr in addrs {
        if ip_is_internal(addr.ip()) {
            return Err(format!(
                "storage host {bare:?} resolves to a private/loopback address"
            ));
        }
    }
    Ok(())
}

/// A human hint keyed on the common probe failures (spec: error handling).
fn probe_hint(e: &anyhow::Error) -> &'static str {
    let s = e.to_string();
    if s.contains("403") || s.contains("AccessDenied") {
        " — check that the key's IAM policy matches the one shown for this bucket/prefix"
    } else if s.contains("NoSuchBucket") || s.contains("404") {
        " — the bucket was not found; check the bucket name and region"
    } else if s.contains("certificate") || s.contains("tls") || s.contains("dns") {
        " — the endpoint could not be reached; check the endpoint URL"
    } else {
        ""
    }
}

#[derive(Deserialize)]
pub struct CreateStorageReq {
    kind: String,
    // s3 (kind:"s3")
    endpoint: Option<String>,
    bucket: Option<String>,
    region: Option<String>,
    // github (kind:"github" — GitHub / Gitea / Forgejo, the Contents API)
    api_base: Option<String>,
    owner: Option<String>,
    repo: Option<String>,
    branch: Option<String>,
    // both kinds
    prefix: Option<String>,
    // per-workspace credentials (plan 1a; encrypted at rest with MUESLI_SECRET_KEY)
    access_key_id: Option<String>, // s3
    secret_key: Option<String>,    // s3
    token: Option<String>,         // github
    // sharepoint (kind:"sharepoint" — BYO storage phase 2)
    tenant: Option<String>,
    site_url: Option<String>,
    site_id: Option<String>,
    drive_id: Option<String>,
    drive_name: Option<String>,
    // per-workspace Entra app (encrypted at rest; cert wins over secret)
    client_id: Option<String>,
    client_secret: Option<String>,
    client_certificate_pem: Option<String>,
    client_private_key_pem: Option<String>,
}

/// The sharepoint arm's request→config step, factored pure(ish) so validation, the
/// hard-refusal rule, and encryption unit-test without handler plumbing.
/// `secret_key_configured` is injected (callers pass crate::secrets::secret_key_configured()).
fn sharepoint_config_from_req(
    req: &CreateStorageReq,
    secret_key_configured: bool,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let get = |v: &Option<String>| v.as_deref().unwrap_or("").trim().to_string();
    let tenant = get(&req.tenant);
    let site_url = get(&req.site_url);
    let site_id = get(&req.site_id);
    let drive_id = get(&req.drive_id);
    let drive_name = get(&req.drive_name);
    if tenant.is_empty() || site_url.is_empty() || site_id.is_empty() || drive_id.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "tenant, site_url, site_id, and drive_id are required".into(),
        ));
    }
    // The tenant is interpolated into the login URL path — GUID or [A-Za-z0-9.-]+ only.
    if !crate::msgraph::valid_tenant(&tenant) {
        return Err((
            StatusCode::BAD_REQUEST,
            "tenant must be a GUID or a domain ([A-Za-z0-9.-]+)".into(),
        ));
    }
    let client_id = get(&req.client_id);
    let client_secret = get(&req.client_secret);
    let cert_pem = get(&req.client_certificate_pem);
    let key_pem = get(&req.client_private_key_pem);
    let has_cert = !cert_pem.is_empty() && !key_pem.is_empty();
    let has_secret = !client_secret.is_empty();
    let has_ws_creds = !client_id.is_empty() && (has_cert || has_secret);
    if has_ws_creds && !secret_key_configured {
        // Phase 1 hard-refusal rule: no plaintext fallback for new secrets, ever.
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "MUESLI_SECRET_KEY is not configured on the server — per-workspace \
             credentials cannot be stored securely"
                .into(),
        ));
    }
    if !has_ws_creds && !crate::msgraph::configured() {
        return Err((
            StatusCode::BAD_REQUEST,
            "client_id and a client_secret (or certificate + private key) are required \
             (this server has no Microsoft app configured)"
                .into(),
        ));
    }
    let mut config = json!({
        "tenant_id": tenant,
        "site_url": site_url,
        "site_id": site_id,
        "drive_id": drive_id,
        "drive_name": drive_name,
        "prefix": muesli_prefix(req.prefix.as_deref().unwrap_or("")),
    });
    if has_ws_creds {
        config["client_id"] = json!(client_id);
        if has_cert {
            // Cert wins over secret at the same level (spec precedence). The
            // certificate is public — plaintext; the private key is encrypted at rest.
            let enc = crate::secrets::encrypt_secret(&key_pem)
                .expect("secret_key_configured checked above");
            config["client_certificate_pem"] = json!(cert_pem);
            config["client_private_key_enc"] = json!(enc);
        } else {
            let enc = crate::secrets::encrypt_secret(&client_secret)
                .expect("secret_key_configured checked above");
            config["client_secret_enc"] = json!(enc);
        }
    }
    Ok(config)
}

/// POST /api/workspaces/{id}/storage — admin. Two kinds:
///   {kind:"s3", endpoint, bucket, region?, prefix?}
///   {kind:"github", api_base, owner, repo, branch, prefix?}
/// Secrets stay in server env (MUESLI_S3_ACCESS_KEY/MUESLI_S3_SECRET_KEY,
/// MUESLI_GITHUB_TOKEN); the config jsonb holds only locations. Each kind is probed
/// before the row is created so a typo'd config fails this request (502), not the loops.
pub async fn create_storage_connection(
    State(state): State<AppState>,
    Path(workspace_id): Path<Uuid>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<CreateStorageReq>,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Err(r) = c.require_admin(workspace_id).await {
        return r;
    }
    // A workspace that already has storage bound must disconnect first: silently
    // rebinding would abandon the previous backend without the admin realizing (existing
    // documents stay attached to the OLD connection's row even though a new one now
    // "owns" the workspace). Grandfathered workspaces — connections exist, but
    // storage_conn_id was never set — are unaffected and proceed as before. Checked
    // BEFORE any probe so a doomed request never touches the network.
    match c.persistence.workspace_meta(workspace_id).await {
        Ok(Some(meta)) if meta.storage_conn_id.is_some() => {
            return err(
                StatusCode::CONFLICT,
                "this workspace already has storage bound; disconnect it first",
            );
        }
        Ok(_) => {}
        Err(e) => return err500(e),
    }
    let (kind, config) = match req.kind.as_str() {
        "s3" => {
            let access_key_id = req
                .access_key_id
                .as_deref()
                .unwrap_or("")
                .trim()
                .to_string();
            let secret_key = req.secret_key.as_deref().unwrap_or("").trim().to_string();
            let has_ws_creds = !access_key_id.is_empty() && !secret_key.is_empty();
            if has_ws_creds && !crate::secrets::secret_key_configured() {
                return err(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "MUESLI_SECRET_KEY is not configured on the server — per-workspace \
                     credentials cannot be stored securely",
                );
            }
            if !has_ws_creds && !crate::storage::s3_creds_configured() {
                return err(
                    StatusCode::BAD_REQUEST,
                    "access_key_id and secret_key are required (this server has no \
                     shared S3 credentials configured)",
                );
            }
            let endpoint = req
                .endpoint
                .as_deref()
                .unwrap_or("")
                .trim_end_matches('/')
                .to_string();
            let bucket = req.bucket.as_deref().unwrap_or("");
            if endpoint.is_empty() || bucket.is_empty() {
                return err(StatusCode::BAD_REQUEST, "endpoint and bucket are required");
            }
            // SSRF guard BEFORE any probe: the probe signs with credentials (workspace-
            // or server-wide) that must never reach an attacker-controlled endpoint.
            if let Err(msg) = validate_storage_url(&endpoint).await {
                return err(StatusCode::BAD_REQUEST, format!("endpoint rejected: {msg}"));
            }
            let mut config = json!({
                "endpoint": endpoint,
                "bucket": bucket,
                "region": req.region.as_deref().unwrap_or("us-east-1"),
                "prefix": muesli_prefix(req.prefix.as_deref().unwrap_or("")),
                "force_path_style": true,
            });
            if has_ws_creds {
                let enc = crate::secrets::encrypt_secret(&secret_key)
                    .expect("secret_key_configured() checked above");
                config["access_key_id"] = json!(access_key_id);
                config["secret_key_enc"] = json!(enc);
            }
            match crate::storage::S3Backend::from_conn("s3", &config) {
                Ok(backend) => {
                    if let Err(e) = backend.probe().await {
                        return err(
                            StatusCode::BAD_GATEWAY,
                            format!("storage probe failed: {e:#}{}", probe_hint(&e)),
                        );
                    }
                }
                Err(e) => return err(StatusCode::BAD_REQUEST, e.to_string()),
            }
            ("s3", config)
        }
        "github" => {
            let token = req.token.as_deref().unwrap_or("").trim().to_string();
            let has_ws_creds = !token.is_empty();
            if has_ws_creds && !crate::secrets::secret_key_configured() {
                return err(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "MUESLI_SECRET_KEY is not configured on the server — per-workspace \
                     credentials cannot be stored securely",
                );
            }
            if !has_ws_creds && !crate::storage::github_token_configured() {
                return err(
                    StatusCode::BAD_REQUEST,
                    "token is required (this server has no shared GitHub token configured)",
                );
            }
            let api_base = req
                .api_base
                .as_deref()
                .unwrap_or("")
                .trim_end_matches('/')
                .to_string();
            let owner = req.owner.as_deref().unwrap_or("");
            let repo = req.repo.as_deref().unwrap_or("");
            let branch = req.branch.as_deref().unwrap_or("");
            if api_base.is_empty() || owner.is_empty() || repo.is_empty() || branch.is_empty() {
                return err(
                    StatusCode::BAD_REQUEST,
                    "api_base, owner, repo, and branch are required",
                );
            }
            // SSRF guard BEFORE the probe: the probe carries a token (workspace- or
            // server-wide) that must never reach an attacker-controlled endpoint.
            if let Err(msg) = validate_storage_url(&api_base).await {
                return err(StatusCode::BAD_REQUEST, format!("api_base rejected: {msg}"));
            }
            let mut config = json!({
                "api_base": api_base,
                "owner": owner,
                "repo": repo,
                "branch": branch,
                "prefix": muesli_prefix(req.prefix.as_deref().unwrap_or("")),
            });
            if has_ws_creds {
                let enc = crate::secrets::encrypt_secret(&token)
                    .expect("secret_key_configured() checked above");
                config["token_enc"] = json!(enc);
            }
            match crate::storage::GithubBackend::from_conn("github", &config) {
                Ok(backend) => {
                    if let Err(e) = backend.probe().await {
                        return err(
                            StatusCode::BAD_GATEWAY,
                            format!("storage backend unreachable: {e}"),
                        );
                    }
                }
                Err(e) => return err(StatusCode::BAD_REQUEST, e.to_string()),
            }
            ("github", config)
        }
        "sharepoint" => {
            let config =
                match sharepoint_config_from_req(&req, crate::secrets::secret_key_configured()) {
                    Ok(c) => c,
                    Err((status, msg)) => return err(status, msg),
                };
            // NO validate_storage_url here (spec: SSRF section): the request carries no
            // backend host — Graph/login hosts come from server env (MUESLI_MS_LOGIN_BASE
            // / MUESLI_MS_GRAPH_BASE); the site URL is parsed only, never fetched.
            match crate::msgraph::SharePointBackend::from_conn("sharepoint", &config) {
                Ok(backend) => {
                    // Full write/read/byte-compare/delete probe — a mis-granted site
                    // fails THIS request (502 + hint), not the materialize loops later.
                    if let Err(e) = backend.probe().await {
                        return err(
                            StatusCode::BAD_GATEWAY,
                            format!(
                                "storage probe failed: {e:#}{}",
                                crate::msgraph::graph_hint(&e)
                            ),
                        );
                    }
                }
                Err(e) => return err(StatusCode::BAD_REQUEST, e.to_string()),
            }
            ("sharepoint", config)
        }
        "gdrive" => {
            // Drive connections are born from the per-workspace OAuth dance (gdrive.rs):
            // there is no config a client could legitimately POST here.
            return err(
                StatusCode::BAD_REQUEST,
                "google drive connections are created through the OAuth flow: \
                 GET /api/workspaces/{id}/storage/google/start",
            );
        }
        _ => {
            return err(
                StatusCode::BAD_REQUEST,
                "kind must be \"s3\", \"github\" or \"sharepoint\" (\"gdrive\" uses the OAuth flow)",
            );
        }
    };
    match c
        .persistence
        .create_storage_connection(workspace_id, kind, &config)
        .await
    {
        Ok(id) => {
            audit::record(
                &c.persistence,
                AuditEvent::new("storage_connection_created")
                    .workspace(Some(workspace_id))
                    .actor(Some(c.user_id))
                    .detail(json!({ "kind": kind, "storage_conn_id": id })),
            );
            // Bind now (plan 1a task 7): activates a pending workspace, or bulk-attaches
            // a grandfathered active one's unattached documents. Never blocks the
            // connection response — a bind failure is logged and the client can retry
            // (documents stay unattached; a later re-connect/bind picks them up).
            let mut workspace_status = json!(null);
            let mut attached = 0usize;
            if let Some(mgr) = state.storage.clone() {
                match mgr.bind_workspace(workspace_id, id).await {
                    Ok(n) => {
                        attached = n;
                        workspace_status = json!("active");
                    }
                    Err(e) => warn!(%e, "workspace bind after connect failed"),
                }
            }
            // Never echo the raw config back: for s3/github it may now carry
            // secret_key_enc/token_enc (ciphertext, but still a secret-derived value
            // that must not leave the server — same redaction as the GET listing).
            Json(json!({
                "storage_conn_id": id,
                "kind": kind,
                "config": public_config(kind, &config),
                "workspace_status": workspace_status,
                "attached_documents": attached,
            }))
            .into_response()
        }
        Err(e) => err500(e),
    }
}

/// GET /api/storage/s3/policy?bucket=&prefix= — any authenticated user (the wizard shows
/// this BEFORE a workspace exists). Pure function of the query, no DB access.
pub async fn s3_policy(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(r) = ctx(&state, &jar, &headers).await {
        return r;
    }
    let bucket = params
        .get("bucket")
        .map(String::as_str)
        .unwrap_or("")
        .trim();
    if bucket.is_empty() {
        return err(StatusCode::BAD_REQUEST, "bucket is required");
    }
    let prefix = params
        .get("prefix")
        .map(String::as_str)
        .unwrap_or("")
        .trim();
    // The wizard shows this before the connection is created, but the stored config
    // already folds the Muesli root segment onto the typed prefix (create_storage_connection
    // above) — show the grant for the layout that will actually exist.
    Json(json!({ "policy": crate::storage::s3_iam_policy(bucket, &muesli_prefix(prefix)) }))
        .into_response()
}

/// What of a connection's config is safe to show members. A gdrive config carries the
/// per-user OAuth refresh token; s3/github/sharepoint configs may now carry per-workspace
/// credentials (plan 1a task 4; phase 2 task 8) — every secret-shaped field is stripped
/// and its presence echoed as a boolean (or, for s3/github/sharepoint, as a
/// `"credentials"` origin tag).
pub(crate) fn public_config(kind: &str, config: &Value) -> Value {
    let mut config = config.clone();
    if let Some(obj) = config.as_object_mut() {
        match kind {
            "gdrive" => {
                // Both the legacy plaintext field and the encrypted-at-rest one
                // (gdrive.rs) are secrets: neither may leave the server.
                let had_plain = obj.remove("refresh_token").is_some();
                let had_enc = obj.remove("refresh_token_enc").is_some();
                obj.insert(
                    "has_refresh_token".into(),
                    Value::Bool(had_plain || had_enc),
                );
            }
            "s3" => {
                let had = obj.remove("secret_key_enc").is_some();
                if let Some(Value::String(id)) = obj.remove("access_key_id") {
                    let last4: String = id
                        .chars()
                        .rev()
                        .take(4)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();
                    obj.insert("access_key_id".into(), Value::String(format!("…{last4}")));
                }
                obj.insert(
                    "credentials".into(),
                    Value::String(if had { "workspace" } else { "server-env" }.into()),
                );
            }
            "github" => {
                let had = obj.remove("token_enc").is_some();
                obj.insert(
                    "credentials".into(),
                    Value::String(if had { "workspace" } else { "server-env" }.into()),
                );
            }
            "sharepoint" => {
                // client_id and the tenant/site/drive fields are public; the encrypted
                // secret material must never leave the server. The certificate PEM is
                // public by nature and passes through.
                let had_secret = obj.remove("client_secret_enc").is_some();
                let had_key = obj.remove("client_private_key_enc").is_some();
                obj.insert(
                    "credentials".into(),
                    Value::String(
                        if had_secret || had_key {
                            "workspace"
                        } else {
                            "server-app"
                        }
                        .into(),
                    ),
                );
            }
            _ => {}
        }
    }
    config
}

/// What of a workspace SSO config is safe to show: the client_secret is stripped and
/// echoed as a boolean, exactly like the gdrive refresh_token in [`public_config`].
pub(crate) fn public_sso(config: &Value) -> Value {
    let mut config = config.clone();
    if let Some(obj) = config.as_object_mut() {
        let had = obj.remove("client_secret").is_some();
        obj.insert("has_client_secret".into(), Value::Bool(had));
    }
    config
}

// ---------------------------------------------------------------------------
// Per-workspace IdP (Phase 5; ADR 0012 "Multi-issuer / per-Workspace IdP")
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SsoReq {
    issuer: String,
    client_id: String,
    client_secret: String,
    email_domains: Vec<String>,
}

/// PUT /api/workspaces/{id}/sso {issuer, client_id, client_secret, email_domains} —
/// admin. The issuer is probed (OIDC discovery) before anything is stored, so a typo'd
/// config fails THIS request with 502, never a later login. The stored config is
/// plaintext jsonb (prototype; same posture as gdrive refresh tokens) and the secret is
/// redacted from every response.
pub async fn set_workspace_sso(
    State(state): State<AppState>,
    Path(workspace_id): Path<Uuid>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<SsoReq>,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Err(r) = c.require_admin(workspace_id).await {
        return r;
    }
    // ctx() already guaranteed auth mode.
    let Some(auth) = state.auth.clone() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, OPEN_MODE);
    };

    let issuer = crate::auth::normalize_issuer(req.issuer.trim());
    let client_id = req.client_id.trim().to_string();
    let client_secret = req.client_secret.trim().to_string();
    if issuer.is_empty() || client_id.is_empty() || client_secret.is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "issuer, client_id, and client_secret are required",
        );
    }
    let domains: Vec<String> = req
        .email_domains
        .iter()
        .map(|d| d.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|d| !d.is_empty())
        .collect();
    if domains.is_empty() || domains.iter().any(|d| !d.contains('.') || d.contains('@')) {
        return err(
            StatusCode::BAD_REQUEST,
            "email_domains must be at least one domain like \"corp.example\"",
        );
    }

    // The probe: discovery against the issuer, right now (502 at config time, ADR 0013's
    // storage-probe convention applied to identity).
    if let Err(e) = auth.probe_issuer(&issuer, &client_id, &client_secret).await {
        warn!(%e, %issuer, "sso issuer probe failed");
        return err(
            StatusCode::BAD_GATEWAY,
            format!("issuer discovery failed: {e:#}"),
        );
    }

    let sso = json!({
        "issuer": issuer,
        "client_id": client_id,
        "client_secret": client_secret,
        "email_domains": domains,
    });
    match c
        .persistence
        .set_workspace_sso(workspace_id, Some(&sso))
        .await
    {
        Ok(true) => {}
        Ok(false) => return err(StatusCode::NOT_FOUND, "no such workspace"),
        Err(e) => return err500(e),
    }
    if let Err(e) = auth.reload_workspace_issuers().await {
        warn!(%e, "issuer registry reload failed after sso config");
    }
    audit::record(
        &c.persistence,
        AuditEvent::new("workspace_sso_configured")
            .workspace(Some(workspace_id))
            .actor(Some(c.user_id))
            .detail(public_sso(&sso)),
    );
    Json(public_sso(&sso)).into_response()
}

/// DELETE /api/workspaces/{id}/sso — admin; removes the workspace IdP (existing
/// users/sessions keyed on (issuer, subject) are untouched — only future logins change).
pub async fn delete_workspace_sso(
    State(state): State<AppState>,
    Path(workspace_id): Path<Uuid>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Err(r) = c.require_admin(workspace_id).await {
        return r;
    }
    let had = match c.persistence.workspace_sso(workspace_id).await {
        Ok(s) => s.is_some(),
        Err(e) => return err500(e),
    };
    if !had {
        return err(
            StatusCode::NOT_FOUND,
            "this workspace has no SSO configuration",
        );
    }
    match c.persistence.set_workspace_sso(workspace_id, None).await {
        Ok(true) => {}
        Ok(false) => return err(StatusCode::NOT_FOUND, "no such workspace"),
        Err(e) => return err500(e),
    }
    if let Some(auth) = state.auth.as_ref() {
        if let Err(e) = auth.reload_workspace_issuers().await {
            warn!(%e, "issuer registry reload failed after sso removal");
        }
    }
    audit::record(
        &c.persistence,
        AuditEvent::new("workspace_sso_removed")
            .workspace(Some(workspace_id))
            .actor(Some(c.user_id)),
    );
    Json(json!({ "removed": true })).into_response()
}

/// GET /api/workspaces/{id}/storage →
///   { connections: [{id, kind, config, created_at}], google: { configured } } —
/// any member (editors need the ids to attach documents). gdrive configs are redacted
/// (see [`public_config`]). `google.configured` is the Drive-OAuth readiness flag
/// (settings.md §2.3): it lets the UI render an honest "setup required" card instead of
/// bouncing users into the start endpoint's 503.
pub async fn list_storage_connections(
    State(state): State<AppState>,
    Path(workspace_id): Path<Uuid>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Err(r) = c.member_role(workspace_id).await {
        return r;
    }
    match c.persistence.list_storage_connections(workspace_id).await {
        Ok(conns) => Json(json!({
            "connections": conns.iter().map(|s| json!({
                "id": s.id, "kind": s.kind, "config": public_config(&s.kind, &s.config),
                "created_at": s.created_at,
            })).collect::<Vec<_>>(),
            "google": { "configured": crate::gdrive::configured() },
        }))
        .into_response(),
        Err(e) => err500(e),
    }
}

/// DELETE /api/workspaces/{id}/storage/{conn_id} — admin. Disconnecting a backend that
/// documents still reference would orphan their canonical storage, so that is a 409
/// carrying the count ({ attached_documents: n }) — detach the documents first; there
/// is deliberately no force flag in v1 (settings.md §2.3). The backend files themselves
/// are never touched: canonical storage is user-owned (ADR 0013).
pub async fn delete_storage_connection(
    State(state): State<AppState>,
    Path((workspace_id, conn_id)): Path<(Uuid, Uuid)>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Err(r) = c.require_admin(workspace_id).await {
        return r;
    }
    // Workspace-scoped lookup (a foreign workspace's conn id reads as absent).
    let conn = match c
        .persistence
        .get_storage_connection(conn_id, workspace_id)
        .await
    {
        Ok(Some(s)) => s,
        Ok(None) => {
            return err(
                StatusCode::NOT_FOUND,
                "no such storage connection on this workspace",
            )
        }
        Err(e) => return err500(e),
    };
    let attached = match c.persistence.count_attached_documents(conn_id).await {
        Ok(n) => n,
        Err(e) => return err500(e),
    };
    if attached > 0 {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "attached_documents": attached })),
        )
            .into_response();
    }
    match c
        .persistence
        .delete_storage_connection(conn_id, workspace_id)
        .await
    {
        Ok(true) => {
            audit::record(
                &c.persistence,
                AuditEvent::new("storage_disconnected")
                    .workspace(Some(workspace_id))
                    .actor(Some(c.user_id))
                    .detail(json!({ "storage_conn_id": conn_id, "kind": conn.kind })),
            );
            Json(json!({ "deleted": true })).into_response()
        }
        Ok(false) => err(
            StatusCode::NOT_FOUND,
            "no such storage connection on this workspace",
        ),
        Err(e) => err500(e),
    }
}

/// GET /api/workspaces/{id}/storage/status — member. The storage-health surface
/// (spec §7): websocket dot ≠ storage health; this is the storage half. Health is
/// in-memory (plan 1a task 10; see [`crate::storage::HealthRegistry`]) — it resets on
/// server restart, so a workspace bound but never yet materialized/polled reads as
/// `healthy: null` (unknown), not `false`.
pub async fn storage_status(
    State(state): State<AppState>,
    Path(workspace_id): Path<Uuid>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Err(r) = c.member_role(workspace_id).await {
        return r;
    }
    let meta = match c.persistence.workspace_meta(workspace_id).await {
        Ok(Some(m)) => m,
        Ok(None) => return err(StatusCode::NOT_FOUND, "no such workspace"),
        Err(e) => return err500(e),
    };
    let Some(conn_id) = meta.storage_conn_id else {
        return Json(json!({ "bound": false, "status": meta.status })).into_response();
    };
    let kind = match c
        .persistence
        .get_storage_connection(conn_id, workspace_id)
        .await
    {
        Ok(Some(conn)) => conn.kind,
        Ok(None) => return Json(json!({ "bound": false, "status": meta.status })).into_response(),
        Err(e) => return err500(e),
    };
    let health = state.storage.as_ref().and_then(|m| m.conn_health(conn_id));
    Json(json!({
        "bound": true,
        "status": meta.status,
        "storage_conn_id": conn_id,
        "kind": kind,
        "healthy": health.as_ref().map(|h| h.healthy),
        "last_ok_unix": health.as_ref().and_then(|h| h.last_ok_unix),
        "last_error": health.as_ref().and_then(|h| h.last_error.clone()),
        "last_error_unix": health.as_ref().and_then(|h| h.last_error_unix),
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct AttachReq {
    storage_conn_id: Uuid,
    rel_path: Option<String>,
}

/// POST /api/documents/{slug}/storage {storage_conn_id, rel_path?} — Editor on the
/// document; the connection must belong to the document's workspace. Attaches and
/// immediately materializes the current text to the backend (ADR 0013).
pub async fn attach_document_storage(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<AttachReq>,
) -> Response {
    if state.auth.is_none() {
        return err(StatusCode::SERVICE_UNAVAILABLE, OPEN_MODE);
    }
    let Some(p) = state.persistence.clone() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, NO_DB);
    };
    let Some(manager) = state.storage.clone() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, NO_DB);
    };

    // The same authorization seam as ws/REST/MCP: Editor on this document. The share
    // token is read from the X-Muesli-Share header first (capability tokens do not
    // belong in URLs — query strings land in proxy/access logs and browser history);
    // the ?share= query param stays as the compatibility fallback.
    let header_share = headers.get("X-Muesli-Share").and_then(|v| v.to_str().ok());
    let share = header_share.or_else(|| params.get("share").map(String::as_str));
    let access = match resolve_access(&state, &slug, &jar, &headers, share).await {
        Ok(a) => a,
        Err(StatusCode::UNAUTHORIZED) => return err(StatusCode::UNAUTHORIZED, "sign in"),
        Err(StatusCode::FORBIDDEN) => {
            return err(StatusCode::FORBIDDEN, "you have no access to this document")
        }
        Err(other) => return other.into_response(),
    };
    if access.role < Role::Editor {
        return err(StatusCode::FORBIDDEN, "requires the editor role");
    }

    let doc = match p.find_document(&slug).await {
        Ok(Some(d)) => d,
        Ok(None) => return err(StatusCode::NOT_FOUND, "no such document"),
        Err(e) => return err500(e),
    };
    // Workspace-scoped lookup: the connection must belong to the document's workspace
    // (a foreign workspace's conn id reads as absent — no cross-tenant config read).
    let Some(doc_workspace) = doc.workspace_id else {
        return err(
            StatusCode::BAD_REQUEST,
            "the document belongs to no workspace; storage connections are workspace-scoped",
        );
    };
    let conn = match p
        .get_storage_connection(req.storage_conn_id, doc_workspace)
        .await
    {
        Ok(Some(s)) => s,
        Ok(None) => return err(StatusCode::NOT_FOUND, "no such storage connection"),
        Err(e) => return err500(e),
    };

    // The default rel_path mirrors the document's folder placement (migration 0008):
    // <folder names>/<slug>.md — the same shape StorageManager::relocate maintains.
    let explicit = req
        .rel_path
        .map(|r| r.trim().trim_start_matches('/').to_string())
        .filter(|r| !r.is_empty());
    let rel_path = match &explicit {
        Some(r) => r.clone(),
        None => {
            let chain = match p.folder_chain_names(doc.folder_id).await {
                Ok(c) => c,
                Err(e) => return err500(e),
            };
            crate::storage::rel_path_for(&chain, &slug)
        }
    };
    // The shared traversal guard (storage::validate_rel_path): '..'/'.'/empty segments,
    // backslashes, and absolute paths are rejected, never sanitized.
    if let Err(e) = crate::storage::validate_rel_path(&rel_path) {
        return err(
            StatusCode::BAD_REQUEST,
            format!("rel_path must be a clean relative path: {e}"),
        );
    }
    // An explicit NESTED rel_path implies a folder placement: get-or-create the folder
    // chain in the connection's workspace and move the document into the leaf, so the
    // backend tree and the in-app tree stay one structure.
    if explicit.is_some() && rel_path.contains('/') {
        let dirs: Vec<&str> = {
            let mut parts: Vec<&str> = rel_path.split('/').collect();
            parts.pop(); // the file name
            parts
        };
        let leaf = match p.ensure_folder_chain(Some(conn.workspace_id), &dirs).await {
            Ok(l) => l,
            Err(e) => return err500(e),
        };
        if leaf != doc.folder_id {
            if let Err(e) = p.set_document_folder(doc.id, leaf).await {
                return err500(e);
            }
        }
    }

    if let Err(e) = p.attach_document_storage(doc.id, conn.id, &rel_path).await {
        // The partial unique index on (storage_conn_id, rel_path), migration 0005.
        if e.to_string().contains("documents_storage_path") {
            return err(
                StatusCode::CONFLICT,
                "another document is already attached to that path on this connection",
            );
        }
        return err500(e);
    }

    // Materialize now: the object exists the moment the API call returns.
    match manager.materialize(doc.id).await {
        Ok(content_hash) => {
            audit::record(
                &p,
                AuditEvent::new("document_storage_attached")
                    .workspace(Some(conn.workspace_id))
                    .document(Some(doc.id))
                    .actor(access.user_id)
                    .detail(json!({
                        "storage_conn_id": conn.id, "kind": conn.kind, "rel_path": rel_path,
                    })),
            );
            Json(json!({
                "document_id": doc.id,
                "storage_conn_id": conn.id,
                "rel_path": rel_path,
                "content_hash": content_hash,
            }))
            .into_response()
        }
        Err(e) => {
            // Keep attach atomic: a backend we cannot write to is not an attachment.
            if let Err(e2) = p.detach_document_storage(doc.id).await {
                warn!(%e2, "detach after failed materialization also failed");
            }
            err(
                StatusCode::BAD_GATEWAY,
                format!("failed to write to the storage backend: {e}"),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn muesli_prefix_folds_the_root_segment() {
        assert_eq!(muesli_prefix(""), "Muesli");
        assert_eq!(muesli_prefix("/"), "Muesli");
        assert_eq!(muesli_prefix("team-notes"), "team-notes/Muesli");
        assert_eq!(muesli_prefix("/a/b/"), "a/b/Muesli");
        // stays a clean rel_path
        assert!(crate::storage::validate_rel_path(&muesli_prefix("a/b")).is_ok());
    }

    #[test]
    fn gdrive_config_is_redacted_for_members() {
        let gdrive =
            json!({"refresh_token": "1//secret", "folder_id": "f1", "folder_name": "Muesli"});
        let public = public_config("gdrive", &gdrive);
        assert_eq!(public.get("refresh_token"), None);
        assert_eq!(public["has_refresh_token"], json!(true));
        assert_eq!(public["folder_id"], json!("f1"));
        // the encrypted-at-rest field is a secret too and must never be echoed
        let gdrive_enc = json!({"refresh_token_enc": "bm9uY2U…", "folder_id": "f1"});
        let public_enc = public_config("gdrive", &gdrive_enc);
        assert_eq!(public_enc.get("refresh_token_enc"), None);
        assert_eq!(public_enc["has_refresh_token"], json!(true));
        // neither field present reads as no token
        assert_eq!(
            public_config("gdrive", &json!({"folder_id": "f1"}))["has_refresh_token"],
            json!(false)
        );
        // kinds with no credential-shaped fields pass through untouched
        let sso_ish = json!({"issuer": "https://idp.example.com"});
        assert_eq!(public_config("unknown-kind", &sso_ish), sso_ish);
    }

    /// S3/GitHub configs now carry secrets — public_config must redact them (plan 1a task 4).
    #[test]
    fn s3_and_github_configs_are_redacted_for_members() {
        let s3 = json!({
            "endpoint": "https://s3.example.com", "bucket": "b", "region": "us-east-1",
            "prefix": "", "access_key_id": "AKIAIOSFODNN7EXAMPLE", "secret_key_enc": "abc123",
        });
        let public = public_config("s3", &s3);
        assert_eq!(public.get("secret_key_enc"), None);
        assert_eq!(
            public.get("access_key_id").and_then(Value::as_str),
            Some("…MPLE")
        );
        assert_eq!(
            public.get("credentials").and_then(Value::as_str),
            Some("workspace")
        );

        let gh = json!({"api_base": "https://api.github.com", "owner": "o", "repo": "r",
                        "branch": "main", "token_enc": "xyz"});
        let public = public_config("github", &gh);
        assert_eq!(public.get("token_enc"), None);
        assert_eq!(
            public.get("credentials").and_then(Value::as_str),
            Some("workspace")
        );

        let legacy = json!({"endpoint": "https://s3.example.com", "bucket": "b"});
        let public = public_config("s3", &legacy);
        assert_eq!(
            public.get("credentials").and_then(Value::as_str),
            Some("server-env")
        );
    }

    #[test]
    fn internal_addresses_are_recognized() {
        use std::net::IpAddr;
        let internal = [
            "127.0.0.1",
            "127.8.8.8",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "::1",
            "::",
            "fc00::1",
            "fd12::1",
            "fe80::1",
            "::ffff:10.0.0.1",
            "::ffff:127.0.0.1",
        ];
        for a in internal {
            assert!(
                ip_is_internal(a.parse::<IpAddr>().unwrap()),
                "{a} must read as internal"
            );
        }
        let external = ["8.8.8.8", "172.32.0.1", "140.82.112.3", "2606:4700::1111"];
        for a in external {
            assert!(
                !ip_is_internal(a.parse::<IpAddr>().unwrap()),
                "{a} must read as external"
            );
        }
    }

    #[tokio::test]
    async fn storage_url_guard_blocks_ssrf_shapes() {
        // NOTE: assumes MUESLI_STORAGE_HOST_ALLOWLIST is unset in the test environment
        // (nothing in this suite sets it) — these exercise the default policy.
        if std::env::var("MUESLI_STORAGE_HOST_ALLOWLIST").is_ok() {
            eprintln!("skipping: MUESLI_STORAGE_HOST_ALLOWLIST is set");
            return;
        }
        // http is refused outright
        assert!(validate_storage_url("http://api.github.com").await.is_err());
        // loopback / private / link-local literals are refused
        assert!(validate_storage_url("https://127.0.0.1:9000")
            .await
            .is_err());
        assert!(validate_storage_url("https://10.1.2.3").await.is_err());
        assert!(validate_storage_url("https://169.254.169.254/latest")
            .await
            .is_err());
        assert!(validate_storage_url("https://[::1]:9000").await.is_err());
        assert!(validate_storage_url("https://localhost:9000")
            .await
            .is_err());
        assert!(validate_storage_url("https://minio.localhost")
            .await
            .is_err());
        // garbage is a clean error
        assert!(validate_storage_url("not a url").await.is_err());
        // a public literal address passes without DNS
        assert!(validate_storage_url("https://140.82.112.3").await.is_ok());

        // MUESLI_STORAGE_ALLOW_PRIVATE=true (self-host escape hatch, plan 1a task 6):
        // http + private/loopback endpoints pass without an allowlist entry.
        std::env::set_var("MUESLI_STORAGE_ALLOW_PRIVATE", "true");
        assert!(validate_storage_url("http://minio:9000").await.is_ok());
        assert!(validate_storage_url("http://10.1.2.3:9000").await.is_ok());
        std::env::remove_var("MUESLI_STORAGE_ALLOW_PRIVATE");
    }

    #[test]
    fn sso_config_is_redacted_like_gdrive() {
        let sso = json!({
            "issuer": "http://localhost:5558/dex",
            "client_id": "muesli",
            "client_secret": "muesli-dev-secret",
            "email_domains": ["corpdomain.example"],
        });
        let public = public_sso(&sso);
        assert_eq!(
            public.get("client_secret"),
            None,
            "the secret must never be echoed"
        );
        assert_eq!(public["has_client_secret"], json!(true));
        assert_eq!(public["issuer"], json!("http://localhost:5558/dex"));
        assert_eq!(public["client_id"], json!("muesli"));
        assert_eq!(public["email_domains"], json!(["corpdomain.example"]));
        // absent secret is reported honestly
        let no_secret = json!({ "issuer": "http://i", "client_id": "c" });
        assert_eq!(public_sso(&no_secret)["has_client_secret"], json!(false));
    }

    #[test]
    fn create_workspace_blank_name_is_rejected() {
        use crate::persistence::blank_name;
        // The handler 400s exactly when blank_name() is true (post-trim emptiness).
        assert!(blank_name(""));
        assert!(blank_name("   "));
        assert!(!blank_name("Team"));
        assert!(!blank_name("  Team  "));
    }

    #[test]
    fn last_admin_guard_matrix() {
        // (target_role, new_role, admin_count) → violation?
        let cases = [
            ("admin", None, 1, true),           // removing the only admin
            ("admin", Some("member"), 1, true), // demoting the only admin
            ("admin", Some("admin"), 1, false), // no-op role keeps the admin
            ("admin", None, 2, false),          // another admin remains
            ("admin", Some("member"), 2, false),
            ("member", None, 1, false), // members can always leave
            ("member", Some("admin"), 1, false), // promotion is always fine
        ];
        for (target, new_role, admins, expected) in cases {
            assert_eq!(
                last_admin_violation(target, new_role, admins),
                expected,
                "last_admin_violation({target}, {new_role:?}, {admins})"
            );
        }
    }

    /// Builder for sharepoint connect requests (CreateStorageReq has many unrelated
    /// optional fields; only the sharepoint ones vary here).
    /// (client_id, secret, (cert_pem, key_pem)) — the sharepoint credential triple.
    type SpCreds<'a> = (&'a str, Option<&'a str>, Option<(&'a str, &'a str)>);

    fn sp_req(creds: Option<SpCreds>) -> CreateStorageReq {
        let (client_id, secret, cert) = match creds {
            Some((id, s, c)) => (Some(id.to_string()), s.map(str::to_string), c),
            None => (None, None, None),
        };
        CreateStorageReq {
            kind: "sharepoint".into(),
            endpoint: None,
            bucket: None,
            region: None,
            api_base: None,
            owner: None,
            repo: None,
            branch: None,
            prefix: Some("notes".into()),
            access_key_id: None,
            secret_key: None,
            token: None,
            tenant: Some("contoso.onmicrosoft.com".into()),
            site_url: Some("https://contoso.sharepoint.com/sites/eng".into()),
            site_id: Some("contoso.sharepoint.com,g1,g2".into()),
            drive_id: Some("drv-1".into()),
            drive_name: Some("Documents".into()),
            client_id,
            client_secret: secret,
            client_certificate_pem: cert.map(|(c, _)| c.to_string()),
            client_private_key_pem: cert.map(|(_, k)| k.to_string()),
        }
    }

    #[test]
    fn sharepoint_req_validation() {
        // missing required fields → 400
        let mut req = sp_req(None);
        req.drive_id = None;
        let (status, msg) = sharepoint_config_from_req(&req, true).unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(msg.contains("drive_id"), "{msg}");
        // bad tenant → 400 with the spec rule spelled out. (GUID/domain ACCEPTANCE is
        // locked order-independently by msgraph::tests::tenant_validation_guid_or_domain
        // — this handler-side test must not depend on msgraph::configured(), which the
        // dispatch test's install_test_ctx can flip within the same test process.)
        let mut req = sp_req(None);
        req.tenant = Some("bad/tenant".into());
        let (status, msg) = sharepoint_config_from_req(&req, true).unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(msg.contains("tenant must be"), "{msg}");
    }

    /// Phase 1 hard-refusal rule: per-workspace credentials without MUESLI_SECRET_KEY
    /// are refused with 503 — no plaintext fallback for new secrets.
    #[test]
    fn sharepoint_ws_creds_hard_refused_without_secret_key() {
        let req = sp_req(Some(("ws-cid", Some("ws-secret"), None)));
        let (status, msg) = sharepoint_config_from_req(&req, false).unwrap_err();
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(msg.contains("MUESLI_SECRET_KEY"), "{msg}");
    }

    /// Encryption at rest: the secret (or private key) lands encrypted; the cert stays
    /// plaintext (it is public); cert wins when both credential shapes are sent.
    #[test]
    fn sharepoint_config_encrypts_ws_credentials() {
        // Serialize env access on the same key value storage.rs uses, so even a
        // cross-module race writes an identical value (locks are module-local).
        static SP_SECRET_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = SP_SECRET_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // MUESLI_SECRET_KEY is process-global; this module-local lock alone cannot
        // serialize against msgraph.rs's/storage.rs's own secret-key tests, so also take
        // the cross-module lock (module lock first, then this one — consistent order,
        // so the two locks can never deadlock).
        let _sk_guard = crate::secrets::SECRET_KEY_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let key_hex = "0101010101010101010101010101010101010101010101010101010101010101";
        std::env::set_var("MUESLI_SECRET_KEY", key_hex);
        struct Unset;
        impl Drop for Unset {
            fn drop(&mut self) {
                std::env::remove_var("MUESLI_SECRET_KEY");
            }
        }
        let _unset = Unset;

        // secret path
        let req = sp_req(Some(("ws-cid", Some("ws-secret"), None)));
        let config = sharepoint_config_from_req(&req, true).unwrap();
        assert_eq!(config["tenant_id"], json!("contoso.onmicrosoft.com"));
        assert_eq!(config["site_id"], json!("contoso.sharepoint.com,g1,g2"));
        assert_eq!(config["drive_id"], json!("drv-1"));
        assert_eq!(config["drive_name"], json!("Documents"));
        // stored prefix folds the Muesli root segment onto the admin-typed prefix
        assert_eq!(config["prefix"], json!("notes/Muesli"));
        assert_eq!(config["client_id"], json!("ws-cid"));
        let enc = config["client_secret_enc"].as_str().expect("encrypted");
        assert_ne!(enc, "ws-secret", "never stored plaintext");
        assert_eq!(crate::secrets::decrypt_secret(enc).unwrap(), "ws-secret");
        assert!(
            config.get("client_secret").is_none(),
            "the request field never lands in config"
        );

        // cert path wins over a simultaneously-sent secret
        let req = sp_req(Some((
            "ws-cid",
            Some("ws-secret"),
            Some(("CERT-PEM", "KEY-PEM")),
        )));
        let config = sharepoint_config_from_req(&req, true).unwrap();
        assert_eq!(
            config["client_certificate_pem"],
            json!("CERT-PEM"),
            "cert is public, plaintext"
        );
        let key_enc = config["client_private_key_enc"]
            .as_str()
            .expect("encrypted");
        assert_eq!(crate::secrets::decrypt_secret(key_enc).unwrap(), "KEY-PEM");
        assert!(
            config.get("client_secret_enc").is_none(),
            "cert wins over secret"
        );
    }

    /// public_config for sharepoint (spec): strips client_secret_enc +
    /// client_private_key_enc, keeps client_id + tenant/site/drive fields, adds
    /// credentials: "workspace" | "server-app".
    #[test]
    fn sharepoint_config_is_redacted_for_members() {
        let ws = json!({
            "tenant_id": "contoso.onmicrosoft.com",
            "site_url": "https://contoso.sharepoint.com/sites/eng",
            "site_id": "contoso.sharepoint.com,g1,g2",
            "drive_id": "drv-1", "drive_name": "Documents", "prefix": "",
            "client_id": "ws-cid", "client_secret_enc": "AAAA",
        });
        let public = public_config("sharepoint", &ws);
        assert_eq!(public.get("client_secret_enc"), None);
        assert_eq!(public["client_id"], json!("ws-cid"));
        assert_eq!(
            public["site_url"],
            json!("https://contoso.sharepoint.com/sites/eng")
        );
        assert_eq!(public["drive_name"], json!("Documents"));
        assert_eq!(public["credentials"], json!("workspace"));

        let cert = json!({
            "tenant_id": "t", "site_id": "s", "drive_id": "d",
            "client_id": "c", "client_certificate_pem": "CERT", "client_private_key_enc": "BBBB",
        });
        let public = public_config("sharepoint", &cert);
        assert_eq!(public.get("client_private_key_enc"), None);
        assert_eq!(public["credentials"], json!("workspace"));

        let server_app = json!({ "tenant_id": "t", "site_id": "s", "drive_id": "d" });
        assert_eq!(
            public_config("sharepoint", &server_app)["credentials"],
            json!("server-app")
        );
    }

    /// DB-gated: a sharepoint row persists and lists like any other kind; the listing
    /// redaction applies. (The probe→bind→activate lifecycle is kind-agnostic and
    /// already locked by storage.rs's bind_workspace_attaches_and_activates.)
    #[tokio::test]
    async fn sharepoint_connection_row_round_trips() {
        let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
            eprintln!(
                "skipping: set TEST_DATABASE_URL to run sharepoint_connection_row_round_trips"
            );
            return;
        };
        let p = crate::persistence::Persistence::connect(&url)
            .await
            .expect("connect TEST_DATABASE_URL");
        let owner = p.create_agent_user("sp-owner").await.unwrap();
        let ws = p.create_workspace("SP Round Trip", owner).await.unwrap();
        let config = json!({
            "tenant_id": "contoso.onmicrosoft.com",
            "site_url": "https://contoso.sharepoint.com/sites/eng",
            "site_id": "contoso.sharepoint.com,g1,g2",
            "drive_id": "drv-1", "drive_name": "Documents", "prefix": "",
            "client_id": "cid", "client_secret_enc": "AAAA",
        });
        let id = p
            .create_storage_connection(ws, "sharepoint", &config)
            .await
            .unwrap();
        let rows = p.list_storage_connections(ws).await.unwrap();
        let row = rows.iter().find(|r| r.id == id).expect("row exists");
        assert_eq!(row.kind, "sharepoint");
        assert_eq!(row.config["drive_id"], json!("drv-1"));
        let public = public_config("sharepoint", &row.config);
        assert_eq!(public.get("client_secret_enc"), None);
        assert_eq!(public["credentials"], json!("workspace"));
    }
}
