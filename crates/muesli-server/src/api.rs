//! Phase 2 REST surface (ADR 0019, 0007): comments/threads, suggestions, history, and
//! point-in-time text — all under /api/documents/{slug}/. Anchors are created and resolved
//! inside the room actor (it owns the Doc); Postgres holds the durable rows. Pending
//! suggestions NEVER touch the CRDT or the .md (ADR 0019) — accepting one applies it via
//! the room as a single attributed change set (ADR 0007).

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tracing::warn;
use uuid::Uuid;

use crate::audit::{self, AuditEvent};
use crate::auth::{resolve_access, Access, Role};
use crate::mentions::parse_mentions;
use crate::persistence::{AuthorJson, HistoryRow, Persistence, SuggestionRow};
use crate::room::RoomMsg;
use crate::AppState;

const NO_DB: &str = "this endpoint requires DATABASE_URL (server is running volatile)";

/// Hard caps: every listed thread/suggestion costs one serialized ResolveAnchor on the
/// room actor and every suggestion edit one CreateAnchor — both O(document size) — so an
/// unbounded request could pin the actor and stall live editing for all collaborators.
const MAX_LIST_ITEMS: usize = 200;
const MAX_SUGGESTION_EDITS: usize = 500;

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, msg.into()).into_response()
}

fn err500(e: anyhow::Error) -> Response {
    warn!(%e, "api error");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

/// Ask the room actor something and await the oneshot reply.
async fn room_call<T>(
    room: &mpsc::UnboundedSender<RoomMsg>,
    make: impl FnOnce(oneshot::Sender<T>) -> RoomMsg,
) -> Result<T, Response> {
    let (tx, rx) = oneshot::channel();
    room.send(make(tx))
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "room is gone"))?;
    rx.await.map_err(|_| {
        err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "room dropped the request",
        )
    })
}

/// Everything a collaboration endpoint needs: resolved access (401/403 already handled),
/// the room actor (hydrated exactly like the ws path), persistence, and the document id.
/// Crate-visible so other per-document endpoints (links.rs) share the same seam.
pub(crate) struct ApiCtx {
    pub(crate) access: Access,
    pub(crate) room: mpsc::UnboundedSender<RoomMsg>,
    pub(crate) persistence: Arc<Persistence>,
    pub(crate) document_id: Uuid,
}

pub(crate) async fn ctx(
    state: &AppState,
    slug: &str,
    jar: &CookieJar,
    headers: &axum::http::HeaderMap,
    params: &HashMap<String, String>,
    min_role: Role,
) -> Result<ApiCtx, Response> {
    // Share token: the X-Muesli-Share header wins (keeps the secret out of URLs and
    // access logs); the ?share= query param stays as the fallback.
    let share = headers
        .get("x-muesli-share")
        .and_then(|v| v.to_str().ok())
        .or_else(|| params.get("share").map(String::as_str));
    let access = resolve_access(state, slug, jar, headers, share)
        .await
        .map_err(|status| match status {
            StatusCode::UNAUTHORIZED => err(status, "sign in (or use a share link)"),
            StatusCode::FORBIDDEN => err(status, "you have no access to this document"),
            other => other.into_response(),
        })?;
    if access.role < min_role {
        return Err(err(
            StatusCode::FORBIDDEN,
            format!("requires the {} role", min_role.as_str()),
        ));
    }
    let Some(persistence) = state.persistence.clone() else {
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, NO_DB));
    };
    let room = crate::ensure_room(state, slug);
    // The room answers commands only after hydration, so a reply proves the doc row exists.
    let document_id = room_call(&room, |reply| RoomMsg::GetDocumentId { reply })
        .await?
        .ok_or_else(|| err(StatusCode::SERVICE_UNAVAILABLE, NO_DB))?;
    Ok(ApiCtx {
        access,
        room,
        persistence,
        document_id,
    })
}

fn range_json(range: Option<(usize, usize)>) -> Value {
    match range {
        Some((start, end)) => json!({ "start": start, "end": end }),
        None => Value::Null,
    }
}

// ---------------------------------------------------------------------------
// Members (sub-project ④b — @mention picker)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct MemberJson {
    id: Uuid,
    display_name: Option<String>,
    avatar_url: Option<String>,
    kind: String,
}

