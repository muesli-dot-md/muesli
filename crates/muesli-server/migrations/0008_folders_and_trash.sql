-- Folders, trash (soft delete), and display titles.
--
-- Folders are a server-side hierarchy for organizing documents; workspace_id null is the
-- open-mode/global space (mirroring documents created before auth). Trash is a stamped
-- deleted_at on folders AND documents — live queries filter it, restore clears it, and
-- purge (documents only) hard-deletes with explicit child-table deletes (no cascades on
-- crdt_* tables). Titles are a deliberate deviation from ADR 0013's "titles stay derived":
-- a stored display name that renames a document WITHOUT touching its slug (the immutable
-- room identifier); null falls back to the slug.

create table folders (
    id            uuid primary key default gen_random_uuid(),
    workspace_id  uuid references workspaces (id),
    parent_id     uuid references folders (id),
    name          text not null,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    deleted_at    timestamptz                          -- null = live; set = in the trash
);
create index folders_parent on folders (parent_id);
create index folders_workspace on folders (workspace_id);

-- Sibling-name uniqueness among LIVE folders only (trashed names never block reuse).
-- The zero uuid stands in for null workspace (open mode) / null parent (root).
create unique index folders_sibling_name on folders (
    coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(parent_id,    '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
) where deleted_at is null;

alter table documents
    add column folder_id  uuid references folders (id),
    add column title      text,
    add column deleted_at timestamptz;

create index documents_folder on documents (folder_id);
