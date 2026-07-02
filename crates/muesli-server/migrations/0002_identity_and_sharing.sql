-- Identity, tenancy, and sharing (ADR 0011, 0012; docs/design/data-model.md).
-- Sessions are NOT here — they live in Redis (or in-memory in dev), per ADR 0017.

create table users (
    id            uuid primary key default gen_random_uuid(),
    kind          text not null default 'human',          -- 'human' | 'agent'
    oidc_issuer   text,                                   -- (issuer, subject) = external identity
    oidc_subject  text,
    email         text,
    display_name  text,
    avatar_url    text,
    created_at    timestamptz not null default now(),
    unique (oidc_issuer, oidc_subject)
);

create table workspaces (
    id            uuid primary key default gen_random_uuid(),
    name          text not null,
    plan          text not null default 'free',
    created_at    timestamptz not null default now()
);

create table memberships (
    workspace_id  uuid not null references workspaces (id) on delete cascade,
    user_id       uuid not null references users (id) on delete cascade,
    role          text not null,                          -- 'admin' | 'member'
    primary key (workspace_id, user_id)
);

-- Documents gain an owner: the Workspace they belong to and who created them (ADR 0011).
alter table documents
    add column workspace_id uuid references workspaces (id),
    add column created_by   uuid references users (id);

create table document_acl (
    document_id   uuid not null references documents (id) on delete cascade,
    user_id       uuid not null references users (id) on delete cascade,
    role          text not null,                          -- 'viewer' | 'commenter' | 'editor'
    primary key (document_id, user_id)
);

create table share_links (
    id            uuid primary key default gen_random_uuid(),
    document_id   uuid not null references documents (id) on delete cascade,
    token         text not null unique,                   -- the link secret (capability)
    role          text not null,                          -- role granted to link users
    expires_at    timestamptz,
    created_by    uuid references users (id),
    created_at    timestamptz not null default now()
);

-- Attribution on the update log (ADR 0007): author_id existed since 0001, now points somewhere.
alter table crdt_updates
    add constraint crdt_updates_author_fk foreign key (author_id) references users (id);