/// GET /api/documents/{slug}/members — people who can be @mentioned on this document:
/// the union of the doc's workspace members and explicit share-grantees with current
/// access. Viewer+ (anyone who can see the doc can see who to mention).
pub async fn list_members(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match ctx(&state, &slug, &jar, &headers, &params, Role::Viewer).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let mut members = match c.persistence.list_document_members(c.document_id).await {
        Ok(m) => m,
        Err(e) => return err500(e),
    };
    // Roster scoping: the full roster (workspace members ∪ ACL grantees) is reserved for
    // actual members of the document's workspace; open mode has no tenancy and keeps it
    // all. Anyone else — a share-link guest or a non-member ACL grantee — must not
    // enumerate the workspace from one read-only link, so they see only users with an
    // explicit grant on THIS document (computed as the roster minus workspace members;
    // a dedicated ACL-grantee query in persistence would be cleaner).
    if let Some(auth) = state.auth.as_ref() {
        let doc_ws = match c.persistence.find_document(&slug).await {
            Ok(Some(d)) => d.workspace_id,
            Ok(None) => None,
            Err(e) => return err500(e),
        };
        let caller_is_member = match (auth.authenticate(&jar, &headers).await, doc_ws) {
            (Some(p), Some(ws)) => match c.persistence.workspace_role(ws, p.role_user).await {
                Ok(role) => role.is_some(),
                Err(e) => return err500(e),
            },
            _ => false,
        };
        if !caller_is_member {
            if let Some(ws) = doc_ws {
                let mut grantees = Vec::with_capacity(members.len());
                for m in members {
                    match c.persistence.workspace_role(ws, m.id).await {
                        // Visible only via workspace membership: hidden from non-members.
                        Ok(Some(_)) => {}
                        Ok(None) => grantees.push(m),
                        Err(e) => return err500(e),
                    }
                }
                members = grantees;
            }
            // doc_ws == None: the roster already contains only ACL grantees (the
            // membership arm of list_document_members joins on the workspace).
        }
    }
    let out: Vec<MemberJson> = members
        .into_iter()
        .map(|m| MemberJson {
            id: m.id,
            display_name: m.display_name,
            avatar_url: m.avatar_url,
            kind: m.kind,
        })
        .collect();
    Json(json!({ "members": out })).into_response()
}

// ---------------------------------------------------------------------------
// Comments (ADR 0019)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct CommentJson {
    id: Uuid,
    body: String,
    created_at: String,
    author: Option<AuthorJson>,
}

#[derive(Serialize)]
struct ThreadJson {
    id: Uuid,
    status: String,
    range: Value,
    created_by: Option<Uuid>,
    created_at: String,
    comments: Vec<CommentJson>,
}

/// GET /api/documents/{slug}/comments?status= — threads with replies and their current
/// resolved range. Orphaning is lazy (ADR 0019): open threads whose anchor is gone or
/// collapsed flip to 'orphaned' here; orphaned ones that resolve again flip back to 'open'.
pub async fn list_comments(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match ctx(&state, &slug, &jar, &headers, &params, Role::Viewer).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let (mut threads, comments) = match tokio::try_join!(
        c.persistence.list_threads(c.document_id),
        c.persistence.list_comments(c.document_id),
    ) {
        Ok(v) => v,
        Err(e) => return err500(e),
    };
    // Hard cap: each thread costs one serialized ResolveAnchor on the room actor, so an
    // inflated thread count must not turn one list call into seconds of pinned actor time.
    threads.truncate(MAX_LIST_ITEMS);
    let mut by_thread: HashMap<Uuid, Vec<CommentJson>> = HashMap::new();
    for cm in comments {
        by_thread
            .entry(cm.thread_id)
            .or_default()
            .push(CommentJson {
                id: cm.id,
                body: cm.body,
                created_at: cm.created_at,
                author: cm.author,
            });
    }

    let mut out = Vec::with_capacity(threads.len());
    for t in threads {
        let range = match room_call(&c.room, |reply| RoomMsg::ResolveAnchor {
            anchor: t.anchor.clone(),
            reply,
        })
        .await
        {
            Ok(r) => r,
            Err(r) => return r,
        };
        let gone = range.is_none_or(|(s, e)| s >= e);
        let status = match (t.status.as_str(), gone) {
            ("open", true) => "orphaned",
            ("orphaned", false) => "open",
            (other, _) => other,
        };
        if status != t.status {
            if let Err(e) = c.persistence.set_thread_status(t.id, status).await {
                return err500(e);
            }
        }
        out.push(ThreadJson {
            id: t.id,
            status: status.to_string(),
            range: range_json(range),
            created_by: t.created_by,
            created_at: t.created_at,
            comments: by_thread.remove(&t.id).unwrap_or_default(),
        });
    }
    if let Some(filter) = params.get("status") {
        out.retain(|t| &t.status == filter);
    }
    // "mentions you" filter (sub-project ④b): keep only threads where the authenticated
    // caller is tagged. Guests (no user_id) get an empty result rather than everything.
    if params.get("mentions").map(String::as_str) == Some("me") {
        let mentioned = match c.access.user_id {
            Some(uid) => match c.persistence.threads_mentioning(c.document_id, uid).await {
                Ok(set) => set,
                Err(e) => return err500(e),
            },
            None => std::collections::HashSet::new(),
        };
        out.retain(|t| mentioned.contains(&t.id));
    }
    Json(json!({ "threads": out })).into_response()
}

#[derive(Deserialize)]
pub struct CreateCommentReq {
    anchor_start: usize,
    anchor_end: usize,
    body: String,
}

