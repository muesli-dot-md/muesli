-- Phase 1 persistence (ADR 0010; docs/design/data-model.md subset).
-- The append-only update log IS the edit history; snapshots are pure compaction.
-- Full data-model (workspaces, ACLs, comments, …) lands with auth.

create table documents (
    id          uuid primary key default gen_random_uuid(),
    slug        text not null unique,          -- the room name; rel_path/storage land with ADR 0013
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create table crdt_updates (
    id            bigint generated always as identity primary key,
    document_id   uuid not null references documents(id),
    seq           bigint not null,             -- per-document monotonic
    update_blob   bytea not null,              -- yrs/Yjs v1 update bytes
    origin        text,                        -- 'human' | 'agent' | 'ingest' (ADR 0007; null until auth)
    author_id     uuid,                        -- attribution, lands with auth (ADR 0012)
    change_set_id uuid,                        -- groups large edits (ADR 0007)
    created_at    timestamptz not null default now(),
    unique (document_id, seq)
);

create table crdt_snapshots (
    document_id   uuid not null references documents(id),
    up_to_seq     bigint not null,
    snapshot_blob bytea not null,
    created_at    timestamptz not null default now(),
    primary key (document_id, up_to_seq)
);
