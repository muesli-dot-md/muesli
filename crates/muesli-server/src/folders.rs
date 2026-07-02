//! Folders, trash, and rename (migration 0008): the document-organization REST surface.
//!
//! - **Folders** are a per-workspace hierarchy (`workspace_id` null = the open-mode
//!   space). Sibling names are unique among live folders (case-insensitive); moving a
//!   folder under its own descendant is a 409 (cycle).
//! - **Trash** is a soft delete: `deleted_at` stamped on a document, or on a whole
//!   folder subtree (folders + documents). Trashed documents refuse new room
//!   connections (auth::resolve_access answers 410) and vanish from listings, the link
//!   graph, and link resolution until restored. Purge is the hard delete, with explicit
//!   ordered child-table deletes (no cascades on the crdt_* tables).
//! - **Rename** stores a display `title` on the document. This deliberately deviates
//!   from ADR 0013's "titles stay derived": the slug is the immutable room identifier
//!   and survives every rename, so links/URLs never break; the title is presentation.
//!
//! Storage tie-in (ADR 0013): a document's backend rel_path mirrors its folder chain
//! (`storage::rel_path_for`). Moving a document — or renaming/moving any folder above
//! it — relocates the canonical file (write new path, delete old,
//! `StorageManager::relocate`). Trashing does NOT touch the backend file: canonical
//! storage is user-owned, the file stays in place and the loops simply stop touching it.
//!
//! Auth mirrors the existing document routes: open mode allows everything; OIDC mode
//! requires Editor on the document, or membership in the folder's workspace.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde::{Deserialize, Deserializer};
use serde_json::json;
use tracing::warn;
use uuid::Uuid;

use muesli_core::events::{WorkspaceEvent, WorkspaceEventEnvelope};

use crate::audit::{self, AuditEvent};
use crate::auth::Role;
use crate::persistence::{DocRef, FolderRow, Persistence};
use crate::AppState;

const NO_DB: &str = "this endpoint requires DATABASE_URL (server is running volatile)";

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, msg.into()).into_response()
}

fn err500(e: anyhow::Error) -> Response {
    warn!(%e, "folders api error");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

/// Map a constraint-named DB error to 409, anything else to 500.
fn conflict_or_500(e: anyhow::Error, constraint: &str, msg: &str) -> Response {
    if e.to_string().contains(constraint) {
        err(StatusCode::CONFLICT, msg)
    } else {
        err500(e)
    }
}

/// The cross-workspace slug-collision sentinel raised by
/// persistence::create_document_in_workspace. Pure so the 409 mapping is unit-tested.
fn is_slug_conflict(e: &anyhow::Error) -> bool {
    e.to_string().contains("slug_in_other_workspace")
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/// Folder names become rel_path segments (storage::rel_path_for), so they must be
/// non-empty, slash-free, and not the path dots.
pub(crate) fn valid_folder_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 200 && !name.contains('/') && name != "." && name != ".."
}

/// Would re-parenting `folder` under `new_parent` create a cycle? True when the walk
/// from `new_parent` to the root passes through `folder` (or when new_parent IS the
/// folder). `parents` is the live (id → parent_id) map of the workspace scope.
pub(crate) fn creates_cycle(
    folder: Uuid,
    new_parent: Option<Uuid>,
    parents: &std::collections::HashMap<Uuid, Option<Uuid>>,
) -> bool {
    let mut cur = new_parent;
    let mut hops = 0usize;
    while let Some(id) = cur {
        if id == folder {
            return true;
        }
        hops += 1;
        if hops > parents.len() {
            return true; // a pre-existing cycle in the data; refuse to extend it
        }
        cur = parents.get(&id).copied().flatten();
    }
    false
}

/// Map an applied folder update to the structure events it produced: a rename if `name`
/// changed, a move if `parent` changed (Contract 1). `name`/`parent` are `Some(..)` only
/// when that field actually changed in this request.
fn folder_update_events(
    id: Uuid,
    name: Option<String>,
    parent: Option<Option<Uuid>>,
) -> Vec<WorkspaceEvent> {
    let mut out = Vec::new();
    if let Some(name) = name {
        out.push(WorkspaceEvent::FolderRenamed {
            id: id.to_string(),
            name,
        });
    }
    if let Some(parent_id) = parent {
        out.push(WorkspaceEvent::FolderMoved {
            id: id.to_string(),
            parent_id: parent_id.map(|p| p.to_string()),
        });
    }
    out
}

/// Map an applied document update to its structure events (Contract 1). `title` is
/// `Some(_)` only when the title field changed (inner `Option` = the new title, None =
/// cleared to the slug fallback); `folder` is `Some(_)` only when the folder changed.
fn document_update_events(
    slug: &str,
    title: Option<Option<String>>,
    folder: Option<Option<Uuid>>,
) -> Vec<WorkspaceEvent> {
    let mut out = Vec::new();
    if let Some(title) = title {
        out.push(WorkspaceEvent::DocRenamed {
            slug: slug.to_string(),
            title,
        });
    }
    if let Some(folder_id) = folder {
        out.push(WorkspaceEvent::DocMoved {
            slug: slug.to_string(),
            folder_id: folder_id.map(|f| f.to_string()),
        });
    }
    out
}

/// The originating sync client-id (Contract 3 echo-guard) from `x-muesli-client-id`, if the
/// caller is the daemon. UI/browser callers omit it → `None`.
fn origin_of(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get("x-muesli-client-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

/// serde helper distinguishing "field absent" (no change) from "field: null" (clear):
/// wrap in Option<Option<T>> with #[serde(default, deserialize_with = "some")].
fn some<'de, T, D>(d: D) -> Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    T::deserialize(d).map(Some)
}

// ---------------------------------------------------------------------------
// Auth seams
// ---------------------------------------------------------------------------

/// An authenticated (or open-mode) folders-API caller. `user` is None in open mode.
struct Ctx {
    persistence: Arc<Persistence>,
    user: Option<Uuid>,
    workspace_restriction: Option<Uuid>,
    /// A token confined to ONE document (mirroring auth::resolve_access / doc_editor):
    /// such a principal must never perform workspace-wide structural changes, so
    /// require_workspace rejects it outright.
    document_restriction: Option<Uuid>,
}

async fn ctx(
    state: &AppState,
    jar: &CookieJar,
    headers: &axum::http::HeaderMap,
) -> Result<Ctx, Response> {
    let Some(persistence) = state.persistence.clone() else {
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, NO_DB));
    };
    match state.auth.as_ref() {
        // Open mode: everything allowed, like the existing document routes (ADR 0012).
        None => Ok(Ctx {
            persistence,
            user: None,
            workspace_restriction: None,
            document_restriction: None,
        }),
        Some(auth) => match auth.authenticate(jar, headers).await {
            Some(p) => {
                if p.role_cap < Role::Editor {
                    return Err(err(StatusCode::FORBIDDEN, "requires the write scope"));
                }
                Ok(Ctx {
                    persistence,
                    user: Some(p.role_user),
                    workspace_restriction: p.workspace_restriction,
                    document_restriction: p.document_restriction,
                })
            }
            None => Err(err(StatusCode::UNAUTHORIZED, "sign in")),
        },
    }
}