/// POST /api/documents/{slug}/comments — new thread + first comment. Commenter+.
pub async fn create_comment(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<CreateCommentReq>,
) -> Response {
    let c = match ctx(&state, &slug, &jar, &headers, &params, Role::Commenter).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if req.body.trim().is_empty() {
        return err(StatusCode::BAD_REQUEST, "comment body is empty");
    }
    let anchor = match room_call(&c.room, |reply| RoomMsg::CreateAnchor {
        start: req.anchor_start,
        end: req.anchor_end,
        reply,
    })
    .await
    {
        Ok(Ok(a)) => a,
        Ok(Err(e)) => return err(StatusCode::BAD_REQUEST, e),
        Err(r) => return r,
    };
    match c
        .persistence
        .create_thread(c.document_id, &anchor, c.access.user_id, &req.body)
        .await
    {
        Ok((thread_id, comment_id)) => {
            record_body_mentions(&state, &c, &slug, thread_id, comment_id, &req.body).await;
            Json(json!({
                "thread_id": thread_id,
                "comment_id": comment_id,
                "status": "open",
                "range": { "start": req.anchor_start, "end": req.anchor_end },
            }))
            .into_response()
        }
        Err(e) => err500(e),
    }
}

/// Parse `@[Name](muesli:user/<uuid>)` tokens out of a freshly-stored comment body and
/// persist authoritative `mention` rows (sub-project ④b), enqueuing one in-app notification
/// per newly-mentioned recipient in the SAME transaction (sub-project ④c). Best-effort: a
/// mention-write failure never fails the comment that already committed — it's logged and
/// dropped.
///
/// Out-of-band delivery (email) is then SPAWNED off this path so the triggering request never
/// blocks on SMTP. No digest batching, no durable queue/retries (explicit later hardening).
async fn record_body_mentions(
    state: &AppState,
    c: &ApiCtx,
    slug: &str,
    thread_id: Uuid,
    comment_id: Uuid,
    body: &str,
) {
    let recipients = parse_mentions(body);
    if recipients.is_empty() {
        return;
    }
    // Trust boundary: a mention may only ever reach the document's authorized audience —
    // workspace members ∪ explicit ACL grantees (exactly what list_document_members
    // returns). Any other UUID a commenter types into the body (e.g. a user harvested
    // from another tenant) is dropped HERE, before any mention row, in-app notification,
    // or email exists.
    let audience: std::collections::HashSet<Uuid> =
        match c.persistence.list_document_members(c.document_id).await {
            Ok(members) => members.into_iter().map(|m| m.id).collect(),
            Err(e) => {
                warn!(%e, "failed to load the document's mention audience; dropping mentions");
                return;
            }
        };
    let recipients: Vec<Uuid> = recipients
        .into_iter()
        .filter(|r| audience.contains(r))
        .collect();
    if recipients.is_empty() {
        return;
    }
    // Resolve the actor's display name and the document title for the notification payload /
    // email. Both best-effort: a missing name renders as "Someone", a missing title as the slug.
    let actor_name = match c.access.user_id {
        Some(uid) => c
            .persistence
            .get_user(uid)
            .await
            .ok()
            .flatten()
            .and_then(|u| u.display_name),
        None => None,
    };
    let doc_title = c
        .persistence
        .find_document(slug)
        .await
        .ok()
        .flatten()
        .and_then(|d| d.title)
        .unwrap_or_else(|| slug.to_string());
    let actor_label = actor_name.clone().unwrap_or_else(|| "Someone".to_string());

    let dispatch = match c
        .persistence
        .record_mentions(
            c.document_id,
            thread_id,
            comment_id,
            c.access.user_id,
            actor_name.as_deref(),
            slug,
            &doc_title,
            &recipients,
        )
        .await
    {
        Ok(d) => d,
        Err(e) => {
            warn!(%e, "failed to record mentions");
            return;
        }
    };

    // Fan out to out-of-band channels off the request path. The in-app notification row is
    // already committed above; here we only deliver email for recipients whose matrix enables it.
    let Some(dispatcher) = state.dispatcher.clone() else {
        return;
    };
    let doc_url = crate::notifications::doc_deep_link(&state.web_origin, slug);
    for ctx in dispatch {
        let dispatcher = dispatcher.clone();
        let rendered = crate::notifications::RenderedNotification {
            event_type: crate::notifications::EVENT_MENTION.to_string(),
            recipient_id: ctx.recipient_id,
            recipient_email: ctx.recipient_email,
            actor_name: actor_label.clone(),
            doc_title: doc_title.clone(),
            doc_url: doc_url.clone(),
        };
        let prefs = ctx.prefs;
        tokio::spawn(async move {
            dispatcher.dispatch(&rendered, &prefs).await;
        });
    }
}

#[derive(Deserialize)]
pub struct ReplyReq {
    body: String,
}

/// Look a thread up and check it belongs to this document.
async fn thread_in_doc(c: &ApiCtx, thread_id: Uuid) -> Result<String, Response> {
    match c.persistence.thread_ref(thread_id).await {
        Ok(Some((doc, status))) if doc == c.document_id => Ok(status),
        Ok(_) => Err(err(
            StatusCode::NOT_FOUND,
            "no such thread on this document",
        )),
        Err(e) => Err(err500(e)),
    }
}

