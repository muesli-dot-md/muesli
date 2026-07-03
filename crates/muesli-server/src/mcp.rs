//! MCP façade over the sync server (ADR 0008; docs/design/mcp-and-agent-auth.md).
//!
//! POST /mcp speaks streamable-HTTP JSON-RPC 2.0, one request per POST, hand-rolled (no SDK).
//! Every tool acts through the same room actor + persistence the REST surface and websockets
//! use, so an MCP edit is an ordinary room event with full attribution (ADR 0007):
//! - `edit_document` lands as ONE change set, origin `agent`, presence-announced;
//!   `mode: direct` is downgraded to `suggest` while a human is co-present unless
//!   `MUESLI_AGENT_DIRECT=always` (suggest-when-co-present, ADR 0007).
//! - accept/resolve tools are gated behind `MUESLI_AGENT_GATED_ACTIONS=true` (ADR 0008).
//!
//! Auth: `Authorization: Bearer mua_…` (or a session cookie) via the existing principal
//! path; open mode (no OIDC_ISSUER) admits an anonymous agent. Tool failures are MCP
//! tool-call results with `isError: true`, never protocol errors.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::audit::{self, AuditEvent};
use crate::auth::{resolve_access, Access, Principal, Role};
use crate::persistence::{Persistence, SuggestionRow};
use crate::room::RoomMsg;
use crate::AppState;

const PROTOCOL_DEFAULT: &str = "2025-03-26";
const KNOWN_PROTOCOLS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18"];
const NO_DB: &str = "this tool requires DATABASE_URL (server is running volatile)";
/// One generic message for both "no such document" and "exists but you may not see it",
/// so an MCP client can never use the error text as a cross-tenant existence oracle.
const DOC_UNAVAILABLE: &str = "document not found or access denied";
/// Hard caps (the MCP twins of api.rs): every listed thread/suggestion costs one
/// serialized ResolveAnchor on the room actor and every edit one CreateAnchor — both
/// O(document size) — so unbounded requests could pin the actor for all collaborators.
const MAX_LIST_ITEMS: usize = 200;
const MAX_EDITS: usize = 500;
const POLICY_DISABLED: &str = "policy-disabled: agent gated actions (accept/resolve/purge/delete-workspace) are disabled on this server (MUESLI_AGENT_GATED_ACTIONS)";

// ---------------------------------------------------------------------------
// Transport: one JSON-RPC request per POST
// ---------------------------------------------------------------------------

/// GET /mcp — this façade is single-request streamable HTTP; there is no SSE stream.
pub async fn method_not_allowed() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, "use POST with a single JSON-RPC request").into_response()
}

fn rpc_result(id: Value, result: Value) -> Response {
    axum::Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })).into_response()
}

fn rpc_error(id: Value, code: i64, message: impl Into<String>) -> Response {
    axum::Json(json!({
        "jsonrpc": "2.0", "id": id,
        "error": { "code": code, "message": message.into() }
    }))
    .into_response()
}

/// POST /mcp.
pub async fn handle(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    body: String,
) -> Response {
    let req: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => return rpc_error(Value::Null, -32700, format!("parse error: {e}")),
    };
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let Some(method) = req.get("method").and_then(Value::as_str).map(str::to_owned) else {
        return rpc_error(id, -32600, "invalid request: no method");
    };
    let params = req.get("params").cloned().unwrap_or_else(|| json!({}));

    // Authentication (mcp-and-agent-auth.md): in OIDC mode every MCP request needs a
    // principal (Bearer mua_ token or a session cookie); open mode admits an anonymous
    // agent. Authorization per document happens inside each tool via resolve_access.
    let principal = match state.auth.as_ref() {
        None => None,
        Some(auth) => match auth.authenticate(&jar, &headers).await {
            Some(p) => Some(p),
            None => {
                return (
                    StatusCode::UNAUTHORIZED,
                    [("www-authenticate", "Bearer")],
                    "unauthorized: provide Authorization: Bearer mua_… (run `muesli login`)",
                )
                    .into_response();
            }
        },
    };

    // Notifications (no id) are acknowledged with 202 and produce no body.
    if id.is_null() && method.starts_with("notifications/") {
        return StatusCode::ACCEPTED.into_response();
    }

    match method.as_str() {
        "initialize" => {
            let client_proto = params.get("protocolVersion").and_then(Value::as_str);
            let proto = match client_proto {
                Some(p) if KNOWN_PROTOCOLS.contains(&p) => p,
                _ => PROTOCOL_DEFAULT,
            };
            rpc_result(
                id,
                json!({
                    "protocolVersion": proto,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "muesli", "version": env!("CARGO_PKG_VERSION") }
                }),
            )
        }
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, json!({ "tools": tool_definitions() })),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return rpc_error(id, -32602, "tools/call needs a tool name");
            };
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let caller = Caller { state: &state, jar: &jar, headers: &headers, principal };
            match call_tool(&caller, name, &args).await {
                Ok(value) => rpc_result(
                    id,
                    json!({
                        "content": [{ "type": "text", "text": value.to_string() }],
                        "isError": false
                    }),
                ),
                Err(ToolError::Unknown) => rpc_error(id, -32602, format!("unknown tool: {name}")),
                Err(ToolError::Failed(msg)) => rpc_result(
                    id,
                    json!({
                        "content": [{ "type": "text", "text": msg }],
                        "isError": true
                    }),
                ),
            }
        }
        other => rpc_error(id, -32601, format!("method not found: {other}")),
    }
}

// ---------------------------------------------------------------------------
// Tool definitions (tools/list)
// ---------------------------------------------------------------------------

/// Shared `document_id` / `slug` properties (ADR 0009: id everywhere, slug as convenience).
fn doc_ref_props() -> Value {
    json!({
        "document_id": { "type": "string", "description": "Document UUID" },
        "slug": { "type": "string", "description": "Document slug (room name), alternative to document_id" }
    })
}

fn schema(mut properties: Value, required: &[&str]) -> Value {
    if let Some(obj) = properties.as_object_mut() {
        for (k, v) in doc_ref_props().as_object().unwrap() {
            obj.entry(k.clone()).or_insert(v.clone());
        }
    }
    json!({ "type": "object", "properties": properties, "required": required })
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({ "name": name, "description": description, "inputSchema": input_schema })
}

