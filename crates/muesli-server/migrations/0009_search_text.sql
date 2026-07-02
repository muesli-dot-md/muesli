-- Server-side search (GET /api/search): a per-document text projection kept by the link
-- indexer (links.rs reindex — the same debounced mark_dirty seam as document_links), so
-- content search never replays CRDT logs at query time. Backfill is lazy: a document
-- without a row simply doesn't content-match yet (title search still finds it); room
-- hydration queues a projection for rows that predate this table.

create table document_texts (
    document_id  uuid primary key references documents (id) on delete cascade,
    text         text not null,
    -- 'simple' config: no stemming surprises, multibyte tokens kept verbatim. Short or
    -- partial tokens that FTS can't match fall back to ILIKE in the search query. left()
    -- keeps pathological documents under the tsvector size limit.
    tsv          tsvector generated always as (to_tsvector('simple', left(text, 400000))) stored,
    updated_at   timestamptz not null default now()
);
create index document_texts_tsv on document_texts using gin (tsv);