/// POST /api/documents/{slug}/comments/{thread_id}/replies — Commenter+.
pub async fn reply_comment(
    State(state): State<AppState>,
    Path((slug, thread_id)): Path<(String, Uuid)>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<ReplyReq>,
) -> Response {
    let c = match ctx(&state, &slug, &jar, &headers, &params, Role::Commenter).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if req.body.trim().is_empty() {
        return err(StatusCode::BAD_REQUEST, "comment body is empty");
    }
    if let Err(r) = thread_in_doc(&c, thread_id).await {
        return r;
    }
    match c
        .persistence
        .add_comment(thread_id, c.access.user_id, &req.body)
        .await
    {
        Ok(comment_id) => {
            record_body_mentions(&state, &c, &slug, thread_id, comment_id, &req.body).await;
            Json(json!({ "comment_id": comment_id })).into_response()
        }
        Err(e) => err500(e),
    }
}

/// POST .../comments/{thread_id}/resolve and /reopen — Commenter+. Resolving hides but
/// preserves (ADR 0019); reopening hands the thread back to the lazy orphan check.
async fn set_thread_status(
    state: AppState,
    slug: String,
    thread_id: Uuid,
    params: HashMap<String, String>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    status: &str,
) -> Response {
    let c = match ctx(&state, &slug, &jar, &headers, &params, Role::Commenter).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Err(r) = thread_in_doc(&c, thread_id).await {
        return r;
    }
    match c.persistence.set_thread_status(thread_id, status).await {
        Ok(()) => {
            if status == "resolved" {
                audit::record(
                    &c.persistence,
                    AuditEvent::new("comment_resolved")
                        .document(Some(c.document_id))
                        .actor(c.access.user_id)
                        .detail(json!({ "thread_id": thread_id })),
                );
            }
            Json(json!({ "thread_id": thread_id, "status": status })).into_response()
        }
        Err(e) => err500(e),
    }
}

pub async fn resolve_thread(
    State(state): State<AppState>,
    Path((slug, thread_id)): Path<(String, Uuid)>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    set_thread_status(state, slug, thread_id, params, jar, headers, "resolved").await
}

pub async fn reopen_thread(
    State(state): State<AppState>,
    Path((slug, thread_id)): Path<(String, Uuid)>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    set_thread_status(state, slug, thread_id, params, jar, headers, "open").await
}

// ---------------------------------------------------------------------------
// Suggestions (ADR 0019 / 0007)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct SuggestionJson {
    id: Uuid,
    change_set_id: Uuid,
    status: String,
    range: Value,
    op: Value,
    note: Option<String>,
    author: Option<AuthorJson>,
    created_at: String,
}

async fn suggestion_json(c: &ApiCtx, s: SuggestionRow) -> Result<SuggestionJson, Response> {
    let range = room_call(&c.room, |reply| RoomMsg::ResolveAnchor {
        anchor: s.anchor.clone(),
        reply,
    })
    .await?;
    Ok(SuggestionJson {
        id: s.id,
        change_set_id: s.change_set_id,
        status: s.status,
        range: range_json(range),
        op: s.op,
        note: s.note,
        author: s.author,
        created_at: s.created_at,
    })
}

/// GET /api/documents/{slug}/suggestions?status=pending — with current resolved ranges.
pub async fn list_suggestions(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match ctx(&state, &slug, &jar, &headers, &params, Role::Viewer).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let mut rows = match c
        .persistence
        .list_suggestions(
            c.document_id,
            params.get("status").map(String::as_str),
            None,
        )
        .await
    {
        Ok(rows) => rows,
        Err(e) => return err500(e),
    };
    // Hard cap: one serialized ResolveAnchor per row (see MAX_LIST_ITEMS).
    rows.truncate(MAX_LIST_ITEMS);
    let mut out = Vec::with_capacity(rows.len());
    for s in rows {
        match suggestion_json(&c, s).await {
            Ok(j) => out.push(j),
            Err(r) => return r,
        }
    }
    Json(json!({ "suggestions": out })).into_response()
}

#[derive(Deserialize)]
pub struct SuggestEdit {
    start: usize,
    end: usize,
    insert: String,
}

#[derive(Deserialize)]
pub struct CreateSuggestionReq {
    edits: Vec<SuggestEdit>,
    note: Option<String>,
}

