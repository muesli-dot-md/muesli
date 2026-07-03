-- Phase 5 enterprise (ADR 0012 "Multi-issuer / per-Workspace IdP"; ADR 0021 ops posture).

-- Workspace audit log: security-relevant events, append-only, written fire-and-forget
-- (audit.rs — the trail must never block or fail the action it describes). workspace_id
-- is resolved where natural (a document event inherits its document's workspace) and null
-- otherwise; references are `set null` so an audit entry outlives what it describes.
create table audit_log (
    id            bigserial primary key,
    workspace_id  uuid references workspaces (id) on delete set null,
    document_id   uuid references documents (id) on delete set null,
    actor_user_id uuid references users (id) on delete set null,
    actor_label   text,                                -- non-user actors (system jobs)
    action        text not null,                       -- e.g. 'login', 'share_link_created'
    detail        jsonb not null default '{}'::jsonb,
    created_at    timestamptz not null default now()
);
-- The admin view: one workspace, newest first, paged by id (GET /api/workspaces/{id}/audit).
create index audit_log_workspace on audit_log (workspace_id, id desc);

-- Per-workspace IdP (multi-issuer SSO): {issuer, client_id, client_secret, email_domains:[…]}.
-- PROTOTYPE NOTE: client_secret is plaintext jsonb, same posture as the per-user gdrive
-- refresh tokens in storage_connections.config (migration 0005) — encrypt at rest before
-- this ships to real enterprise tenants. It is redacted from every API response.
alter table workspaces add column sso jsonb;