impl Ctx {
    /// Folder authorization: open mode allows everything; OIDC mode requires membership
    /// in the folder's workspace. A workspace-less folder (open-mode row) is 403 in
    /// OIDC mode — the same posture as pre-auth ownerless documents.
    async fn require_workspace(&self, workspace_id: Option<Uuid>) -> Result<(), Response> {
        let Some(user) = self.user else { return Ok(()) };
        // A document-restricted token is confined to that one document; folder trees,
        // subtree trash/restore, and document creation are workspace-wide structural
        // operations it must never perform (the same hard boundary resolve_access and
        // doc_editor enforce).
        if self.document_restriction.is_some() {
            return Err(err(
                StatusCode::FORBIDDEN,
                "your token is restricted to a single document",
            ));
        }
        if let Some(r) = self.workspace_restriction {
            if workspace_id != Some(r) {
                return Err(err(
                    StatusCode::FORBIDDEN,
                    "your token is restricted to another workspace",
                ));
            }
        }
        let Some(ws) = workspace_id else {
            return Err(err(
                StatusCode::FORBIDDEN,
                "this folder belongs to no workspace",
            ));
        };
        match self.persistence.workspace_role(ws, user).await {
            Ok(Some(_)) => Ok(()),
            Ok(None) => Err(err(
                StatusCode::FORBIDDEN,
                "you are not a member of this workspace",
            )),
            Err(e) => Err(err500(e)),
        }
    }

    /// The owner/creator uuid for a created document: the authenticated user in OIDC mode.
    /// In open mode there is no user — fall back to the nil uuid so the ACL grant is inert
    /// (open mode never reads document_acl; resolve_access allows everything).
    fn user_or_creator(&self) -> Uuid {
        self.user.unwrap_or(Uuid::nil())
    }
}