fn tool_definitions() -> Vec<Value> {
    let id_only = |key: &str, desc: &str| {
        json!({ "type": "object",
                "properties": { key: { "type": "string", "description": desc } },
                "required": [key] })
    };
    vec![
        tool(
            "list_documents",
            "List documents visible to you (owner ACL or workspace membership). Optional substring filter on the slug.",
            json!({ "type": "object", "properties": { "query": { "type": "string", "description": "Substring filter on the slug" } }, "required": [] }),
        ),
        tool(
            "read_document",
            "Read a document's markdown. Pass version (a history seq) for a point-in-time read.",
            schema(json!({ "version": { "type": "integer", "description": "Historical seq to read at (from get_history)" } }), &[]),
        ),
        tool(
            "get_history",
            "Attributed, coalesced edit history (newest first): who changed the document, when, via which origin (human/agent/ingest), grouped by change set.",
            schema(json!({ "limit": { "type": "integer", "description": "Max raw updates scanned (default 50, max 500)" } }), &[]),
        ),
        tool(
            "create_document",
            "Create a new document and seed its content as one change set.",
            json!({ "type": "object",
                    "properties": {
                        "slug": { "type": "string", "description": "New document slug (room name)" },
                        "markdown": { "type": "string", "description": "Initial markdown content" }
                    },
                    "required": ["slug", "markdown"] }),
        ),
        tool(
            "edit_document",
            "Edit a document. Every call lands as ONE change set. mode=direct applies live (may be downgraded to suggest while a human is co-present — check applied_mode in the response); mode=suggest stores pending suggestions for human review. Each edit is either {anchor_text, insert?, delete?} (delete:true removes the anchor text; insert without delete inserts AFTER it; both = replace), {range:{start,end}, insert?} with UTF-8 byte offsets, or {replace_all: markdown}. anchor_text must match exactly once. Pass base_seq (from read_document) to fail instead of editing a document that moved.",
            schema(
                json!({
                    "mode": { "type": "string", "enum": ["direct", "suggest"] },
                    "edits": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "anchor_text": { "type": "string", "description": "Exact text to anchor this edit to (must match exactly once)" },
                                "insert": { "type": "string", "description": "Text to insert (after anchor_text, or replacing it when delete:true / replacing range)" },
                                "delete": { "type": "boolean", "description": "Remove the anchor_text" },
                                "range": { "type": "object", "properties": { "start": { "type": "integer" }, "end": { "type": "integer" } }, "required": ["start", "end"], "description": "UTF-8 byte range to replace (delete when insert is omitted)" },
                                "replace_all": { "type": "string", "description": "Replace the whole document with this markdown (must be the only edit)" }
                            }
                        }
                    },
                    "base_seq": { "type": "integer", "description": "Fail if the document has moved past this seq (re-read and retry)" }
                }),
                &["mode", "edits"],
            ),
        ),
        tool(
            "add_comment",
            "Start a comment thread anchored to text (anchor_text must match exactly once, or pass an explicit byte range).",
            schema(
                json!({
                    "anchor_text": { "type": "string", "description": "Exact text to anchor the comment to" },
                    "range": { "type": "object", "properties": { "start": { "type": "integer" }, "end": { "type": "integer" } }, "required": ["start", "end"] },
                    "body": { "type": "string" }
                }),
                &["body"],
            ),
        ),
        tool(
            "reply_comment",
            "Reply to an existing comment thread.",
            json!({ "type": "object",
                    "properties": {
                        "thread_id": { "type": "string", "description": "Comment thread UUID" },
                        "body": { "type": "string" }
                    },
                    "required": ["thread_id", "body"] }),
        ),
        tool(
            "list_comments",
            "List comment threads (with replies and their current text ranges). Optional status filter: open | resolved | orphaned.",
            schema(json!({ "status": { "type": "string", "enum": ["open", "resolved", "orphaned"] } }), &[]),
        ),
        tool(
            "list_suggestions",
            "List suggestions on a document with their current text ranges. Optional status filter: pending | accepted | rejected.",
            schema(json!({ "status": { "type": "string", "enum": ["pending", "accepted", "rejected"] } }), &[]),
        ),
        tool(
            "resolve_comment",
            "Resolve a comment thread (gated: requires MUESLI_AGENT_GATED_ACTIONS=true on the server).",
            id_only("thread_id", "Comment thread UUID"),
        ),
        tool(
            "accept_suggestion",
            "Accept one pending suggestion, applying it to the document (gated: requires MUESLI_AGENT_GATED_ACTIONS=true on the server).",
            id_only("suggestion_id", "Suggestion UUID"),
        ),
        tool(
            "reject_suggestion",
            "Reject one pending suggestion (gated: requires MUESLI_AGENT_GATED_ACTIONS=true on the server).",
            id_only("suggestion_id", "Suggestion UUID"),
        ),
        tool(
            "accept_change_set",
            "Accept every pending suggestion in a change set as one atomic edit (gated: requires MUESLI_AGENT_GATED_ACTIONS=true on the server).",
            id_only("change_set_id", "Change set UUID"),
        ),
        tool(
            "reject_change_set",
            "Reject every pending suggestion in a change set (gated: requires MUESLI_AGENT_GATED_ACTIONS=true on the server).",
            id_only("change_set_id", "Change set UUID"),
        ),
        // --- Full-surface parity tools (bridged onto the REST handlers) ---
        tool(
            "update_document",
            "Rename (display title), move between folders, and/or star a document. title: null/\"\" clears back to the slug; folder_id: null moves to the root. Editor on the document.",
            schema(
                json!({
                    "title": { "type": ["string", "null"], "description": "New display title; null or \"\" clears it" },
                    "folder_id": { "type": ["string", "null"], "description": "Destination folder UUID; null = workspace root" },
                    "starred": { "type": "boolean" }
                }),
                &[],
            ),
        ),
        tool(
            "trash_document",
            "Move a document to the trash (soft delete; restorable). Editor on the document.",
            schema(json!({}), &[]),
        ),
        tool(
            "restore_document",
            "Restore a trashed document. Editor on the document.",
            schema(json!({}), &[]),
        ),
        tool(
            "purge_document",
            "PERMANENTLY delete a trashed or live document and all its comments/suggestions/history (gated: requires MUESLI_AGENT_GATED_ACTIONS=true on the server). Editor on the document.",
            schema(json!({}), &[]),
        ),
        tool(
            "search",
            "Full-text search over documents visible to you (title and content, ranked). Returns snippets.",
            json!({ "type": "object",
                    "properties": {
                        "q": { "type": "string", "description": "Search query" },
                        "limit": { "type": "integer", "description": "Max results (default 20, max 100)" }
                    },
                    "required": ["q"] }),
        ),
        tool(
            "reopen_comment",
            "Reopen a resolved comment thread (the inverse of resolve_comment).",
            schema(json!({ "thread_id": { "type": "string", "description": "Comment thread UUID" } }), &["thread_id"]),
        ),
        tool(
            "create_folder",
            "Create a folder. The default workspace is the parent's, else your primary workspace.",
            json!({ "type": "object",
                    "properties": {
                        "name": { "type": "string" },
                        "parent_id": { "type": "string", "description": "Parent folder UUID (absent = workspace root)" },
                        "workspace_id": { "type": "string", "description": "Workspace UUID (defaults to the parent's, else your primary workspace)" }
                    },
                    "required": ["name"] }),
        ),
        tool(
            "update_folder",
            "Rename a folder and/or move it (parent_id: null = to the root). Moving under a descendant is rejected.",
            json!({ "type": "object",
                    "properties": {
                        "folder_id": { "type": "string" },
                        "name": { "type": "string" },
                        "parent_id": { "type": ["string", "null"], "description": "New parent folder UUID; null = workspace root" }
                    },
                    "required": ["folder_id"] }),
        ),
        tool(
            "trash_folder",
            "Move a folder (and its contents) to the trash (soft delete; restorable).",
            id_only("folder_id", "Folder UUID"),
        ),
        tool(
            "restore_folder",
            "Restore a trashed folder and its contents.",
            id_only("folder_id", "Folder UUID"),
        ),
        tool(
            "create_share_link",
            "Create a share link for a document at a role (viewer | commenter | editor). Editor on the document.",
            schema(
                json!({
                    "role": { "type": "string", "enum": ["viewer", "commenter", "editor"] },
                    "expires_in_secs": { "type": "integer", "description": "Link lifetime in seconds (absent = no expiry)" }
                }),
                &["role"],
            ),
        ),
        tool(
            "list_document_members",
            "List who can access a document (workspace members and per-document grants).",
            schema(json!({}), &[]),
        ),
        tool(
            "list_notifications",
            "Your notification inbox (newest first): mentions addressed to this principal. For a delegated agent token this is the AGENT's own inbox.",
            json!({ "type": "object",
                    "properties": {
                        "unread_only": { "type": "boolean" },
                        "before": { "type": "string", "description": "Timestamp cursor for paging (from a previous page's oldest created_at)" }
                    },
                    "required": [] }),
        ),
        tool(
            "mark_notification_read",
            "Mark one notification read.",
            id_only("notification_id", "Notification UUID"),
        ),
        tool(
            "mark_all_notifications_read",
            "Mark every unread notification read.",
            json!({ "type": "object", "properties": {}, "required": [] }),
        ),
        tool(
            "get_graph",
            "The cross-document link graph visible to you: nodes (documents), edges (wikilinks), unresolved link targets.",
            json!({ "type": "object", "properties": {}, "required": [] }),
        ),
        tool(
            "get_document_links",
            "One document's outgoing links and incoming backlinks.",
            schema(json!({}), &[]),
        ),
        tool(
            "list_workspaces",
            "List workspaces you belong to, with your role in each.",
            json!({ "type": "object", "properties": {}, "required": [] }),
        ),
        tool(
            "create_workspace",
            "Create a new workspace (you become its admin). It starts pending_storage until a storage connection is bound.",
            json!({ "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] }),
        ),
        tool(
            "get_workspace",
            "One workspace's detail: members, invites, storage binding.",
            id_only("workspace_id", "Workspace UUID"),
        ),
        tool(
            "rename_workspace",
            "Rename a workspace. Admin.",
            json!({ "type": "object",
                    "properties": { "workspace_id": { "type": "string" }, "name": { "type": "string" } },
                    "required": ["workspace_id", "name"] }),
        ),
        tool(
            "delete_workspace",
            "PERMANENTLY delete a workspace and every document in it, for all members (gated: requires MUESLI_AGENT_GATED_ACTIONS=true on the server). Admin.",
            id_only("workspace_id", "Workspace UUID"),
        ),
        tool(
            "create_workspace_invite",
            "Invite an email to a workspace at a role (admin | member). Admin.",
            json!({ "type": "object",
                    "properties": {
                        "workspace_id": { "type": "string" },
                        "email": { "type": "string" },
                        "role": { "type": "string", "enum": ["admin", "member"] }
                    },
                    "required": ["workspace_id", "email", "role"] }),
        ),
        tool(
            "revoke_workspace_invite",
            "Revoke a pending workspace invite. Admin.",
            json!({ "type": "object",
                    "properties": { "workspace_id": { "type": "string" }, "invite_id": { "type": "string" } },
                    "required": ["workspace_id", "invite_id"] }),
        ),
        tool(
            "set_workspace_member_role",
            "Change a member's role (admin | member). Demoting the last admin is rejected. Admin.",
            json!({ "type": "object",
                    "properties": {
                        "workspace_id": { "type": "string" },
                        "user_id": { "type": "string" },
                        "role": { "type": "string", "enum": ["admin", "member"] }
                    },
                    "required": ["workspace_id", "user_id", "role"] }),
        ),
        tool(
            "remove_workspace_member",
            "Remove a member from a workspace (or yourself, to leave). Removing the last admin is rejected.",
            json!({ "type": "object",
                    "properties": { "workspace_id": { "type": "string" }, "user_id": { "type": "string" } },
                    "required": ["workspace_id", "user_id"] }),
        ),
        tool(
            "list_workspace_audit",
            "The workspace's security audit trail (newest first). Admin.",
            json!({ "type": "object",
                    "properties": {
                        "workspace_id": { "type": "string" },
                        "limit": { "type": "integer" },
                        "before_id": { "type": "integer", "description": "Paging cursor (an audit row id)" }
                    },
                    "required": ["workspace_id"] }),
        ),
        tool(
            "list_storage_connections",
            "List a workspace's storage connections (S3 / GitHub / Google Drive / SharePoint). Admin.",
            id_only("workspace_id", "Workspace UUID"),
        ),
        tool(
            "create_storage_connection",
            "Create a storage connection on a workspace. kind: \"s3\" (endpoint, bucket, region, access_key_id, secret_key, prefix?) or \"github\" (api_base, owner, repo, branch?, token, prefix?). The connection is probed before it is stored. Admin. (Google Drive / SharePoint bind via browser OAuth, not this tool.)",
            json!({ "type": "object",
                    "properties": {
                        "workspace_id": { "type": "string" },
                        "kind": { "type": "string", "enum": ["s3", "github"] },
                        "endpoint": { "type": "string" }, "bucket": { "type": "string" },
                        "region": { "type": "string" }, "access_key_id": { "type": "string" },
                        "secret_key": { "type": "string" }, "api_base": { "type": "string" },
                        "owner": { "type": "string" }, "repo": { "type": "string" },
                        "branch": { "type": "string" }, "token": { "type": "string" },
                        "prefix": { "type": "string" }
                    },
                    "required": ["workspace_id", "kind"] }),
        ),
        tool(
            "delete_storage_connection",
            "Delete a workspace storage connection. Admin.",
            json!({ "type": "object",
                    "properties": { "workspace_id": { "type": "string" }, "connection_id": { "type": "string" } },
                    "required": ["workspace_id", "connection_id"] }),
        ),
        tool(
            "get_storage_status",
            "Per-document materialization status for a workspace's storage (attached, pending, errors). Admin.",
            id_only("workspace_id", "Workspace UUID"),
        ),
        tool(
            "attach_document_storage",
            "Attach one document to a storage connection (writes the canonical file). Editor on the document; the connection must belong to its workspace.",
            schema(
                json!({
                    "storage_conn_id": { "type": "string" },
                    "rel_path": { "type": "string", "description": "Path inside the backend (defaults to the computed folder path + title)" }
                }),
                &["storage_conn_id"],
            ),
        ),
        tool(
            "get_me",
            "Who am I: the server's auth mode and the signed-in user (the token OWNER's identity for delegated tokens).",
            json!({ "type": "object", "properties": {}, "required": [] }),
        ),
        tool(
            "update_profile",
            "Update the caller's profile (display_name, avatar_url). Requires a human session — delegated agent tokens are refused by the server (they may only stamp onboarded).",
            json!({ "type": "object",
                    "properties": {
                        "display_name": { "type": ["string", "null"] },
                        "avatar_url": { "type": ["string", "null"] },
                        "onboarded": { "type": "boolean" }
                    },
                    "required": [] }),
        ),
        tool(
            "list_api_tokens",
            "List the caller's delegated agent tokens. Requires a human session — agent tokens are refused (an agent cannot inspect its owner's keys).",
            json!({ "type": "object", "properties": {}, "required": [] }),
        ),
        tool(
            "mint_api_token",
            "Mint a delegated agent token. Requires a human session — agent tokens are refused (an agent cannot mint itself new keys).",
            json!({ "type": "object",
                    "properties": {
                        "label": { "type": "string" },
                        "scopes": { "type": "array", "items": { "type": "string" }, "description": "[\"read\"] or [\"read\",\"write\"]" },
                        "expires_in_days": { "type": "integer" }
                    },
                    "required": ["label", "scopes"] }),
        ),
        tool(
            "revoke_api_token",
            "Revoke one of the caller's tokens. Requires a human session — agent tokens are refused.",
            id_only("token_id", "Token UUID"),
        ),
        tool(
            "get_storage_usage",
            "The caller's per-workspace storage usage. Requires a human session.",
            json!({ "type": "object", "properties": {}, "required": [] }),
        ),
    ]
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

enum ToolError {
    Unknown,
    Failed(String),
}

impl From<String> for ToolError {
    fn from(msg: String) -> Self {
        ToolError::Failed(msg)
    }
}

struct Caller<'a> {
    state: &'a AppState,
    jar: &'a CookieJar,
    headers: &'a HeaderMap,
    /// None = open mode (anonymous agent "agent").
    principal: Option<Principal>,
}

