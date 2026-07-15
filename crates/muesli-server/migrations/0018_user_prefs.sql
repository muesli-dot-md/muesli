-- Per-user appearance preferences (GET/PATCH /api/me/prefs): a single jsonb
-- object of known keys (theme / accent / tint_strength / tint_hue / folder_hue),
-- validated by the API layer — the column itself stays shapeless so adding a
-- key is an API change, not a migration. Sparse by design: a key is present
-- only once the user has actually picked something, so each app keeps its own
-- default until then (web defaults accent "gray", desktop periwinkle).
alter table users
    add column prefs jsonb not null default '{}'::jsonb;