/// POST /api/documents/{slug}/suggestions — one change_set_id groups all edits (ADR 0007);
/// rows are pending and the CRDT is untouched (ADR 0019). Commenter+.
pub async fn create_suggestion(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<CreateSuggestionReq>,
) -> Response {
    let c = match ctx(&state, &slug, &jar, &headers, &params, Role::Commenter).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if req.edits.is_empty() {
        return err(StatusCode::BAD_REQUEST, "no edits in suggestion");
    }
    // Hard cap: each edit fires one serialized CreateAnchor at the room actor.
    if req.edits.len() > MAX_SUGGESTION_EDITS {
        return err(
            StatusCode::BAD_REQUEST,
            format!("too many edits in one suggestion (max {MAX_SUGGESTION_EDITS})"),
        );
    }
    let mut edits = req.edits;
    edits.sort_by_key(|e| (e.start, e.end));
    for pair in edits.windows(2) {
        if pair[1].start < pair[0].end {
            return err(StatusCode::BAD_REQUEST, "suggestion edits overlap");
        }
    }
    let text = match room_call(&c.room, |reply| RoomMsg::GetText { reply }).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    let mut items = Vec::with_capacity(edits.len());
    for e in &edits {
        if e.start > e.end
            || e.end > text.len()
            || !text.is_char_boundary(e.start)
            || !text.is_char_boundary(e.end)
        {
            return err(
                StatusCode::BAD_REQUEST,
                format!("bad edit range {}..{}", e.start, e.end),
            );
        }
        let anchor = match room_call(&c.room, |reply| RoomMsg::CreateAnchor {
            start: e.start,
            end: e.end,
            reply,
        })
        .await
        {
            Ok(Ok(a)) => a,
            Ok(Err(msg)) => return err(StatusCode::BAD_REQUEST, msg),
            Err(r) => return r,
        };
        let op = json!({
            "start": e.start,
            "end": e.end,
            "insert": e.insert,
            "old_text": &text[e.start..e.end],
        });
        items.push((anchor, op));
    }
    let change_set_id = Uuid::now_v7();
    match c
        .persistence
        .insert_suggestions(
            c.document_id,
            change_set_id,
            &items,
            c.access.user_id,
            req.note.as_deref(),
        )
        .await
    {
        Ok(ids) => Json(json!({
            "change_set_id": change_set_id,
            "suggestion_ids": ids,
            "status": "pending",
        }))
        .into_response(),
        Err(e) => err500(e),
    }
}

/// Resolve a pending suggestion's anchor into a concrete (start, end, insert) op, or a
/// human-readable conflict reason (the anchored text is gone).
async fn resolve_for_accept(
    c: &ApiCtx,
    s: &SuggestionRow,
) -> Result<Result<(usize, usize, String), String>, Response> {
    let range = room_call(&c.room, |reply| RoomMsg::ResolveAnchor {
        anchor: s.anchor.clone(),
        reply,
    })
    .await?;
    let Some((start, end)) = range else {
        return Ok(Err("the suggestion's anchor no longer resolves".into()));
    };
    let old_text = s.op.get("old_text").and_then(Value::as_str).unwrap_or("");
    if start >= end && !old_text.is_empty() {
        return Ok(Err(
            "the text this suggestion would replace was deleted".into()
        ));
    }
    let insert =
        s.op.get("insert")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
    Ok(Ok((start, end, insert)))
}

fn suggestion_origin(s: &SuggestionRow) -> String {
    match &s.author {
        Some(a) if a.kind == "agent" => "agent".into(),
        _ => "human".into(),
    }
}

async fn get_doc_suggestion(c: &ApiCtx, id: Uuid) -> Result<SuggestionRow, Response> {
    match c.persistence.get_suggestion(id).await {
        Ok(Some(s)) if s.document_id == c.document_id => Ok(s),
        Ok(_) => Err(err(
            StatusCode::NOT_FOUND,
            "no such suggestion on this document",
        )),
        Err(e) => Err(err500(e)),
    }
}

/// POST .../suggestions/{id}/accept — Editor only. Applies the edit to the CRDT attributed
/// to the suggestion's AUTHOR under its change_set_id (ADR 0007); 409 when the anchored
/// text is gone.
pub async fn accept_suggestion(
    State(state): State<AppState>,
    Path((slug, id)): Path<(String, Uuid)>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match ctx(&state, &slug, &jar, &headers, &params, Role::Editor).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let s = match get_doc_suggestion(&c, id).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if s.status != "pending" {
        return err(
            StatusCode::CONFLICT,
            format!("suggestion is already {}", s.status),
        );
    }
    let (start, end, insert) = match resolve_for_accept(&c, &s).await {
        Ok(Ok(op)) => op,
        Ok(Err(reason)) => return err(StatusCode::CONFLICT, reason),
        Err(r) => return r,
    };
    let seq = match room_call(&c.room, |reply| RoomMsg::ApplyEdit {
        ops: vec![(start, end, insert.clone())],
        author_id: s.author.as_ref().map(|a| a.id),
        change_set_id: Some(s.change_set_id),
        origin: suggestion_origin(&s),
        reply,
    })
    .await
    {
        Ok(Ok(seq)) => seq,
        Ok(Err(e)) => return err(StatusCode::CONFLICT, e),
        Err(r) => return r,
    };
    if let Err(e) = c.persistence.set_suggestion_status(id, "accepted").await {
        return err500(e);
    }
    audit::record(
        &c.persistence,
        AuditEvent::new("suggestion_accepted")
            .document(Some(c.document_id))
            .actor(c.access.user_id)
            .detail(json!({ "suggestion_id": id, "change_set_id": s.change_set_id, "seq": seq })),
    );
    Json(json!({
        "id": id,
        "status": "accepted",
        "applied": { "start": start, "end": end, "insert": insert },
        "seq": seq,
    }))
    .into_response()
}