async fn call_tool(c: &Caller<'_>, name: &str, args: &Value) -> Result<Value, ToolError> {
    Ok(match name {
        "list_documents" => list_documents(c, args).await?,
        "read_document" => read_document(c, args).await?,
        "get_history" => get_history(c, args).await?,
        "create_document" => create_document(c, args).await?,
        "edit_document" => edit_document(c, args).await?,
        "add_comment" => add_comment(c, args).await?,
        "reply_comment" => reply_comment(c, args).await?,
        "list_comments" => list_comments(c, args).await?,
        "list_suggestions" => list_suggestions(c, args).await?,
        "resolve_comment" => resolve_comment(c, args).await?,
        "accept_suggestion" => accept_suggestion(c, args).await?,
        "reject_suggestion" => reject_suggestion(c, args).await?,
        "accept_change_set" => accept_change_set(c, args).await?,
        "reject_change_set" => reject_change_set(c, args).await?,
        // --- REST-bridged parity tools (see "Full-surface parity" below) ---
        "update_document" => update_document(c, args).await?,
        "trash_document" => trash_document(c, args).await?,
        "restore_document" => restore_document(c, args).await?,
        "purge_document" => purge_document(c, args).await?,
        "search" => search_docs(c, args).await?,
        "reopen_comment" => reopen_comment(c, args).await?,
        "create_folder" => create_folder(c, args).await?,
        "update_folder" => update_folder(c, args).await?,
        "trash_folder" => trash_folder(c, args).await?,
        "restore_folder" => restore_folder(c, args).await?,
        "create_share_link" => create_share_link(c, args).await?,
        "list_document_members" => list_document_members(c, args).await?,
        "list_notifications" => notif_list(c, args).await?,
        "mark_notification_read" => notif_mark_read(c, args).await?,
        "mark_all_notifications_read" => notif_read_all(c).await?,
        "get_graph" => get_graph(c).await?,
        "get_document_links" => get_document_links(c, args).await?,
        "list_workspaces" => ws_list(c).await?,
        "create_workspace" => ws_create(c, args).await?,
        "get_workspace" => ws_get(c, args).await?,
        "rename_workspace" => ws_rename(c, args).await?,
        "delete_workspace" => ws_delete(c, args).await?,
        "create_workspace_invite" => ws_invite(c, args).await?,
        "revoke_workspace_invite" => ws_revoke_invite(c, args).await?,
        "set_workspace_member_role" => ws_set_role(c, args).await?,
        "remove_workspace_member" => ws_remove_member(c, args).await?,
        "list_workspace_audit" => ws_audit(c, args).await?,
        "list_storage_connections" => storage_list(c, args).await?,
        "create_storage_connection" => storage_create(c, args).await?,
        "delete_storage_connection" => storage_delete(c, args).await?,
        "get_storage_status" => storage_status_tool(c, args).await?,
        "attach_document_storage" => attach_storage(c, args).await?,
        "get_me" => me_tool(c).await?,
        "update_profile" => update_profile(c, args).await?,
        "list_api_tokens" => tokens_list(c).await?,
        "mint_api_token" => tokens_mint(c, args).await?,
        "revoke_api_token" => tokens_revoke(c, args).await?,
        "get_storage_usage" => storage_usage_tool(c).await?,
        _ => return Err(ToolError::Unknown),
    })
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

async fn room_call<T>(
    room: &mpsc::UnboundedSender<RoomMsg>,
    make: impl FnOnce(oneshot::Sender<T>) -> RoomMsg,
) -> Result<T, String> {
    let (tx, rx) = oneshot::channel();
    room.send(make(tx)).map_err(|_| "room is gone".to_string())?;
    rx.await.map_err(|_| "room dropped the request".to_string())
}

fn internal(e: anyhow::Error) -> String {
    tracing::warn!(%e, "mcp tool error");
    "internal error".to_string()
}

/// Everything a document-scoped tool needs (the MCP twin of api.rs ApiCtx).
struct DocCtx {
    slug: String,
    access: Access,
    room: mpsc::UnboundedSender<RoomMsg>,
    persistence: Option<Arc<Persistence>>,
    document_id: Option<Uuid>,
}

impl Caller<'_> {
    fn persistence(&self) -> Result<Arc<Persistence>, String> {
        self.state.persistence.clone().ok_or_else(|| NO_DB.to_string())
    }

    /// Resolve `document_id` | `slug` arguments to a room slug.
    async fn slug_from_args(&self, args: &Value) -> Result<String, String> {
        if let Some(id) = args.get("document_id").and_then(Value::as_str) {
            let id = Uuid::parse_str(id).map_err(|_| "document_id is not a UUID".to_string())?;
            return self
                .persistence()?
                .document_slug(id)
                .await
                .map_err(internal)?
                .ok_or_else(|| DOC_UNAVAILABLE.to_string());
        }
        args.get("slug")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "pass document_id or slug".to_string())
    }

    /// Per-document authorization through the same seam as REST and websockets
    /// (resolve_access: roles, token scopes, document/workspace restrictions).
    async fn doc(&self, args: &Value, min_role: Role, must_exist: bool) -> Result<DocCtx, String> {
        let slug = self.slug_from_args(args).await?;
        self.doc_by_slug(&slug, min_role, must_exist).await
    }

    async fn doc_by_slug(
        &self,
        slug: &str,
        min_role: Role,
        must_exist: bool,
    ) -> Result<DocCtx, String> {
        if let Some(p) = self.state.persistence.as_ref() {
            let exists = p.find_document(slug).await.map_err(internal)?.is_some();
            // Existence oracle: "not found" and (below) "forbidden" collapse into ONE
            // generic message — slugs are globally unique, so distinguishable errors
            // would let any Bearer client enumerate other tenants' documents. The
            // create path is genericized for the same reason: "already exists" alone
            // would confirm a foreign slug.
            if must_exist && !exists {
                return Err(DOC_UNAVAILABLE.to_string());
            }
            if !must_exist && exists {
                return Err("cannot create document: the slug is already in use or access is denied".to_string());
            }
        }
        let access = resolve_access(self.state, slug, self.jar, self.headers, None)
            .await
            .map_err(|status| match status {
                StatusCode::UNAUTHORIZED => "unauthorized: sign in or pass a Bearer token".into(),
                StatusCode::FORBIDDEN => DOC_UNAVAILABLE.to_string(),
                other => format!("access check failed ({other})"),
            })?;
        if access.role < min_role {
            return Err(format!(
                "forbidden: this tool requires the {} role on {slug} (you have {})",
                min_role.as_str(),
                access.role.as_str()
            ));
        }
        let room = crate::ensure_room(self.state, slug);
        let document_id = room_call(&room, |reply| RoomMsg::GetDocumentId { reply }).await?;
        Ok(DocCtx {
            slug: slug.to_string(),
            access,
            room,
            persistence: self.state.persistence.clone(),
            document_id,
        })
    }

    /// The display name announced in awareness while the agent edits (ADR 0007).
    async fn agent_name(&self) -> String {
        if let (Some(p), Some(db)) = (&self.principal, &self.state.persistence) {
            if let Ok(Some(user)) = db.get_user(p.author).await {
                if let Some(name) = user.display_name {
                    return name;
                }
            }
        }
        "agent".to_string()
    }
}

