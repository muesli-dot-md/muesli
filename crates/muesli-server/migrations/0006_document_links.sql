-- Cross-document link graph (ADR 0015; docs/design/wikilinks-and-link-graph.md;
-- docs/design/data-model.md "Link graph"). One row per distinct link target written in a
-- document's markdown (wikilinks + relative .md links). dst_document_id is null while the
-- target doesn't resolve to a Document; the raw text is kept so the link can resolve later
-- (a matching document gets created) or be shown as a ghost node in the graph view.
--
-- target_slug / target_path refine the data-model sketch: they are the normalized
-- resolution keys computed at extraction time (links.rs), so re-resolution when a new
-- document appears is one indexed UPDATE instead of re-parsing every document.

create table document_links (
    src_document_id uuid not null references documents (id) on delete cascade,
    -- A deleted target flips its inbound links back to unresolved (set null), per the
    -- design doc; the raw text in the source documents is untouched (ADR 0001).
    dst_document_id uuid references documents (id) on delete set null,
    raw_target      text not null,        -- the target exactly as written in the markdown
    target_slug     text not null,        -- render.ts-compatible slug of the target (resolution key)
    target_path     text,                 -- cleaned relative path, for md links / path-style wikilinks
    primary key (src_document_id, raw_target)
);

create index document_links_dst on document_links (dst_document_id)
    where dst_document_id is not null;
-- Re-resolution when a new document appears: match pending targets by slug in one update.
create index document_links_unresolved_slug on document_links (target_slug)
    where dst_document_id is null;