/// The trash/rename seam for one document: Editor on the document, persistence in hand.
/// Unlike auth::resolve_access this never answers 410 for trashed documents — restore
/// and purge exist precisely to act on them. Returns (persistence, doc, actor).
async fn doc_editor(
    state: &AppState,
    slug: &str,
    jar: &CookieJar,
    headers: &axum::http::HeaderMap,
) -> Result<(Arc<Persistence>, DocRef, Option<Uuid>), Response> {
    let Some(p) = state.persistence.clone() else {
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, NO_DB));
    };
    let doc = match p.find_document(slug).await {
        Ok(Some(d)) => d,
        Ok(None) => return Err(err(StatusCode::NOT_FOUND, "no such document")),
        Err(e) => return Err(err500(e)),
    };
    let Some(auth) = state.auth.as_ref() else {
        return Ok((p, doc, None)); // open mode
    };
    let Some(principal) = auth.authenticate(jar, headers).await else {
        return Err(err(StatusCode::UNAUTHORIZED, "sign in"));
    };
    let restricted = principal.document_restriction.is_some_and(|d| d != doc.id)
        || principal
            .workspace_restriction
            .is_some_and(|w| doc.workspace_id != Some(w));
    if restricted {
        return Err(err(
            StatusCode::FORBIDDEN,
            "your token is restricted elsewhere",
        ));
    }
    let role = match p.user_role(doc.id, principal.role_user).await {
        Ok(r) => r.map(|r| r.min(principal.role_cap)),
        Err(e) => return Err(err500(e)),
    };
    if role < Some(Role::Editor) {
        return Err(err(StatusCode::FORBIDDEN, "requires the editor role"));
    }
    Ok((p, doc, Some(principal.role_user)))
}

// ---------------------------------------------------------------------------
// Storage relocation after folder changes
// ---------------------------------------------------------------------------

/// Relocate every given attached document to its recomputed rel_path. The DB change
/// that triggered this already stands; failures are surfaced (502) but never undo it.
async fn relocate_all(state: &AppState, doc_ids: Vec<Uuid>) -> Vec<String> {
    let Some(mgr) = state.storage.clone() else {
        return Vec::new();
    };
    let mut errors = Vec::new();
    for id in doc_ids {
        if let Err(e) = mgr.relocate(id).await {
            warn!(doc_id = %id, %e, "storage relocation failed after folder change");
            errors.push(format!("{id}: {e}"));
        }
    }
    errors
}

fn relocation_response(payload: serde_json::Value, errors: Vec<String>) -> Response {
    if errors.is_empty() {
        Json(payload).into_response()
    } else {
        // The metadata change stands; the canonical file(s) could not be moved. The
        // next materialize self-heals the new path; the old file may linger.
        err(
            StatusCode::BAD_GATEWAY,
            format!(
                "updated, but storage relocation failed: {}",
                errors.join("; ")
            ),
        )
    }
}

fn folder_json(f: &FolderRow) -> serde_json::Value {
    json!({
        "id": f.id,
        "workspace_id": f.workspace_id,
        "parent_id": f.parent_id,
        "name": f.name,
        "updated_at": f.updated_at,
        "deleted_at": f.deleted_at,
    })
}

// ---------------------------------------------------------------------------
// Folder routes
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct CreateFolderReq {
    name: String,
    parent_id: Option<Uuid>,
    workspace_id: Option<Uuid>,
}

/// POST /api/folders {name, parent_id?, workspace_id?} — create a folder. The default
/// workspace is the parent's, else (OIDC mode) the caller's primary workspace (400s if
/// they have none — BYO storage: nothing may auto-create one), else (open mode) none.
pub async fn create_folder(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<CreateFolderReq>,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let name = req.name.trim();
    if !valid_folder_name(name) {
        return err(
            StatusCode::BAD_REQUEST,
            "folder name must be non-empty and contain no '/'",
        );
    }
    let parent = match req.parent_id {
        None => None,
        Some(pid) => match c.persistence.get_folder(pid).await {
            Ok(Some(f)) if f.deleted_at.is_none() => Some(f),
            Ok(Some(_)) => return err(StatusCode::CONFLICT, "the parent folder is in the trash"),
            Ok(None) => return err(StatusCode::NOT_FOUND, "no such parent folder"),
            Err(e) => return err500(e),
        },
    };
    let workspace_id = match (&parent, req.workspace_id, c.user) {
        (Some(p), Some(ws), _) if p.workspace_id != Some(ws) => {
            return err(
                StatusCode::BAD_REQUEST,
                "the parent folder belongs to a different workspace",
            )
        }
        (Some(p), _, _) => p.workspace_id,
        (None, Some(ws), _) => Some(ws),
        (None, None, Some(user)) => {
            // OIDC default: the caller's primary workspace (the same default as
            // document creation, persistence::ensure_document_owned). BYO storage:
            // nothing may auto-create workspaces anymore, so a workspace-less user
            // is turned back rather than minted one on the spot.
            match c.persistence.primary_workspace_of(user).await {
                Ok(Some(ws)) => Some(ws),
                Ok(None) => {
                    return err(
                        StatusCode::BAD_REQUEST,
                        "you have no workspace yet — create one first",
                    )
                }
                Err(e) => return err500(e),
            }
        }
        (None, None, None) => None, // open mode: the global space
    };
    if let Err(r) = c.require_workspace(workspace_id).await {
        return r;
    }
    match c
        .persistence
        .create_folder(workspace_id, parent.as_ref().map(|p| p.id), name)
        .await
    {
        Ok(folder) => {
            audit::record(
                &c.persistence,
                AuditEvent::new("folder_created")
                    .workspace(workspace_id)
                    .actor(c.user)
                    .detail(json!({ "folder_id": folder.id, "name": name, "parent_id": folder.parent_id })),
            );
            if let Some(ws) = workspace_id {
                state.workspace_events.publish(
                    ws,
                    WorkspaceEventEnvelope {
                        origin: origin_of(&headers),
                        event: WorkspaceEvent::FolderCreated {
                            id: folder.id.to_string(),
                            parent_id: folder.parent_id.map(|p| p.to_string()),
                            name: name.to_string(),
                        },
                    },
                );
            }
            Json(folder_json(&folder)).into_response()
        }
        Err(e) => conflict_or_500(
            e,
            "folders_sibling_name",
            "a folder with that name already exists here",
        ),
    }
}