impl DocCtx {
    fn persistence(&self) -> Result<(&Arc<Persistence>, Uuid), String> {
        match (self.persistence.as_ref(), self.document_id) {
            (Some(p), Some(id)) => Ok((p, id)),
            _ => Err(NO_DB.to_string()),
        }
    }
}

/// Announce agent presence on the room and schedule its removal (best effort, ADR 0007).
async fn announce_presence(room: &mpsc::UnboundedSender<RoomMsg>, name: String) {
    if let Ok(generation) =
        room_call(room, |reply| RoomMsg::AgentPresenceSet { name, reply }).await
    {
        let room = room.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let _ = room.send(RoomMsg::AgentPresenceClear { generation });
        });
    }
}

fn range_json(range: Option<(usize, usize)>) -> Value {
    match range {
        Some((start, end)) => json!({ "start": start, "end": end }),
        None => Value::Null,
    }
}

/// First markdown heading, as a cheap title.
fn title_of(markdown: &str) -> Value {
    markdown
        .lines()
        .find_map(|l| l.strip_prefix('#').map(|h| h.trim_start_matches('#').trim()))
        .filter(|t| !t.is_empty())
        .map_or(Value::Null, |t| json!(t))
}

// ---------------------------------------------------------------------------
// Policy: suggest-when-co-present (ADR 0007) and gated actions (ADR 0008)
// ---------------------------------------------------------------------------

/// Which mode actually applies (the downgrade decision, ADR 0007). `direct_policy` is
/// MUESLI_AGENT_DIRECT: "auto" (default — downgrade while a human is present), "always"
/// (never downgrade), "never" (agents always suggest).
pub(crate) fn decide_mode(requested: &str, human_present: bool, direct_policy: &str) -> &'static str {
    if requested != "direct" || direct_policy == "never" {
        return "suggest";
    }
    if human_present && direct_policy != "always" {
        "suggest"
    } else {
        "direct"
    }
}

fn direct_policy() -> String {
    std::env::var("MUESLI_AGENT_DIRECT").unwrap_or_else(|_| "auto".into())
}

fn gated_actions_enabled() -> bool {
    std::env::var("MUESLI_AGENT_GATED_ACTIONS")
        .is_ok_and(|v| matches!(v.as_str(), "true" | "1" | "yes"))
}

/// The gate in front of accept/resolve tools (ADR 0008) — and the audit point for it:
/// every attempt is recorded as allowed or denied (fire-and-forget; the actor join
/// flags agent identities). Workspace stays null here — denial happens before any
/// document is resolved; allowed actions additionally audit their concrete effect
/// (suggestion_accepted / comment_resolved) with full document context.
fn gate(c: &Caller<'_>, tool: &'static str) -> Result<(), String> {
    let allowed = gated_actions_enabled();
    if let Some(p) = c.state.persistence.as_ref() {
        let action =
            if allowed { "mcp_gated_action_allowed" } else { "mcp_gated_action_denied" };
        audit::record(
            p,
            AuditEvent::new(action)
                .actor(c.principal.as_ref().map(|p| p.author))
                .detail(json!({ "tool": tool })),
        );
    }
    if allowed {
        Ok(())
    } else {
        Err(POLICY_DISABLED.to_string())
    }
}

/// Audit one MCP-performed action against its document (the via:"mcp" twin of the REST
/// hooks in api.rs); no-op when the server runs volatile.
fn audit_mcp(ctx: &DocCtx, c: &Caller<'_>, action: &'static str, mut detail: Value) {
    let Some(p) = ctx.persistence.as_ref() else { return };
    if let Some(obj) = detail.as_object_mut() {
        obj.insert("via".into(), json!("mcp"));
    }
    audit::record(
        p,
        AuditEvent::new(action)
            .document(ctx.document_id)
            .actor(c.principal.as_ref().map(|p| p.author))
            .detail(detail),
    );
}

// ---------------------------------------------------------------------------
// anchor_text resolution (mcp-and-agent-auth.md: ambiguous → error, never a guess)
// ---------------------------------------------------------------------------

