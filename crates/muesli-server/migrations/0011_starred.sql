-- Starred / favourites (Drive-style), documents only for v1.
--
-- A per-document boolean flag. v1 is intentionally workspace-global rather than
-- per-user: the column lives on the document row, mirroring the title/folder/trash
-- state added in migration 0008. (A per-user star would need its own join table;
-- documents are sufficient for the first cut.) Live list/single-doc read models
-- surface this so the UI can render filled vs outline stars and a "~starred" view.
alter table documents
    add column starred boolean not null default false;
