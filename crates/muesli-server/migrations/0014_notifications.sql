-- Notifications platform (sub-project ④c; design 2026-06-25-comments-mentions-notifications-design.md).
-- A generic notification inbox plus a per-user event-type × channel preference matrix. v1
-- emits exactly one notification `type` = 'mention' (written in the same transaction as the
-- ④b mention row), but the schema is deliberately generic so future types — 'comment_reply',
-- 'suggestion_resolved', 'share_invite', … — add without a migration.
-- Ids are UUIDv7, generated app-side (uuid::Uuid::now_v7), like every other table here.

create table notification (
    id            uuid primary key,
    recipient_id  uuid not null references users (id) on delete cascade,
    -- The event type. Open-ended text (not an enum) so new types need no migration.
    type          text not null,
    -- Type-specific render data: for 'mention' = { actor_name, doc_slug, doc_title,
    -- thread_id, comment_id }. The inbox renders straight from this; no extra joins.
    payload       jsonb not null default '{}'::jsonb,
    -- The user who triggered it (mention author); null = anonymous/system actor.
    actor_id      uuid references users (id) on delete set null,
    -- Null = unread. A non-null timestamp = when the recipient marked it read.
    read_at       timestamptz,
    created_at    timestamptz not null default now()
);

-- The inbox query: a recipient's notifications, newest first, optionally unread-only.
create index notification_recipient_created on notification (recipient_id, created_at desc);
-- The unread-count badge: partial index over just the unread rows.
create index notification_unread on notification (recipient_id) where read_at is null;

-- Per-user toggle matrix: one row per (user, event_type, channel) the user has an explicit
-- preference for. Absence = the coded default (in-app always on; email defaults ON for
-- mentions — see notifications::default_enabled). 'in_app' is stored for completeness but is
-- never disableable; only 'email' is meaningfully toggled in v1.
create table notification_preference (
    user_id     uuid not null references users (id) on delete cascade,
    event_type  text not null,
    channel     text not null,
    enabled     boolean not null,
    primary key (user_id, event_type, channel)
);