#[derive(Deserialize)]
pub struct UpdateFolderReq {
    name: Option<String>,
    /// Absent = leave alone; null = move to the root; a uuid = move under that folder.
    #[serde(default, deserialize_with = "some")]
    parent_id: Option<Option<Uuid>>,
}

/// PATCH /api/folders/{id} {name?, parent_id?} — rename and/or move. Moving a folder
/// under its own descendant is a 409 (cycle); attached documents in the subtree are
/// relocated in their storage backends.
pub async fn update_folder(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<UpdateFolderReq>,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let folder = match c.persistence.get_folder(id).await {
        Ok(Some(f)) => f,
        Ok(None) => return err(StatusCode::NOT_FOUND, "no such folder"),
        Err(e) => return err500(e),
    };
    if let Err(r) = c.require_workspace(folder.workspace_id).await {
        return r;
    }
    if folder.deleted_at.is_some() {
        return err(
            StatusCode::CONFLICT,
            "this folder is in the trash (restore it first)",
        );
    }
    let name = match &req.name {
        None => None,
        Some(n) => {
            let n = n.trim();
            if !valid_folder_name(n) {
                return err(
                    StatusCode::BAD_REQUEST,
                    "folder name must be non-empty and contain no '/'",
                );
            }
            Some(n.to_string())
        }
    };
    if let Some(Some(new_parent)) = req.parent_id {
        let parent = match c.persistence.get_folder(new_parent).await {
            Ok(Some(f)) if f.deleted_at.is_none() => f,
            Ok(Some(_)) => return err(StatusCode::CONFLICT, "the new parent is in the trash"),
            Ok(None) => return err(StatusCode::NOT_FOUND, "no such parent folder"),
            Err(e) => return err500(e),
        };
        if parent.workspace_id != folder.workspace_id {
            return err(
                StatusCode::BAD_REQUEST,
                "cannot move a folder across workspaces",
            );
        }
        let parents: std::collections::HashMap<Uuid, Option<Uuid>> =
            match c.persistence.live_folder_parents(folder.workspace_id).await {
                Ok(rows) => rows.into_iter().collect(),
                Err(e) => return err500(e),
            };
        if creates_cycle(id, Some(new_parent), &parents) {
            return err(
                StatusCode::CONFLICT,
                "cannot move a folder under itself or its own descendant",
            );
        }
    }
    match c
        .persistence
        .update_folder(id, name.as_deref(), req.parent_id)
        .await
    {
        Ok(true) => {}
        Ok(false) => return err(StatusCode::NOT_FOUND, "no such folder"),
        Err(e) => {
            return conflict_or_500(
                e,
                "folders_sibling_name",
                "a folder with that name already exists here",
            )
        }
    }
    // The rel_path of every attached document below this folder just changed.
    let attached = match c.persistence.attached_docs_in_subtree(id).await {
        Ok(v) => v,
        Err(e) => return err500(e),
    };
    let errors = relocate_all(&state, attached).await;
    let updated = match c.persistence.get_folder(id).await {
        Ok(Some(f)) => f,
        Ok(None) => return err(StatusCode::NOT_FOUND, "no such folder"),
        Err(e) => return err500(e),
    };
    audit::record(
        &c.persistence,
        AuditEvent::new("folder_updated")
            .workspace(updated.workspace_id)
            .actor(c.user)
            .detail(
                json!({ "folder_id": id, "name": updated.name, "parent_id": updated.parent_id }),
            ),
    );
    if let Some(ws) = updated.workspace_id {
        for event in folder_update_events(id, name.clone(), req.parent_id) {
            state.workspace_events.publish(
                ws,
                WorkspaceEventEnvelope {
                    origin: origin_of(&headers),
                    event,
                },
            );
        }
    }
    relocation_response(folder_json(&updated), errors)
}