/// POST .../suggestions/{id}/reject — Editor, or the suggestion's author themself.
pub async fn reject_suggestion(
    State(state): State<AppState>,
    Path((slug, id)): Path<(String, Uuid)>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match ctx(&state, &slug, &jar, &headers, &params, Role::Commenter).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let s = match get_doc_suggestion(&c, id).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let is_author =
        c.access.user_id.is_some() && c.access.user_id == s.author.as_ref().map(|a| a.id);
    if !(c.access.role.can_edit() || is_author) {
        return err(
            StatusCode::FORBIDDEN,
            "only editors (or the author) can reject",
        );
    }
    if s.status != "pending" {
        return err(
            StatusCode::CONFLICT,
            format!("suggestion is already {}", s.status),
        );
    }
    if let Err(e) = c.persistence.set_suggestion_status(id, "rejected").await {
        return err500(e);
    }
    audit::record(
        &c.persistence,
        AuditEvent::new("suggestion_rejected")
            .document(Some(c.document_id))
            .actor(c.access.user_id)
            .detail(json!({ "suggestion_id": id, "change_set_id": s.change_set_id })),
    );
    Json(json!({ "id": id, "status": "rejected" })).into_response()
}

/// POST .../suggestions/changesets/{change_set_id}/accept — Editor. Applies every pending
/// suggestion in the set in anchor order as ONE atomic CRDT transaction, skipping (and
/// reporting) the ones whose anchored text is gone or which overlap an earlier edit.
pub async fn accept_change_set(
    State(state): State<AppState>,
    Path((slug, change_set_id)): Path<(String, Uuid)>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match ctx(&state, &slug, &jar, &headers, &params, Role::Editor).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let rows = match c
        .persistence
        .list_suggestions(c.document_id, Some("pending"), Some(change_set_id))
        .await
    {
        Ok(rows) => rows,
        Err(e) => return err500(e),
    };
    if rows.is_empty() {
        return err(
            StatusCode::NOT_FOUND,
            "no pending suggestions in this change set",
        );
    }

    let mut conflicts: Vec<Value> = Vec::new();
    let mut resolved: Vec<(usize, usize, String, Uuid)> = Vec::new();
    for s in &rows {
        match resolve_for_accept(&c, s).await {
            Ok(Ok((start, end, insert))) => resolved.push((start, end, insert, s.id)),
            Ok(Err(reason)) => conflicts.push(json!({ "id": s.id, "reason": reason })),
            Err(r) => return r,
        }
    }
    // Apply in anchor order; anything overlapping an earlier accepted edit conflicts out.
    resolved.sort_by_key(|(start, end, ..)| (*start, *end));
    let mut ops: Vec<(usize, usize, String)> = Vec::new();
    let mut accepted: Vec<Uuid> = Vec::new();
    let mut prev_end = 0usize;
    for (start, end, insert, id) in resolved {
        if !ops.is_empty() && start < prev_end {
            conflicts.push(json!({ "id": id, "reason": "overlaps an earlier edit in the set" }));
            continue;
        }
        prev_end = end;
        ops.push((start, end, insert));
        accepted.push(id);
    }

    let mut seq: Option<i64> = None;
    if !ops.is_empty() {
        let author = rows[0].author.as_ref().map(|a| a.id);
        let origin = suggestion_origin(&rows[0]);
        match room_call(&c.room, |reply| RoomMsg::ApplyEdit {
            ops,
            author_id: author,
            change_set_id: Some(change_set_id),
            origin,
            reply,
        })
        .await
        {
            Ok(Ok(s)) => seq = Some(s),
            Ok(Err(e)) => return err(StatusCode::CONFLICT, e),
            Err(r) => return r,
        }
        for id in &accepted {
            if let Err(e) = c.persistence.set_suggestion_status(*id, "accepted").await {
                return err500(e);
            }
        }
        audit::record(
            &c.persistence,
            AuditEvent::new("suggestion_accepted")
                .document(Some(c.document_id))
                .actor(c.access.user_id)
                .detail(json!({
                    "change_set_id": change_set_id,
                    "accepted_count": accepted.len(),
                    "conflict_count": conflicts.len(),
                    "seq": seq,
                })),
        );
    }
    Json(json!({
        "change_set_id": change_set_id,
        "accepted": accepted,
        "conflicts": conflicts,
        "seq": seq,
    }))
    .into_response()
}

