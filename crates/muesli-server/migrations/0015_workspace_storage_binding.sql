-- crates/muesli-server/migrations/0015_workspace_storage_binding.sql
-- BYO-storage workspaces (spec 2026-07-01): a workspace is created 'pending_storage'
-- and becomes 'active' when a probed storage connection is bound. Existing rows are
-- grandfathered active with no binding. retention: null = server default
-- (MUESLI_RETENTION), else 'full' | 'bounded'.

alter table workspaces
    add column status          text not null default 'active',
    add column storage_conn_id uuid references storage_connections (id),
    add column retention       text;

-- Backfill: a workspace that already has exactly one storage connection is bound to it.
update workspaces w set storage_conn_id = c.id
from (select workspace_id, min(id::text)::uuid as id, count(*) as n
      from storage_connections group by workspace_id) c
where c.workspace_id = w.id and c.n = 1;

create index workspaces_pending on workspaces (created_at) where status = 'pending_storage';