/// DELETE /api/folders/{id} — soft-delete the folder and its ENTIRE subtree (folders +
/// documents) by stamping deleted_at. Backend files stay in place (user-owned storage).
pub async fn delete_folder(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let folder = match c.persistence.get_folder(id).await {
        Ok(Some(f)) => f,
        Ok(None) => return err(StatusCode::NOT_FOUND, "no such folder"),
        Err(e) => return err500(e),
    };
    if let Err(r) = c.require_workspace(folder.workspace_id).await {
        return r;
    }
    match c.persistence.trash_folder_subtree(id).await {
        Ok((folders, documents)) => {
            audit::record(
                &c.persistence,
                AuditEvent::new("folder_trashed")
                    .workspace(folder.workspace_id)
                    .actor(c.user)
                    .detail(json!({ "folder_id": id, "folders": folders, "documents": documents })),
            );
            if let Some(ws) = folder.workspace_id {
                state.workspace_events.publish(
                    ws,
                    WorkspaceEventEnvelope {
                        origin: origin_of(&headers),
                        event: WorkspaceEvent::FolderDeleted { id: id.to_string() },
                    },
                );
            }
            Json(json!({ "trashed": true, "folders": folders, "documents": documents }))
                .into_response()
        }
        Err(e) => err500(e),
    }
}

/// POST /api/folders/{id}/restore — clear deleted_at on the subtree. If the parent is
/// itself still trashed the folder restores to the root level.
pub async fn restore_folder(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let folder = match c.persistence.get_folder(id).await {
        Ok(Some(f)) => f,
        Ok(None) => return err(StatusCode::NOT_FOUND, "no such folder"),
        Err(e) => return err500(e),
    };
    if let Err(r) = c.require_workspace(folder.workspace_id).await {
        return r;
    }
    let (folders, documents) = match c.persistence.restore_folder_subtree(id).await {
        Ok(v) => v,
        Err(e) => {
            return conflict_or_500(
                e,
                "folders_sibling_name",
                "a live folder with that name already exists at the destination",
            )
        }
    };
    // The restore may have re-rooted the folder (trashed parent): rel_paths can change.
    let attached = match c.persistence.attached_docs_in_subtree(id).await {
        Ok(v) => v,
        Err(e) => return err500(e),
    };
    let errors = relocate_all(&state, attached).await;
    audit::record(
        &c.persistence,
        AuditEvent::new("folder_restored")
            .workspace(folder.workspace_id)
            .actor(c.user)
            .detail(json!({ "folder_id": id, "folders": folders, "documents": documents })),
    );
    if let Some(ws) = folder.workspace_id {
        state.workspace_events.publish(
            ws,
            WorkspaceEventEnvelope {
                origin: origin_of(&headers),
                event: WorkspaceEvent::FolderCreated {
                    id: folder.id.to_string(),
                    parent_id: folder.parent_id.map(|p| p.to_string()),
                    name: folder.name.clone(),
                },
            },
        );
    }
    relocation_response(
        json!({ "restored": true, "folders": folders, "documents": documents }),
        errors,
    )
}

// ---------------------------------------------------------------------------
// Document routes: rename / move / trash / restore / purge
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct CreateDocumentReq {
    workspace_id: Uuid,
    slug: String,
    folder_id: Option<Uuid>,
    title: Option<String>,
}

