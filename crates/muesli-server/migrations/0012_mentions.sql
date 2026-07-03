-- @mentions (sub-project ④b; design 2026-06-25-comments-mentions-notifications-design.md).
-- The server parses `@[Name](muesli:user/<uuid>)` tokens out of a comment/reply body and
-- writes one row per distinct mentioned recipient. These rows are authoritative (derived
-- from the stored body, never trusted from the client) and power:
--   (a) the "mentions you" comments filter (GET .../comments?mentions=me), and
--   (b) sub-project ④c notification enqueueing (the same write becomes the seam).
-- Ids are UUIDv7, generated app-side (uuid::Uuid::now_v7).

create table mentions (
    id            uuid primary key,
    recipient_id  uuid not null references users (id) on delete cascade,
    actor_id      uuid references users (id) on delete set null,  -- null = anonymous author
    document_id   uuid not null references documents (id) on delete cascade,
    thread_id     uuid not null references comment_threads (id) on delete cascade,
    comment_id    uuid not null references comments (id) on delete cascade,
    created_at    timestamptz not null default now()
);

-- "mentions you" filter: recipient + document lookups.
create index mentions_recipient_doc on mentions (recipient_id, document_id);
-- Map a comment back to its mentions (e.g. ④c dispatch, cleanup).
create index mentions_comment on mentions (comment_id);