fn floor_boundary(text: &str, mut i: usize) -> usize {
    while i > 0 && !text.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_boundary(text: &str, mut i: usize) -> usize {
    while i < text.len() && !text.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// ~40 chars of context around a match, for ambiguity errors.
fn context_around(text: &str, at: usize, len: usize) -> String {
    let start = floor_boundary(text, at.saturating_sub(20));
    let end = ceil_boundary(text, (at + len + 20).min(text.len()));
    text[start..end].replace('\n', "⏎")
}

/// Resolve `anchor_text` to the byte range of its unique occurrence. Zero matches and
/// multiple matches are both errors — the agent must disambiguate, we never guess.
pub(crate) fn resolve_anchor_text(text: &str, needle: &str) -> Result<(usize, usize), String> {
    if needle.is_empty() {
        return Err("anchor_text is empty".into());
    }
    let matches: Vec<usize> = text.match_indices(needle).map(|(i, _)| i).collect();
    match matches.len() {
        0 => Err(format!("anchor text not found: {needle:?}")),
        1 => Ok((matches[0], matches[0] + needle.len())),
        n => {
            let mut msg = format!(
                "anchor text is ambiguous ({n} matches) — pass a longer unique anchor_text or an explicit range. Matches:"
            );
            for &at in matches.iter().take(10) {
                msg.push_str(&format!(
                    "\n  byte {at}: …{}…",
                    context_around(text, at, needle.len())
                ));
            }
            if n > 10 {
                msg.push_str(&format!("\n  … and {} more", n - 10));
            }
            Err(msg)
        }
    }
}

/// Turn the `edits` argument into sorted, non-overlapping (start, end, insert) ops against
/// the current text. anchor_text semantics: delete:true removes it, insert without delete
/// inserts AFTER it, insert+delete replaces it.
pub(crate) fn build_ops(
    text: &str,
    edits: &[Value],
) -> Result<Vec<(usize, usize, String)>, String> {
    if edits.is_empty() {
        return Err("edits is empty".into());
    }
    // Hard cap: each edit costs one serialized CreateAnchor on the room actor (suggest
    // path); a single huge request must not monopolize it.
    if edits.len() > MAX_EDITS {
        return Err(format!(
            "too many edits ({}) — at most {MAX_EDITS} per call; split into multiple calls",
            edits.len()
        ));
    }
    if edits.iter().any(|e| e.get("replace_all").is_some()) {
        if edits.len() != 1 {
            return Err("replace_all must be the only edit".into());
        }
        let markdown = edits[0]
            .get("replace_all")
            .and_then(Value::as_str)
            .ok_or_else(|| "replace_all must be a string".to_string())?;
        return Ok(vec![(0, text.len(), markdown.to_string())]);
    }

    let mut ops = Vec::with_capacity(edits.len());
    for (i, e) in edits.iter().enumerate() {
        let insert = e.get("insert").and_then(Value::as_str);
        let op = if let Some(anchor) = e.get("anchor_text").and_then(Value::as_str) {
            let delete = e.get("delete").and_then(Value::as_bool).unwrap_or(false);
            let (s, end) = resolve_anchor_text(text, anchor).map_err(|m| format!("edit {i}: {m}"))?;
            match (insert, delete) {
                (None, false) => {
                    return Err(format!("edit {i}: anchor_text needs insert and/or delete:true"))
                }
                (None, true) => (s, end, String::new()),
                (Some(ins), false) => (end, end, ins.to_string()), // insert AFTER the anchor
                (Some(ins), true) => (s, end, ins.to_string()),    // replace
            }
        } else if let Some(range) = e.get("range") {
            let start = range.get("start").and_then(Value::as_u64).map(|v| v as usize);
            let end = range.get("end").and_then(Value::as_u64).map(|v| v as usize);
            let (Some(start), Some(end)) = (start, end) else {
                return Err(format!("edit {i}: range needs integer start and end"));
            };
            if start > end || end > text.len() {
                return Err(format!(
                    "edit {i}: range {start}..{end} out of bounds (len {})",
                    text.len()
                ));
            }
            if !text.is_char_boundary(start) || !text.is_char_boundary(end) {
                return Err(format!("edit {i}: range {start}..{end} splits a character"));
            }
            (start, end, insert.unwrap_or("").to_string())
        } else {
            return Err(format!("edit {i}: pass anchor_text, range, or replace_all"));
        };
        ops.push(op);
    }
    ops.sort_by_key(|(start, end, _)| (*start, *end));
    for pair in ops.windows(2) {
        if pair[1].0 < pair[0].1 {
            return Err("edits overlap — make each edit target distinct text".into());
        }
    }
    Ok(ops)
}

// ---------------------------------------------------------------------------
// Discovery & reading
// ---------------------------------------------------------------------------

async fn list_documents(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let db = c.persistence()?;
    let query = args.get("query").and_then(Value::as_str);
    // Visibility = the principal's role user (the human owner for delegated tokens);
    // open mode sees everything (ADR 0012 local-solo exception).
    let (user, doc_restriction, ws_restriction) = match &c.principal {
        Some(p) => (Some(p.role_user), p.document_restriction, p.workspace_restriction),
        None => (None, None, None),
    };
    // trashed = false: the trash is invisible to agents (restore is a UI/REST concern).
    let docs = db
        .list_documents_visible(user, query, doc_restriction, ws_restriction, false)
        .await
        .map_err(internal)?;
    let out: Vec<Value> = docs
        .into_iter()
        .map(|d| {
            json!({
                "document_id": d.id,
                "slug": d.slug,
                // The stored display title (migration 0008); slug stands in when unset.
                "title": d.title.as_deref().unwrap_or(&d.slug),
                "rel_path": Value::Null,
                "updated_at": d.updated_at,
            })
        })
        .collect();
    Ok(json!({ "documents": out }))
}

async fn read_document(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let ctx = c.doc(args, Role::Viewer, true).await?;
    match args.get("version").and_then(Value::as_i64) {
        None => {
            let markdown = room_call(&ctx.room, |reply| RoomMsg::GetText { reply }).await?;
            let seq = room_call(&ctx.room, |reply| RoomMsg::GetSeq { reply }).await?;
            Ok(json!({ "markdown": markdown, "seq": seq, "title": title_of(&markdown) }))
        }
        Some(version) if version >= 0 => {
            // Historical read: latest snapshot ≤ version + replay (same as GET text?seq=).
            let (db, document_id) = ctx.persistence()?;
            let (snapshot, updates) = db.load_at(document_id, version).await.map_err(internal)?;
            let doc = muesli_core::MuesliDoc::new();
            if let Some(snap) = snapshot {
                doc.apply_update(&snap).map_err(|e| format!("corrupt snapshot: {e}"))?;
            }
            for u in &updates {
                doc.apply_update(u).map_err(|e| format!("corrupt update during replay: {e}"))?;
            }
            let markdown = doc.materialize();
            Ok(json!({ "markdown": markdown, "seq": version, "title": title_of(&markdown) }))
        }
        Some(_) => Err("version must be a non-negative integer".into()),
    }
}

async fn get_history(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let ctx = c.doc(args, Role::Viewer, true).await?;
    let (db, document_id) = ctx.persistence()?;
    let limit = args.get("limit").and_then(Value::as_i64).unwrap_or(50).clamp(1, 500);
    let rows = db.history(document_id, limit, None).await.map_err(internal)?;
    let entries = crate::api::coalesce_history(rows);
    Ok(json!({ "entries": entries }))
}

// ---------------------------------------------------------------------------
// Editing (every call = ONE change set, ADR 0007)
// ---------------------------------------------------------------------------

async fn create_document(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let slug = args
        .get("slug")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "create_document needs a slug".to_string())?;
    let markdown = args
        .get("markdown")
        .and_then(Value::as_str)
        .ok_or_else(|| "create_document needs markdown".to_string())?;
    // must_exist = false: rejects an existing slug, then resolve_access creates the
    // document owned by the principal's workspace (same path as REST/ws).
    let ctx = c.doc_by_slug(slug, Role::Editor, false).await?;

    announce_presence(&ctx.room, c.agent_name().await).await;
    let seq = room_call(&ctx.room, |reply| RoomMsg::ApplyEdit {
        ops: vec![(0, 0, markdown.to_string())],
        author_id: ctx.access.user_id,
        change_set_id: Some(Uuid::now_v7()),
        origin: "agent".into(),
        reply,
    })
    .await??;
    Ok(json!({
        "document_id": ctx.document_id,
        "slug": ctx.slug,
        "seq": seq,
    }))
}

async fn edit_document(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let requested = match args.get("mode").and_then(Value::as_str) {
        Some(m @ ("direct" | "suggest")) => m,
        _ => return Err("mode must be \"direct\" or \"suggest\"".into()),
    };
    // direct needs Editor; suggest is the same power as a human Commenter (ADR 0019).
    let min_role = if requested == "direct" { Role::Editor } else { Role::Commenter };
    let ctx = c.doc(args, min_role, true).await?;

    let text = room_call(&ctx.room, |reply| RoomMsg::GetText { reply }).await?;
    let seq = room_call(&ctx.room, |reply| RoomMsg::GetSeq { reply }).await?;
    if let Some(base_seq) = args.get("base_seq").and_then(Value::as_i64) {
        if seq > base_seq {
            return Err(format!(
                "stale base_seq: the document is now at seq {seq} (your base_seq was {base_seq}) — re-read the document and retry"
            ));
        }
    }
    let edits = args
        .get("edits")
        .and_then(Value::as_array)
        .ok_or_else(|| "edits must be an array".to_string())?;
    let ops = build_ops(&text, edits)?;

    // Suggest-when-co-present (ADR 0007): direct downgrades while a human is live unless
    // the operator pinned MUESLI_AGENT_DIRECT=always.
    let human_present = room_call(&ctx.room, |reply| RoomMsg::HumanPresent { reply }).await?;
    let applied_mode = decide_mode(requested, human_present, &direct_policy());
    let change_set_id = Uuid::now_v7();

    if applied_mode == "direct" {
        announce_presence(&ctx.room, c.agent_name().await).await;
        let seq = room_call(&ctx.room, |reply| RoomMsg::ApplyEdit {
            ops,
            author_id: ctx.access.user_id,
            change_set_id: Some(change_set_id),
            origin: "agent".into(),
            reply,
        })
        .await??;
        return Ok(json!({
            "applied_mode": "direct",
            "seq": seq,
            "change_set_id": change_set_id,
        }));
    }

    // Suggest path (possibly a downgrade): pending rows + anchors, CRDT untouched (ADR 0019).
    let (db, document_id) = ctx.persistence()?;
    let mut items = Vec::with_capacity(ops.len());
    for (start, end, insert) in &ops {
        let anchor = room_call(&ctx.room, |reply| RoomMsg::CreateAnchor {
            start: *start,
            end: *end,
            reply,
        })
        .await??;
        let op = json!({
            "start": start, "end": end, "insert": insert,
            "old_text": &text[*start..*end],
        });
        items.push((anchor, op));
    }
    let ids = db
        .insert_suggestions(document_id, change_set_id, &items, ctx.access.user_id, None)
        .await
        .map_err(internal)?;
    let mut out = json!({
        "applied_mode": "suggest",
        "change_set_id": change_set_id,
        "suggestion_ids": ids,
        "status": "pending",
    });
    if requested == "direct" {
        out["downgraded"] = json!(true);
        out["reason"] = json!("a human is co-present — your edit was stored as suggestions for review (ADR 0007)");
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/// anchor_text or {range:{start,end}} → a concrete byte range against the live text.
async fn comment_range(ctx: &DocCtx, args: &Value) -> Result<(usize, usize), String> {
    if let Some(anchor) = args.get("anchor_text").and_then(Value::as_str) {
        let text = room_call(&ctx.room, |reply| RoomMsg::GetText { reply }).await?;
        return resolve_anchor_text(&text, anchor);
    }
    if let Some(range) = args.get("range") {
        let (start, end) = (
            range.get("start").and_then(Value::as_u64),
            range.get("end").and_then(Value::as_u64),
        );
        if let (Some(s), Some(e)) = (start, end) {
            return Ok((s as usize, e as usize));
        }
    }
    Err("pass anchor_text or range:{start,end}".into())
}

async fn add_comment(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let ctx = c.doc(args, Role::Commenter, true).await?;
    let body = args
        .get("body")
        .and_then(Value::as_str)
        .filter(|b| !b.trim().is_empty())
        .ok_or_else(|| "comment body is empty".to_string())?;
    let (start, end) = comment_range(&ctx, args).await?;
    let anchor =
        room_call(&ctx.room, |reply| RoomMsg::CreateAnchor { start, end, reply }).await??;
    let (db, document_id) = ctx.persistence()?;
    let (thread_id, comment_id) = db
        .create_thread(document_id, &anchor, ctx.access.user_id, body)
        .await
        .map_err(internal)?;
    Ok(json!({
        "thread_id": thread_id,
        "comment_id": comment_id,
        "status": "open",
        "range": { "start": start, "end": end },
    }))
}

/// Resolve a thread id to its document's DocCtx (threads are addressed globally over MCP).
async fn thread_ctx(
    c: &Caller<'_>,
    thread_id: Uuid,
    min_role: Role,
) -> Result<(DocCtx, String), String> {
    let db = c.persistence()?;
    let (document_id, status) = db
        .thread_ref(thread_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| format!("no such thread: {thread_id}"))?;
    let slug = db
        .document_slug(document_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| "thread's document is gone".to_string())?;
    Ok((c.doc_by_slug(&slug, min_role, true).await?, status))
}

fn uuid_arg(args: &Value, key: &str) -> Result<Uuid, String> {
    args.get(key)
        .and_then(Value::as_str)
        .and_then(|s| Uuid::parse_str(s).ok())
        .ok_or_else(|| format!("{key} must be a UUID"))
}

async fn reply_comment(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let thread_id = uuid_arg(args, "thread_id")?;
    let body = args
        .get("body")
        .and_then(Value::as_str)
        .filter(|b| !b.trim().is_empty())
        .ok_or_else(|| "comment body is empty".to_string())?;
    let (ctx, _) = thread_ctx(c, thread_id, Role::Commenter).await?;
    let (db, _) = ctx.persistence()?;
    let comment_id = db.add_comment(thread_id, ctx.access.user_id, body).await.map_err(internal)?;
    Ok(json!({ "thread_id": thread_id, "comment_id": comment_id }))
}

async fn list_comments(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let ctx = c.doc(args, Role::Viewer, true).await?;
    let (db, document_id) = ctx.persistence()?;
    let mut threads = db.list_threads(document_id).await.map_err(internal)?;
    // Hard cap: one serialized ResolveAnchor per thread (see MAX_LIST_ITEMS).
    threads.truncate(MAX_LIST_ITEMS);
    let comments = db.list_comments(document_id).await.map_err(internal)?;
    let mut by_thread: HashMap<Uuid, Vec<Value>> = HashMap::new();
    for cm in comments {
        by_thread.entry(cm.thread_id).or_default().push(json!({
            "id": cm.id, "body": cm.body, "created_at": cm.created_at, "author": cm.author,
        }));
    }
    let mut out = Vec::with_capacity(threads.len());
    for t in threads {
        let range = room_call(&ctx.room, |reply| RoomMsg::ResolveAnchor {
            anchor: t.anchor.clone(),
            reply,
        })
        .await?;
        // The same lazy orphan flip as REST (ADR 0019).
        let gone = range.is_none_or(|(s, e)| s >= e);
        let status = match (t.status.as_str(), gone) {
            ("open", true) => "orphaned",
            ("orphaned", false) => "open",
            (other, _) => other,
        };
        if status != t.status {
            db.set_thread_status(t.id, status).await.map_err(internal)?;
        }
        out.push(json!({
            "thread_id": t.id,
            "status": status,
            "range": range_json(range),
            "created_at": t.created_at,
            "comments": by_thread.remove(&t.id).unwrap_or_default(),
        }));
    }
    if let Some(filter) = args.get("status").and_then(Value::as_str) {
        out.retain(|t| t["status"] == filter);
    }
    Ok(json!({ "threads": out }))
}

async fn resolve_comment(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    gate(c, "resolve_comment")?;
    let thread_id = uuid_arg(args, "thread_id")?;
    let (ctx, _) = thread_ctx(c, thread_id, Role::Commenter).await?;
    let (db, _) = ctx.persistence()?;
    db.set_thread_status(thread_id, "resolved").await.map_err(internal)?;
    audit_mcp(&ctx, c, "comment_resolved", json!({ "thread_id": thread_id }));
    Ok(json!({ "thread_id": thread_id, "status": "resolved" }))
}

// ---------------------------------------------------------------------------
// Suggestions (list is open; accept/reject are gated, ADR 0008)
// ---------------------------------------------------------------------------

async fn suggestion_json(ctx: &DocCtx, s: &SuggestionRow) -> Result<Value, String> {
    let range = room_call(&ctx.room, |reply| RoomMsg::ResolveAnchor {
        anchor: s.anchor.clone(),
        reply,
    })
    .await?;
    Ok(json!({
        "id": s.id,
        "change_set_id": s.change_set_id,
        "status": s.status,
        "range": range_json(range),
        "op": s.op,
        "note": s.note,
        "author": s.author,
        "created_at": s.created_at,
    }))
}

async fn list_suggestions(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let ctx = c.doc(args, Role::Viewer, true).await?;
    let (db, document_id) = ctx.persistence()?;
    let status = args.get("status").and_then(Value::as_str);
    let mut rows = db.list_suggestions(document_id, status, None).await.map_err(internal)?;
    // Hard cap: one serialized ResolveAnchor per row (see MAX_LIST_ITEMS).
    rows.truncate(MAX_LIST_ITEMS);
    let mut out = Vec::with_capacity(rows.len());
    for s in &rows {
        out.push(suggestion_json(&ctx, s).await?);
    }
    Ok(json!({ "suggestions": out }))
}

/// Resolve a suggestion id to its document's DocCtx + the row.
async fn suggestion_ctx(
    c: &Caller<'_>,
    suggestion_id: Uuid,
    min_role: Role,
) -> Result<(DocCtx, SuggestionRow), String> {
    let db = c.persistence()?;
    let s = db
        .get_suggestion(suggestion_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| format!("no such suggestion: {suggestion_id}"))?;
    let slug = db
        .document_slug(s.document_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| "suggestion's document is gone".to_string())?;
    Ok((c.doc_by_slug(&slug, min_role, true).await?, s))
}

/// A pending suggestion's anchor → a concrete (start, end, insert), or the conflict reason
/// (same semantics as api.rs resolve_for_accept).
async fn resolve_for_accept(
    ctx: &DocCtx,
    s: &SuggestionRow,
) -> Result<Result<(usize, usize, String), String>, String> {
    let range = room_call(&ctx.room, |reply| RoomMsg::ResolveAnchor {
        anchor: s.anchor.clone(),
        reply,
    })
    .await?;
    let Some((start, end)) = range else {
        return Ok(Err("the suggestion's anchor no longer resolves".into()));
    };
    let old_text = s.op.get("old_text").and_then(Value::as_str).unwrap_or("");
    if start >= end && !old_text.is_empty() {
        return Ok(Err("the text this suggestion would replace was deleted".into()));
    }
    let insert = s.op.get("insert").and_then(Value::as_str).unwrap_or("").to_string();
    Ok(Ok((start, end, insert)))
}

fn suggestion_origin(s: &SuggestionRow) -> String {
    match &s.author {
        Some(a) if a.kind == "agent" => "agent".into(),
        _ => "human".into(),
    }
}

async fn accept_suggestion(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    gate(c, "accept_suggestion")?;
    let id = uuid_arg(args, "suggestion_id")?;
    let (ctx, s) = suggestion_ctx(c, id, Role::Editor).await?;
    if s.status != "pending" {
        return Err(format!("suggestion is already {}", s.status));
    }
    let (start, end, insert) = resolve_for_accept(&ctx, &s).await??;
    let seq = room_call(&ctx.room, |reply| RoomMsg::ApplyEdit {
        ops: vec![(start, end, insert.clone())],
        author_id: s.author.as_ref().map(|a| a.id),
        change_set_id: Some(s.change_set_id),
        origin: suggestion_origin(&s),
        reply,
    })
    .await??;
    let (db, _) = ctx.persistence()?;
    db.set_suggestion_status(id, "accepted").await.map_err(internal)?;
    audit_mcp(
        &ctx,
        c,
        "suggestion_accepted",
        json!({ "suggestion_id": id, "change_set_id": s.change_set_id, "seq": seq }),
    );
    Ok(json!({
        "id": id,
        "status": "accepted",
        "applied": { "start": start, "end": end, "insert": insert },
        "seq": seq,
    }))
}

async fn reject_suggestion(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    gate(c, "reject_suggestion")?;
    let id = uuid_arg(args, "suggestion_id")?;
    let (ctx, s) = suggestion_ctx(c, id, Role::Commenter).await?;
    // Editors reject anything; an author may withdraw their own (same rule as REST).
    let is_author =
        ctx.access.user_id.is_some() && ctx.access.user_id == s.author.as_ref().map(|a| a.id);
    if !(ctx.access.role.can_edit() || is_author) {
        return Err("forbidden: only editors (or the author) can reject".into());
    }
    if s.status != "pending" {
        return Err(format!("suggestion is already {}", s.status));
    }
    let (db, _) = ctx.persistence()?;
    db.set_suggestion_status(id, "rejected").await.map_err(internal)?;
    audit_mcp(
        &ctx,
        c,
        "suggestion_rejected",
        json!({ "suggestion_id": id, "change_set_id": s.change_set_id }),
    );
    Ok(json!({ "id": id, "status": "rejected" }))
}

/// Resolve a change set id to its document's DocCtx + its pending rows.
async fn change_set_ctx(
    c: &Caller<'_>,
    change_set_id: Uuid,
    min_role: Role,
) -> Result<(DocCtx, Vec<SuggestionRow>), String> {
    let db = c.persistence()?;
    let document_id = db
        .change_set_document(change_set_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| format!("no such change set: {change_set_id}"))?;
    let slug = db
        .document_slug(document_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| "change set's document is gone".to_string())?;
    let ctx = c.doc_by_slug(&slug, min_role, true).await?;
    let rows = db
        .list_suggestions(document_id, Some("pending"), Some(change_set_id))
        .await
        .map_err(internal)?;
    if rows.is_empty() {
        return Err("no pending suggestions in this change set".into());
    }
    Ok((ctx, rows))
}

async fn accept_change_set(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    gate(c, "accept_change_set")?;
    let change_set_id = uuid_arg(args, "change_set_id")?;
    let (ctx, rows) = change_set_ctx(c, change_set_id, Role::Editor).await?;

    // Same algorithm as REST accept_change_set: resolve all anchors, apply in anchor order
    // as ONE transaction, conflict out anything unresolvable or overlapping.
    let mut conflicts: Vec<Value> = Vec::new();
    let mut resolved: Vec<(usize, usize, String, Uuid)> = Vec::new();
    for s in &rows {
        match resolve_for_accept(&ctx, s).await? {
            Ok((start, end, insert)) => resolved.push((start, end, insert, s.id)),
            Err(reason) => conflicts.push(json!({ "id": s.id, "reason": reason })),
        }
    }
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
        seq = Some(
            room_call(&ctx.room, |reply| RoomMsg::ApplyEdit {
                ops,
                author_id: author,
                change_set_id: Some(change_set_id),
                origin,
                reply,
            })
            .await??,
        );
        let (db, _) = ctx.persistence()?;
        for id in &accepted {
            db.set_suggestion_status(*id, "accepted").await.map_err(internal)?;
        }
        audit_mcp(
            &ctx,
            c,
            "suggestion_accepted",
            json!({
                "change_set_id": change_set_id,
                "accepted_count": accepted.len(),
                "conflict_count": conflicts.len(),
                "seq": seq,
            }),
        );
    }
    Ok(json!({
        "change_set_id": change_set_id,
        "accepted": accepted,
        "conflicts": conflicts,
        "seq": seq,
    }))
}

async fn reject_change_set(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    gate(c, "reject_change_set")?;
    let change_set_id = uuid_arg(args, "change_set_id")?;
    let (ctx, rows) = change_set_ctx(c, change_set_id, Role::Commenter).await?;
    let is_author = ctx.access.user_id.is_some()
        && rows.iter().all(|s| ctx.access.user_id == s.author.as_ref().map(|a| a.id));
    if !(ctx.access.role.can_edit() || is_author) {
        return Err("forbidden: only editors (or the author) can reject".into());
    }
    let (db, _) = ctx.persistence()?;
    let mut rejected = Vec::with_capacity(rows.len());
    for s in &rows {
        db.set_suggestion_status(s.id, "rejected").await.map_err(internal)?;
        rejected.push(s.id);
    }
    audit_mcp(
        &ctx,
        c,
        "suggestion_rejected",
        json!({ "change_set_id": change_set_id, "rejected_count": rejected.len() }),
    );
    Ok(json!({ "change_set_id": change_set_id, "rejected": rejected }))
}

// ---------------------------------------------------------------------------
// Full-surface parity (MCP-parity audit 2026-07-02): the remaining user
// capabilities, BRIDGED onto the real REST handlers rather than re-implemented.
// Each tool builds the handler's extractors from the SAME state/jar/headers this
// request carried and invokes the handler function directly — so authentication,
// role checks, token scopes, audit entries, workspace SSE events, and storage
// side effects are the REST ones, by construction, and can never drift.
// ---------------------------------------------------------------------------

/// Convert a bridged handler's Response into an MCP tool result. Success bodies
/// parse as JSON (every bridged endpoint answers JSON); failures carry the
/// handler's plain-text error verbatim.
async fn rest_result(resp: Response) -> Result<Value, String> {
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), 8 * 1024 * 1024)
        .await
        .map_err(|e| format!("reading internal response failed: {e}"))?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if status.is_success() {
        Ok(serde_json::from_str(&text).unwrap_or_else(|_| json!({ "ok": true })))
    } else if text.trim().is_empty() {
        Err(format!("HTTP {status}"))
    } else {
        Err(text)
    }
}

