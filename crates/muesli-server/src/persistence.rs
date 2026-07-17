//! Postgres persistence (ADR 0010): an append-only per-document update log plus periodic
//! snapshots. Loading = latest snapshot + replay of the tail. The log is never pruned — it is
//! the edit history.

use anyhow::{anyhow, Context, Result};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// Snapshot every N appended updates (compaction cadence; tune later, ADR 0021 metrics).
pub const SNAPSHOT_EVERY: u64 = 256;

pub struct Persistence {
    pool: PgPool,
}

/// Everything a room needs to hydrate.
pub struct DocState {
    pub document_id: Uuid,
    pub workspace_id: Option<Uuid>,
    pub snapshot: Option<Vec<u8>>,
    pub tail: Vec<Vec<u8>>,
    pub last_seq: i64,
}

pub struct DocRef {
    pub id: Uuid,
    pub workspace_id: Option<Uuid>,
    pub folder_id: Option<Uuid>,
    /// Stored display name; None falls back to the slug (folders.rs rename).
    pub title: Option<String>,
    /// In the trash (migration 0008): trashed documents refuse new room connections.
    pub deleted: bool,
    /// Starred / favourite (migration 0011). Workspace-global v1 flag.
    pub starred: bool,
}

/// One row of `list_documents` (MCP, ADR 0008; GET /api/documents).
pub struct DocumentListing {
    pub id: Uuid,
    pub slug: String,
    pub updated_at: String,
    pub workspace_id: Option<Uuid>,
    pub folder_id: Option<Uuid>,
    /// Stored display name (rename); None falls back to the slug. A deliberate deviation
    /// from ADR 0013's derived titles — the slug (room identity) never changes on rename.
    pub title: Option<String>,
    pub deleted_at: Option<String>,
    /// Starred / favourite (migration 0011). Workspace-global v1 flag.
    pub starred: bool,
    /// The owning user: the document_acl row granted at creation (ensure_document_owned),
    /// preferring the row matching documents.created_by. None for pre-auth documents.
    pub owner_id: Option<Uuid>,
    pub owner_name: Option<String>,
}

/// One GET /api/search hit, pre-ranking-tier (see search.rs for the response shape).
pub struct SearchRow {
    pub id: Uuid,
    pub slug: String,
    pub title: Option<String>,
    pub folder_id: Option<Uuid>,
    pub workspace_id: Option<Uuid>,
    pub updated_at: String,
    /// The attached storage connection, when any (search.rs turns this into a label).
    pub conn_kind: Option<String>,
    pub conn_config: Option<serde_json::Value>,
    pub owner_id: Option<Uuid>,
    pub owner_name: Option<String>,
    /// The search-text projection; None when the document has no row yet (title-only hit).
    pub content: Option<String>,
    /// 0 = title prefix, 1 = title substring, 2 = content FTS, 3 = content ILIKE.
    pub tier: i32,
    pub rank: f32,
}

/// One folders row (migration 0008; GET /api/documents "folders", /api/folders).
pub struct FolderRow {
    pub id: Uuid,
    pub workspace_id: Option<Uuid>,
    pub parent_id: Option<Uuid>,
    pub name: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

/// One workspace the caller belongs to (GET /api/workspaces).
pub struct WorkspaceListing {
    pub id: Uuid,
    pub name: String,
    pub role: String,
    pub is_personal: bool,
}

/// One member of a workspace (GET /api/workspaces/{id}).
pub struct MemberRow {
    pub user_id: Uuid,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub kind: String,
    pub role: String,
}

/// One pending invite (GET /api/workspaces/{id}, admins only).
pub struct InviteRow {
    pub id: Uuid,
    pub email: String,
    pub role: String,
    pub created_at: String,
}

/// One storage connection (ADR 0013).
pub struct StorageConnRow {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub kind: String,
    pub config: serde_json::Value,
    pub created_at: String,
}

/// Workspace lifecycle + storage binding (BYO storage, migration 0015).
pub struct WorkspaceMeta {
    pub status: String,
    pub storage_conn_id: Option<Uuid>,
    pub retention: Option<String>,
}

/// A live document with no storage attachment (the grandfathered bulk-bind list).
pub struct UnattachedDoc {
    pub id: Uuid,
    pub slug: String,
    pub folder_id: Option<Uuid>,
    pub title: Option<String>,
}

/// UnattachedDoc + its workspace (the auto-attach lookup needs the binding).
pub struct UnattachedDocFull {
    pub id: Uuid,
    pub slug: String,
    pub workspace_id: Option<Uuid>,
    pub folder_id: Option<Uuid>,
    pub title: Option<String>,
}

/// A document attached to a storage backend (the materialize/poll loops, ADR 0013).
pub struct AttachedDoc {
    pub document_id: Uuid,
    pub slug: String,
    pub rel_path: String,
    pub content_hash: Option<String>,
    pub kind: String,
    pub config: serde_json::Value,
    /// The connection's workspace — where poll-ingest auto-creates folder chains for
    /// nested rel_paths (migration 0008).
    pub workspace_id: Uuid,
    pub folder_id: Option<Uuid>,
    /// The storage connection this document is attached to (plan 1a task 10: the key
    /// into `HealthRegistry`).
    pub storage_conn_id: Uuid,
}

/// Attribution as the API exposes it ({id, display_name, kind}); None = anonymous.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AuthorJson {
    pub id: Uuid,
    pub display_name: Option<String>,
    pub kind: String,
}

/// A person who can be @mentioned on a document: the union of the doc's workspace
/// members and explicit share-grantees (document_acl). `kind` is the users.kind
/// ('human' | 'agent'); `avatar_url` honors the per-user override.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DocMemberRow {
    pub id: Uuid,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub kind: String,
}

pub struct ThreadRow {
    pub id: Uuid,
    pub anchor: serde_json::Value,
    pub status: String,
    pub created_by: Option<Uuid>,
    pub created_at: String,
}

/// One `notification` row as the inbox API exposes it (sub-project ④c). `payload` is the
/// type-specific render data ({ actor_name, doc_slug, doc_title, thread_id, comment_id } for
/// 'mention'); the client renders straight from it. `read` is `read_at is not null`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct NotificationRow {
    pub id: Uuid,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: serde_json::Value,
    pub actor_id: Option<Uuid>,
    pub read: bool,
    pub created_at: String,
}

/// A newly-enqueued notification's dispatch context (sub-project ④c): who to deliver to and
/// their resolved email + stored preference matrix. Returned by [`Persistence::record_mentions`]
/// so the API layer can spawn delivery off the request path.
///
/// `notification_id` is `Some` only when the in-app channel was enabled and a `notification` row
/// was actually inserted; it is `None` when in-app is disabled but another channel (email) is
/// on, so the context still exists to drive out-of-band delivery. The email path never reads
/// `notification_id` — it resolves channels from `prefs` — so the `None` case is delivery-safe.
pub struct DispatchContext {
    pub notification_id: Option<Uuid>,
    pub recipient_id: Uuid,
    pub recipient_email: Option<String>,
    pub prefs: Vec<crate::notifications::PreferenceRow>,
}

pub struct CommentRow {
    pub id: Uuid,
    pub thread_id: Uuid,
    pub body: String,
    pub created_at: String,
    pub author: Option<AuthorJson>,
}

pub struct SuggestionRow {
    pub id: Uuid,
    pub document_id: Uuid,
    pub change_set_id: Uuid,
    pub anchor: serde_json::Value,
    pub op: serde_json::Value,
    pub note: Option<String>,
    pub status: String,
    pub created_at: String,
    pub author: Option<AuthorJson>,
}

pub struct HistoryRow {
    pub seq: i64,
    pub origin: Option<String>,
    pub change_set_id: Option<Uuid>,
    pub created_at: String,
    pub created_ms: i64,
    pub author: Option<AuthorJson>,
}

fn author_from(r: &sqlx::postgres::PgRow) -> Option<AuthorJson> {
    let id: Option<Uuid> = r.get("author_id");
    id.map(|id| AuthorJson {
        id,
        display_name: r.get("author_name"),
        kind: r.get("author_kind"),
    })
}

fn suggestion_from(r: &sqlx::postgres::PgRow) -> SuggestionRow {
    SuggestionRow {
        id: r.get("id"),
        document_id: r.get("document_id"),
        change_set_id: r.get("change_set_id"),
        anchor: r.get("anchor"),
        op: r.get("op"),
        note: r.get("note"),
        status: r.get("status"),
        created_at: r.get("created_at"),
        author: author_from(r),
    }
}

/// One document_links row as the graph endpoint reads it (ADR 0015).
pub struct GraphLinkRow {
    pub src: Uuid,
    pub dst: Option<Uuid>,
    pub raw_target: String,
}

/// One outgoing link of a document (GET /api/documents/{slug}/links).
pub struct OutgoingLinkRow {
    pub raw_target: String,
    pub dst_id: Option<Uuid>,
    pub dst_slug: Option<String>,
}

/// One incoming link (backlink) of a document.
pub struct IncomingLinkRow {
    pub src_id: Uuid,
    pub src_slug: String,
    pub raw_target: String,
}

/// One of the caller's delegated API keys (GET /api/me/tokens). The label is the agent
/// user's display_name (tokens have no label column of their own); the hash never
/// leaves the table.
pub struct OwnedTokenRow {
    pub id: Uuid,
    pub label: String,
    pub scopes: Vec<String>,
    pub created_at: String,
    pub expires_at: Option<String>,
}

/// A resolved (valid, unexpired, unrevoked) API token (mcp-and-agent-auth.md).
pub struct ApiTokenInfo {
    pub principal_id: Uuid,
    pub owner_user_id: Option<Uuid>,
    pub scopes: Vec<String>,
    pub workspace_id: Option<Uuid>,
    pub document_id: Option<Uuid>,
    /// 'device' (cli_login's OS-Keychain token) or 'delegated' (POST /api/me/tokens);
    /// migration 0017. See auth::TokenKind for what distinguishes on this.
    pub kind: String,
}

/// A document get-or-created by [`Persistence::ensure_document_owned`]. `created` is true
/// when this call inserted the row (it drives the document_created audit entry).
pub struct EnsuredDoc {
    pub id: Uuid,
    pub workspace_id: Option<Uuid>,
    pub created: bool,
}

/// A document created by [`Persistence::create_document_in_workspace`] (Plan 5). `created`
/// is false on the idempotent path (the doc already existed in this same workspace), true
/// when this call inserted the row.
pub struct CreatedDoc {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub folder_id: Option<Uuid>,
    pub created: bool,
}

/// True when a user-supplied name is empty once trimmed — the shared blank-name guard for
/// workspace creation (workspace::create_workspace) and rename. Pure so it is unit-tested
/// without a database.
pub(crate) fn blank_name(name: &str) -> bool {
    name.trim().is_empty()
}

/// One audit_log row joined to its actor (GET /api/workspaces/{id}/audit; migration 0007).
pub struct AuditLogRow {
    pub id: i64,
    pub action: String,
    pub actor: Option<AuthorJson>,
    pub actor_label: Option<String>,
    pub document_id: Option<Uuid>,
    pub detail: serde_json::Value,
    pub created_at: String,
}

impl Persistence {
    pub async fn connect(url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .connect(url)
            .await
            .with_context(|| format!("connecting to {url}"))?;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .context("running migrations")?;
        Ok(Self { pool })
    }

    /// A pool that never contacts the database until first use — tests point it at a
    /// dead address to exercise failure paths (the audit never-fails contract).
    #[cfg(test)]
    pub(crate) fn lazy_for_tests(url: &str) -> Self {
        let pool = PgPoolOptions::new()
            // Fail fast: these pools point at dead addresses on purpose.
            .acquire_timeout(std::time::Duration::from_millis(500))
            .connect_lazy(url)
            .expect("lazy pool");
        Self { pool }
    }

    /// Get-or-create the Document for a room slug and load snapshot + replay tail.
    pub async fn load(&self, slug: &str) -> Result<DocState> {
        let row = sqlx::query(
            "insert into documents (slug) values ($1)
             on conflict (slug) do update set updated_at = now()
             returning id, workspace_id",
        )
        .bind(slug)
        .fetch_one(&self.pool)
        .await?;
        let document_id: Uuid = row.get("id");
        let workspace_id: Option<Uuid> = row.get("workspace_id");

        let snap = sqlx::query(
            "select up_to_seq, snapshot_blob from crdt_snapshots
             where document_id = $1 order by up_to_seq desc limit 1",
        )
        .bind(document_id)
        .fetch_optional(&self.pool)
        .await?;
        let (snap_seq, snapshot) = match snap {
            Some(r) => (
                r.get::<i64, _>("up_to_seq"),
                Some(r.get::<Vec<u8>, _>("snapshot_blob")),
            ),
            None => (0, None),
        };

        let rows = sqlx::query(
            "select seq, update_blob from crdt_updates
             where document_id = $1 and seq > $2 order by seq asc",
        )
        .bind(document_id)
        .bind(snap_seq)
        .fetch_all(&self.pool)
        .await?;
        let last_seq = rows
            .last()
            .map(|r| r.get::<i64, _>("seq"))
            .unwrap_or(snap_seq);
        let tail = rows
            .into_iter()
            .map(|r| r.get::<Vec<u8>, _>("update_blob"))
            .collect();

        Ok(DocState {
            document_id,
            workspace_id,
            snapshot,
            tail,
            last_seq,
        })
    }

    pub async fn append_update(
        &self,
        document_id: Uuid,
        seq: i64,
        blob: &[u8],
        origin: &str,
        author_id: Option<Uuid>,
        change_set_id: Option<Uuid>,
    ) -> Result<()> {
        sqlx::query(
            "insert into crdt_updates (document_id, seq, update_blob, origin, author_id, change_set_id)
             values ($1, $2, $3, $4, $5, $6)",
        )
        .bind(document_id)
        .bind(seq)
        .bind(blob)
        .bind(origin)
        .bind(author_id)
        .bind(change_set_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Snapshot + update tail capped at `seq`, for reconstructing the text at a point in
    /// history (GET text?seq=N). Returns (snapshot, updates ≤ seq after it).
    pub async fn load_at(
        &self,
        document_id: Uuid,
        seq: i64,
    ) -> Result<(Option<Vec<u8>>, Vec<Vec<u8>>)> {
        let snap = sqlx::query(
            "select up_to_seq, snapshot_blob from crdt_snapshots
             where document_id = $1 and up_to_seq <= $2 order by up_to_seq desc limit 1",
        )
        .bind(document_id)
        .bind(seq)
        .fetch_optional(&self.pool)
        .await?;
        let (snap_seq, snapshot) = match snap {
            Some(r) => (
                r.get::<i64, _>("up_to_seq"),
                Some(r.get::<Vec<u8>, _>("snapshot_blob")),
            ),
            None => (0, None),
        };
        let rows = sqlx::query(
            "select update_blob from crdt_updates
             where document_id = $1 and seq > $2 and seq <= $3 order by seq asc",
        )
        .bind(document_id)
        .bind(snap_seq)
        .bind(seq)
        .fetch_all(&self.pool)
        .await?;
        Ok((
            snapshot,
            rows.into_iter()
                .map(|r| r.get::<Vec<u8>, _>("update_blob"))
                .collect(),
        ))
    }

    pub async fn save_snapshot(
        &self,
        document_id: Uuid,
        up_to_seq: i64,
        blob: &[u8],
    ) -> Result<()> {
        sqlx::query(
            "insert into crdt_snapshots (document_id, up_to_seq, snapshot_blob) values ($1, $2, $3)
             on conflict (document_id, up_to_seq) do nothing",
        )
        .bind(document_id)
        .bind(up_to_seq)
        .bind(blob)
        .execute(&self.pool)
        .await?;
        sqlx::query("update documents set updated_at = now() where id = $1")
            .bind(document_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Bounded-retention pruning (BYO storage spec §5). Deletes updates covered by the
    /// latest snapshot and all older snapshots. Callers MUST only invoke this after the
    /// document's current content was verified written to its storage backend — this
    /// function itself cannot know that. Without any snapshot it prunes NOTHING (the
    /// update log is then the only representation of the document).
    pub async fn prune_history(&self, document_id: Uuid) -> Result<(u64, u64)> {
        let latest: Option<i64> =
            sqlx::query_scalar("select max(up_to_seq) from crdt_snapshots where document_id = $1")
                .bind(document_id)
                .fetch_one(&self.pool)
                .await?;
        let Some(latest) = latest else {
            return Ok((0, 0));
        };
        let updates = sqlx::query("delete from crdt_updates where document_id = $1 and seq <= $2")
            .bind(document_id)
            .bind(latest)
            .execute(&self.pool)
            .await?
            .rows_affected();
        let snaps =
            sqlx::query("delete from crdt_snapshots where document_id = $1 and up_to_seq < $2")
                .bind(document_id)
                .bind(latest)
                .execute(&self.pool)
                .await?
                .rows_affected();
        Ok((updates, snaps))
    }

    /// The document's workspace retention override ('full' | 'bounded' | None = server
    /// default). None also for workspace-less documents.
    pub async fn workspace_retention_for_document(
        &self,
        document_id: Uuid,
    ) -> Result<Option<String>> {
        let row = sqlx::query(
            "select w.retention from documents d join workspaces w on w.id = d.workspace_id
             where d.id = $1",
        )
        .bind(document_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.and_then(|r| r.get::<Option<String>, _>("retention")))
    }

    // -----------------------------------------------------------------------
    // Identity & sharing (ADR 0011, 0012; migration 0002)
    // -----------------------------------------------------------------------

    /// Upsert a User keyed by the external (issuer, subject) identity (ADR 0012).
    pub async fn upsert_oidc_user(
        &self,
        issuer: &str,
        subject: &str,
        email: Option<&str>,
        display_name: Option<&str>,
        avatar_url: Option<&str>,
    ) -> Result<Uuid> {
        let row = sqlx::query(
            "insert into users (kind, oidc_issuer, oidc_subject, email, display_name, avatar_url)
             values ('human', $1, $2, $3, $4, $5)
             on conflict (oidc_issuer, oidc_subject) do update set
                 email        = coalesce(excluded.email, users.email),
                 display_name = coalesce(excluded.display_name, users.display_name),
                 avatar_url   = coalesce(excluded.avatar_url, users.avatar_url)
             returning id",
        )
        .bind(issuer)
        .bind(subject)
        .bind(email)
        .bind(display_name)
        .bind(avatar_url)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.get("id"))
    }

    /// The user as the API exposes them: profile overrides (migration 0010) win over the
    /// IdP claim columns, which upsert_oidc_user keeps refreshing on every login.
    pub async fn get_user(&self, user_id: Uuid) -> Result<Option<crate::auth::UserJson>> {
        let row = sqlx::query(
            "select id, email,
                    coalesce(custom_display_name, display_name) as display_name,
                    coalesce(custom_avatar_url, avatar_url) as avatar_url,
                    to_char(onboarded_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as onboarded_at
             from users where id = $1",
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| crate::auth::UserJson {
            id: r.get("id"),
            email: r.get("email"),
            display_name: r.get("display_name"),
            avatar_url: r.get("avatar_url"),
            onboarded_at: r.get("onboarded_at"),
        }))
    }

    /// Set/clear the user-owned profile override columns (migration 0010; PATCH /api/me).
    /// Each `set_*` flag gates its column (the PATCH "absent = unchanged" semantics);
    /// the value None clears the override back to the IdP claim. False = no such user.
    pub async fn update_user_overrides(
        &self,
        user_id: Uuid,
        set_display_name: bool,
        display_name: Option<&str>,
        set_avatar_url: bool,
        avatar_url: Option<&str>,
    ) -> Result<bool> {
        let res = sqlx::query(
            "update users set
                 custom_display_name = case when $2 then $3 else custom_display_name end,
                 custom_avatar_url   = case when $4 then $5 else custom_avatar_url end
             where id = $1",
        )
        .bind(user_id)
        .bind(set_display_name)
        .bind(display_name)
        .bind(set_avatar_url)
        .bind(avatar_url)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected() > 0)
    }

    /// Stamp users.onboarded_at (first-login onboarding, migration 0016).
    /// Idempotent by design: the FIRST stamp wins — completing onboarding on a
    /// second device keeps the original time. False = no such user.
    pub async fn set_user_onboarded(&self, user_id: Uuid) -> Result<bool> {
        let res = sqlx::query(
            "update users set onboarded_at = coalesce(onboarded_at, now()) where id = $1",
        )
        .bind(user_id)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected() > 0)
    }

    /// The user's stored preference object (migration 0018). None = no such user.
    pub async fn get_user_prefs(&self, user_id: Uuid) -> Result<Option<serde_json::Value>> {
        let row = sqlx::query("select prefs from users where id = $1")
            .bind(user_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.get("prefs")))
    }

