-- User-set profile overrides (docs/design/settings.md §2.1 Profile).
--
-- The OIDC upsert (upsert_oidc_user) coalesce-refreshes email/display_name/avatar_url
-- from the IdP claims on EVERY login, so a user edit stored in those columns would be
-- silently overwritten next sign-in (the "coalesce trap"). User edits therefore live in
-- separate override columns; every read coalesces (custom_*, claim) — see get_user and
-- the display-name joins in persistence.rs. Clearing an override (null) falls back to
-- the IdP claim again.
--
-- custom_avatar_url holds a client-resized data URL (validated ≤ 64 KB, image/webp|png|
-- jpeg) — no blob storage involved; every render site already treats avatar_url as an
-- <img src>.
alter table users
    add column custom_display_name text,
    add column custom_avatar_url   text;