/// Document-scoped variant: 403/404/410 collapse into the one generic message
/// (the same existence-oracle rule as doc_by_slug — slugs are globally unique).
async fn rest_doc_result(resp: Response) -> Result<Value, String> {
    let status = resp.status();
    if matches!(
        status,
        StatusCode::FORBIDDEN | StatusCode::NOT_FOUND | StatusCode::GONE
    ) {
        // Drain the body (drop the distinguishing text) before answering generically.
        let _ = axum::body::to_bytes(resp.into_body(), 64 * 1024).await;
        return Err(DOC_UNAVAILABLE.to_string());
    }
    rest_result(resp).await
}

/// Deserialize the tool arguments into a REST request body (unknown fields —
/// document_id/slug and friends — are ignored by serde's defaults).
fn body_from_args<T: serde::de::DeserializeOwned>(args: &Value) -> Result<T, String> {
    serde_json::from_value(args.clone()).map_err(|e| format!("invalid arguments: {e}"))
}

/// Copy selected args into a REST query map (numbers/bools stringified).
fn query_of(args: &Value, keys: &[&str]) -> Query<HashMap<String, String>> {
    let mut map = HashMap::new();
    for key in keys {
        match args.get(*key) {
            Some(Value::String(s)) => {
                map.insert((*key).to_string(), s.clone());
            }
            Some(v) if v.is_number() || v.is_boolean() => {
                map.insert((*key).to_string(), v.to_string());
            }
            _ => {}
        }
    }
    Query(map)
}