    /// Sparse-merge into users.prefs (PATCH /api/me/prefs): keys in `set` are
    /// written (overwriting), keys in `delete` are removed — deletion wins when a
    /// key somehow appears in both, matching "null deletes" (the API layer never
    /// produces that overlap). Returns the full merged object; None = no such user.
    /// Last-write-wins, no versioning.
    pub async fn merge_user_prefs(
        &self,
        user_id: Uuid,
        set: &serde_json::Value,
        delete: &[String],
    ) -> Result<Option<serde_json::Value>> {
        let row = sqlx::query(
            "update users set prefs = (prefs || $2::jsonb) - $3::text[]
             where id = $1 returning prefs",
        )
        .bind(user_id)
        .bind(set)
        .bind(delete)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.get("prefs")))
    }

    /// The user's primary workspace if any (personal first, then oldest). BYO storage:
    /// nothing may auto-create workspaces anymore, so this is a lookup only — callers
    /// that used to fall back to auto-creation now surface "no workspace" to the user.
    /// A workspace still `pending_storage` (created, wizard not finished) does not count
    /// as usable yet — it has no storage bound, so documents cannot attach to it.
    pub async fn primary_workspace_of(&self, user_id: Uuid) -> Result<Option<Uuid>> {
        let row = sqlx::query(
            "select w.id from memberships m join workspaces w on w.id = m.workspace_id
             where m.user_id = $1 and w.status <> 'pending_storage'
             order by (w.created_by = $1) desc nulls last, w.created_at asc limit 1",
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.get("id")))
    }

    /// Create a brand-new workspace owned by `owner`, who is granted the 'admin' membership.
    /// Unlike [`Self::primary_workspace_of`] there is no get-or-create pre-check: every
    /// call inserts a fresh workspace (Plan 5 — explicit create-remote / promote).
    pub async fn create_workspace(&self, name: &str, owner: Uuid) -> Result<Uuid> {
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "insert into workspaces (name, created_by, status) values ($1, $2, 'pending_storage')
             returning id",
        )
        .bind(name)
        .bind(owner)
        .fetch_one(&mut *tx)
        .await?;
        let workspace_id: Uuid = row.get("id");
        sqlx::query(
            "insert into memberships (workspace_id, user_id, role) values ($1, $2, 'admin')",
        )
        .bind(workspace_id)
        .bind(owner)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(workspace_id)
    }

    pub async fn find_document(&self, slug: &str) -> Result<Option<DocRef>> {
        let row = sqlx::query(
            "select id, workspace_id, folder_id, title, starred,
                    (deleted_at is not null) as deleted
             from documents where slug = $1",
        )
        .bind(slug)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| DocRef {
            id: r.get("id"),
            workspace_id: r.get("workspace_id"),
            folder_id: r.get("folder_id"),
            title: r.get("title"),
            deleted: r.get("deleted"),
            starred: r.get("starred"),
        }))
    }

    /// Get-or-create a Document owned by `owner`'s Workspace; the owner becomes an Editor
    /// via an explicit ACL grant. `creator` is who actually performed the creation (may be
    /// an agent identity acting for the owner). Existing documents are returned unchanged
    /// (including pre-auth ones with no owner).
    pub async fn ensure_document_owned(
        &self,
        slug: &str,
        owner: Uuid,
        creator: Uuid,
    ) -> Result<EnsuredDoc> {
        let workspace_id = self
            .primary_workspace_of(owner)
            .await?
            .ok_or_else(|| anyhow::anyhow!("user has no workspace yet — create one first"))?;
        let mut tx = self.pool.begin().await?;
        // `returning workspace_id` reads the ROW's owner — for a pre-existing document
        // that is its real workspace, not the caller's.
        let row = sqlx::query(
            "insert into documents (slug, workspace_id, created_by) values ($1, $2, $3)
             on conflict (slug) do update set updated_at = now()
             returning id, workspace_id, (xmax = 0) as inserted",
        )
        .bind(slug)
        .bind(workspace_id)
        .bind(creator)
        .fetch_one(&mut *tx)
        .await?;
        let document_id: Uuid = row.get("id");
        let created: bool = row.get("inserted");
        if created {
            sqlx::query(
                "insert into document_acl (document_id, user_id, role) values ($1, $2, 'editor')
                 on conflict do nothing",
            )
            .bind(document_id)
            .bind(owner)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(EnsuredDoc {
            id: document_id,
            workspace_id: row.get("workspace_id"),
            created,
        })
    }

    /// Birth a document DIRECTLY in `workspace_id` (Plan 5: POST /api/documents). Purely
    /// structural — sets slug/workspace/folder/title only; the document TEXT is owned by the
    /// daemon's CRDT replica and never touched here (one-replica-per-doc).
    ///
    /// Idempotent on the slug: if the slug already exists IN THE SAME workspace this returns the
    /// existing row with `created = false`; if it exists in a DIFFERENT workspace this errors with
    /// a message containing `slug_in_other_workspace` (the handler maps that to 409). On a fresh
    /// insert the `owner` is granted an explicit 'editor' ACL grant, mirroring
    /// [`Self::ensure_document_owned`].
    pub async fn create_document_in_workspace(
        &self,
        slug: &str,
        workspace_id: Uuid,
        folder_id: Option<Uuid>,
        title: Option<&str>,
        owner: Uuid,
    ) -> Result<CreatedDoc> {
        let mut tx = self.pool.begin().await?;
        let inserted = sqlx::query(
            "insert into documents (slug, workspace_id, folder_id, title, created_by)
             values ($1, $2, $3, $4, $5)
             on conflict (slug) do nothing
             returning id",
        )
        .bind(slug)
        .bind(workspace_id)
        .bind(folder_id)
        .bind(title)
        .bind(owner)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(row) = inserted {
            let document_id: Uuid = row.get("id");
            sqlx::query(
                "insert into document_acl (document_id, user_id, role) values ($1, $2, 'editor')
                 on conflict do nothing",
            )
            .bind(document_id)
            .bind(owner)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(CreatedDoc {
                id: document_id,
                workspace_id,
                folder_id,
                created: true,
            });
        }

        // The slug already exists. Read the existing row's owner workspace to decide:
        // same workspace → idempotent success; different workspace → typed 409 conflict.
        let existing =
            sqlx::query("select id, workspace_id, folder_id from documents where slug = $1")
                .bind(slug)
                .fetch_one(&mut *tx)
                .await?;
        tx.commit().await?;
        let existing_ws: Option<Uuid> = existing.get("workspace_id");
        if existing_ws == Some(workspace_id) {
            Ok(CreatedDoc {
                id: existing.get("id"),
                workspace_id,
                folder_id: existing.get("folder_id"),
                created: false,
            })
        } else {
            anyhow::bail!("slug_in_other_workspace: {slug} already exists elsewhere")
        }
    }

    /// A user's effective role on a Document: explicit ACL grant, or Editor via
    /// membership in the owning Workspace (ADR 0011).
    pub async fn user_role(
        &self,
        document_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<crate::auth::Role>> {
        let acl =
            sqlx::query("select role from document_acl where document_id = $1 and user_id = $2")
                .bind(document_id)
                .bind(user_id)
                .fetch_optional(&self.pool)
                .await?
                .and_then(|r| crate::auth::Role::parse(r.get("role")));

        let member = sqlx::query(
            "select 1 as one from memberships m
             join documents d on d.workspace_id = m.workspace_id
             where d.id = $1 and m.user_id = $2",
        )
        .bind(document_id)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?
        .map(|_| crate::auth::Role::Editor);

        Ok(acl.max(member))
    }

    /// Resolve a share-link token to its role. `token` is the RAW token from the caller;
    /// the stored column holds its SHA-256 digest (see [`Self::create_share_link`]), so
    /// the comparison is hash-to-hash — mirroring api_tokens.
    pub async fn share_link_role(
        &self,
        document_id: Uuid,
        token: &str,
    ) -> Result<Option<crate::auth::Role>> {
        let row = sqlx::query(
            "select role from share_links
             where document_id = $1 and token = $2
               and (expires_at is null or expires_at > now())",
        )
        .bind(document_id)
        .bind(crate::auth::hash_token(token))
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.and_then(|r| crate::auth::Role::parse(r.get("role"))))
    }

    /// Create an agent identity: a first-class users row with kind = 'agent'
    /// (mcp-and-agent-auth.md). No OIDC fields — agents authenticate via api_tokens.
    pub async fn create_agent_user(&self, display_name: &str) -> Result<Uuid> {
        let row =
            sqlx::query("insert into users (kind, display_name) values ('agent', $1) returning id")
                .bind(display_name)
                .fetch_one(&self.pool)
                .await?;
        Ok(row.get("id"))
    }

    /// Mint one api_tokens row. `kind` is 'device' for cli_login's OS-Keychain token or
    /// 'delegated' for an ordinary POST /api/me/tokens key (migration 0017) — the
    /// distinction the notifications REST surface uses to admit the desktop app's own
    /// token while still rejecting other delegated keys. `expires_in_days` None = never
    /// expires (the expiry is computed in SQL — null * interval = null, the
    /// create_share_link convention). Returns (token id, expires_at) for the mint response.
    pub async fn insert_api_token(
        &self,
        token_hash: &str,
        principal_id: Uuid,
        owner_user_id: Option<Uuid>,
        scopes: &[&str],
        expires_in_days: Option<i64>,
        kind: &str,
    ) -> Result<(Uuid, Option<String>)> {
        let row = sqlx::query(
            r#"insert into api_tokens (token_hash, principal_id, owner_user_id, scopes, expires_at, kind)
               values ($1, $2, $3, $4, now() + $5 * interval '1 day', $6)
               returning id,
                         to_char(expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as expires_at"#,
        )
        .bind(token_hash)
        .bind(principal_id)
        .bind(owner_user_id)
        .bind(scopes.iter().map(|s| s.to_string()).collect::<Vec<_>>())
        .bind(expires_in_days)
        .bind(kind)
        .fetch_one(&self.pool)
        .await?;
        Ok((row.get("id"), row.get("expires_at")))
    }

    /// The caller's delegated API keys (GET /api/me/tokens): unrevoked tokens owned by
    /// this user, joined to the agent user whose display_name is the key's label.
    /// Hashes never leave this table.
    pub async fn list_owned_api_tokens(&self, owner_user_id: Uuid) -> Result<Vec<OwnedTokenRow>> {
        let rows = sqlx::query(
            r#"select t.id, t.scopes,
                      coalesce(u.display_name, 'agent') as label,
                      to_char(t.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
                      to_char(t.expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as expires_at
               from api_tokens t
               join users u on u.id = t.principal_id
               where t.owner_user_id = $1 and t.revoked_at is null
               order by t.created_at desc"#,
        )
        .bind(owner_user_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| OwnedTokenRow {
                id: r.get("id"),
                label: r.get("label"),
                scopes: r.get("scopes"),
                created_at: r.get("created_at"),
                expires_at: r.get("expires_at"),
            })
            .collect())
    }

    /// Revoke one of the caller's delegated tokens (DELETE /api/me/tokens/{id}): sets
    /// revoked_at, owner-scoped so a foreign id reads as absent (the 404-hide posture).
    /// False = no such unrevoked token owned by this user.
    pub async fn revoke_api_token(&self, id: Uuid, owner_user_id: Uuid) -> Result<bool> {
        let res = sqlx::query(
            "update api_tokens set revoked_at = now()
             where id = $1 and owner_user_id = $2 and revoked_at is null",
        )
        .bind(id)
        .bind(owner_user_id)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected() > 0)
    }

    pub async fn lookup_api_token(&self, token_hash: &str) -> Result<Option<ApiTokenInfo>> {
        let row = sqlx::query(
            "select principal_id, owner_user_id, scopes, workspace_id, document_id, kind
             from api_tokens
             where token_hash = $1
               and revoked_at is null
               and (expires_at is null or expires_at > now())",
        )
        .bind(token_hash)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| ApiTokenInfo {
            principal_id: r.get("principal_id"),
            owner_user_id: r.get("owner_user_id"),
            scopes: r.get("scopes"),
            workspace_id: r.get("workspace_id"),
            document_id: r.get("document_id"),
            kind: r.get("kind"),
        }))
    }

    // -----------------------------------------------------------------------
    // Comments & suggestions (ADR 0019; migration 0004)
    // -----------------------------------------------------------------------

    /// Create a thread + its first comment in one transaction (ADR 0019).
    pub async fn create_thread(
        &self,
        document_id: Uuid,
        anchor: &serde_json::Value,
        author_id: Option<Uuid>,
        body: &str,
    ) -> Result<(Uuid, Uuid)> {
        let thread_id = Uuid::now_v7();
        let comment_id = Uuid::now_v7();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "insert into comment_threads (id, document_id, anchor, created_by) values ($1, $2, $3, $4)",
        )
        .bind(thread_id)
        .bind(document_id)
        .bind(anchor)
        .bind(author_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "insert into comments (id, thread_id, author_id, body) values ($1, $2, $3, $4)",
        )
        .bind(comment_id)
        .bind(thread_id)
        .bind(author_id)
        .bind(body)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok((thread_id, comment_id))
    }

    /// The document a thread belongs to and its status; None = no such thread.
    pub async fn thread_ref(&self, thread_id: Uuid) -> Result<Option<(Uuid, String)>> {
        let row = sqlx::query("select document_id, status from comment_threads where id = $1")
            .bind(thread_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| (r.get("document_id"), r.get("status"))))
    }

    pub async fn add_comment(
        &self,
        thread_id: Uuid,
        author_id: Option<Uuid>,
        body: &str,
    ) -> Result<Uuid> {
        let comment_id = Uuid::now_v7();
        sqlx::query(
            "insert into comments (id, thread_id, author_id, body) values ($1, $2, $3, $4)",
        )
        .bind(comment_id)
        .bind(thread_id)
        .bind(author_id)
        .bind(body)
        .execute(&self.pool)
        .await?;
        Ok(comment_id)
    }

    /// People who can be @mentioned on a document (sub-project ④b): the union of the
    /// document's workspace members (memberships) and explicit share-grantees
    /// (document_acl) who currently have access. Distinct by user id; agents included.
    pub async fn list_document_members(&self, document_id: Uuid) -> Result<Vec<DocMemberRow>> {
        let rows = sqlx::query(
            r#"select distinct u.id,
                      coalesce(u.custom_display_name, u.display_name) as display_name,
                      coalesce(u.custom_avatar_url, u.avatar_url) as avatar_url,
                      u.kind
               from users u
               where u.id in (
                       select a.user_id from document_acl a where a.document_id = $1
                       union
                       select m.user_id from memberships m
                       join documents d on d.workspace_id = m.workspace_id
                       where d.id = $1
                     )
               order by display_name asc nulls last, u.id asc"#,
        )
        .bind(document_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| DocMemberRow {
                id: r.get("id"),
                display_name: r.get("display_name"),
                avatar_url: r.get("avatar_url"),
                kind: r.get("kind"),
            })
            .collect())
    }

    /// Record one `mention` row per distinct recipient parsed out of a comment body
    /// (sub-project ④b) AND, in the SAME transaction, enqueue one `notification` row per
    /// newly-mentioned recipient (sub-project ④c). Authoritative: callers pass ids already
    /// extracted server-side from the stored body. Recipients that aren't real users are
    /// skipped (the `where exists (… users …)` guard makes each insert a no-op for a stale id).
    ///
    /// Idempotent (migration 0013): `ON CONFLICT (recipient_id, comment_id) DO NOTHING` on the
    /// mention insert means a re-parse of the same stored comment never double-inserts a mention
    /// — and since a notification is enqueued ONLY for a mention the insert actually created
    /// (`returning id` non-empty), a retry/re-derive enqueues no second notification either.
    /// So: exactly one notification per distinct recipient per comment.
    ///
    /// The actor never notifies themselves (a self-mention writes the mention row but enqueues
    /// no notification). Delivery is per-channel: the in-app `notification` row is inserted only
    /// when the recipient's resolved preferences keep in-app on, and an email dispatch context is
    /// returned only when email is on — both independent. A recipient who has disabled BOTH gets
    /// the mention row (for the `?mentions=me` filter) but no notification row and no dispatch.
    /// Returns the dispatch context for each recipient with at least one channel enabled so the
    /// API layer can deliver out-of-band channels (email) off the request path; in-app delivery
    /// is the persisted row itself and needs nothing further.
    #[allow(clippy::too_many_arguments)]
    pub async fn record_mentions(
        &self,
        document_id: Uuid,
        thread_id: Uuid,
        comment_id: Uuid,
        actor_id: Option<Uuid>,
        actor_name: Option<&str>,
        doc_slug: &str,
        doc_title: &str,
        recipient_ids: &[Uuid],
    ) -> Result<Vec<DispatchContext>> {
        if recipient_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut dispatch = Vec::new();
        let mut tx = self.pool.begin().await?;
        for recipient in recipient_ids {
            let inserted = sqlx::query(
                r#"insert into mentions
                       (id, recipient_id, actor_id, document_id, thread_id, comment_id)
                   select $1, $2, $3, $4, $5, $6
                   where exists (select 1 from users where id = $2)
                   on conflict (recipient_id, comment_id) do nothing
                   returning id"#,
            )
            .bind(Uuid::now_v7())
            .bind(recipient)
            .bind(actor_id)
            .bind(document_id)
            .bind(thread_id)
            .bind(comment_id)
            .fetch_optional(&mut *tx)
            .await;
            let newly = match inserted {
                Ok(Some(_)) => true,
                Ok(None) => false, // stale id, or already mentioned on this comment
                Err(e) => {
                    tracing::warn!(%e, %recipient, "skipping mention row");
                    false
                }
            };
            // Don't notify the author of their own mention. The mention row above is still
            // recorded (the "mentions you" filter is recipient-scoped, so a self-mention simply
            // never matches the author's own filter) — we only skip enqueuing the notification.
            if !newly || Some(*recipient) == actor_id {
                continue;
            }
            // Resolve the recipient's email + stored preference matrix FIRST, so we can honor a
            // per-channel opt-out for in-app (the inbox row) just like email. The mention row is
            // already persisted above regardless of any preference — only delivery is gated.
            let recipient_email: Option<String> =
                sqlx::query_scalar("select email from users where id = $1")
                    .bind(recipient)
                    .fetch_optional(&mut *tx)
                    .await?
                    .flatten();
            let pref_rows = sqlx::query(
                "select event_type, channel, enabled from notification_preference where user_id = $1",
            )
            .bind(recipient)
            .fetch_all(&mut *tx)
            .await?;
            let prefs: Vec<crate::notifications::PreferenceRow> = pref_rows
                .into_iter()
                .map(|r| crate::notifications::PreferenceRow {
                    event_type: r.get("event_type"),
                    channel: r.get("channel"),
                    enabled: r.get("enabled"),
                })
                .collect();
            let channels =
                crate::notifications::resolve_channels(crate::notifications::EVENT_MENTION, &prefs);
            let in_app_on = channels
                .iter()
                .any(|c| c == crate::notifications::CHANNEL_IN_APP);
            // Any non-in-app channel enabled (e.g. email) means we still need a dispatch context
            // for off-request delivery, even when the in-app inbox row is skipped.
            let out_of_band_on = channels
                .iter()
                .any(|c| c != crate::notifications::CHANNEL_IN_APP);

            // Insert the in-app notification row ONLY if in-app is enabled. When disabled, leave
            // the already-persisted mention row in place and create no inbox row.
            let notification_id = if in_app_on {
                let id = Uuid::now_v7();
                let payload = serde_json::json!({
                    "actor_name": actor_name,
                    "doc_slug": doc_slug,
                    "doc_title": doc_title,
                    "thread_id": thread_id,
                    "comment_id": comment_id,
                });
                sqlx::query(
                    r#"insert into notification (id, recipient_id, type, payload, actor_id)
                       values ($1, $2, 'mention', $3, $4)"#,
                )
                .bind(id)
                .bind(recipient)
                .bind(&payload)
                .bind(actor_id)
                .execute(&mut *tx)
                .await?;
                Some(id)
            } else {
                None
            };

            // Produce a dispatch context when ANY channel is enabled. If neither in-app nor an
            // out-of-band channel is on, the event is fully muted: insert nothing, dispatch nothing.
            if in_app_on || out_of_band_on {
                dispatch.push(DispatchContext {
                    notification_id,
                    recipient_id: *recipient,
                    recipient_email,
                    prefs,
                });
            }
        }
        tx.commit().await?;
        Ok(dispatch)
    }

    // -----------------------------------------------------------------------
    // Notifications inbox & preferences (sub-project ④c; migration 0014)
    // -----------------------------------------------------------------------

    /// Whether a client-supplied string parses as a Postgres `timestamptz` — the same cast the
    /// notifications listing applies to the `before` cursor. Lets the handler reject a malformed
    /// cursor with a 400 instead of letting the cast poison the listing query into a 500. A real
    /// connection error still surfaces as `Err` (→ 500).
    pub async fn is_valid_timestamptz(&self, value: &str) -> Result<bool> {
        // Cast back to text so the result decodes without a sqlx date feature; the
        // `::timestamptz` step still forces Postgres to parse (and reject) the input.
        match sqlx::query_scalar::<_, String>("select ($1::timestamptz)::text")
            .bind(value)
            .fetch_one(&self.pool)
            .await
        {
            Ok(_) => Ok(true),
            Err(sqlx::Error::Database(_)) => Ok(false), // bad input → invalid_datetime_format etc.
            Err(e) => Err(e.into()),
        }
    }

    /// A recipient's notifications, newest first (GET /api/notifications). `unread_only` keeps
    /// just the unread rows; `before` paginates (created_at strictly older than the cursor).
    /// Always recipient-scoped — the handler passes the authenticated user's id, so a caller
    /// only ever sees their OWN notifications.
    pub async fn list_notifications(
        &self,
        recipient_id: Uuid,
        unread_only: bool,
        before: Option<&str>,
        limit: i64,
    ) -> Result<Vec<NotificationRow>> {
        // Server-side ceiling regardless of what the handler forwards (DoS guard),
        // matching list_documents_visible's hard limit.
        let limit = limit.clamp(1, 200);
        let rows = sqlx::query(
            r#"select id, type, payload, actor_id, (read_at is not null) as read,
                      to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
               from notification
               where recipient_id = $1
                 and ($2::bool is false or read_at is null)
                 and ($3::timestamptz is null or created_at < $3::timestamptz)
               order by created_at desc, id desc
               limit $4"#,
        )
        .bind(recipient_id)
        .bind(unread_only)
        .bind(before)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| NotificationRow {
                id: r.get("id"),
                event_type: r.get("type"),
                payload: r.get("payload"),
                actor_id: r.get("actor_id"),
                read: r.get("read"),
                created_at: r.get("created_at"),
            })
            .collect())
    }

    /// The recipient's unread badge count (GET /api/notifications/unread-count).
    pub async fn unread_notification_count(&self, recipient_id: Uuid) -> Result<i64> {
        let n: i64 = sqlx::query_scalar(
            "select count(*) from notification where recipient_id = $1 and read_at is null",
        )
        .bind(recipient_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(n)
    }

    /// Mark one notification read (POST /api/notifications/{id}/read). Recipient-scoped: a
    /// foreign id affects no rows and reads as 404 to the handler. Idempotent (already-read
    /// stays read). False = no such notification owned by this user.
    pub async fn mark_notification_read(&self, id: Uuid, recipient_id: Uuid) -> Result<bool> {
        let res = sqlx::query(
            "update notification set read_at = coalesce(read_at, now())
             where id = $1 and recipient_id = $2",
        )
        .bind(id)
        .bind(recipient_id)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected() > 0)
    }

    /// Mark every unread notification read (POST /api/notifications/read-all). Returns how
    /// many flipped. Recipient-scoped.
    pub async fn mark_all_notifications_read(&self, recipient_id: Uuid) -> Result<u64> {
        let res = sqlx::query(
            "update notification set read_at = now()
             where recipient_id = $1 and read_at is null",
        )
        .bind(recipient_id)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected())
    }

    /// The user's stored preference rows (GET /api/notification-preferences). Absent rows mean
    /// the coded default — the handler fills the full matrix from these + notifications::defaults.
    pub async fn list_notification_preferences(
        &self,
        user_id: Uuid,
    ) -> Result<Vec<crate::notifications::PreferenceRow>> {
        let rows = sqlx::query(
            "select event_type, channel, enabled from notification_preference where user_id = $1",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| crate::notifications::PreferenceRow {
                event_type: r.get("event_type"),
                channel: r.get("channel"),
                enabled: r.get("enabled"),
            })
            .collect())
    }

    /// Upsert one preference toggle (PUT /api/notification-preferences). The handler rejects
    /// non-toggleable channels (in-app) before this; here we just persist the row.
    pub async fn set_notification_preference(
        &self,
        user_id: Uuid,
        event_type: &str,
        channel: &str,
        enabled: bool,
    ) -> Result<()> {
        sqlx::query(
            "insert into notification_preference (user_id, event_type, channel, enabled)
             values ($1, $2, $3, $4)
             on conflict (user_id, event_type, channel) do update set enabled = excluded.enabled",
        )
        .bind(user_id)
        .bind(event_type)
        .bind(channel)
        .bind(enabled)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Thread ids on a document that mention `recipient` (sub-project ④b "mentions you"
    /// filter). Used to narrow the comments listing to threads where the caller is tagged.
    pub async fn threads_mentioning(
        &self,
        document_id: Uuid,
        recipient: Uuid,
    ) -> Result<std::collections::HashSet<Uuid>> {
        let rows = sqlx::query(
            "select distinct thread_id from mentions where document_id = $1 and recipient_id = $2",
        )
        .bind(document_id)
        .bind(recipient)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| r.get("thread_id")).collect())
    }

    pub async fn set_thread_status(&self, thread_id: Uuid, status: &str) -> Result<()> {
        sqlx::query("update comment_threads set status = $2 where id = $1")
            .bind(thread_id)
            .bind(status)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// All threads on a document (status filtering happens after lazy orphan-flipping,
    /// so the caller always loads everything).
    pub async fn list_threads(&self, document_id: Uuid) -> Result<Vec<ThreadRow>> {
        let rows = sqlx::query(
            r#"select t.id, t.anchor, t.status, t.created_by,
                      to_char(t.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
               from comment_threads t where t.document_id = $1 order by t.created_at asc"#,
        )
        .bind(document_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| ThreadRow {
                id: r.get("id"),
                anchor: r.get("anchor"),
                status: r.get("status"),
                created_by: r.get("created_by"),
                created_at: r.get("created_at"),
            })
            .collect())
    }

    /// Every comment on a document's threads (joined to authors), oldest first.
    pub async fn list_comments(&self, document_id: Uuid) -> Result<Vec<CommentRow>> {
        let rows = sqlx::query(
            r#"select c.id, c.thread_id, c.body,
                      to_char(c.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
                      u.id as author_id, coalesce(u.custom_display_name, u.display_name) as author_name, u.kind as author_kind
               from comments c
               join comment_threads t on t.id = c.thread_id
               left join users u on u.id = c.author_id
               where t.document_id = $1
               order by c.created_at asc, c.id asc"#,
        )
        .bind(document_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| CommentRow {
                id: r.get("id"),
                thread_id: r.get("thread_id"),
                body: r.get("body"),
                created_at: r.get("created_at"),
                author: author_from(&r),
            })
            .collect())
    }

    pub async fn insert_suggestions(
        &self,
        document_id: Uuid,
        change_set_id: Uuid,
        items: &[(serde_json::Value, serde_json::Value)], // (anchor, op)
        author_id: Option<Uuid>,
        note: Option<&str>,
    ) -> Result<Vec<Uuid>> {
        let mut tx = self.pool.begin().await?;
        let mut ids = Vec::with_capacity(items.len());
        for (anchor, op) in items {
            let id = Uuid::now_v7();
            sqlx::query(
                "insert into suggestions (id, document_id, change_set_id, anchor, op, note, author_id)
                 values ($1, $2, $3, $4, $5, $6, $7)",
            )
            .bind(id)
            .bind(document_id)
            .bind(change_set_id)
            .bind(anchor)
            .bind(op)
            .bind(note)
            .bind(author_id)
            .execute(&mut *tx)
            .await?;
            ids.push(id);
        }
        tx.commit().await?;
        Ok(ids)
    }

    pub async fn list_suggestions(
        &self,
        document_id: Uuid,
        status: Option<&str>,
        change_set_id: Option<Uuid>,
    ) -> Result<Vec<SuggestionRow>> {
        let rows = sqlx::query(
            r#"select s.id, s.change_set_id, s.anchor, s.op, s.note, s.status, s.document_id,
                      to_char(s.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
                      u.id as author_id, coalesce(u.custom_display_name, u.display_name) as author_name, u.kind as author_kind
               from suggestions s
               left join users u on u.id = s.author_id
               where s.document_id = $1
                 and ($2::text is null or s.status = $2)
                 and ($3::uuid is null or s.change_set_id = $3)
               order by s.created_at asc, s.id asc"#,
        )
        .bind(document_id)
        .bind(status)
        .bind(change_set_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(suggestion_from).collect())
    }

    pub async fn get_suggestion(&self, id: Uuid) -> Result<Option<SuggestionRow>> {
        let row = sqlx::query(
            r#"select s.id, s.change_set_id, s.anchor, s.op, s.note, s.status, s.document_id,
                      to_char(s.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
                      u.id as author_id, coalesce(u.custom_display_name, u.display_name) as author_name, u.kind as author_kind
               from suggestions s
               left join users u on u.id = s.author_id
               where s.id = $1"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(suggestion_from))
    }

    pub async fn set_suggestion_status(&self, id: Uuid, status: &str) -> Result<()> {
        sqlx::query("update suggestions set status = $2 where id = $1")
            .bind(id)
            .bind(status)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Raw history rows (newest first) for GET history; coalescing happens in the API layer.
    pub async fn history(
        &self,
        document_id: Uuid,
        limit: i64,
        before_seq: Option<i64>,
    ) -> Result<Vec<HistoryRow>> {
        // Server-side ceiling regardless of what the handler forwards (DoS guard).
        let limit = limit.clamp(1, 500);
        let rows = sqlx::query(
            r#"select cu.seq, cu.origin, cu.change_set_id,
                      to_char(cu.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
                      (extract(epoch from cu.created_at) * 1000)::bigint as created_ms,
                      u.id as author_id, coalesce(u.custom_display_name, u.display_name) as author_name, u.kind as author_kind
               from crdt_updates cu
               left join users u on u.id = cu.author_id
               where cu.document_id = $1 and ($2::bigint is null or cu.seq < $2)
               order by cu.seq desc limit $3"#,
        )
        .bind(document_id)
        .bind(before_seq)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| HistoryRow {
                seq: r.get("seq"),
                origin: r.get("origin"),
                change_set_id: r.get("change_set_id"),
                created_at: r.get("created_at"),
                created_ms: r.get("created_ms"),
                author: author_from(&r),
            })
            .collect())
    }

    // -----------------------------------------------------------------------
    // MCP façade lookups (ADR 0008; internal/design/mcp-and-agent-auth.md)
    // -----------------------------------------------------------------------

    /// Documents visible to a principal for `list_documents`: an explicit ACL grant or
    /// membership in the owning Workspace (ADR 0011). `user_id = None` (open mode) lists
    /// everything; token restrictions narrow further. `trashed` flips the listing between
    /// live documents (the default) and the trash (deleted_at set, migration 0008).
    pub async fn list_documents_visible(
        &self,
        user_id: Option<Uuid>,
        query: Option<&str>,
        document_restriction: Option<Uuid>,
        workspace_restriction: Option<Uuid>,
        trashed: bool,
    ) -> Result<Vec<DocumentListing>> {
        // Escape LIKE metacharacters so the filter only ever matches literally
        // (consistent with search_documents; not an injection — the value is bound).
        let query = query.map(crate::search::escape_like);
        let rows = sqlx::query(
            r#"select d.id, d.slug, d.workspace_id, d.folder_id, d.title, d.starred,
                      to_char(d.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at,
                      to_char(d.deleted_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as deleted_at,
                      o.id as owner_id, o.display_name as owner_name
               from documents d
               left join lateral (
                   select u.id, coalesce(u.custom_display_name, u.display_name) as display_name
                   from document_acl a join users u on u.id = a.user_id
                   where a.document_id = d.id
                   order by (a.user_id = d.created_by) desc, u.created_at asc
                   limit 1
               ) o on true
               where ($1::uuid is null
                      or exists (select 1 from document_acl a
                                 where a.document_id = d.id and a.user_id = $1)
                      or exists (select 1 from memberships m
                                 where m.workspace_id = d.workspace_id and m.user_id = $1))
                 and ($2::text is null or d.slug ilike '%' || $2 || '%'
                      or coalesce(d.title, '') ilike '%' || $2 || '%')
                 and ($3::uuid is null or d.id = $3)
                 and ($4::uuid is null or d.workspace_id = $4)
                 and ((d.deleted_at is not null) = $5)
               order by d.updated_at desc
               limit 200"#,
        )
        .bind(user_id)
        .bind(query)
        .bind(document_restriction)
        .bind(workspace_restriction)
        .bind(trashed)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| DocumentListing {
                id: r.get("id"),
                slug: r.get("slug"),
                updated_at: r.get("updated_at"),
                workspace_id: r.get("workspace_id"),
                folder_id: r.get("folder_id"),
                title: r.get("title"),
                deleted_at: r.get("deleted_at"),
                starred: r.get("starred"),
                owner_id: r.get("owner_id"),
                owner_name: r.get("owner_name"),
            })
            .collect())
    }

    /// Documents matching a search query, visibility identical to
    /// [`Self::list_documents_visible`] (live documents only — the trash never matches).
    /// `like_pattern` is the LIKE-escaped query (search::escape_like); `raw_query` feeds
    /// plainto_tsquery. Tiers: title prefix (0) > title substring (1) > content FTS (2) >
    /// content ILIKE (3); FTS hits rank by ts_rank, ties by recency.
    pub async fn search_documents(
        &self,
        user_id: Option<Uuid>,
        document_restriction: Option<Uuid>,
        workspace_restriction: Option<Uuid>,
        raw_query: &str,
        like_pattern: &str,
        limit: i64,
    ) -> Result<Vec<SearchRow>> {
        // Server-side ceiling regardless of what the handler forwards (DoS guard),
        // matching list_documents_visible's hard limit of 200.
        let limit = limit.clamp(1, 200);
        let rows = sqlx::query(
            r#"select d.id, d.slug, d.title, d.folder_id, d.workspace_id,
                      to_char(d.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at,
                      c.kind as conn_kind, c.config as conn_config,
                      o.id as owner_id, o.display_name as owner_name,
                      t.text as content,
                      case
                          when coalesce(d.title, d.slug) ilike $5 || '%' then 0
                          when coalesce(d.title, d.slug) ilike '%' || $5 || '%' then 1
                          when t.tsv @@ plainto_tsquery('simple', $6) then 2
                          else 3
                      end as tier,
                      coalesce(ts_rank(t.tsv, plainto_tsquery('simple', $6)), 0::real) as rank
               from documents d
               left join storage_connections c on c.id = d.storage_conn_id
               left join document_texts t on t.document_id = d.id
               left join lateral (
                   select u.id, coalesce(u.custom_display_name, u.display_name) as display_name
                   from document_acl a join users u on u.id = a.user_id
                   where a.document_id = d.id
                   order by (a.user_id = d.created_by) desc, u.created_at asc
                   limit 1
               ) o on true
               where ($1::uuid is null
                      or exists (select 1 from document_acl a
                                 where a.document_id = d.id and a.user_id = $1)
                      or exists (select 1 from memberships m
                                 where m.workspace_id = d.workspace_id and m.user_id = $1))
                 and ($2::uuid is null or d.id = $2)
                 and ($3::uuid is null or d.workspace_id = $3)
                 and d.deleted_at is null
                 and (coalesce(d.title, d.slug) ilike '%' || $5 || '%'
                      or t.tsv @@ plainto_tsquery('simple', $6)
                      or t.text ilike '%' || $5 || '%')
               order by tier asc, rank desc, d.updated_at desc
               limit $4"#,
        )
        .bind(user_id)
        .bind(document_restriction)
        .bind(workspace_restriction)
        .bind(limit)
        .bind(like_pattern)
        .bind(raw_query)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| SearchRow {
                id: r.get("id"),
                slug: r.get("slug"),
                title: r.get("title"),
                folder_id: r.get("folder_id"),
                workspace_id: r.get("workspace_id"),
                updated_at: r.get("updated_at"),
                conn_kind: r.get("conn_kind"),
                conn_config: r.get("conn_config"),
                owner_id: r.get("owner_id"),
                owner_name: r.get("owner_name"),
                content: r.get("content"),
                tier: r.get("tier"),
                rank: r.get("rank"),
            })
            .collect())
    }

    /// Upsert the search-text projection (migration 0009). Called by the link indexer
    /// with the text it just materialized, so projection and link rows stay in lockstep.
    pub async fn upsert_search_text(&self, document_id: Uuid, text: &str) -> Result<()> {
        sqlx::query(
            "insert into document_texts (document_id, text) values ($1, $2)
             on conflict (document_id) do update set text = excluded.text, updated_at = now()",
        )
        .bind(document_id)
        .bind(text)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Whether the document has a search-text projection (the lazy-backfill check on
    /// room hydration, mirroring has_links_from).
    pub async fn has_search_text(&self, document_id: Uuid) -> Result<bool> {
        let row = sqlx::query("select 1 as one from document_texts where document_id = $1")
            .bind(document_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.is_some())
    }

    /// The room slug for a documents.id (MCP tools accept either identifier, ADR 0009).
    pub async fn document_slug(&self, id: Uuid) -> Result<Option<String>> {
        let row = sqlx::query("select slug from documents where id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.get("slug")))
    }

    /// Which document a suggestion change set belongs to (suggestions in one set never
    /// span documents — they are minted per-document).
    pub async fn change_set_document(&self, change_set_id: Uuid) -> Result<Option<Uuid>> {
        let row =
            sqlx::query("select document_id from suggestions where change_set_id = $1 limit 1")
                .bind(change_set_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|r| r.get("document_id")))
    }

    /// Store a share link. `token` is the RAW token (the caller hands it to the user);
    /// only its SHA-256 digest is persisted — mirroring api_tokens — so a leaked
    /// share_links table yields no live capabilities. [`Self::share_link_role`] hashes
    /// the presented token symmetrically.
    pub async fn create_share_link(
        &self,
        document_id: Uuid,
        token: &str,
        role: &str,
        expires_in_secs: Option<i64>,
        created_by: Uuid,
    ) -> Result<()> {
        sqlx::query(
            "insert into share_links (document_id, token, role, expires_at, created_by)
             values ($1, $2, $3, now() + $4 * interval '1 second', $5)",
        )
        .bind(document_id)
        .bind(crate::auth::hash_token(token))
        .bind(role)
        .bind(expires_in_secs) // null * interval = null = never expires
        .bind(created_by)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Workspace management (ADR 0011; migration 0005)
    // -----------------------------------------------------------------------

    /// Every workspace the user belongs to; the personal one (created_by = user) first.
    pub async fn list_workspaces(&self, user_id: Uuid) -> Result<Vec<WorkspaceListing>> {
        let rows = sqlx::query(
            "select w.id, w.name, m.role,
                    coalesce(w.created_by = m.user_id, false) as is_personal
             from memberships m join workspaces w on w.id = m.workspace_id
             where m.user_id = $1 and w.status <> 'pending_storage'
             order by is_personal desc, w.created_at asc",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| WorkspaceListing {
                id: r.get("id"),
                name: r.get("name"),
                role: r.get("role"),
                is_personal: r.get("is_personal"),
            })
            .collect())
    }

    /// The user's membership role in a workspace ('admin' | 'member'); None = not a member.
    pub async fn workspace_role(
        &self,
        workspace_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<String>> {
        let row =
            sqlx::query("select role from memberships where workspace_id = $1 and user_id = $2")
                .bind(workspace_id)
                .bind(user_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|r| r.get("role")))
    }

    /// Total bytes stored for documents visible to `user_id` — the Drive-style "X used"
    /// figure for the storage meter (settings.md About section). "Stored bytes" is the
    /// real persisted footprint of each document: the append-only CRDT update log
    /// (`crdt_updates.update_blob`) plus its compaction snapshots (`crdt_snapshots`),
    /// summed with `octet_length`. Visibility mirrors [`Self::list_documents_visible`]
    /// (an ACL grant OR workspace membership), so the meter counts everything the user
    /// can actually open. Trashed documents still occupy storage, so they're included.
    ///
    /// In open mode (`user_id` = None) every document counts, matching open-mode
    /// visibility everywhere else (ADR 0012). Returns 0 for a user with no documents.
    pub async fn storage_used_bytes(&self, user_id: Option<Uuid>) -> Result<i64> {
        let row = sqlx::query(
            r#"with visible as (
                   select d.id
                   from documents d
                   where $1::uuid is null
                      or exists (select 1 from document_acl a
                                 where a.document_id = d.id and a.user_id = $1)
                      or exists (select 1 from memberships m
                                 where m.workspace_id = d.workspace_id and m.user_id = $1)
               )
               select
                   coalesce((select sum(octet_length(u.update_blob))
                             from crdt_updates u
                             where u.document_id in (select id from visible)), 0)
                 + coalesce((select sum(octet_length(s.snapshot_blob))
                             from crdt_snapshots s
                             where s.document_id in (select id from visible)), 0)
                 as used_bytes"#,
        )
        .bind(user_id)
        .fetch_one(&self.pool)
        .await?;
        // sum(octet_length(int4)) widens to bigint in Postgres; coalesce(...)+coalesce(...)
        // stays bigint, so a plain i64 read is correct. Footprints stay far within i64.
        let used: i64 = row.try_get::<i64, _>("used_bytes").unwrap_or(0);
        Ok(used)
    }

    pub async fn workspace_name(&self, workspace_id: Uuid) -> Result<Option<String>> {
        let row = sqlx::query("select name from workspaces where id = $1")
            .bind(workspace_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.get("name")))
    }

    pub async fn rename_workspace(&self, workspace_id: Uuid, name: &str) -> Result<()> {
        sqlx::query("update workspaces set name = $2 where id = $1")
            .bind(workspace_id)
            .bind(name)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Hard-delete a workspace: every document in it (live AND trashed) is purged with
    /// the same ordered deletes as [`Self::purge_document`] — set-based, one transaction —
    /// then folders, then the workspace row (memberships / invites / storage connections /
    /// SSO cascade; audit_log keeps its rows via on-delete-set-null). Tokens scoped to the
    /// workspace or its documents are REVOKED, never widened (purge_document's rule).
    /// Returns the purged documents' slugs so the caller can evict their live rooms.
    pub async fn delete_workspace(&self, workspace_id: Uuid) -> Result<Vec<String>> {
        let mut tx = self.pool.begin().await?;
        let slugs: Vec<String> =
            sqlx::query_scalar("select slug from documents where workspace_id = $1")
                .bind(workspace_id)
                .fetch_all(&mut *tx)
                .await?;
        const DOCS: &str = "(select id from documents where workspace_id = $1)";
        for stmt in [
            format!("delete from crdt_snapshots where document_id in {DOCS}"),
            format!(
                "delete from comments where thread_id in
                     (select id from comment_threads where document_id in {DOCS})"
            ),
            format!("delete from comment_threads where document_id in {DOCS}"),
            format!("delete from suggestions where document_id in {DOCS}"),
            format!("delete from document_acl where document_id in {DOCS}"),
            format!("delete from share_links where document_id in {DOCS}"),
            format!("delete from document_links where src_document_id in {DOCS}"),
            format!(
                "update document_links set dst_document_id = null where dst_document_id in {DOCS}"
            ),
            format!("update audit_log set document_id = null where document_id in {DOCS}"),
            format!(
                "update api_tokens set revoked_at = coalesce(revoked_at, now()),
                        document_id = null
                 where document_id in {DOCS}"
            ),
            format!("delete from crdt_updates where document_id in {DOCS}"),
        ] {
            sqlx::query(&stmt)
                .bind(workspace_id)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query(
            "update api_tokens set revoked_at = coalesce(revoked_at, now()), workspace_id = null
             where workspace_id = $1",
        )
        .bind(workspace_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("delete from documents where workspace_id = $1")
            .bind(workspace_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("delete from folders where workspace_id = $1")
            .bind(workspace_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("delete from workspaces where id = $1")
            .bind(workspace_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(slugs)
    }

    pub async fn list_members(&self, workspace_id: Uuid) -> Result<Vec<MemberRow>> {
        let rows = sqlx::query(
            "select u.id as user_id,
                    coalesce(u.custom_display_name, u.display_name) as display_name,
                    u.email, u.kind, m.role
             from memberships m join users u on u.id = m.user_id
             where m.workspace_id = $1
             order by (m.role = 'admin') desc, u.created_at asc",
        )
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| MemberRow {
                user_id: r.get("user_id"),
                display_name: r.get("display_name"),
                email: r.get("email"),
                kind: r.get("kind"),
                role: r.get("role"),
            })
            .collect())
    }

    pub async fn admin_count(&self, workspace_id: Uuid) -> Result<i64> {
        let row = sqlx::query(
            "select count(*) as n from memberships where workspace_id = $1 and role = 'admin'",
        )
        .bind(workspace_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.get("n"))
    }

    /// Add (or keep) a membership. An existing membership keeps its current role.
    pub async fn add_membership(
        &self,
        workspace_id: Uuid,
        user_id: Uuid,
        role: &str,
    ) -> Result<()> {
        sqlx::query(
            "insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)
             on conflict (workspace_id, user_id) do nothing",
        )
        .bind(workspace_id)
        .bind(user_id)
        .bind(role)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Returns false when there is no such membership.
    pub async fn set_member_role(
        &self,
        workspace_id: Uuid,
        user_id: Uuid,
        role: &str,
    ) -> Result<bool> {
        let res = sqlx::query(
            "update memberships set role = $3 where workspace_id = $1 and user_id = $2",
        )
        .bind(workspace_id)
        .bind(user_id)
        .bind(role)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected() > 0)
    }

    pub async fn remove_member(&self, workspace_id: Uuid, user_id: Uuid) -> Result<bool> {
        let res = sqlx::query("delete from memberships where workspace_id = $1 and user_id = $2")
            .bind(workspace_id)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    /// A human user by email (case-insensitive, any issuer), oldest first.
    pub async fn find_user_by_email(&self, email: &str) -> Result<Option<Uuid>> {
        let row = sqlx::query(
            "select id from users where kind = 'human' and lower(email) = lower($1)
             order by created_at asc limit 1",
        )
        .bind(email)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.get("id")))
    }

    /// Create (or refresh the role of) a pending invite. Returns the invite id.
    pub async fn create_invite(
        &self,
        workspace_id: Uuid,
        email: &str,
        role: &str,
        created_by: Uuid,
    ) -> Result<Uuid> {
        let row = sqlx::query(
            "insert into invites (workspace_id, email, role, created_by) values ($1, lower($2), $3, $4)
             on conflict (workspace_id, email) where claimed_at is null
                 do update set role = excluded.role
             returning id",
        )
        .bind(workspace_id)
        .bind(email)
        .bind(role)
        .bind(created_by)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.get("id"))
    }

    pub async fn list_invites(&self, workspace_id: Uuid) -> Result<Vec<InviteRow>> {
        let rows = sqlx::query(
            r#"select id, email, role,
                      to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
               from invites where workspace_id = $1 and claimed_at is null
               order by created_at asc"#,
        )
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| InviteRow {
                id: r.get("id"),
                email: r.get("email"),
                role: r.get("role"),
                created_at: r.get("created_at"),
            })
            .collect())
    }

    /// Returns false when there is no such pending invite on this workspace.
    pub async fn delete_invite(&self, workspace_id: Uuid, invite_id: Uuid) -> Result<bool> {
        let res = sqlx::query(
            "delete from invites where id = $1 and workspace_id = $2 and claimed_at is null",
        )
        .bind(invite_id)
        .bind(workspace_id)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected() > 0)
    }

    /// On OIDC login: turn matching unclaimed invites (ADR 0011) into memberships and
    /// return the claimed (workspace_id, role) pairs so callers can audit each claim.
    /// Claiming is scoped to issuers authoritative for the
    /// invite's workspace. `deployment_wide` is true only for the operator's primary
    /// (env) issuer, whose email claims are trusted across every tenant; for a
    /// tenant-registered per-workspace issuer it is false and `only_workspaces` lists the
    /// workspaces that registered that issuer — the sole invites it may claim. The scope
    /// predicate `($3 or workspace_id = any($4))` is applied IDENTICALLY to the insert and
    /// the claimed_at update so a claimed membership and its stamped invite never diverge.
    /// Without this scope a hostile per-workspace issuer asserting a victim's email would
    /// claim that victim's invites in unrelated tenants (CWE-290 cross-tenant takeover).
    pub async fn claim_invites(
        &self,
        user_id: Uuid,
        email: &str,
        deployment_wide: bool,
        only_workspaces: &[Uuid],
    ) -> Result<Vec<(Uuid, String)>> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "insert into memberships (workspace_id, user_id, role)
             select workspace_id, $1, role from invites
             where lower(email) = lower($2) and claimed_at is null
               and ($3 or workspace_id = any($4))
             on conflict (workspace_id, user_id) do nothing",
        )
        .bind(user_id)
        .bind(email)
        .bind(deployment_wide)
        .bind(only_workspaces)
        .execute(&mut *tx)
        .await?;
        let rows = sqlx::query(
            "update invites set claimed_at = now()
             where lower(email) = lower($1) and claimed_at is null
               and ($2 or workspace_id = any($3))
             returning workspace_id, role",
        )
        .bind(email)
        .bind(deployment_wide)
        .bind(only_workspaces)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(rows
            .into_iter()
            .map(|r| (r.get("workspace_id"), r.get("role")))
            .collect())
    }

    // -----------------------------------------------------------------------
    // Storage connections & attachments (ADR 0013; migration 0005)
    // -----------------------------------------------------------------------

    pub async fn create_storage_connection(
        &self,
        workspace_id: Uuid,
        kind: &str,
        config: &serde_json::Value,
    ) -> Result<Uuid> {
        // Stamp the frozen per-workspace container HERE — the single funnel every
        // creation flow (REST, MCP, gdrive OAuth) passes through — so no backend can be
        // connected without isolation, and a future backend cannot forget to. A missing
        // workspace name falls back to the id-only slug; isolation never depends on it.
        let name = self.workspace_name(workspace_id).await?.unwrap_or_default();
        let container = crate::storage::workspace_container(&name, workspace_id);
        let mut config = config.clone();
        config
            .as_object_mut()
            .ok_or_else(|| anyhow!("storage connection config must be a JSON object"))?
            .insert(
                "container".to_string(),
                serde_json::Value::String(container),
            );
        let row = sqlx::query(
            "insert into storage_connections (workspace_id, kind, config)
             values ($1, $2, $3) returning id",
        )
        .bind(workspace_id)
        .bind(kind)
        .bind(&config)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.get("id"))
    }

    pub async fn list_storage_connections(
        &self,
        workspace_id: Uuid,
    ) -> Result<Vec<StorageConnRow>> {
        let rows = sqlx::query(
            r#"select id, workspace_id, kind, config,
                      to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
               from storage_connections where workspace_id = $1 order by created_at asc"#,
        )
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(storage_conn_from).collect())
    }

    /// One storage connection, workspace-scoped like [`Self::delete_storage_connection`]:
    /// a foreign workspace's conn id reads as absent, so the full config (which can carry
    /// the gdrive OAuth material) never crosses a tenant boundary.
    pub async fn get_storage_connection(
        &self,
        id: Uuid,
        workspace_id: Uuid,
    ) -> Result<Option<StorageConnRow>> {
        let row = sqlx::query(
            r#"select id, workspace_id, kind, config,
                      to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
               from storage_connections where id = $1 and workspace_id = $2"#,
        )
        .bind(id)
        .bind(workspace_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(storage_conn_from))
    }

    /// How many documents (live or trashed — both still reference the row) are attached
    /// to a storage connection. The disconnect guard: > 0 blocks the delete with 409.
    pub async fn count_attached_documents(&self, storage_conn_id: Uuid) -> Result<i64> {
        let row = sqlx::query("select count(*) as n from documents where storage_conn_id = $1")
            .bind(storage_conn_id)
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get("n"))
    }

    /// Delete one storage connection, workspace-scoped so a foreign id reads as absent.
    /// Callers must check [`Self::count_attached_documents`] first — documents.storage_conn_id
    /// has a plain FK (no cascade), so a referenced row would error anyway.
    ///
    /// migration 0015's `workspaces.storage_conn_id` FK is RESTRICT: deleting a connection
    /// that is still the workspace's bound storage would 500 on the FK. So this first
    /// clears the binding (in the same transaction) if `id` is the workspace's current
    /// binding — the workspace falls back to unbound-active (the grandfathered banner
    /// state); `status` is left untouched ('active' either way, never reverts to
    /// 'pending_storage').
    /// False = no such connection on this workspace.
    pub async fn delete_storage_connection(&self, id: Uuid, workspace_id: Uuid) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "update workspaces set storage_conn_id = null where storage_conn_id = $1 and id = $2",
        )
        .bind(id)
        .bind(workspace_id)
        .execute(&mut *tx)
        .await?;
        let res =
            sqlx::query("delete from storage_connections where id = $1 and workspace_id = $2")
                .bind(id)
                .bind(workspace_id)
                .execute(&mut *tx)
                .await?;
        tx.commit().await?;
        Ok(res.rows_affected() > 0)
    }

    /// Attach a document to a backend location. Errors on a (storage_conn_id, rel_path)
    /// collision (unique index, migration 0005) — callers map that to 409.
    pub async fn attach_document_storage(
        &self,
        document_id: Uuid,
        storage_conn_id: Uuid,
        rel_path: &str,
    ) -> Result<()> {
        sqlx::query(
            "update documents set storage_conn_id = $2, rel_path = $3, content_hash = null
             where id = $1",
        )
        .bind(document_id)
        .bind(storage_conn_id)
        .bind(rel_path)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn detach_document_storage(&self, document_id: Uuid) -> Result<()> {
        sqlx::query(
            "update documents set storage_conn_id = null, rel_path = null, content_hash = null
             where id = $1",
        )
        .bind(document_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_content_hash(&self, document_id: Uuid, hash: &str) -> Result<()> {
        sqlx::query("update documents set content_hash = $2, updated_at = now() where id = $1")
            .bind(document_id)
            .bind(hash)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn workspace_meta(&self, workspace_id: Uuid) -> Result<Option<WorkspaceMeta>> {
        let row =
            sqlx::query("select status, storage_conn_id, retention from workspaces where id = $1")
                .bind(workspace_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|r| WorkspaceMeta {
            status: r.get("status"),
            storage_conn_id: r.get("storage_conn_id"),
            retention: r.get("retention"),
        }))
    }

    /// Bind a probed connection and activate. Idempotent for re-binding a
    /// grandfathered active workspace (status stays/becomes 'active').
    pub async fn activate_workspace_with_storage(
        &self,
        workspace_id: Uuid,
        conn_id: Uuid,
    ) -> Result<()> {
        sqlx::query("update workspaces set storage_conn_id = $2, status = 'active' where id = $1")
            .bind(workspace_id)
            .bind(conn_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// GC for wizard abandonment: delete pending workspaces older than the TTL that hold
    /// no documents. storage_connections/memberships cascade (migration 0005/0002);
    /// the documents guard makes data loss structurally impossible.
    pub async fn purge_abandoned_pending_workspaces(&self, older_than_hours: i64) -> Result<u64> {
        let res = sqlx::query(
            "delete from workspaces w
             where w.status = 'pending_storage'
               and w.created_at < now() - ($1 * interval '1 hour')
               and not exists (select 1 from documents d where d.workspace_id = w.id)",
        )
        .bind(older_than_hours)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected())
    }

    /// Live documents in a workspace with no storage attachment — the bulk-bind work
    /// list when a grandfathered workspace connects storage (plan 1a task 7).
    pub async fn unattached_documents_in_workspace(
        &self,
        workspace_id: Uuid,
    ) -> Result<Vec<UnattachedDoc>> {
        let rows = sqlx::query(
            "select id, slug, folder_id, title from documents
             where workspace_id = $1 and storage_conn_id is null and deleted_at is null",
        )
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| UnattachedDoc {
                id: r.get("id"),
                slug: r.get("slug"),
                folder_id: r.get("folder_id"),
                title: r.get("title"),
            })
            .collect())
    }

    /// One live, unattached document (auto-attach lookup). None when the document is
    /// attached, trashed, or absent.
    pub async fn unattached_document(
        &self,
        document_id: Uuid,
    ) -> Result<Option<UnattachedDocFull>> {
        let row = sqlx::query(
            "select id, slug, workspace_id, folder_id, title from documents
             where id = $1 and storage_conn_id is null and deleted_at is null",
        )
        .bind(document_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| UnattachedDocFull {
            id: r.get("id"),
            slug: r.get("slug"),
            workspace_id: r.get("workspace_id"),
            folder_id: r.get("folder_id"),
            title: r.get("title"),
        }))
    }

    // -----------------------------------------------------------------------
    // Link graph (ADR 0015; migration 0006; links.rs owns extraction)
    // -----------------------------------------------------------------------

    /// Diff-update a document's outgoing links in one transaction: rows whose raw_target
    /// vanished are deleted, new ones inserted (resolving dst by slug, then rel_path).
    /// Kept rows are untouched — re-resolution has its own trigger (resolve_links_to).
    /// Returns (inserted, deleted).
    pub async fn update_document_links(
        &self,
        src_document_id: Uuid,
        links: &[crate::links::ExtractedLink],
    ) -> Result<(u64, u64)> {
        let mut tx = self.pool.begin().await?;
        let existing: Vec<String> =
            sqlx::query("select raw_target from document_links where src_document_id = $1")
                .bind(src_document_id)
                .fetch_all(&mut *tx)
                .await?
                .into_iter()
                .map(|r| r.get("raw_target"))
                .collect();
        let wanted: std::collections::HashSet<&str> =
            links.iter().map(|l| l.raw_target.as_str()).collect();
        let gone: Vec<String> = existing
            .iter()
            .filter(|t| !wanted.contains(t.as_str()))
            .cloned()
            .collect();
        let have: std::collections::HashSet<&str> = existing.iter().map(String::as_str).collect();

        let mut deleted = 0u64;
        if !gone.is_empty() {
            let res = sqlx::query(
                "delete from document_links where src_document_id = $1 and raw_target = any($2)",
            )
            .bind(src_document_id)
            .bind(&gone)
            .execute(&mut *tx)
            .await?;
            deleted = res.rows_affected();
        }
        let mut inserted = 0u64;
        for link in links {
            if have.contains(link.raw_target.as_str()) {
                continue;
            }
            // Resolve at insert time: slug match wins, rel_path (attached docs) second.
            // Trashed documents never resolve (migration 0008) — links stay unresolved
            // until the target is restored (room hydration re-resolves).
            let res = sqlx::query(
                "insert into document_links
                     (src_document_id, raw_target, target_slug, target_path, dst_document_id)
                 values ($1, $2, $3, $4,
                     (select id from documents
                      where (slug = $3 or ($4::text is not null and rel_path = $4))
                        and deleted_at is null
                      order by (slug = $3) desc limit 1))
                 on conflict (src_document_id, raw_target) do nothing",
            )
            .bind(src_document_id)
            .bind(&link.raw_target)
            .bind(&link.target_slug)
            .bind(&link.target_path)
            .execute(&mut *tx)
            .await?;
            inserted += res.rows_affected();
        }
        tx.commit().await?;
        Ok((inserted, deleted))
    }

    /// Re-resolution trigger (wikilinks-and-link-graph.md): point every unresolved link
    /// whose normalized target matches this document at it. Called on room hydration —
    /// cheap (partial index on unresolved target_slug) and idempotent.
    pub async fn resolve_links_to(&self, document_id: Uuid, slug: &str) -> Result<u64> {
        let res = sqlx::query(
            "update document_links set dst_document_id = $1
             where dst_document_id is null and target_slug = $2",
        )
        .bind(document_id)
        .bind(slug)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected())
    }

    /// Whether the document has any extracted link rows (the lazy-backfill check).
    pub async fn has_links_from(&self, document_id: Uuid) -> Result<bool> {
        let row =
            sqlx::query("select 1 as one from document_links where src_document_id = $1 limit 1")
                .bind(document_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.is_some())
    }

    /// Every link row originating from the given documents (GET /api/graph).
    pub async fn links_among(&self, src_ids: &[Uuid]) -> Result<Vec<GraphLinkRow>> {
        let rows = sqlx::query(
            "select src_document_id, dst_document_id, raw_target from document_links
             where src_document_id = any($1)
             order by src_document_id, raw_target",
        )
        .bind(src_ids)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| GraphLinkRow {
                src: r.get("src_document_id"),
                dst: r.get("dst_document_id"),
                raw_target: r.get("raw_target"),
            })
            .collect())
    }

    /// Outgoing links of one document, with the resolved target's slug when set.
    pub async fn links_from(&self, document_id: Uuid) -> Result<Vec<OutgoingLinkRow>> {
        let rows = sqlx::query(
            "select l.raw_target, l.dst_document_id, d.slug as dst_slug
             from document_links l left join documents d on d.id = l.dst_document_id
             where l.src_document_id = $1
             order by l.raw_target",
        )
        .bind(document_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| OutgoingLinkRow {
                raw_target: r.get("raw_target"),
                dst_id: r.get("dst_document_id"),
                dst_slug: r.get("dst_slug"),
            })
            .collect())
    }

    /// Incoming links (backlinks) of one document, with each source's slug.
    pub async fn links_to(&self, document_id: Uuid) -> Result<Vec<IncomingLinkRow>> {
        let rows = sqlx::query(
            "select l.src_document_id, l.raw_target, d.slug as src_slug
             from document_links l join documents d on d.id = l.src_document_id
             where l.dst_document_id = $1
             order by d.slug, l.raw_target",
        )
        .bind(document_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| IncomingLinkRow {
                src_id: r.get("src_document_id"),
                src_slug: r.get("src_slug"),
                raw_target: r.get("raw_target"),
            })
            .collect())
    }

    /// One attached document with its backend config (the materialize loop). Trashed
    /// documents read as unattached: their backend file is deliberately left in place
    /// (canonical storage is user-owned) but the loops stop touching it.
    pub async fn document_attachment(&self, document_id: Uuid) -> Result<Option<AttachedDoc>> {
        let row = sqlx::query(
            "select d.id, d.slug, d.rel_path, d.content_hash, d.folder_id,
                    c.kind, c.config, c.workspace_id, c.id as storage_conn_id
             from documents d join storage_connections c on c.id = d.storage_conn_id
             where d.id = $1 and d.deleted_at is null",
        )
        .bind(document_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(attached_from))
    }

    /// Every live attached document (the poll loop, ADR 0013); the trash is skipped.
    pub async fn attached_documents(&self) -> Result<Vec<AttachedDoc>> {
        let rows = sqlx::query(
            "select d.id, d.slug, d.rel_path, d.content_hash, d.folder_id,
                    c.kind, c.config, c.workspace_id, c.id as storage_conn_id
             from documents d join storage_connections c on c.id = d.storage_conn_id
             where d.deleted_at is null",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(attached_from).collect())
    }

    // -----------------------------------------------------------------------
    // Folders & trash (migration 0008)
    // -----------------------------------------------------------------------

    /// Create one folder. A sibling-name collision (the partial unique index
    /// folders_sibling_name) bubbles as an error — callers map it to 409.
    pub async fn create_folder(
        &self,
        workspace_id: Option<Uuid>,
        parent_id: Option<Uuid>,
        name: &str,
    ) -> Result<FolderRow> {
        let row = sqlx::query(
            r#"insert into folders (workspace_id, parent_id, name) values ($1, $2, $3)
               returning id, workspace_id, parent_id, name,
                         to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at,
                         to_char(deleted_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as deleted_at"#,
        )
        .bind(workspace_id)
        .bind(parent_id)
        .bind(name)
        .fetch_one(&self.pool)
        .await?;
        Ok(folder_from(&row))
    }

    pub async fn get_folder(&self, id: Uuid) -> Result<Option<FolderRow>> {
        let row = sqlx::query(
            r#"select id, workspace_id, parent_id, name,
                      to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at,
                      to_char(deleted_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as deleted_at
               from folders where id = $1"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(folder_from))
    }

    /// Folders visible to a principal: membership in the owning workspace (folders carry
    /// no per-folder ACL; workspace_id null = open-mode/global space, visible to all).
    /// Mirrors [`Self::list_documents_visible`], including the trashed flip.
    pub async fn list_folders_visible(
        &self,
        user_id: Option<Uuid>,
        workspace_restriction: Option<Uuid>,
        trashed: bool,
    ) -> Result<Vec<FolderRow>> {
        let rows = sqlx::query(
            r#"select f.id, f.workspace_id, f.parent_id, f.name,
                      to_char(f.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at,
                      to_char(f.deleted_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as deleted_at
               from folders f
               where ($1::uuid is null
                      or f.workspace_id is null
                      or exists (select 1 from memberships m
                                 where m.workspace_id = f.workspace_id and m.user_id = $1))
                 and ($2::uuid is null or f.workspace_id = $2)
                 and ((f.deleted_at is not null) = $3)
               order by f.name asc
               limit 500"#,
        )
        .bind(user_id)
        .bind(workspace_restriction)
        .bind(trashed)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(folder_from).collect())
    }

    /// (id, parent_id) of every LIVE folder in one workspace scope — the cycle-check
    /// input for folder moves (folders::creates_cycle).
    pub async fn live_folder_parents(
        &self,
        workspace_id: Option<Uuid>,
    ) -> Result<Vec<(Uuid, Option<Uuid>)>> {
        let rows = sqlx::query(
            "select id, parent_id from folders
             where workspace_id is not distinct from $1 and deleted_at is null",
        )
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| (r.get("id"), r.get("parent_id")))
            .collect())
    }

    /// Rename and/or move one live folder. `parent` None = leave alone;
    /// Some(None) = move to root. False = no such live folder.
    pub async fn update_folder(
        &self,
        id: Uuid,
        name: Option<&str>,
        parent: Option<Option<Uuid>>,
    ) -> Result<bool> {
        let (set_parent, new_parent) = match parent {
            None => (false, None),
            Some(p) => (true, p),
        };
        let res = sqlx::query(
            "update folders set
                 name = coalesce($2, name),
                 parent_id = case when $3 then $4 else parent_id end,
                 updated_at = now()
             where id = $1 and deleted_at is null",
        )
        .bind(id)
        .bind(name)
        .bind(set_parent)
        .bind(new_parent)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected() > 0)
    }

    /// Every folder id in the subtree rooted at `id` (root included), trashed or not.
    pub async fn folder_subtree_ids(&self, id: Uuid) -> Result<Vec<Uuid>> {
        let rows = sqlx::query(
            "with recursive sub as (
                 select id from folders where id = $1
                 union all
                 select f.id from folders f join sub on f.parent_id = sub.id
             )
             select id from sub",
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| r.get("id")).collect())
    }

    /// Soft-delete a folder subtree: stamp deleted_at on every live folder in it AND
    /// every live document inside those folders. Inbound links to those documents flip
    /// back to unresolved (the same posture as a hard delete's `on delete set null`).
    /// Returns (folders, documents) trashed.
    pub async fn trash_folder_subtree(&self, id: Uuid) -> Result<(u64, u64)> {
        let ids = self.folder_subtree_ids(id).await?;
        let mut tx = self.pool.begin().await?;
        let f = sqlx::query(
            "update folders set deleted_at = now(), updated_at = now()
             where id = any($1) and deleted_at is null",
        )
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
        let d = sqlx::query(
            "update documents set deleted_at = now(), updated_at = now()
             where folder_id = any($1) and deleted_at is null",
        )
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "update document_links set dst_document_id = null
             where dst_document_id in (select id from documents where folder_id = any($1))",
        )
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok((f.rows_affected(), d.rows_affected()))
    }

    /// Restore a trashed folder subtree (clear deleted_at on its folders + documents).
    /// When the subtree root's parent is itself still trashed the root moves to the
    /// root level — restoring must never leave a live folder under a trashed one.
    /// A sibling-name collision bubbles (callers map it to 409).
    /// Returns (folders, documents) restored.
    pub async fn restore_folder_subtree(&self, id: Uuid) -> Result<(u64, u64)> {
        let ids = self.folder_subtree_ids(id).await?;
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "update folders set parent_id = null, updated_at = now()
             where id = $1 and parent_id in (select id from folders where deleted_at is not null)",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        let f = sqlx::query(
            "update folders set deleted_at = null, updated_at = now()
             where id = any($1) and deleted_at is not null",
        )
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
        let d = sqlx::query(
            "update documents set deleted_at = null, updated_at = now()
             where folder_id = any($1) and deleted_at is not null",
        )
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok((f.rows_affected(), d.rows_affected()))
    }

    /// The folder-chain names from root to `folder_id` (inclusive) — the storage
    /// rel_path prefix (storage::rel_path_for). Empty for folder_id None.
    pub async fn folder_chain_names(&self, folder_id: Option<Uuid>) -> Result<Vec<String>> {
        let Some(folder_id) = folder_id else {
            return Ok(Vec::new());
        };
        let rows = sqlx::query(
            "with recursive chain as (
                 select id, parent_id, name, 1 as depth from folders where id = $1
                 union all
                 select f.id, f.parent_id, f.name, c.depth + 1
                 from folders f join chain c on f.id = c.parent_id
             )
             select name from chain order by depth desc",
        )
        .bind(folder_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| r.get("name")).collect())
    }

    /// Get-or-create the live folder chain `names` (root-first) in a workspace scope;
    /// returns the leaf folder id (None for an empty chain). Name matching is
    /// case-insensitive, mirroring the sibling unique index.
    pub async fn ensure_folder_chain(
        &self,
        workspace_id: Option<Uuid>,
        names: &[&str],
    ) -> Result<Option<Uuid>> {
        let mut parent: Option<Uuid> = None;
        for name in names {
            // Folder names become backend rel_path segments (storage::rel_path_for), so
            // '.'/'..'/empty/slash-bearing segments — reachable via externally-sourced
            // file names on ingest — must never be minted (path-traversal guard). Same
            // rule as the folder REST surface (folders::valid_folder_name).
            if !crate::folders::valid_folder_name(name) {
                return Err(anyhow::anyhow!(
                    "invalid folder name {name:?} in folder chain"
                ));
            }
            let existing = sqlx::query(
                "select id from folders
                 where workspace_id is not distinct from $1
                   and parent_id is not distinct from $2
                   and lower(name) = lower($3) and deleted_at is null",
            )
            .bind(workspace_id)
            .bind(parent)
            .bind(name)
            .fetch_optional(&self.pool)
            .await?;
            parent = Some(match existing {
                Some(r) => r.get("id"),
                None => self.create_folder(workspace_id, parent, name).await?.id,
            });
        }
        Ok(parent)
    }

    /// Live storage-attached documents inside a folder subtree — the set whose rel_path
    /// must be recomputed after a folder rename/move (StorageManager::relocate).
    pub async fn attached_docs_in_subtree(&self, folder_id: Uuid) -> Result<Vec<Uuid>> {
        let ids = self.folder_subtree_ids(folder_id).await?;
        let rows = sqlx::query(
            "select id from documents
             where folder_id = any($1) and storage_conn_id is not null and deleted_at is null",
        )
        .bind(&ids)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| r.get("id")).collect())
    }

    /// Move a document between folders (None = root).
    pub async fn set_document_folder(
        &self,
        document_id: Uuid,
        folder_id: Option<Uuid>,
    ) -> Result<()> {
        sqlx::query("update documents set folder_id = $2, updated_at = now() where id = $1")
            .bind(document_id)
            .bind(folder_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Set (or with None clear) a document's display title. The slug — the room
    /// identifier — deliberately never changes (deviation from ADR 0013 noted there).
    pub async fn set_document_title(&self, document_id: Uuid, title: Option<&str>) -> Result<()> {
        sqlx::query("update documents set title = $2, updated_at = now() where id = $1")
            .bind(document_id)
            .bind(title)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Star / unstar a document (migration 0011). Does NOT bump updated_at: starring is a
    /// view-level affordance, not a content edit, so it must not reorder the recents list.
    pub async fn set_document_starred(&self, document_id: Uuid, starred: bool) -> Result<()> {
        sqlx::query("update documents set starred = $2 where id = $1")
            .bind(document_id)
            .bind(starred)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Move a document to its backend location after a folder move/rename. Clears the
    /// content_hash so a follow-up materialize never skips the write to the new path.
    /// A (storage_conn_id, rel_path) collision bubbles (callers map it to 409).
    pub async fn set_rel_path(&self, document_id: Uuid, rel_path: &str) -> Result<()> {
        sqlx::query(
            "update documents set rel_path = $2, content_hash = null, updated_at = now()
             where id = $1",
        )
        .bind(document_id)
        .bind(rel_path)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Soft-delete one document; inbound links flip back to unresolved. Idempotent.
    pub async fn trash_document(&self, document_id: Uuid) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "update documents set deleted_at = now(), updated_at = now()
             where id = $1 and deleted_at is null",
        )
        .bind(document_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("update document_links set dst_document_id = null where dst_document_id = $1")
            .bind(document_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Restore one trashed document. When its folder is itself still trashed the
    /// document moves to the root (it must not reappear inside the trash). Returns the
    /// final folder_id.
    pub async fn restore_document(&self, document_id: Uuid) -> Result<Option<Uuid>> {
        let row = sqlx::query(
            "update documents set
                 deleted_at = null,
                 folder_id = case
                     when folder_id in (select id from folders where deleted_at is not null)
                     then null else folder_id end,
                 updated_at = now()
             where id = $1
             returning folder_id",
        )
        .bind(document_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.get("folder_id"))
    }

    /// Hard-delete one document and everything that references it, in one transaction
    /// with EXPLICIT ordered deletes — there are no cascades on the crdt_* tables.
    /// audit_log keeps its rows (document_id set null); document-restricted api_tokens
    /// are revoked rather than widened (a token scoped to a purged document must not
    /// silently become unrestricted).
    pub async fn purge_document(&self, document_id: Uuid) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("delete from crdt_snapshots where document_id = $1")
            .bind(document_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("delete from crdt_updates where document_id = $1")
            .bind(document_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "delete from comments where thread_id in
                 (select id from comment_threads where document_id = $1)",
        )
        .bind(document_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("delete from comment_threads where document_id = $1")
            .bind(document_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("delete from suggestions where document_id = $1")
            .bind(document_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("delete from document_acl where document_id = $1")
            .bind(document_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("delete from share_links where document_id = $1")
            .bind(document_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("delete from document_links where src_document_id = $1")
            .bind(document_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("update document_links set dst_document_id = null where dst_document_id = $1")
            .bind(document_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("update audit_log set document_id = null where document_id = $1")
            .bind(document_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "update api_tokens set revoked_at = coalesce(revoked_at, now()), document_id = null
             where document_id = $1",
        )
        .bind(document_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("delete from documents where id = $1")
            .bind(document_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Audit log & per-workspace SSO (Phase 5 enterprise; migration 0007)
    // -----------------------------------------------------------------------

    /// Insert one audit entry. When the event carries no workspace but does carry a
    /// document, the workspace is resolved from the document right here (its natural
    /// owner) — one statement, no extra round trip on the hot path.
    pub async fn insert_audit(&self, e: &crate::audit::AuditEvent) -> Result<()> {
        sqlx::query(
            "insert into audit_log
                 (workspace_id, document_id, actor_user_id, actor_label, action, detail)
             values
                 (coalesce($1, (select workspace_id from documents where id = $2)),
                  $2, $3, $4, $5, $6)",
        )
        .bind(e.workspace_id)
        .bind(e.document_id)
        .bind(e.actor_user_id)
        .bind(&e.actor_label)
        .bind(e.action)
        .bind(&e.detail)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// One workspace's audit entries, newest first, paged by id (like document history).
    pub async fn list_audit(
        &self,
        workspace_id: Uuid,
        limit: i64,
        before_id: Option<i64>,
    ) -> Result<Vec<AuditLogRow>> {
        // Server-side ceiling regardless of what the handler forwards (DoS guard).
        let limit = limit.clamp(1, 500);
        let rows = sqlx::query(
            r#"select a.id, a.action, a.actor_label, a.document_id, a.detail,
                      to_char(a.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
                      u.id as author_id, coalesce(u.custom_display_name, u.display_name) as author_name, u.kind as author_kind
               from audit_log a
               left join users u on u.id = a.actor_user_id
               where a.workspace_id = $1 and ($2::bigint is null or a.id < $2)
               order by a.id desc limit $3"#,
        )
        .bind(workspace_id)
        .bind(before_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| AuditLogRow {
                id: r.get("id"),
                action: r.get("action"),
                actor: author_from(&r),
                actor_label: r.get("actor_label"),
                document_id: r.get("document_id"),
                detail: r.get("detail"),
                created_at: r.get("created_at"),
            })
            .collect())
    }

    /// Every workspace with an SSO config: (workspace_id, sso jsonb). Feeds the issuer
    /// registry, the email-domain → issuer lookup, and the login membership invariant.
    pub async fn workspace_sso_configs(&self) -> Result<Vec<(Uuid, serde_json::Value)>> {
        let rows = sqlx::query("select id, sso from workspaces where sso is not null")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| (r.get("id"), r.get("sso")))
            .collect())
    }

    pub async fn workspace_sso(&self, workspace_id: Uuid) -> Result<Option<serde_json::Value>> {
        let row = sqlx::query("select sso from workspaces where id = $1")
            .bind(workspace_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.and_then(|r| r.get("sso")))
    }

    /// Set (or, with None, remove) a workspace's SSO config. False = no such workspace.
    pub async fn set_workspace_sso(
        &self,
        workspace_id: Uuid,
        sso: Option<&serde_json::Value>,
    ) -> Result<bool> {
        let res = sqlx::query("update workspaces set sso = $2 where id = $1")
            .bind(workspace_id)
            .bind(sso)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }
}

fn folder_from(r: &sqlx::postgres::PgRow) -> FolderRow {
    FolderRow {
        id: r.get("id"),
        workspace_id: r.get("workspace_id"),
        parent_id: r.get("parent_id"),
        name: r.get("name"),
        updated_at: r.get("updated_at"),
        deleted_at: r.get("deleted_at"),
    }
}

fn storage_conn_from(r: &sqlx::postgres::PgRow) -> StorageConnRow {
    StorageConnRow {
        id: r.get("id"),
        workspace_id: r.get("workspace_id"),
        kind: r.get("kind"),
        config: r.get("config"),
        created_at: r.get("created_at"),
    }
}

fn attached_from(r: &sqlx::postgres::PgRow) -> AttachedDoc {
    AttachedDoc {
        document_id: r.get("id"),
        slug: r.get("slug"),
        rel_path: r.get("rel_path"),
        content_hash: r.get("content_hash"),
        kind: r.get("kind"),
        config: r.get("config"),
        workspace_id: r.get("workspace_id"),
        folder_id: r.get("folder_id"),
        storage_conn_id: r.get("storage_conn_id"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notifications::{CHANNEL_EMAIL, CHANNEL_IN_APP, EVENT_MENTION};

    #[test]
    fn blank_name_rejects_empty_and_whitespace() {
        assert!(blank_name(""));
        assert!(blank_name("   "));
        assert!(blank_name("\t\n"));
        assert!(!blank_name("Notes"));
        assert!(!blank_name("  Notes  ")); // has non-whitespace content
    }

    /// A live-Postgres test pool from `TEST_DATABASE_URL`, or `None` when the var is unset
    /// (CI runs `cargo test` without a database — those tests skip, see each call site). The
    /// pool runs migrations so the schema under test (e.g. migration 0013) is present.
    async fn test_db() -> Option<Persistence> {
        let url = std::env::var("TEST_DATABASE_URL").ok()?;
        Some(
            Persistence::connect(&url)
                .await
                .expect("connect TEST_DATABASE_URL"),
        )
    }

    /// Test helper: a workspace that is actually usable by `ensure_document_owned` (Fix 3 —
    /// `primary_workspace_of` excludes `pending_storage`). Binds a bare "memory" connection
    /// so the workspace becomes 'active', matching how a real workspace exits the wizard.
    async fn active_workspace(p: &Persistence, name: &str, owner: Uuid) -> Uuid {
        let ws = p.create_workspace(name, owner).await.unwrap();
        let conn = p
            .create_storage_connection(ws, "memory", &serde_json::json!({}))
            .await
            .unwrap();
        p.activate_workspace_with_storage(ws, conn).await.unwrap();
        ws
    }

    /// Isolation invariant (plan: per-workspace container): every connection created
    /// through the funnel carries a non-empty `config["container"]`, derived from the
    /// workspace's own name, not caller-supplied config. Skips unless TEST_DATABASE_URL
    /// is set.
    #[tokio::test]
    async fn create_storage_connection_stamps_a_container() {
        let Some(p) = test_db().await else {
            eprintln!(
                "skipping: set TEST_DATABASE_URL to run create_storage_connection_stamps_a_container"
            );
            return;
        };
        let owner = p.create_agent_user("container-owner").await.unwrap();
        let ws = p.create_workspace("My Notes", owner).await.unwrap();
        let id = p
            .create_storage_connection(ws, "memory", &serde_json::json!({}))
            .await
            .unwrap();
        let row = p.get_storage_connection(id, ws).await.unwrap().unwrap();
        let container = row
            .config
            .get("container")
            .and_then(|v| v.as_str())
            .unwrap();
        assert!(container.starts_with("my-notes-"), "got {container}");
        assert!(!container.contains('/'));
    }

    /// Tenant-isolation regression (CWE-290, vuln-0001): a non-primary issuer's invite
    /// claim is confined to the workspaces that registered it. An invite in a workspace
    /// the issuer is NOT authoritative for must survive untouched (no membership, invite
    /// stays unclaimed), while the same issuer scoped to the invite's own workspace, and
    /// the deployment-wide (primary) path, both claim it at the invited role.
    /// Skips unless TEST_DATABASE_URL is set.
    #[tokio::test]
    async fn claim_invites_is_scoped_to_authoritative_workspaces() {
        let Some(p) = test_db().await else {
            eprintln!(
                "skipping: set TEST_DATABASE_URL to run claim_invites_is_scoped_to_authoritative_workspaces"
            );
            return;
        };
        let owner_v = p.create_agent_user("victim-owner").await.unwrap();
        let ws_victim = p.create_workspace("victim-ws", owner_v).await.unwrap();
        let owner_a = p.create_agent_user("attacker-owner").await.unwrap();
        let ws_attacker = p.create_workspace("attacker-ws", owner_a).await.unwrap();
        // An outstanding ADMIN invite in the victim workspace — the prize.
        p.create_invite(ws_victim, "victim@corp.example", "admin", owner_v)
            .await
            .unwrap();

        // Attacker's per-workspace issuer is authoritative only for ws_attacker. Claiming
        // the victim's email scoped to ws_attacker must grant nothing in ws_victim.
        let attacker = p.create_agent_user("attacker").await.unwrap();
        let claimed = p
            .claim_invites(attacker, "victim@corp.example", false, &[ws_attacker])
            .await
            .unwrap();
        assert!(
            claimed.is_empty(),
            "cross-tenant claim leaked invites: {claimed:?}"
        );
        assert_eq!(
            p.workspace_role(ws_victim, attacker).await.unwrap(),
            None,
            "attacker must not gain membership in the victim workspace"
        );

        // The legitimate path: the SAME non-primary issuer, scoped to the invite's own
        // workspace (the workspace that registered it), claims at the invited role.
        let member = p.create_agent_user("legit").await.unwrap();
        let claimed = p
            .claim_invites(member, "victim@corp.example", false, &[ws_victim])
            .await
            .unwrap();
        assert_eq!(claimed, vec![(ws_victim, "admin".to_string())]);
        assert_eq!(
            p.workspace_role(ws_victim, member)
                .await
                .unwrap()
                .as_deref(),
            Some("admin")
        );

        // The deployment-wide (operator primary issuer) path claims across tenants; prove
        // it against a fresh invite so the assertion is independent of the claim above.
        let owner_o = p.create_agent_user("other-owner").await.unwrap();
        let ws_other = p.create_workspace("other-ws", owner_o).await.unwrap();
        p.create_invite(ws_other, "person@corp.example", "member", owner_o)
            .await
            .unwrap();
        let person = p.create_agent_user("person").await.unwrap();
        let claimed = p
            .claim_invites(person, "person@corp.example", true, &[])
            .await
            .unwrap();
        assert_eq!(claimed, vec![(ws_other, "member".to_string())]);
    }

    /// Onboarding stamp (migration 0016, spec 2026-07-02 §1): null until stamped,
    /// idempotent — the FIRST stamp wins — and round-trips through get_user as the
    /// house ISO-8601 string. Skips unless TEST_DATABASE_URL is set.
    #[tokio::test]
    async fn onboarded_at_stamps_once_and_round_trips() {
        let Some(p) = test_db().await else {
            eprintln!(
                "skipping: set TEST_DATABASE_URL to run onboarded_at_stamps_once_and_round_trips"
            );
            return;
        };
        let user = p.create_agent_user("onboardee").await.unwrap();
        let before = p.get_user(user).await.unwrap().unwrap();
        assert_eq!(before.onboarded_at, None, "fresh users are un-onboarded");

        assert!(p.set_user_onboarded(user).await.unwrap());
        let first = p
            .get_user(user)
            .await
            .unwrap()
            .unwrap()
            .onboarded_at
            .expect("stamped");
        assert!(
            first.contains('T') && first.ends_with('Z'),
            "house ISO shape: {first}"
        );

        // Idempotent: a second stamp (e.g. finishing on a second device) keeps
        // the FIRST timestamp.
        assert!(p.set_user_onboarded(user).await.unwrap());
        let second = p
            .get_user(user)
            .await
            .unwrap()
            .unwrap()
            .onboarded_at
            .unwrap();
        assert_eq!(first, second, "the first stamp wins");

        // Unknown user: false, not an error.
        assert!(!p.set_user_onboarded(Uuid::now_v7()).await.unwrap());
    }

    /// Task 0 / migration 0013 proof: re-recording the same parsed comment does not
    /// double-insert mention rows — and (sub-project ④c) enqueues exactly one notification
    /// per distinct recipient per comment. Skips unless TEST_DATABASE_URL points at a Postgres.
    #[tokio::test]
    async fn record_mentions_is_idempotent_across_reparse() {
        let Some(p) = test_db().await else {
            eprintln!("skipping: set TEST_DATABASE_URL to run record_mentions_is_idempotent_across_reparse");
            return;
        };
        // Seed an author, a recipient, a document, a thread, and a comment.
        let actor = p.create_agent_user("actor").await.unwrap();
        let recipient = p.create_agent_user("recipient").await.unwrap();
        // ensure_document_owned no longer auto-creates a workspace (BYO storage) — the
        // actor needs one up front.
        active_workspace(&p, "Actor WS", actor).await;
        let doc = p
            .ensure_document_owned(&format!("idem-{}", Uuid::now_v7()), actor, actor)
            .await
            .unwrap();
        let slug = p.document_slug(doc.id).await.unwrap().unwrap();
        let body = format!("hi @[R](muesli:user/{recipient})");
        let (thread_id, comment_id) = p
            .create_thread(doc.id, &serde_json::json!({"k": "v"}), Some(actor), &body)
            .await
            .unwrap();

        // First record: the recipient is newly mentioned → one dispatch context enqueued.
        let first = p
            .record_mentions(
                doc.id,
                thread_id,
                comment_id,
                Some(actor),
                Some("Actor"),
                &slug,
                "Doc",
                &[recipient],
            )
            .await
            .unwrap();
        assert_eq!(
            first.len(),
            1,
            "first parse inserts the mention + one notification"
        );
        assert_eq!(first[0].recipient_id, recipient);

        // Second record of the SAME comment (a retry / ④c re-derive): no new row, no new
        // notification → empty dispatch set.
        let second = p
            .record_mentions(
                doc.id,
                thread_id,
                comment_id,
                Some(actor),
                Some("Actor"),
                &slug,
                "Doc",
                &[recipient],
            )
            .await
            .unwrap();
        assert!(
            second.is_empty(),
            "re-parse must not double-insert or re-enqueue"
        );

        // Exactly one mention row AND exactly one notification row for this recipient/comment.
        let mention_count: i64 = sqlx::query_scalar(
            "select count(*) from mentions where recipient_id = $1 and comment_id = $2",
        )
        .bind(recipient)
        .bind(comment_id)
        .fetch_one(&p.pool)
        .await
        .unwrap();
        assert_eq!(
            mention_count, 1,
            "exactly one mention row after two records"
        );

        let notif_count: i64 =
            sqlx::query_scalar("select count(*) from notification where recipient_id = $1")
                .bind(recipient)
                .fetch_one(&p.pool)
                .await
                .unwrap();
        assert_eq!(
            notif_count, 1,
            "exactly one notification per recipient per comment"
        );
    }

    /// Security-critical isolation (sub-project ④c): a notification belongs to exactly one
    /// recipient. User B can never read, count, or mark-read user A's notifications — the
    /// recipient-scoped queries simply never match. Skips unless TEST_DATABASE_URL is set.
    #[tokio::test]
    async fn notifications_are_isolated_per_recipient() {
        let Some(p) = test_db().await else {
            eprintln!(
                "skipping: set TEST_DATABASE_URL to run notifications_are_isolated_per_recipient"
            );
            return;
        };
        // Two distinct recipients (A and B) plus an actor who mentions A.
        let actor = p.create_agent_user("actor").await.unwrap();
        let user_a = p.create_agent_user("user-a").await.unwrap();
        let user_b = p.create_agent_user("user-b").await.unwrap();
        // ensure_document_owned no longer auto-creates a workspace (BYO storage) — the
        // actor needs one up front.
        active_workspace(&p, "Actor WS", actor).await;
        let doc = p
            .ensure_document_owned(&format!("iso-{}", Uuid::now_v7()), actor, actor)
            .await
            .unwrap();
        let slug = p.document_slug(doc.id).await.unwrap().unwrap();

        // Mention A, enqueueing a notification owned by A.
        let body = format!("hi @[A](muesli:user/{user_a})");
        let (thread_id, comment_id) = p
            .create_thread(doc.id, &serde_json::json!({"k": "v"}), Some(actor), &body)
            .await
            .unwrap();
        let dispatch = p
            .record_mentions(
                doc.id,
                thread_id,
                comment_id,
                Some(actor),
                Some("Actor"),
                &slug,
                "Doc",
                &[user_a],
            )
            .await
            .unwrap();
        assert_eq!(
            dispatch.len(),
            1,
            "A is newly mentioned → one notification enqueued"
        );
        let a_notification_id = dispatch[0]
            .notification_id
            .expect("in-app default on → a notification row exists");

        // B sees nothing: empty list, zero unread count.
        let b_list = p
            .list_notifications(user_b, false, None, 100)
            .await
            .unwrap();
        assert!(
            b_list.is_empty(),
            "user B must not see user A's notifications"
        );
        assert_eq!(
            p.unread_notification_count(user_b).await.unwrap(),
            0,
            "user B's unread count must not include user A's notifications",
        );

        // B cannot mark A's notification read: ownership-scoped update affects zero rows.
        let marked = p
            .mark_notification_read(a_notification_id, user_b)
            .await
            .unwrap();
        assert!(
            !marked,
            "user B marking A's notification read must affect no rows"
        );

        // Proof it was a true no-op: A's notification is still unread and visible to A.
        assert_eq!(
            p.unread_notification_count(user_a).await.unwrap(),
            1,
            "A's notification stays unread after B's failed mark-read",
        );
        let a_list = p.list_notifications(user_a, true, None, 100).await.unwrap();
        assert_eq!(
            a_list.len(),
            1,
            "A still sees their own unread notification"
        );
        assert_eq!(a_list[0].id, a_notification_id);
        assert!(!a_list[0].read);
    }

    /// Migration 0017's `kind` column round-trips through insert_api_token/lookup_api_token,
    /// and TokenKind::from_db resolves it back to the right variant — the round trip
    /// account::authorize_notifications depends on to admit the desktop's own device-login
    /// token while rejecting an ordinary delegated key. Skips unless TEST_DATABASE_URL is set.
    #[tokio::test]
    async fn api_token_kind_round_trips_device_vs_delegated() {
        let Some(p) = test_db().await else {
            eprintln!(
                "skipping: set TEST_DATABASE_URL to run api_token_kind_round_trips_device_vs_delegated"
            );
            return;
        };
        let owner = p.create_agent_user("owner").await.unwrap();

        // Unique per run: the dev docker-compose Postgres persists volumes, so a fixed
        // hash would violate api_tokens' unique token_hash on the second run.
        let device_hash = format!("device-hash-{}", uuid::Uuid::new_v4());
        let delegated_hash = format!("delegated-hash-{}", uuid::Uuid::new_v4());

        let device_agent = p.create_agent_user("device-agent").await.unwrap();
        let (device_id, _) = p
            .insert_api_token(
                &device_hash,
                device_agent,
                Some(owner),
                &["read", "write"],
                None,
                crate::auth::TokenKind::Device.as_db(),
            )
            .await
            .unwrap();

        let delegated_agent = p.create_agent_user("delegated-agent").await.unwrap();
        let (delegated_id, _) = p
            .insert_api_token(
                &delegated_hash,
                delegated_agent,
                Some(owner),
                &["read", "write"],
                None,
                crate::auth::TokenKind::Delegated.as_db(),
            )
            .await
            .unwrap();

        let device_info = p.lookup_api_token(&device_hash).await.unwrap().unwrap();
        assert_eq!(device_info.principal_id, device_agent);
        assert_eq!(
            crate::auth::TokenKind::from_db(&device_info.kind),
            crate::auth::TokenKind::Device
        );

        let delegated_info = p.lookup_api_token(&delegated_hash).await.unwrap().unwrap();
        assert_eq!(delegated_info.principal_id, delegated_agent);
        assert_eq!(
            crate::auth::TokenKind::from_db(&delegated_info.kind),
            crate::auth::TokenKind::Delegated
        );

        // Sanity: two distinct rows, not the same one re-read.
        assert_ne!(device_id, delegated_id);
    }

    /// Migration 0017's backfill UPDATE flips a cli_login-shaped token (audit event
    /// WITHOUT a 'token_id' key) to kind='device', leaves a mint_token-shaped key
    /// (audit event WITH 'token_id') delegated, and survives malformed audit detail.
    /// The UPDATE is executed straight from the migration file so this test cannot
    /// drift from the shipped SQL. Skips unless TEST_DATABASE_URL is set.
    #[tokio::test]
    async fn api_token_kind_backfill_flips_only_cli_login_tokens() {
        let Some(p) = test_db().await else {
            eprintln!(
                "skipping: set TEST_DATABASE_URL to run api_token_kind_backfill_flips_only_cli_login_tokens"
            );
            return;
        };
        let migration = include_str!("../migrations/0017_api_token_kind.sql");
        let backfill = &migration[migration
            .find("update api_tokens")
            .expect("backfill UPDATE present in migration 0017")..];

        // cli_login shape: fresh agent, row left at the column default ('delegated', as a
        // pre-migration token would be), audit detail carrying agent_id but NO token_id.
        let cli_agent = p.create_agent_user("backfill-cli-agent").await.unwrap();
        let cli_hash = format!("backfill-cli-{}", uuid::Uuid::new_v4());
        p.insert_api_token(
            &cli_hash,
            cli_agent,
            None,
            &["read", "write"],
            None,
            crate::auth::TokenKind::Delegated.as_db(),
        )
        .await
        .unwrap();
        sqlx::query(
            "insert into audit_log (action, detail)
             values ('agent_token_minted', jsonb_build_object('agent_id', $1::text))",
        )
        .bind(cli_agent.to_string())
        .execute(&p.pool)
        .await
        .unwrap();

        // mint_token shape: identical except the detail includes a token_id key.
        let minted_agent = p.create_agent_user("backfill-minted-agent").await.unwrap();
        let minted_hash = format!("backfill-minted-{}", uuid::Uuid::new_v4());
        p.insert_api_token(
            &minted_hash,
            minted_agent,
            None,
            &["read", "write"],
            None,
            crate::auth::TokenKind::Delegated.as_db(),
        )
        .await
        .unwrap();
        sqlx::query(
            "insert into audit_log (action, detail)
             values ('agent_token_minted',
                     jsonb_build_object('agent_id', $1::text, 'token_id', $2::text))",
        )
        .bind(minted_agent.to_string())
        .bind(uuid::Uuid::new_v4().to_string())
        .execute(&p.pool)
        .await
        .unwrap();

        // Malformed audit rows: the regex guard must keep the ::uuid cast from aborting.
        sqlx::query(
            "insert into audit_log (action, detail) values
             ('agent_token_minted', '{\"agent_id\":\"not-a-uuid\"}'::jsonb),
             ('agent_token_minted', '{}'::jsonb)",
        )
        .execute(&p.pool)
        .await
        .unwrap();

        sqlx::query(backfill).execute(&p.pool).await.unwrap();

        let cli_info = p.lookup_api_token(&cli_hash).await.unwrap().unwrap();
        assert_eq!(
            crate::auth::TokenKind::from_db(&cli_info.kind),
            crate::auth::TokenKind::Device,
            "cli_login-shaped token must be backfilled to device"
        );
        let minted_info = p.lookup_api_token(&minted_hash).await.unwrap().unwrap();
        assert_eq!(
            crate::auth::TokenKind::from_db(&minted_info.kind),
            crate::auth::TokenKind::Delegated,
            "mint_token-shaped key must stay delegated"
        );
    }

    /// The `before` cursor validation (fix ④c): a well-formed timestamp validates, garbage does
    /// not — letting the handler answer 400 instead of letting the cast 500. The cursor format
    /// `list_notifications` itself emits must round-trip as valid. Skips without TEST_DATABASE_URL.
    #[tokio::test]
    async fn is_valid_timestamptz_accepts_real_timestamps_and_rejects_garbage() {
        let Some(p) = test_db().await else {
            eprintln!("skipping: set TEST_DATABASE_URL to run is_valid_timestamptz_accepts_real_timestamps_and_rejects_garbage");
            return;
        };
        // The exact shape the listing emits for `created_at` (microseconds + Z) round-trips.
        assert!(p
            .is_valid_timestamptz("2026-06-26T12:00:00.123456Z")
            .await
            .unwrap());
        assert!(p
            .is_valid_timestamptz("2026-06-26T12:00:00Z")
            .await
            .unwrap());
        // Malformed cursors are rejected (→ 400), not surfaced as a 500.
        assert!(!p.is_valid_timestamptz("not-a-timestamp").await.unwrap());
        assert!(!p
            .is_valid_timestamptz("2026-13-99T99:99:99Z")
            .await
            .unwrap());
    }

    /// You are never notified for mentioning yourself: when the recipient IS the actor,
    /// `record_mentions` records the mention but enqueues no notification (the `Some(*recipient)
    /// == actor_id` guard in the loop). Regression lock for that self-exclusion. Skips unless
    /// TEST_DATABASE_URL is set.
    #[tokio::test]
    async fn self_mention_creates_no_notification() {
        let Some(p) = test_db().await else {
            eprintln!(
                "skipping: set TEST_DATABASE_URL to run self_mention_creates_no_notification"
            );
            return;
        };
        // One user A who both authors the comment and is the mention recipient.
        let user_a = p.create_agent_user("user-a").await.unwrap();
        // ensure_document_owned no longer auto-creates a workspace (BYO storage) — user_a
        // needs one up front.
        active_workspace(&p, "User A WS", user_a).await;
        let doc = p
            .ensure_document_owned(&format!("self-{}", Uuid::now_v7()), user_a, user_a)
            .await
            .unwrap();
        let slug = p.document_slug(doc.id).await.unwrap().unwrap();

        // A mentions A: actor and the sole recipient are the same user.
        let body = format!("note to self @[A](muesli:user/{user_a})");
        let (thread_id, comment_id) = p
            .create_thread(doc.id, &serde_json::json!({"k": "v"}), Some(user_a), &body)
            .await
            .unwrap();
        let dispatch = p
            .record_mentions(
                doc.id,
                thread_id,
                comment_id,
                Some(user_a),
                Some("A"),
                &slug,
                "Doc",
                &[user_a],
            )
            .await
            .unwrap();
        assert!(
            dispatch.is_empty(),
            "a self-mention enqueues no notification dispatch"
        );

        // The guaranteed behavior: A has zero notifications (same recipient-scoped count query
        // the isolation test uses).
        let notif_count: i64 =
            sqlx::query_scalar("select count(*) from notification where recipient_id = $1")
                .bind(user_a)
                .fetch_one(&p.pool)
                .await
                .unwrap();
        assert_eq!(notif_count, 0, "a self-mention must create no notification");
    }

    /// In-app is now toggleable: with a stored `enabled=false` for (mention, in_app), a mention
    /// still records the `mentions` row but creates ZERO `notification` rows for that recipient.
    /// Email is also off here (no stored email pref but recipient is an agent with no email), so
    /// nothing dispatches either. Skips unless TEST_DATABASE_URL is set.
    #[tokio::test]
    async fn record_mentions_skips_notification_when_in_app_disabled() {
        let Some(p) = test_db().await else {
            eprintln!("skipping: set TEST_DATABASE_URL to run record_mentions_skips_notification_when_in_app_disabled");
            return;
        };
        let actor = p.create_agent_user("actor").await.unwrap();
        let recipient = p.create_agent_user("recipient").await.unwrap();
        // Recipient opts OUT of in-app AND email → fully muted for this event.
        p.set_notification_preference(recipient, EVENT_MENTION, CHANNEL_IN_APP, false)
            .await
            .unwrap();
        p.set_notification_preference(recipient, EVENT_MENTION, CHANNEL_EMAIL, false)
            .await
            .unwrap();
        // ensure_document_owned no longer auto-creates a workspace (BYO storage) — the
        // actor needs one up front.
        active_workspace(&p, "Actor WS", actor).await;
        let doc = p
            .ensure_document_owned(&format!("noinapp-{}", Uuid::now_v7()), actor, actor)
            .await
            .unwrap();
        let slug = p.document_slug(doc.id).await.unwrap().unwrap();
        let body = format!("hi @[R](muesli:user/{recipient})");
        let (thread_id, comment_id) = p
            .create_thread(doc.id, &serde_json::json!({"k": "v"}), Some(actor), &body)
            .await
            .unwrap();

        let dispatch = p
            .record_mentions(
                doc.id,
                thread_id,
                comment_id,
                Some(actor),
                Some("Actor"),
                &slug,
                "Doc",
                &[recipient],
            )
            .await
            .unwrap();
        // Both channels off → no dispatch context at all.
        assert!(
            dispatch.is_empty(),
            "both channels off → no dispatch context produced"
        );

        // The mention ROW is still recorded (the "?mentions=me" filter must stay correct).
        let mention_count: i64 = sqlx::query_scalar(
            "select count(*) from mentions where recipient_id = $1 and comment_id = $2",
        )
        .bind(recipient)
        .bind(comment_id)
        .fetch_one(&p.pool)
        .await
        .unwrap();
        assert_eq!(
            mention_count, 1,
            "mention row recorded even with in-app disabled"
        );

        // But ZERO notification rows for that recipient.
        let notif_count: i64 =
            sqlx::query_scalar("select count(*) from notification where recipient_id = $1")
                .bind(recipient)
                .fetch_one(&p.pool)
                .await
                .unwrap();
        assert_eq!(notif_count, 0, "in-app disabled → no notification row");
    }

    /// Regression: the happy path (no stored prefs) still creates the in-app notification row and
    /// one dispatch context. Skips unless TEST_DATABASE_URL is set.
    #[tokio::test]
    async fn record_mentions_creates_notification_by_default() {
        let Some(p) = test_db().await else {
            eprintln!("skipping: set TEST_DATABASE_URL to run record_mentions_creates_notification_by_default");
            return;
        };
        let actor = p.create_agent_user("actor").await.unwrap();
        let recipient = p.create_agent_user("recipient").await.unwrap();
        // ensure_document_owned no longer auto-creates a workspace (BYO storage) — the
        // actor needs one up front.
        active_workspace(&p, "Actor WS", actor).await;
        let doc = p
            .ensure_document_owned(&format!("default-{}", Uuid::now_v7()), actor, actor)
            .await
            .unwrap();
        let slug = p.document_slug(doc.id).await.unwrap().unwrap();
        let body = format!("hi @[R](muesli:user/{recipient})");
        let (thread_id, comment_id) = p
            .create_thread(doc.id, &serde_json::json!({"k": "v"}), Some(actor), &body)
            .await
            .unwrap();

        let dispatch = p
            .record_mentions(
                doc.id,
                thread_id,
                comment_id,
                Some(actor),
                Some("Actor"),
                &slug,
                "Doc",
                &[recipient],
            )
            .await
            .unwrap();
        assert_eq!(dispatch.len(), 1, "default prefs → one dispatch context");
        assert!(
            dispatch[0].notification_id.is_some(),
            "in-app default on → a notification row id"
        );

        let notif_count: i64 =
            sqlx::query_scalar("select count(*) from notification where recipient_id = $1")
                .bind(recipient)
                .fetch_one(&p.pool)
                .await
                .unwrap();
        assert_eq!(
            notif_count, 1,
            "default in-app on → exactly one notification row"
        );
    }

    /// In-app off BUT email on: no notification row is created, yet a DispatchContext for email is
    /// still produced (the email path stays independent of the in-app toggle). The recipient has a
    /// real email so the email channel would actually deliver. Skips unless TEST_DATABASE_URL is set.
    #[tokio::test]
    async fn record_mentions_dispatches_email_when_in_app_off_but_email_on() {
        let Some(p) = test_db().await else {
            eprintln!("skipping: set TEST_DATABASE_URL to run record_mentions_dispatches_email_when_in_app_off_but_email_on");
            return;
        };
        let actor = p.create_agent_user("actor").await.unwrap();
        // A recipient with an email on file; email defaults ON for mentions.
        let recipient = p.create_agent_user("recipient").await.unwrap();
        sqlx::query("update users set email = $1 where id = $2")
            .bind("recipient@example.com")
            .bind(recipient)
            .execute(&p.pool)
            .await
            .unwrap();
        // Disable ONLY in-app; leave email at its default (on).
        p.set_notification_preference(recipient, EVENT_MENTION, CHANNEL_IN_APP, false)
            .await
            .unwrap();
        // ensure_document_owned no longer auto-creates a workspace (BYO storage) — the
        // actor needs one up front.
        active_workspace(&p, "Actor WS", actor).await;
        let doc = p
            .ensure_document_owned(&format!("emailonly-{}", Uuid::now_v7()), actor, actor)
            .await
            .unwrap();
        let slug = p.document_slug(doc.id).await.unwrap().unwrap();
        let body = format!("hi @[R](muesli:user/{recipient})");
        let (thread_id, comment_id) = p
            .create_thread(doc.id, &serde_json::json!({"k": "v"}), Some(actor), &body)
            .await
            .unwrap();

        let dispatch = p
            .record_mentions(
                doc.id,
                thread_id,
                comment_id,
                Some(actor),
                Some("Actor"),
                &slug,
                "Doc",
                &[recipient],
            )
            .await
            .unwrap();
        // Email path intact: a dispatch context is produced even though in-app was skipped.
        assert_eq!(
            dispatch.len(),
            1,
            "email enabled → a dispatch context is produced"
        );
        assert_eq!(dispatch[0].recipient_id, recipient);
        assert_eq!(
            dispatch[0].recipient_email.as_deref(),
            Some("recipient@example.com")
        );
        assert!(
            dispatch[0].notification_id.is_none(),
            "in-app off → no notification row id"
        );
        // resolve_channels on the carried prefs still yields email (and not in-app).
        let channels = crate::notifications::resolve_channels(EVENT_MENTION, &dispatch[0].prefs);
        assert!(
            channels.iter().any(|c| c == CHANNEL_EMAIL),
            "email channel still resolved on"
        );
        assert!(
            !channels.iter().any(|c| c == CHANNEL_IN_APP),
            "in-app not resolved"
        );

        // No notification row was inserted.
        let notif_count: i64 =
            sqlx::query_scalar("select count(*) from notification where recipient_id = $1")
                .bind(recipient)
                .fetch_one(&p.pool)
                .await
                .unwrap();
        assert_eq!(
            notif_count, 0,
            "in-app off → no notification row, email handled out-of-band"
        );
    }

    /// BYO storage (plan 1a task 1): create_workspace now starts 'pending_storage';
    /// activation binds the connection and flips to 'active'.
    #[tokio::test]
    async fn workspace_lifecycle_pending_to_active() {
        let Some(p) = test_db().await else {
            eprintln!(
                "skipping: set TEST_DATABASE_URL to run workspace_lifecycle_pending_to_active"
            );
            return;
        };
        let owner = p.create_agent_user("owner").await.unwrap();
        let ws = p.create_workspace("BYO Test", owner).await.unwrap();

        let meta = p
            .workspace_meta(ws)
            .await
            .unwrap()
            .expect("workspace exists");
        assert_eq!(meta.status, "pending_storage");
        assert_eq!(meta.storage_conn_id, None);
        assert_eq!(meta.retention, None);

        let conn = p
            .create_storage_connection(
                ws,
                "s3",
                &serde_json::json!({"endpoint": "https://x", "bucket": "b"}),
            )
            .await
            .unwrap();
        p.activate_workspace_with_storage(ws, conn).await.unwrap();
        let meta = p.workspace_meta(ws).await.unwrap().unwrap();
        assert_eq!(meta.status, "active");
        assert_eq!(meta.storage_conn_id, Some(conn));
    }

    /// Pending workspaces are hidden from list_workspaces; active ones show.
    #[tokio::test]
    async fn pending_workspaces_are_hidden_from_listings() {
        let Some(p) = test_db().await else {
            eprintln!("skipping: set TEST_DATABASE_URL to run pending_workspaces_are_hidden_from_listings");
            return;
        };
        let owner = p.create_agent_user("owner2").await.unwrap();
        let ws = p.create_workspace("Hidden Pending", owner).await.unwrap();
        assert!(!p
            .list_workspaces(owner)
            .await
            .unwrap()
            .iter()
            .any(|w| w.id == ws));

        let conn = p
            .create_storage_connection(
                ws,
                "s3",
                &serde_json::json!({"endpoint": "https://x", "bucket": "b"}),
            )
            .await
            .unwrap();
        p.activate_workspace_with_storage(ws, conn).await.unwrap();
        assert!(p
            .list_workspaces(owner)
            .await
            .unwrap()
            .iter()
            .any(|w| w.id == ws));
    }

    /// BYO storage (1a task 11): `primary_workspace_of` is a lookup only — it must never
    /// mint a workspace for a workspace-less user (unlike the old `ensure_personal_workspace`).
    #[tokio::test]
    async fn primary_workspace_lookup_never_creates() {
        let Some(p) = test_db().await else {
            eprintln!(
                "skipping: set TEST_DATABASE_URL to run primary_workspace_lookup_never_creates"
            );
            return;
        };
        let user = p.create_agent_user("workspace-less").await.unwrap();

        // Calling it (even twice) must not create a workspace or membership row.
        assert_eq!(p.primary_workspace_of(user).await.unwrap(), None);
        assert_eq!(p.primary_workspace_of(user).await.unwrap(), None);
        let membership_count: i64 =
            sqlx::query_scalar("select count(*) from memberships where user_id = $1")
                .bind(user)
                .fetch_one(&p.pool)
                .await
                .unwrap();
        assert_eq!(
            membership_count, 0,
            "the lookup must not auto-create a workspace/membership"
        );

        // create_workspace leaves the workspace 'pending_storage' — the lookup must still
        // see nothing usable (Fix 3: no storage bound yet means documents can't attach).
        let ws = p.create_workspace("Real Workspace", user).await.unwrap();
        assert_eq!(
            p.primary_workspace_of(user).await.unwrap(),
            None,
            "a pending_storage workspace must not be returned as usable"
        );

        // Once storage is bound (status -> 'active'), the lookup finds it.
        let conn = p
            .create_storage_connection(ws, "memory", &serde_json::json!({}))
            .await
            .unwrap();
        p.activate_workspace_with_storage(ws, conn).await.unwrap();
        assert_eq!(p.primary_workspace_of(user).await.unwrap(), Some(ws));
    }

    /// Fix 1 (BYO storage final review): deleting a storage connection that is still the
    /// workspace's bound storage must clear the binding first (migration 0015's FK is
    /// RESTRICT) rather than 500 — the workspace falls back to unbound-active.
    #[tokio::test]
    async fn delete_storage_connection_clears_workspace_binding() {
        let Some(p) = test_db().await else {
            eprintln!(
                "skipping: set TEST_DATABASE_URL to run delete_storage_connection_clears_workspace_binding"
            );
            return;
        };
        let owner = p.create_agent_user("disconnector").await.unwrap();
        let ws = p.create_workspace("Disconnect Me", owner).await.unwrap();
        let conn = p
            .create_storage_connection(ws, "memory", &serde_json::json!({}))
            .await
            .unwrap();
        p.activate_workspace_with_storage(ws, conn).await.unwrap();
        assert_eq!(p.count_attached_documents(conn).await.unwrap(), 0);

        assert!(
            p.delete_storage_connection(conn, ws).await.unwrap(),
            "delete should succeed"
        );

        let meta = p.workspace_meta(ws).await.unwrap().unwrap();
        assert_eq!(meta.storage_conn_id, None, "binding must be cleared");
        assert_eq!(
            meta.status, "active",
            "workspace stays active, grandfathered-unbound"
        );
    }

    /// Fix 5 (BYO storage final review): `create_storage_connection`'s handler-level
    /// rebinding guard (workspace.rs) branches on exactly this distinction — a
    /// grandfathered workspace (a connection exists, but the workspace was never bound to
    /// it) must proceed unblocked, while a bound workspace (`storage_conn_id` set) must be
    /// rejected. The guard itself lives in an axum handler that needs session/AppState
    /// plumbing this module doesn't set up for tests, so this locks the persistence-level
    /// state the guard reads.
    #[tokio::test]
    async fn workspace_meta_distinguishes_bound_from_grandfathered() {
        let Some(p) = test_db().await else {
            eprintln!(
                "skipping: set TEST_DATABASE_URL to run workspace_meta_distinguishes_bound_from_grandfathered"
            );
            return;
        };
        let owner = p.create_agent_user("rebind-guard").await.unwrap();

        // Grandfathered: a connection exists, but the workspace was never bound to it.
        let ws_grandfathered = p.create_workspace("Grandfathered", owner).await.unwrap();
        p.create_storage_connection(ws_grandfathered, "memory", &serde_json::json!({}))
            .await
            .unwrap();
        let meta = p.workspace_meta(ws_grandfathered).await.unwrap().unwrap();
        assert_eq!(
            meta.storage_conn_id, None,
            "grandfathered: connection exists, no binding"
        );

        // Bound: activate_workspace_with_storage sets storage_conn_id — the guard must
        // see this and reject a second create_storage_connection call.
        let ws_bound = active_workspace(&p, "Bound", owner).await;
        let meta = p.workspace_meta(ws_bound).await.unwrap().unwrap();
        assert!(
            meta.storage_conn_id.is_some(),
            "bound workspace carries a storage_conn_id"
        );
    }

    /// plan 1a task 9: prune keeps the latest snapshot + the update tail after it.
    #[tokio::test]
    async fn prune_history_keeps_latest_snapshot_and_tail() {
        let Some(p) = test_db().await else {
            eprintln!("skipping: set TEST_DATABASE_URL to run prune_history_keeps_latest_snapshot_and_tail");
            return;
        };
        let actor = p.create_agent_user("pruner").await.unwrap();
        // ensure_document_owned no longer auto-creates a workspace (BYO storage) — the
        // actor needs one up front.
        active_workspace(&p, "Pruner WS", actor).await;
        let doc = p
            .ensure_document_owned(&format!("prune-{}", Uuid::now_v7()), actor, actor)
            .await
            .unwrap();
        for seq in 1..=10i64 {
            p.append_update(doc.id, seq, b"u", "test", None, None)
                .await
                .unwrap();
        }
        p.save_snapshot(doc.id, 4, b"snap4").await.unwrap();
        p.save_snapshot(doc.id, 8, b"snap8").await.unwrap();

        let (updates_gone, snaps_gone) = p.prune_history(doc.id).await.unwrap();
        assert_eq!(
            updates_gone, 8,
            "seq 1..=8 pruned (covered by snapshot up_to 8)"
        );
        assert_eq!(snaps_gone, 1, "snap4 pruned, snap8 kept");

        let remaining: i64 =
            sqlx::query_scalar("select count(*) from crdt_updates where document_id = $1")
                .bind(doc.id)
                .fetch_one(&p.pool)
                .await
                .unwrap();
        assert_eq!(remaining, 2, "seq 9,10 survive");
        let snaps: i64 =
            sqlx::query_scalar("select count(*) from crdt_snapshots where document_id = $1")
                .bind(doc.id)
                .fetch_one(&p.pool)
                .await
                .unwrap();
        assert_eq!(snaps, 1);

        // No snapshot at all → nothing is ever pruned (safety: full log IS the doc).
        let doc2 = p
            .ensure_document_owned(&format!("prune2-{}", Uuid::now_v7()), actor, actor)
            .await
            .unwrap();
        p.append_update(doc2.id, 1, b"u", "test", None, None)
            .await
            .unwrap();
        assert_eq!(p.prune_history(doc2.id).await.unwrap(), (0, 0));
    }

    /// GC deletes only old, empty, pending workspaces.
    #[tokio::test]
    async fn purge_only_touches_abandoned_pending_workspaces() {
        let Some(p) = test_db().await else {
            eprintln!("skipping: set TEST_DATABASE_URL to run purge_only_touches_abandoned_pending_workspaces");
            return;
        };
        let owner = p.create_agent_user("owner3").await.unwrap();
        let fresh_pending = p.create_workspace("Fresh", owner).await.unwrap();
        let old_pending = p.create_workspace("Old", owner).await.unwrap();
        sqlx::query("update workspaces set created_at = now() - interval '48 hours' where id = $1")
            .bind(old_pending)
            .execute(&p.pool)
            .await
            .unwrap();
        let purged = p.purge_abandoned_pending_workspaces(24).await.unwrap();
        assert!(purged >= 1);
        assert!(
            p.workspace_meta(old_pending).await.unwrap().is_none(),
            "old pending purged"
        );
        assert!(
            p.workspace_meta(fresh_pending).await.unwrap().is_some(),
            "fresh pending kept"
        );
    }
}