/// POST .../suggestions/changesets/{change_set_id}/reject — Editor or the set's author.
pub async fn reject_change_set(
    State(state): State<AppState>,
    Path((slug, change_set_id)): Path<(String, Uuid)>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match ctx(&state, &slug, &jar, &headers, &params, Role::Commenter).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let rows = match c
        .persistence
        .list_suggestions(c.document_id, Some("pending"), Some(change_set_id))
        .await
    {
        Ok(rows) => rows,
        Err(e) => return err500(e),
    };
    if rows.is_empty() {
        return err(
            StatusCode::NOT_FOUND,
            "no pending suggestions in this change set",
        );
    }
    let is_author = c.access.user_id.is_some()
        && rows
            .iter()
            .all(|s| c.access.user_id == s.author.as_ref().map(|a| a.id));
    if !(c.access.role.can_edit() || is_author) {
        return err(
            StatusCode::FORBIDDEN,
            "only editors (or the author) can reject",
        );
    }
    let mut rejected = Vec::with_capacity(rows.len());
    for s in &rows {
        if let Err(e) = c.persistence.set_suggestion_status(s.id, "rejected").await {
            return err500(e);
        }
        rejected.push(s.id);
    }
    audit::record(
        &c.persistence,
        AuditEvent::new("suggestion_rejected")
            .document(Some(c.document_id))
            .actor(c.access.user_id)
            .detail(json!({ "change_set_id": change_set_id, "rejected_count": rejected.len() })),
    );
    Json(json!({ "change_set_id": change_set_id, "rejected": rejected })).into_response()
}

// ---------------------------------------------------------------------------
// History & point-in-time text (the update log IS the edit history, ADR 0010)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub(crate) struct HistoryEntry {
    pub first_seq: i64,
    pub last_seq: i64,
    pub origin: Option<String>,
    pub change_set_id: Option<Uuid>,
    pub created_at: String,
    pub author: Option<AuthorJson>,
    #[serde(skip)]
    oldest_ms: i64,
}

/// Collapse raw update rows (newest first) into reviewable entries: consecutive rows by
/// the same author+origin within 60s of each other (a typing burst), or sharing a
/// change_set_id (one atomic edit, ADR 0007), become one entry.
pub(crate) fn coalesce_history(rows: Vec<HistoryRow>) -> Vec<HistoryEntry> {
    const WINDOW_MS: i64 = 60_000;
    let mut out: Vec<HistoryEntry> = Vec::new();
    for r in rows {
        let author_id = r.author.as_ref().map(|a| a.id);
        if let Some(last) = out.last_mut() {
            let same_set = last.change_set_id.is_some() && last.change_set_id == r.change_set_id;
            // A typing burst: same author+origin, close in time — but never blend a distinct
            // change set (an atomic, separately reviewable edit, ADR 0007) into the stream.
            let same_stream = last.change_set_id == r.change_set_id
                && last.author.as_ref().map(|a| a.id) == author_id
                && last.origin == r.origin
                && (last.oldest_ms - r.created_ms).abs() <= WINDOW_MS;
            if same_set || same_stream {
                last.first_seq = r.seq;
                last.oldest_ms = r.created_ms;
                continue;
            }
        }
        out.push(HistoryEntry {
            first_seq: r.seq,
            last_seq: r.seq,
            origin: r.origin,
            change_set_id: r.change_set_id,
            created_at: r.created_at,
            author: r.author,
            oldest_ms: r.created_ms,
        });
    }
    out
}

/// GET /api/documents/{slug}/history?limit=50&before_seq= — coalesced, attributed, newest
/// first. `limit` caps the raw update rows scanned (pass the oldest first_seq back as
/// before_seq to page).
pub async fn history(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let c = match ctx(&state, &slug, &jar, &headers, &params, Role::Viewer).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(50)
        .clamp(1, 500);
    let before_seq = params.get("before_seq").and_then(|s| s.parse::<i64>().ok());
    match c
        .persistence
        .history(c.document_id, limit, before_seq)
        .await
    {
        Ok(rows) => Json(json!({ "entries": coalesce_history(rows) })).into_response(),
        Err(e) => err500(e),
    }
}

