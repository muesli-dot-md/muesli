-- Phase 2 collaboration depth (ADR 0019; docs/design/data-model.md).
-- Comments/threads and suggestions live here, never in the .md (ADR 0002). Anchors are
-- yrs sticky-index ranges serialized as jsonb; pending suggestions never touch the CRDT.
-- Note: crdt_updates.change_set_id (ADR 0007) has existed since migration 0001.
-- Ids are UUIDv7, generated app-side (uuid::Uuid::now_v7).

create table comment_threads (
    id            uuid primary key,
    document_id   uuid not null references documents (id) on delete cascade,
    anchor        jsonb not null,                      -- {"v":1,"start":<b64>,"end":<b64>}
    status        text not null default 'open',        -- 'open' | 'resolved' | 'orphaned'
    created_by    uuid references users (id),          -- null = anonymous (open mode)
    created_at    timestamptz not null default now()
);
create index comment_threads_doc on comment_threads (document_id);

create table comments (
    id            uuid primary key,
    thread_id     uuid not null references comment_threads (id) on delete cascade,
    author_id     uuid references users (id),          -- null = anonymous (open mode)
    body          text not null,
    created_at    timestamptz not null default now()
);
create index comments_thread on comments (thread_id);

create table suggestions (
    id            uuid primary key,
    document_id   uuid not null references documents (id) on delete cascade,
    change_set_id uuid not null,                       -- one reviewable unit (ADR 0007)
    anchor        jsonb not null,
    op            jsonb not null,                      -- {start,end,insert,old_text} at creation
    note          text,                                -- optional reviewer-facing rationale
    author_id     uuid references users (id),
    status        text not null default 'pending',     -- 'pending' | 'accepted' | 'rejected'
    created_at    timestamptz not null default now()
);
create index suggestions_doc_status on suggestions (document_id, status);
create index suggestions_change_set on suggestions (change_set_id);
