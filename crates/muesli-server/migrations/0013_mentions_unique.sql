-- @mentions idempotency (sub-project ④b review fix, prerequisite for ④c).
-- record_mentions claimed idempotency ("one row per distinct recipient") but had no unique
-- constraint to back an ON CONFLICT — a re-parse of the same stored comment (retry, or the
-- ④c enqueue re-running) would double-insert. A (recipient_id, comment_id) is unique by
-- construction (the parser dedups recipients within one body), so make the database enforce
-- it. Existing duplicates would block this; in practice mentions has no duplicate rows yet,
-- and dedup-before-constraint is unnecessary for a not-yet-live feature.
alter table mentions add constraint mentions_recipient_comment_unique
    unique (recipient_id, comment_id);
