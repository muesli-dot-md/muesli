-- Phase 2 workspace management (ADR 0011) and storage backends (ADR 0013).

-- Pending invitations into a Workspace, keyed by email. If a user with the email already
-- exists the API creates the membership immediately (no invite row); otherwise the invite
-- is claimed on the invitee's first OIDC login (auth.rs callback / cli login).
create table invites (
    id            uuid primary key default gen_random_uuid(),
    workspace_id  uuid not null references workspaces (id) on delete cascade,
    email         text not null,                       -- stored lowercased
    role          text not null,                       -- 'admin' | 'member'
    created_by    uuid not null references users (id),
    created_at    timestamptz not null default now(),
    claimed_at    timestamptz                          -- null = pending
);
create unique index invites_pending_unique on invites (workspace_id, email)
    where claimed_at is null;
create index invites_pending_email on invites (email) where claimed_at is null;

-- Who created a Workspace. ensure_personal_workspace sets it, and (created_by = caller)
-- is how the API marks a workspace "personal". Backfill existing solo-admin workspaces.
alter table workspaces add column created_by uuid references users (id);
update workspaces w set created_by = m.user_id
from memberships m
where m.workspace_id = w.id and m.role = 'admin'
  and (select count(*) from memberships m2 where m2.workspace_id = w.id) = 1;

-- A Workspace's connected storage backends (ADR 0013). Secrets never live here: the
-- server reads MUESLI_S3_ACCESS_KEY / MUESLI_S3_SECRET_KEY from its environment; config
-- holds only locations: {endpoint, bucket, region, prefix, force_path_style}.
create table storage_connections (
    id            uuid primary key default gen_random_uuid(),
    workspace_id  uuid not null references workspaces (id) on delete cascade,
    kind          text not null,                       -- 'local_fs' | 's3' | 'gdrive'
    config        jsonb not null,
    created_at    timestamptz not null default now()
);
create index storage_connections_ws on storage_connections (workspace_id);

-- A Document attaches to one backend location. content_hash is the sha256 of the last
-- materialized bytes — the loop guard that keeps our own writes from re-ingesting
-- (ADR 0013; docs/design/ingest-and-materialization.md).
alter table documents
    add column storage_conn_id uuid references storage_connections (id),
    add column rel_path        text,
    add column content_hash    text;
create unique index documents_storage_path on documents (storage_conn_id, rel_path)
    where storage_conn_id is not null;