/// GET /api/documents/{slug}/text[?seq=N] — the markdown now (live, via the room) or as it
/// stood after update N (latest snapshot ≤ N + replay ≤ N into a fresh doc). Viewer+.
pub async fn text(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let want_seq = match params.get("seq").map(|s| s.parse::<i64>()) {
        Some(Ok(n)) if n >= 0 => Some(n),
        Some(_) => {
            return err(
                StatusCode::BAD_REQUEST,
                "seq must be a non-negative integer",
            )
        }
        None => None,
    };

    // Live text needs no Postgres — keep it available in volatile mode too.
    // Share token: header first (X-Muesli-Share), then the ?share= query fallback.
    let share = headers
        .get("x-muesli-share")
        .and_then(|v| v.to_str().ok())
        .or_else(|| params.get("share").map(String::as_str));
    if let Err(status) = resolve_access(&state, &slug, &jar, &headers, share).await {
        return status.into_response();
    }
    let room = crate::ensure_room(&state, &slug);

    match want_seq {
        None => {
            let (text, seq) = match tokio::try_join!(
                room_call(&room, |reply| RoomMsg::GetText { reply }),
                room_call(&room, |reply| RoomMsg::GetSeq { reply }),
            ) {
                Ok(v) => v,
                Err(r) => return r,
            };
            Json(json!({ "seq": seq, "text": text })).into_response()
        }
        Some(seq) => {
            let Some(p) = state.persistence.clone() else {
                return err(StatusCode::SERVICE_UNAVAILABLE, NO_DB);
            };
            let document_id = match room_call(&room, |reply| RoomMsg::GetDocumentId { reply }).await
            {
                Ok(Some(id)) => id,
                Ok(None) => return err(StatusCode::SERVICE_UNAVAILABLE, NO_DB),
                Err(r) => return r,
            };
            let (snapshot, updates) = match p.load_at(document_id, seq).await {
                Ok(v) => v,
                Err(e) => return err500(e),
            };
            let doc = muesli_core::MuesliDoc::new();
            if let Some(snap) = snapshot {
                if let Err(e) = doc.apply_update(&snap) {
                    return err500(anyhow::anyhow!("corrupt snapshot: {e}"));
                }
            }
            for u in &updates {
                if let Err(e) = doc.apply_update(u) {
                    return err500(anyhow::anyhow!("corrupt update during replay: {e}"));
                }
            }
            Json(json!({ "seq": seq, "text": doc.materialize() })).into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(
        seq: i64,
        origin: &str,
        csid: Option<Uuid>,
        ms: i64,
        author: Option<(Uuid, &str)>,
    ) -> HistoryRow {
        HistoryRow {
            seq,
            origin: Some(origin.into()),
            change_set_id: csid,
            created_at: format!("t{seq}"),
            created_ms: ms,
            author: author.map(|(id, kind)| AuthorJson {
                id,
                display_name: Some("x".into()),
                kind: kind.into(),
            }),
        }
    }

    #[test]
    fn coalesces_typing_bursts_by_author_origin_and_window() {
        let alice = Uuid::now_v7();
        let bob = Uuid::now_v7();
        // newest first
        let rows = vec![
            row(5, "human", None, 100_000, Some((alice, "human"))),
            row(4, "human", None, 70_000, Some((alice, "human"))),
            row(3, "human", None, 5_000, Some((alice, "human"))),
            row(2, "human", None, 4_000, Some((bob, "human"))),
            row(1, "human", None, 3_500, Some((bob, "human"))),
        ];
        let entries = coalesce_history(rows);
        // 5+4 merge (30s gap), 3 is 65s older than 4 (outside the window), bob's two merge.
        assert_eq!(entries.len(), 3);
        assert_eq!((entries[0].first_seq, entries[0].last_seq), (4, 5));
        assert_eq!((entries[1].first_seq, entries[1].last_seq), (3, 3));
        assert_eq!((entries[2].first_seq, entries[2].last_seq), (1, 2));
    }

    #[test]
    fn coalesces_change_sets_regardless_of_gap() {
        let agent = Uuid::now_v7();
        let cs = Some(Uuid::now_v7());
        let rows = vec![
            row(9, "agent", cs, 500_000, Some((agent, "agent"))),
            row(8, "agent", cs, 100_000, Some((agent, "agent"))), // >60s apart, same set
            row(7, "human", None, 90_000, None),
        ];
        let entries = coalesce_history(rows);
        assert_eq!(entries.len(), 2);
        assert_eq!((entries[0].first_seq, entries[0].last_seq), (8, 9));
        assert_eq!(entries[0].change_set_id, cs);
        assert_eq!((entries[1].first_seq, entries[1].last_seq), (7, 7));
    }

    #[test]
    fn change_set_never_blends_into_a_typing_burst() {
        let alice = Uuid::now_v7();
        let cs = Some(Uuid::now_v7());
        // Same author+origin, seconds apart — but seq 2 is an atomic change set.
        let rows = vec![
            row(3, "human", None, 12_000, Some((alice, "human"))),
            row(2, "human", cs, 11_000, Some((alice, "human"))),
            row(1, "human", None, 10_000, Some((alice, "human"))),
        ];
        let entries = coalesce_history(rows);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[1].change_set_id, cs);
    }

    #[test]
    fn does_not_merge_across_origin_or_author() {
        let alice = Uuid::now_v7();
        let rows = vec![
            row(3, "human", None, 10_000, Some((alice, "human"))),
            row(2, "ingest", None, 9_000, Some((alice, "human"))),
            row(1, "human", None, 8_000, None), // anonymous
        ];
        let entries = coalesce_history(rows);
        assert_eq!(entries.len(), 3);
    }

    #[test]
    fn anonymous_runs_still_merge() {
        let rows = vec![
            row(2, "human", None, 10_000, None),
            row(1, "human", None, 9_000, None),
        ];
        let entries = coalesce_history(rows);
        assert_eq!(entries.len(), 1);
        assert_eq!((entries[0].first_seq, entries[0].last_seq), (1, 2));
    }
}