impl Caller<'_> {
    fn app(&self) -> State<AppState> {
        State(self.state.clone())
    }
    fn jar(&self) -> CookieJar {
        self.jar.clone()
    }
    fn headers(&self) -> HeaderMap {
        self.headers.clone()
    }
}

// --- documents: rename / move / star / trash / restore / purge ----------------

async fn update_document(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let slug = c.slug_from_args(args).await?;
    let req: crate::folders::UpdateDocumentReq = body_from_args(args)?;
    rest_doc_result(
        crate::folders::update_document(c.app(), Path(slug), c.jar(), c.headers(), Json(req))
            .await,
    )
    .await
}

async fn trash_document(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let slug = c.slug_from_args(args).await?;
    rest_doc_result(crate::folders::delete_document(c.app(), Path(slug), c.jar(), c.headers()).await)
        .await
}

async fn restore_document(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let slug = c.slug_from_args(args).await?;
    rest_doc_result(
        crate::folders::restore_document(c.app(), Path(slug), c.jar(), c.headers()).await,
    )
    .await
}

async fn purge_document(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    gate(c, "purge_document")?;
    let slug = c.slug_from_args(args).await?;
    rest_doc_result(crate::folders::purge_document(c.app(), Path(slug), c.jar(), c.headers()).await)
        .await
}

// --- search & graph ------------------------------------------------------------

async fn search_docs(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    if args.get("q").and_then(Value::as_str).map(str::trim).unwrap_or("").is_empty() {
        return Err("pass a non-empty q".into());
    }
    rest_result(
        crate::search::search(c.app(), query_of(args, &["q", "limit"]), c.jar(), c.headers())
            .await,
    )
    .await
}

async fn get_graph(c: &Caller<'_>) -> Result<Value, String> {
    rest_result(crate::links::graph(c.app(), c.jar(), c.headers()).await).await
}

async fn get_document_links(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let slug = c.slug_from_args(args).await?;
    rest_doc_result(
        crate::links::document_links(
            c.app(),
            Path(slug),
            Query(HashMap::new()),
            c.jar(),
            c.headers(),
        )
        .await,
    )
    .await
}

// --- comments: reopen (the inverse resolve_comment lacked) ----------------------

async fn reopen_comment(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let slug = c.slug_from_args(args).await?;
    let thread_id = uuid_arg(args, "thread_id")?;
    rest_doc_result(
        crate::api::reopen_thread(
            c.app(),
            Path((slug, thread_id)),
            Query(HashMap::new()),
            c.jar(),
            c.headers(),
        )
        .await,
    )
    .await
}

// --- folders ---------------------------------------------------------------------

async fn create_folder(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let req: crate::folders::CreateFolderReq = body_from_args(args)?;
    rest_result(crate::folders::create_folder(c.app(), c.jar(), c.headers(), Json(req)).await).await
}

async fn update_folder(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "folder_id")?;
    let req: crate::folders::UpdateFolderReq = body_from_args(args)?;
    rest_result(
        crate::folders::update_folder(c.app(), Path(id), c.jar(), c.headers(), Json(req)).await,
    )
    .await
}

async fn trash_folder(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "folder_id")?;
    rest_result(crate::folders::delete_folder(c.app(), Path(id), c.jar(), c.headers()).await).await
}

async fn restore_folder(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "folder_id")?;
    rest_result(crate::folders::restore_folder(c.app(), Path(id), c.jar(), c.headers()).await).await
}

// --- sharing & members -------------------------------------------------------------

async fn create_share_link(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let slug = c.slug_from_args(args).await?;
    let req: crate::auth::ShareRequest = body_from_args(args)?;
    rest_doc_result(
        crate::auth::create_share(c.app(), Path(slug), c.jar(), c.headers(), Json(req)).await,
    )
    .await
}

async fn list_document_members(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let slug = c.slug_from_args(args).await?;
    rest_doc_result(
        crate::api::list_members(c.app(), Path(slug), Query(HashMap::new()), c.jar(), c.headers())
            .await,
    )
    .await
}

// --- notifications (NOT bridged: the REST inbox is session-only, and an agent
// must read ITS OWN inbox — recipient = the agent identity — never its owner's) ---

fn inbox_user(c: &Caller<'_>) -> Result<Uuid, String> {
    match &c.principal {
        Some(p) if p.is_agent => Ok(p.author),
        Some(p) => Ok(p.role_user),
        None => Err("notifications require identity — the server runs in open mode".into()),
    }
}

async fn notif_list(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let db = c.persistence()?;
    let user = inbox_user(c)?;
    let unread_only = args.get("unread_only").and_then(Value::as_bool).unwrap_or(false);
    let before = args.get("before").and_then(Value::as_str);
    if let Some(raw) = before {
        match db.is_valid_timestamptz(raw).await {
            Ok(true) => {}
            Ok(false) => return Err("malformed before cursor".into()),
            Err(e) => return Err(internal(e)),
        }
    }
    let rows = db
        .list_notifications(user, unread_only, before, crate::notifications_api::INBOX_LIMIT)
        .await
        .map_err(internal)?;
    Ok(json!({ "notifications": rows }))
}

async fn notif_mark_read(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let db = c.persistence()?;
    let user = inbox_user(c)?;
    let id = uuid_arg(args, "notification_id")?;
    match db.mark_notification_read(id, user).await.map_err(internal)? {
        true => Ok(json!({ "ok": true })),
        false => Err("no such notification".into()),
    }
}

async fn notif_read_all(c: &Caller<'_>) -> Result<Value, String> {
    let db = c.persistence()?;
    let user = inbox_user(c)?;
    let n = db.mark_all_notifications_read(user).await.map_err(internal)?;
    Ok(json!({ "marked": n }))
}

// --- workspaces ----------------------------------------------------------------------

async fn ws_list(c: &Caller<'_>) -> Result<Value, String> {
    rest_result(crate::workspace::list_workspaces(c.app(), c.jar(), c.headers()).await).await
}

async fn ws_create(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let req: crate::workspace::CreateWorkspaceReq = body_from_args(args)?;
    rest_result(crate::workspace::create_workspace(c.app(), c.jar(), c.headers(), Json(req)).await)
        .await
}

async fn ws_get(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "workspace_id")?;
    rest_result(crate::workspace::get_workspace(c.app(), Path(id), c.jar(), c.headers()).await)
        .await
}