/// POST /api/documents {workspace_id, slug, folder_id?, title?} → 201
/// { document_id, slug, workspace_id, folder_id }. Births a document DIRECTLY in
/// `workspace_id` (Plan 5). PURELY STRUCTURAL — no text/content is accepted or written; the
/// document body is owned by the daemon's CRDT replica (one-replica-per-doc). Auth mirrors
/// create_folder: open mode allowed; OIDC mode requires Editor + membership in workspace_id.
pub async fn create_document(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<CreateDocumentReq>,
) -> Response {
    let c = match ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Err(r) = c.require_workspace(Some(req.workspace_id)).await {
        return r;
    }
    let slug = req.slug.trim();
    if slug.is_empty() {
        return err(StatusCode::BAD_REQUEST, "slug is empty");
    }
    // Folder/workspace consistency — the same check update_document enforces: a foldered doc
    // and its folder must share a workspace. This is the constraint that today blocks
    // shared-workspace document creation; Phase B satisfies it by creating the folder chain in
    // W first.
    if let Some(fid) = req.folder_id {
        let folder = match c.persistence.get_folder(fid).await {
            Ok(Some(f)) if f.deleted_at.is_none() => f,
            Ok(Some(_)) => return err(StatusCode::CONFLICT, "that folder is in the trash"),
            Ok(None) => return err(StatusCode::NOT_FOUND, "no such folder"),
            Err(e) => return err500(e),
        };
        if folder.workspace_id != Some(req.workspace_id) {
            return err(
                StatusCode::BAD_REQUEST,
                "the folder belongs to a different workspace than the document",
            );
        }
    }
    let title = req
        .title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let created = match c
        .persistence
        .create_document_in_workspace(
            slug,
            req.workspace_id,
            req.folder_id,
            title,
            c.user_or_creator(),
        )
        .await
    {
        Ok(d) => d,
        Err(e) if is_slug_conflict(&e) => {
            return err(
                StatusCode::CONFLICT,
                "that slug already exists in another workspace",
            )
        }
        Err(e) => return err500(e),
    };
    audit::record(
        &c.persistence,
        AuditEvent::new("document_created")
            .workspace(Some(created.workspace_id))
            .document(Some(created.id))
            .actor(c.user)
            .detail(json!({
                "slug": slug,
                "folder_id": created.folder_id,
                "title": title,
                "created": created.created,
            })),
    );
    // Reuse the Plan-4 DocCreated emission pattern (restore_document): same fields, same
    // origin echo-guard so the originating daemon ignores its own event.
    state.workspace_events.publish(
        created.workspace_id,
        WorkspaceEventEnvelope {
            origin: origin_of(&headers),
            event: WorkspaceEvent::DocCreated {
                slug: slug.to_string(),
                folder_id: created.folder_id.map(|f| f.to_string()),
                title: title.map(str::to_string),
            },
        },
    );
    // BYO storage (plan 1a task 8): documents born in a bound workspace attach + write
    // through to the backend immediately. Failure is non-fatal — creation stands, the
    // poll/debounce loops retry.
    if let Some(mgr) = state.storage.clone() {
        if let Err(e) = mgr.attach_new_document(created.id).await {
            warn!(doc_id = %created.id, %e, "auto-attach on create failed");
        }
    }
    (
        StatusCode::CREATED,
        Json(json!({
            "document_id": created.id,
            "slug": slug,
            "workspace_id": created.workspace_id,
            "folder_id": created.folder_id,
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct UpdateDocumentReq {
    /// Absent = leave alone; null (or "") = clear back to the slug fallback.
    #[serde(default, deserialize_with = "some")]
    title: Option<Option<String>>,
    /// Absent = leave alone; null = move to the root; a uuid = move into that folder.
    #[serde(default, deserialize_with = "some")]
    folder_id: Option<Option<Uuid>>,
    /// Starred / favourite (migration 0011). Absent = leave alone; true/false = set.
    #[serde(default)]
    starred: Option<bool>,
}

/// PATCH /api/documents/{slug} {title?, folder_id?} — rename (display title; the slug,
/// i.e. the room identifier, deliberately never changes — a deviation from ADR 0013's
/// derived titles) and/or move between folders. Editor on the document.
pub async fn update_document(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<UpdateDocumentReq>,
) -> Response {
    let (p, doc, actor) = match doc_editor(&state, &slug, &jar, &headers).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let mut title_out: Option<Option<String>> = None;
    let mut title_changed = false;
    if let Some(t) = &req.title {
        let t = t
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        title_changed = t != doc.title;
        if let Err(e) = p.set_document_title(doc.id, t.as_deref()).await {
            return err500(e);
        }
        title_out = Some(t);
    }
    let mut moved = false;
    let mut folder_out = doc.folder_id;
    if let Some(target) = req.folder_id {
        if let Some(fid) = target {
            let folder = match p.get_folder(fid).await {
                Ok(Some(f)) if f.deleted_at.is_none() => f,
                Ok(Some(_)) => return err(StatusCode::CONFLICT, "that folder is in the trash"),
                Ok(None) => return err(StatusCode::NOT_FOUND, "no such folder"),
                Err(e) => return err500(e),
            };
            if folder.workspace_id != doc.workspace_id {
                return err(
                    StatusCode::BAD_REQUEST,
                    "the folder belongs to a different workspace than the document",
                );
            }
        }
        if target != doc.folder_id {
            if let Err(e) = p.set_document_folder(doc.id, target).await {
                return err500(e);
            }
            moved = true;
            folder_out = target;
        }
    }
    // Starred / favourite toggle (migration 0011). Independent of rename/move; never
    // bumps updated_at (see set_document_starred) so it can't reorder the recents list.
    let mut starred_out = doc.starred;
    if let Some(starred) = req.starred {
        if starred != doc.starred {
            if let Err(e) = p.set_document_starred(doc.id, starred).await {
                return err500(e);
            }
            starred_out = starred;
        }
    }
    // A folder move changes the implied backend rel_path: relocate the canonical file.
    let errors = if moved {
        relocate_all(&state, vec![doc.id]).await
    } else {
        Vec::new()
    };
    let title_out_for_events = title_out.clone();
    let effective_title = match title_out {
        Some(t) => t,              // just set (or cleared)
        None => doc.title.clone(), // unchanged
    };
    audit::record(
        &p,
        AuditEvent::new("document_updated")
            .workspace(doc.workspace_id)
            .document(Some(doc.id))
            .actor(actor)
            .detail(json!({
                "slug": slug, "title": effective_title.clone(), "moved": moved,
                "folder_id": folder_out, "starred": starred_out,
            })),
    );
    if let Some(ws) = doc.workspace_id {
        let folder_change = if moved { Some(folder_out) } else { None };
        for event in document_update_events(&slug, title_out_for_events, folder_change) {
            state.workspace_events.publish(
                ws,
                WorkspaceEventEnvelope {
                    origin: origin_of(&headers),
                    event,
                },
            );
        }
    }
    // A title change renames the canonical backend file (the stem tracks the title; see
    // StorageManager::relocate). A folder move already relocated above with the new title,
    // so only relocate here for a title-only change. Unlike a folder move, a failed rename
    // must NOT fail the PATCH — the display title still changed — so we only warn.
    if title_changed && !moved {
        if let Some(mgr) = state.storage.clone() {
            if let Err(e) = mgr.relocate(doc.id).await {
                warn!(doc_id = %doc.id, %e, "storage relocation failed after title change");
            }
        }
    }
    relocation_response(
        json!({
            "document_id": doc.id,
            "slug": slug,
            "title": effective_title,
            "folder_id": folder_out,
            "starred": starred_out,
        }),
        errors,
    )
}

/// DELETE /api/documents/{slug} — soft delete (trash). The backend file, if any, stays
/// in place: canonical storage is user-owned (ADR 0013), the trash only hides the
/// document inside Muesli and the materialize/poll loops stop touching the file.
pub async fn delete_document(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let (p, doc, actor) = match doc_editor(&state, &slug, &jar, &headers).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if let Err(e) = p.trash_document(doc.id).await {
        return err500(e);
    }
    audit::record(
        &p,
        AuditEvent::new("document_trashed")
            .workspace(doc.workspace_id)
            .document(Some(doc.id))
            .actor(actor)
            .detail(json!({ "slug": slug })),
    );
    if let Some(ws) = doc.workspace_id {
        state.workspace_events.publish(
            ws,
            WorkspaceEventEnvelope {
                origin: origin_of(&headers),
                event: WorkspaceEvent::DocDeleted { slug: slug.clone() },
            },
        );
    }
    Json(json!({ "trashed": true, "document_id": doc.id })).into_response()
}

/// POST /api/documents/{slug}/restore — clear deleted_at. A document whose folder is
/// itself still trashed restores to the root. Inbound wikilinks re-resolve.
pub async fn restore_document(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let (p, doc, actor) = match doc_editor(&state, &slug, &jar, &headers).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let folder_id = match p.restore_document(doc.id).await {
        Ok(f) => f,
        Err(e) => return err500(e),
    };
    // Trash flipped this document's inbound links to unresolved; point them back.
    if let Err(e) = p.resolve_links_to(doc.id, &slug).await {
        warn!(%e, %slug, "re-resolving links after restore failed");
    }
    // The restore may have re-rooted the document (trashed folder): the rel_path moves.
    let errors = if folder_id != doc.folder_id {
        relocate_all(&state, vec![doc.id]).await
    } else {
        Vec::new()
    };
    audit::record(
        &p,
        AuditEvent::new("document_restored")
            .workspace(doc.workspace_id)
            .document(Some(doc.id))
            .actor(actor)
            .detail(json!({ "slug": slug, "folder_id": folder_id })),
    );
    if let Some(ws) = doc.workspace_id {
        state.workspace_events.publish(
            ws,
            WorkspaceEventEnvelope {
                origin: origin_of(&headers),
                event: WorkspaceEvent::DocCreated {
                    slug: slug.clone(),
                    folder_id: folder_id.map(|f| f.to_string()),
                    title: doc.title.clone(),
                },
            },
        );
    }
    relocation_response(
        json!({ "restored": true, "document_id": doc.id, "folder_id": folder_id }),
        errors,
    )
}

/// DELETE /api/documents/{slug}/purge — hard delete: the document row and every child
/// row go away in one transaction (persistence::purge_document). The live room (if
/// any) is dropped from the registry so a later visit creates a genuinely fresh
/// document instead of persisting into a void.
pub async fn purge_document(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let (p, doc, actor) = match doc_editor(&state, &slug, &jar, &headers).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if let Err(e) = p.purge_document(doc.id).await {
        return err500(e);
    }
    state.rooms.lock().unwrap().remove(&slug);
    audit::record(
        &p,
        AuditEvent::new("document_purged")
            .workspace(doc.workspace_id)
            .actor(actor)
            .detail(json!({ "slug": slug, "document_id": doc.id })),
    );
    Json(json!({ "purged": true, "document_id": doc.id })).into_response()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn document_update_emits_rename_and_move_per_changed_field() {
        let slug = "notes";
        // title set + folder changed → DocRenamed then DocMoved.
        let folder = Uuid::now_v7();
        let evs = super::document_update_events(
            slug,
            /* title_changed_to */ Some(Some("Notes".to_string())),
            /* folder_changed_to */ Some(Some(folder)),
        );
        assert_eq!(
            evs,
            vec![
                WorkspaceEvent::DocRenamed {
                    slug: slug.into(),
                    title: Some("Notes".into())
                },
                WorkspaceEvent::DocMoved {
                    slug: slug.into(),
                    folder_id: Some(folder.to_string())
                },
            ]
        );
        // title cleared (None) → DocRenamed{title: None}.
        assert_eq!(
            super::document_update_events(slug, Some(None), None),
            vec![WorkspaceEvent::DocRenamed {
                slug: slug.into(),
                title: None
            }]
        );
        // move to root only.
        assert_eq!(
            super::document_update_events(slug, None, Some(None)),
            vec![WorkspaceEvent::DocMoved {
                slug: slug.into(),
                folder_id: None
            }]
        );
        // nothing changed.
        assert!(super::document_update_events(slug, None, None).is_empty());
    }

    #[test]
    fn folder_update_emits_rename_and_move_per_changed_field() {
        let id = Uuid::now_v7();
        let parent = Uuid::now_v7();
        // name changed, parent changed → two events.
        let evs = super::folder_update_events(
            id,
            /* name_changed */ Some("New".to_string()),
            /* parent_changed */ Some(Some(parent)),
        );
        assert_eq!(evs.len(), 2);
        assert_eq!(
            evs[0],
            WorkspaceEvent::FolderRenamed {
                id: id.to_string(),
                name: "New".into()
            }
        );
        assert_eq!(
            evs[1],
            WorkspaceEvent::FolderMoved {
                id: id.to_string(),
                parent_id: Some(parent.to_string())
            }
        );
        // only a rename → one event.
        let only_name = super::folder_update_events(id, Some("X".into()), None);
        assert_eq!(
            only_name,
            vec![WorkspaceEvent::FolderRenamed {
                id: id.to_string(),
                name: "X".into()
            }]
        );
        // only a move to root → one FolderMoved with parent_id None.
        let only_move = super::folder_update_events(id, None, Some(None));
        assert_eq!(
            only_move,
            vec![WorkspaceEvent::FolderMoved {
                id: id.to_string(),
                parent_id: None
            }]
        );
        // nothing changed → no events.
        assert!(super::folder_update_events(id, None, None).is_empty());
    }

    fn parents(edges: &[(Uuid, Option<Uuid>)]) -> HashMap<Uuid, Option<Uuid>> {
        edges.iter().copied().collect()
    }

    #[test]
    fn cycle_detection() {
        let (a, b, c, d) = (
            Uuid::now_v7(),
            Uuid::now_v7(),
            Uuid::now_v7(),
            Uuid::now_v7(),
        );
        // a → b → c (root: a); d is a separate root
        let map = parents(&[(a, None), (b, Some(a)), (c, Some(b)), (d, None)]);

        // moving to the root or under an unrelated tree is fine
        assert!(!creates_cycle(b, None, &map));
        assert!(!creates_cycle(b, Some(d), &map));
        // moving c under a (its grandparent) is fine — still a tree
        assert!(!creates_cycle(c, Some(a), &map));
        // a folder under itself is a cycle
        assert!(creates_cycle(a, Some(a), &map));
        // a under its child or grandchild is a cycle
        assert!(creates_cycle(a, Some(b), &map));
        assert!(creates_cycle(a, Some(c), &map));
        // b under its own child is a cycle
        assert!(creates_cycle(b, Some(c), &map));
        // an unknown parent (not in the live map) terminates the walk — no cycle
        assert!(!creates_cycle(a, Some(Uuid::now_v7()), &map));
    }

    #[test]
    fn cycle_detection_survives_corrupt_data() {
        // x ⇄ y already form a cycle in the map; the walk must terminate (and refuse).
        let (x, y, z) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
        let map = parents(&[(x, Some(y)), (y, Some(x)), (z, None)]);
        assert!(creates_cycle(z, Some(x), &map));
    }

    #[test]
    fn slug_conflict_sentinel_maps_to_409() {
        // The cross-workspace slug error carries this stable sentinel; the handler routes it
        // to 409 through conflict_or_500's substring match (same mechanism as folder names).
        let e = anyhow::anyhow!("slug_in_other_workspace: notes already exists elsewhere");
        assert!(super::is_slug_conflict(&e));
        let other = anyhow::anyhow!("some unrelated db error");
        assert!(!super::is_slug_conflict(&other));
    }

    #[test]
    fn folder_name_validation() {
        assert!(valid_folder_name("Projects"));
        assert!(valid_folder_name("notes 2026"));
        assert!(valid_folder_name("ünïcode"));
        assert!(!valid_folder_name(""));
        assert!(!valid_folder_name("a/b"));
        assert!(!valid_folder_name("."));
        assert!(!valid_folder_name(".."));
        assert!(!valid_folder_name(&"x".repeat(201)));
    }
}
