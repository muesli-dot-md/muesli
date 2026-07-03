-- Machine credentials (docs/design/mcp-and-agent-auth.md): Muesli-issued API tokens.
-- Two kinds: delegated agent tokens (owner_user_id set — acts within the owner's permissions,
-- attributed to the agent identity) and workspace service accounts (owner_user_id null —
-- the principal is its own first-class identity, users.kind = 'agent').

create table api_tokens (
    id            uuid primary key default gen_random_uuid(),
    token_hash    text not null unique,                -- secret shown once, sha-256 at rest
    principal_id  uuid not null references users (id), -- the agent identity edits attribute to
    owner_user_id uuid references users (id),          -- set for delegated agent tokens
    scopes        text[] not null,                     -- ⊆ {read, write, comment, suggest, admin}
    workspace_id  uuid references workspaces (id),     -- optional restriction
    document_id   uuid references documents (id),      -- optional restriction
    expires_at    timestamptz,
    revoked_at    timestamptz,
    created_at    timestamptz not null default now()
);