async fn ws_rename(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "workspace_id")?;
    let req: crate::workspace::RenameReq = body_from_args(args)?;
    rest_result(
        crate::workspace::rename_workspace(c.app(), Path(id), c.jar(), c.headers(), Json(req))
            .await,
    )
    .await
}

async fn ws_delete(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    gate(c, "delete_workspace")?;
    let id = uuid_arg(args, "workspace_id")?;
    rest_result(crate::workspace::delete_workspace(c.app(), Path(id), c.jar(), c.headers()).await)
        .await
}

async fn ws_invite(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "workspace_id")?;
    let req: crate::workspace::InviteReq = body_from_args(args)?;
    rest_result(
        crate::workspace::create_invite(c.app(), Path(id), c.jar(), c.headers(), Json(req)).await,
    )
    .await
}

async fn ws_revoke_invite(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let ws = uuid_arg(args, "workspace_id")?;
    let invite = uuid_arg(args, "invite_id")?;
    rest_result(
        crate::workspace::delete_invite(c.app(), Path((ws, invite)), c.jar(), c.headers()).await,
    )
    .await
}

async fn ws_set_role(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let ws = uuid_arg(args, "workspace_id")?;
    let user = uuid_arg(args, "user_id")?;
    let req: crate::workspace::MemberRoleReq = body_from_args(args)?;
    rest_result(
        crate::workspace::set_member_role(c.app(), Path((ws, user)), c.jar(), c.headers(), Json(req))
            .await,
    )
    .await
}

async fn ws_remove_member(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let ws = uuid_arg(args, "workspace_id")?;
    let user = uuid_arg(args, "user_id")?;
    rest_result(
        crate::workspace::remove_member(c.app(), Path((ws, user)), c.jar(), c.headers()).await,
    )
    .await
}

async fn ws_audit(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "workspace_id")?;
    rest_result(
        crate::audit::list_workspace_audit(
            c.app(),
            Path(id),
            query_of(args, &["limit", "before_id"]),
            c.jar(),
            c.headers(),
        )
        .await,
    )
    .await
}

// --- storage connections ---------------------------------------------------------------

async fn storage_list(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "workspace_id")?;
    rest_result(
        crate::workspace::list_storage_connections(c.app(), Path(id), c.jar(), c.headers()).await,
    )
    .await
}

async fn storage_create(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "workspace_id")?;
    let req: crate::workspace::CreateStorageReq = body_from_args(args)?;
    rest_result(
        crate::workspace::create_storage_connection(
            c.app(),
            Path(id),
            c.jar(),
            c.headers(),
            Json(req),
        )
        .await,
    )
    .await
}

async fn storage_delete(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let ws = uuid_arg(args, "workspace_id")?;
    let conn = uuid_arg(args, "connection_id")?;
    rest_result(
        crate::workspace::delete_storage_connection(c.app(), Path((ws, conn)), c.jar(), c.headers())
            .await,
    )
    .await
}

async fn storage_status_tool(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "workspace_id")?;
    rest_result(crate::workspace::storage_status(c.app(), Path(id), c.jar(), c.headers()).await)
        .await
}

async fn attach_storage(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let slug = c.slug_from_args(args).await?;
    let req: crate::workspace::AttachReq = body_from_args(args)?;
    rest_doc_result(
        crate::workspace::attach_document_storage(
            c.app(),
            Path(slug),
            Query(HashMap::new()),
            c.jar(),
            c.headers(),
            Json(req),
        )
        .await,
    )
    .await
}

// --- account: identity, profile, tokens, usage ------------------------------------------
// list/mint/revoke tokens, profile fields, and usage go through account.rs's
// session_ctx, which REFUSES agent principals (AGENTS_REJECTED) — deliberately
// inherited here: an agent must never mint itself keys or inspect its owner's.

async fn me_tool(c: &Caller<'_>) -> Result<Value, String> {
    rest_result(crate::auth::me(c.app(), c.jar(), c.headers()).await).await
}

async fn update_profile(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let req: crate::account::UpdateMeReq = body_from_args(args)?;
    rest_result(crate::account::update_me(c.app(), c.jar(), c.headers(), Json(req)).await).await
}

async fn tokens_list(c: &Caller<'_>) -> Result<Value, String> {
    rest_result(crate::account::list_tokens(c.app(), c.jar(), c.headers()).await).await
}

async fn tokens_mint(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let req: crate::account::MintTokenReq = body_from_args(args)?;
    rest_result(crate::account::mint_token(c.app(), c.jar(), c.headers(), Json(req)).await).await
}

async fn tokens_revoke(c: &Caller<'_>, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "token_id")?;
    rest_result(crate::account::revoke_token(c.app(), Path(id), c.jar(), c.headers()).await).await
}

async fn storage_usage_tool(c: &Caller<'_>) -> Result<Value, String> {
    rest_result(crate::account::storage_usage(c.app(), c.jar(), c.headers()).await).await
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchor_text_unique_match_resolves() {
        let text = "# Title\n\nhello brave world\n";
        assert_eq!(resolve_anchor_text(text, "brave"), Ok((15, 20)));
        // Whole-line anchors work too.
        assert_eq!(resolve_anchor_text(text, "# Title"), Ok((0, 7)));
    }

    #[test]
    fn anchor_text_not_found_is_an_error() {
        let err = resolve_anchor_text("hello world", "missing").unwrap_err();
        assert!(err.contains("not found"), "{err}");
    }

    #[test]
    fn anchor_text_ambiguous_lists_offsets_and_contexts() {
        let text = "alpha beta gamma beta delta beta\n";
        let err = resolve_anchor_text(text, "beta").unwrap_err();
        assert!(err.contains("ambiguous (3 matches)"), "{err}");
        // every match offset is listed with surrounding context, never guessed
        for offset in ["byte 6:", "byte 17:", "byte 28:"] {
            assert!(err.contains(offset), "missing {offset} in {err}");
        }
        assert!(err.contains("alpha beta gamma"), "context missing: {err}");
    }

    #[test]
    fn anchor_text_ambiguity_context_respects_char_boundaries() {
        let text = "🥣🥣 x 🥣🥣 x 🥣🥣\n";
        let err = resolve_anchor_text(text, "x").unwrap_err();
        assert!(err.contains("ambiguous (2 matches)"), "{err}");
    }

    #[test]
    fn build_ops_anchor_semantics() {
        let text = "hello brave world\n";
        // delete only
        let ops = build_ops(text, &[json!({ "anchor_text": "brave ", "delete": true })]).unwrap();
        assert_eq!(ops, vec![(6, 12, String::new())]);
        // insert AFTER the anchor
        let ops = build_ops(text, &[json!({ "anchor_text": "brave", "insert": " new" })]).unwrap();
        assert_eq!(ops, vec![(11, 11, " new".to_string())]);
        // replace
        let ops = build_ops(
            text,
            &[json!({ "anchor_text": "brave", "insert": "bold", "delete": true })],
        )
        .unwrap();
        assert_eq!(ops, vec![(6, 11, "bold".to_string())]);
        // neither insert nor delete is an error
        assert!(build_ops(text, &[json!({ "anchor_text": "brave" })]).is_err());
    }

    #[test]
    fn build_ops_range_and_replace_all() {
        let text = "0123456789";
        let ops = build_ops(text, &[json!({ "range": { "start": 2, "end": 4 }, "insert": "X" })])
            .unwrap();
        assert_eq!(ops, vec![(2, 4, "X".to_string())]);
        let ops = build_ops(text, &[json!({ "replace_all": "fresh" })]).unwrap();
        assert_eq!(ops, vec![(0, 10, "fresh".to_string())]);
        let err =
            build_ops(text, &[json!({ "replace_all": "a" }), json!({ "replace_all": "b" })])
                .unwrap_err();
        assert!(err.contains("only edit"), "{err}");
    }

    #[test]
    fn build_ops_caps_the_edit_count() {
        let text = "0123456789";
        let edits: Vec<Value> = (0..=MAX_EDITS)
            .map(|_| json!({ "range": { "start": 0, "end": 0 }, "insert": "x" }))
            .collect();
        let err = build_ops(text, &edits).unwrap_err();
        assert!(err.contains("too many edits"), "{err}");
    }

    #[test]
    fn build_ops_sorts_and_rejects_overlap() {
        let text = "alpha beta gamma\n";
        // Out-of-order inputs get sorted.
        let ops = build_ops(
            text,
            &[
                json!({ "anchor_text": "gamma", "insert": "GAMMA", "delete": true }),
                json!({ "anchor_text": "alpha", "insert": "ALPHA", "delete": true }),
            ],
        )
        .unwrap();
        assert_eq!(ops[0].0, 0);
        assert_eq!(ops[1].0, 11);
        // Overlapping edits error out.
        let err = build_ops(
            text,
            &[
                json!({ "range": { "start": 0, "end": 8 } }),
                json!({ "range": { "start": 4, "end": 12 } }),
            ],
        )
        .unwrap_err();
        assert!(err.contains("overlap"), "{err}");
    }

    #[test]
    fn downgrade_decision_matrix() {
        // requested, human_present, policy → applied
        let cases = [
            ("direct", false, "auto", "direct"),  // headless: full automation
            ("direct", true, "auto", "suggest"),  // co-present: downgrade (ADR 0007)
            ("direct", true, "always", "direct"), // operator pinned direct
            ("direct", false, "always", "direct"),
            ("direct", false, "never", "suggest"), // doc/server pinned to suggest
            ("direct", true, "never", "suggest"),
            ("suggest", false, "auto", "suggest"), // suggest is never upgraded
            ("suggest", true, "always", "suggest"),
        ];
        for (requested, human, policy, expected) in cases {
            assert_eq!(
                decide_mode(requested, human, policy),
                expected,
                "decide_mode({requested}, {human}, {policy})"
            );
        }
    }
}
