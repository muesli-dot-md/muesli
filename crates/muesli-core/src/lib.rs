//! Muesli core document engine (ADR 0004/0016): a text CRDT (`yrs`, ADR 0005) that models the
//! raw markdown source (ADR 0003). The CRDT is the live authority; the `.md` is its
//! materialized projection (ADR 0001). Ingest merges external file edits back in as a text
//! diff (see docs/design/ingest-and-materialization.md).

mod anchor;
mod ingest;
pub mod events;
pub mod protocol;

pub use anchor::Anchor;
pub use ingest::{compute_edits, Edit};

use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{
    Assoc, Doc, GetString, IndexedSequence, OffsetKind, Options, ReadTxn, StateVector, Text,
    TextRef, Transact, Update,
};

/// The CRDT root holding the markdown source text.
pub const TEXT_ROOT: &str = "content";

/// Fraction of the document that must change before an ingest is reported as a wholesale
/// replacement (docs/design/ingest-and-materialization.md).
pub const WHOLESALE_THRESHOLD: f64 = 0.8;

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("crdt decode/apply error: {0}")]
    Crdt(String),
    #[error("anchor error: {0}")]
    Anchor(String),
    #[error("edit error: {0}")]
    Edit(String),
}

#[derive(Debug, PartialEq, Eq)]
pub enum IngestOutcome {
    /// The on-disk text already matches the CRDT (the materialize→ingest echo loop guard).
    NoOp,
    /// A fine-grained diff was merged.
    Applied { inserted: usize, deleted: usize },
    /// More than [`WHOLESALE_THRESHOLD`] of the document changed; merged as one coarse edit.
    WholesaleReplace,
}

/// A Muesli Document: a yrs Doc with one text root, plus the materialize/ingest pair.
///
/// The public API speaks UTF-8 **byte** offsets (diff byte ranges map 1:1 onto them), but
/// the yrs Doc runs with `OffsetKind::Utf16` and every index is converted at this boundary.
/// UTF-16 is the only offset kind that is consistent with yrs block clock units (clock
/// lengths are always `content.len(OffsetKind::Utf16)`), and `StickyIndex::at`/`get_offset`
/// mix clock units with `offset_kind` units internally — with `OffsetKind::Bytes` anchors
/// silently corrupt on any document containing multi-byte characters.
pub struct MuesliDoc {
    doc: Doc,
    text: TextRef,
}

/// UTF-16 code-unit offset of byte index `byte_idx` in `text` (caller guarantees it is a
/// char boundary; out-of-range clamps to the end).
fn utf16_at(text: &str, byte_idx: usize) -> u32 {
    let end = byte_idx.min(text.len());
    text[..end].encode_utf16().count() as u32
}

/// Byte offset of UTF-16 code-unit index `utf16_idx` in `text`. Indices inside a surrogate
/// pair round down to the character start; past-the-end clamps to `text.len()`.
fn byte_at_utf16(text: &str, utf16_idx: u32) -> usize {
    if utf16_idx == 0 {
        return 0;
    }
    let mut units = 0u32;
    for (byte, ch) in text.char_indices() {
        if units >= utf16_idx {
            return byte;
        }
        units += ch.len_utf16() as u32;
    }
    text.len()
}

impl MuesliDoc {
    pub fn new() -> Self {
        let doc = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        let text = doc.get_or_insert_text(TEXT_ROOT);
        Self { doc, text }
    }

    pub fn with_text(initial: &str) -> Self {
        let this = Self::new();
        if !initial.is_empty() {
            let mut txn = this.doc.transact_mut();
            this.text.insert(&mut txn, 0, initial);
        }
        this
    }

    /// CRDT → markdown string (the materialization read; writing to storage is the caller's job).
    pub fn materialize(&self) -> String {
        let txn = self.doc.transact();
        self.text.get_string(&txn)
    }

    /// Merge an externally rewritten `.md` into the CRDT as a text diff
    /// (docs/design/ingest-and-materialization.md). Caller is responsible for the hash-based
    /// loop guard against our own materializations; identical text is a no-op here too.
    pub fn ingest(&self, new_text: &str) -> IngestOutcome {
        let base = self.materialize();
        if base == new_text {
            return IngestOutcome::NoOp;
        }
        let edits = compute_edits(&base, new_text);
        let (mut inserted, mut deleted) = (0usize, 0usize);
        {
            let mut txn = self.doc.transact_mut();
            // Apply in reverse so earlier offsets stay valid; reverse order also means the
            // text before each edit is still `base`, so byte→UTF-16 conversion against
            // `base` is exact.
            for e in edits.iter().rev() {
                let s16 = utf16_at(&base, e.start);
                if e.old_len > 0 {
                    let old16 = utf16_at(&base, e.start + e.old_len) - s16;
                    self.text.remove_range(&mut txn, s16, old16);
                    deleted += e.old_len;
                }
                if !e.insert.is_empty() {
                    self.text.insert(&mut txn, s16, &e.insert);
                    inserted += e.insert.len();
                }
            }
        }
        debug_assert_eq!(self.materialize(), new_text);
        let changed = (inserted + deleted) as f64;
        let size = base.len().max(new_text.len()).max(1) as f64;
        if changed / size > WHOLESALE_THRESHOLD {
            IngestOutcome::WholesaleReplace
        } else {
            IngestOutcome::Applied { inserted, deleted }
        }
    }

    /// This doc's state vector (for y-sync step 1), v1-encoded.
    pub fn state_vector(&self) -> Vec<u8> {
        self.doc.transact().state_vector().encode_v1()
    }

    /// Update containing everything the remote (per its state vector) is missing (step 2).
    pub fn diff_update(&self, remote_state_vector: &[u8]) -> Result<Vec<u8>, CoreError> {
        let sv = StateVector::decode_v1(remote_state_vector).map_err(|e| CoreError::Crdt(e.to_string()))?;
        Ok(self.doc.transact().encode_diff_v1(&sv))
    }

    /// The full document state as a single update.
    pub fn encode_full_update(&self) -> Vec<u8> {
        self.doc.transact().encode_diff_v1(&StateVector::default())
    }

    /// Apply a v1-encoded update received from a peer.
    pub fn apply_update(&self, update: &[u8]) -> Result<(), CoreError> {
        let update = Update::decode_v1(update).map_err(|e| CoreError::Crdt(e.to_string()))?;
        let mut txn = self.doc.transact_mut();
        txn.apply_update(update).map_err(|e| CoreError::Crdt(e.to_string()))
    }

    /// Apply a peer update and report whether it changed the document. The check compares
    /// yrs snapshots (state vector + delete set): a state vector alone misses delete-only
    /// updates, which advance no client clock.
    pub fn apply_update_changed(&self, update: &[u8]) -> Result<bool, CoreError> {
        let update = Update::decode_v1(update).map_err(|e| CoreError::Crdt(e.to_string()))?;
        let before = self.doc.transact().snapshot();
        {
            let mut txn = self.doc.transact_mut();
            txn.apply_update(update).map_err(|e| CoreError::Crdt(e.to_string()))?;
        }
        Ok(self.doc.transact().snapshot() != before)
    }

    // -----------------------------------------------------------------------
    // Anchors & attributed edits (ADR 0019 / 0007)
    // -----------------------------------------------------------------------

    /// Pin the byte range `[start, end)` with sticky indices: `Assoc::After` for the start
    /// (sticks with the first anchored character) and `Assoc::Before` for the end (sticks
    /// with the last). At end-of-text there is no right neighbour for `After`, so the start
    /// falls back to `Before`.
    pub fn create_anchor(&self, start: usize, end: usize) -> Result<Anchor, CoreError> {
        let current = self.materialize();
        if start > end || end > current.len() {
            return Err(CoreError::Anchor(format!(
                "range {start}..{end} out of bounds (len {})",
                current.len()
            )));
        }
        if !current.is_char_boundary(start) || !current.is_char_boundary(end) {
            return Err(CoreError::Anchor(format!("range {start}..{end} splits a character")));
        }
        let start16 = utf16_at(&current, start);
        let end16 = utf16_at(&current, end);
        let mut txn = self.doc.transact_mut();
        let s = self
            .text
            .sticky_index(&mut txn, start16, Assoc::After)
            .or_else(|| self.text.sticky_index(&mut txn, start16, Assoc::Before))
            .ok_or_else(|| CoreError::Anchor("cannot pin start".into()))?;
        let e = self
            .text
            .sticky_index(&mut txn, end16, Assoc::Before)
            .ok_or_else(|| CoreError::Anchor("cannot pin end".into()))?;
        Ok(Anchor { start: s, end: e })
    }

    /// Current byte range of an anchor. `None` = unresolvable in this doc; a collapsed
    /// range (start == end) means the anchored text is gone (orphaned, ADR 0019).
    pub fn resolve_anchor(&self, anchor: &Anchor) -> Option<(usize, usize)> {
        let (s16, e16) = {
            let txn = self.doc.transact();
            (
                anchor.start.get_offset(&txn)?.index,
                anchor.end.get_offset(&txn)?.index,
            )
        };
        let current = self.materialize();
        let s = byte_at_utf16(&current, s16);
        let e = byte_at_utf16(&current, e16);
        Some((s, e.max(s)))
    }

    /// Apply `(start, end, replacement)` byte-range edits in ONE transaction — one update,
    /// one atomic change set (ADR 0007). Ops must be sorted ascending by start and
    /// non-overlapping. Returns the v1 update covering exactly this transaction (for
    /// persistence + broadcast); applies nothing on error.
    pub fn apply_edits(&self, ops: &[(usize, usize, String)]) -> Result<Vec<u8>, CoreError> {
        let current = self.materialize();
        let mut prev_end = 0usize;
        for (i, (start, end, _)) in ops.iter().enumerate() {
            if start > end || *end > current.len() {
                return Err(CoreError::Edit(format!(
                    "op {i}: range {start}..{end} out of bounds (len {})",
                    current.len()
                )));
            }
            if i > 0 && *start < prev_end {
                return Err(CoreError::Edit(format!("op {i}: overlaps the previous op")));
            }
            if !current.is_char_boundary(*start) || !current.is_char_boundary(*end) {
                return Err(CoreError::Edit(format!("op {i}: range splits a character")));
            }
            prev_end = *end;
        }
        let before = {
            let txn = self.doc.transact();
            txn.state_vector()
        };
        {
            // Apply in reverse so earlier offsets stay valid (and byte→UTF-16 conversion
            // against the pre-edit text stays exact); one transact_mut = one update.
            let mut txn = self.doc.transact_mut();
            for (start, end, insert) in ops.iter().rev() {
                let s16 = utf16_at(&current, *start);
                if end > start {
                    let len16 = utf16_at(&current, *end) - s16;
                    self.text.remove_range(&mut txn, s16, len16);
                }
                if !insert.is_empty() {
                    self.text.insert(&mut txn, s16, insert);
                }
            }
        }
        Ok(self.doc.transact().encode_diff_v1(&before))
    }
}

impl Default for MuesliDoc {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let md = "# Title\n\nSome *markdown* with a [[wikilink]] and emoji 🥣.\n";
        let doc = MuesliDoc::with_text(md);
        assert_eq!(doc.materialize(), md);
    }

    #[test]
    fn ingest_identical_is_noop() {
        let doc = MuesliDoc::with_text("hello\nworld\n");
        assert_eq!(doc.ingest("hello\nworld\n"), IngestOutcome::NoOp);
        assert_eq!(doc.materialize(), "hello\nworld\n");
    }

    #[test]
    fn ingest_small_edit_lands_exactly() {
        let doc = MuesliDoc::with_text("# CLAUDE.md\n\nUse pnpm for installs.\nRun tests before commits.\n");
        let new = "# CLAUDE.md\n\nUse pnpm v10 for installs.\nRun tests before commits.\n";
        let out = doc.ingest(new);
        assert_eq!(doc.materialize(), new);
        match out {
            IngestOutcome::Applied { inserted, deleted } => {
                // char-level refinement: only the changed words, not whole lines
                assert!(inserted <= 8, "inserted {inserted} bytes, expected a small refined edit");
                assert!(deleted <= 4, "deleted {deleted} bytes, expected a small refined edit");
            }
            other => panic!("expected Applied, got {other:?}"),
        }
    }

    #[test]
    fn ingest_handles_unicode_and_crlf() {
        let cases = [
            ("héllo 🥣 wörld\n", "héllo 🌍 wörld\n"),
            ("a\r\nb\r\nc\r\n", "a\r\nB!\r\nc\r\n"),
            ("", "fresh content\n"),
            ("everything goes away\n", ""),
            ("line1\nline2\n", "line1\ninserted\nline2\n"),
        ];
        for (base, new) in cases {
            let doc = MuesliDoc::with_text(base);
            doc.ingest(new);
            assert_eq!(doc.materialize(), new, "base={base:?}");
        }
    }

    #[test]
    fn wholesale_replace_detected() {
        let doc = MuesliDoc::with_text("completely original text\n");
        let out = doc.ingest("nothing in common whatsoever here\n");
        assert_eq!(out, IngestOutcome::WholesaleReplace);
        assert_eq!(doc.materialize(), "nothing in common whatsoever here\n");
    }

    #[test]
    fn delete_only_updates_report_changed() {
        // Regression: a deletion advances no client clock, so a state-vector comparison
        // calls it a no-op and it never gets persisted.
        let a = MuesliDoc::with_text("delete me\n");
        let b = MuesliDoc::new();
        b.apply_update(&a.encode_full_update()).unwrap();
        a.ingest("me\n"); // pure deletion
        let delta = a.diff_update(&b.state_vector()).unwrap();
        assert!(b.apply_update_changed(&delta).unwrap(), "delete-only update must count as a change");
        assert_eq!(b.materialize(), "me\n");
        // And replaying the same update again is a no-op.
        assert!(!b.apply_update_changed(&delta).unwrap());
    }

    #[test]
    fn anchor_json_round_trip() {
        let doc = MuesliDoc::with_text("hello brave world\n");
        let anchor = doc.create_anchor(6, 11).unwrap(); // "brave"
        let json = anchor.to_json();
        assert_eq!(json["v"], 1);
        let back = Anchor::from_json(&json).unwrap();
        assert_eq!(back, anchor);
        assert_eq!(doc.resolve_anchor(&back), Some((6, 11)));
    }

    #[test]
    fn anchor_rides_along_edits() {
        let doc = MuesliDoc::with_text("hello brave world\n");
        let anchor = doc.create_anchor(6, 11).unwrap(); // "brave"
        doc.ingest("PREFIX hello brave world\n");
        let (s, e) = doc.resolve_anchor(&anchor).unwrap();
        assert_eq!(&doc.materialize()[s..e], "brave");
        // Edit inside the doc after the anchor: range unchanged.
        doc.ingest("PREFIX hello brave new world\n");
        let (s, e) = doc.resolve_anchor(&anchor).unwrap();
        assert_eq!(&doc.materialize()[s..e], "brave");
    }

    #[test]
    fn anchor_collapses_when_text_deleted() {
        let doc = MuesliDoc::with_text("hello brave world\n");
        let anchor = doc.create_anchor(6, 12).unwrap(); // "brave "
        doc.ingest("hello world\n");
        let (s, e) = doc.resolve_anchor(&anchor).unwrap();
        assert_eq!(s, e, "deleted span must resolve collapsed, got {s}..{e}");
    }

    #[test]
    fn anchor_survives_serialization_across_edits() {
        let doc = MuesliDoc::with_text("héllo 🥣 brave wörld\n");
        let text = doc.materialize();
        let start = text.find("brave").unwrap();
        let json = doc.create_anchor(start, start + 5).unwrap().to_json();
        doc.ingest("zzz héllo 🥣 brave wörld zzz\n");
        let anchor = Anchor::from_json(&json).unwrap();
        let (s, e) = doc.resolve_anchor(&anchor).unwrap();
        assert_eq!(&doc.materialize()[s..e], "brave");
    }

    #[test]
    fn anchor_at_document_edges() {
        let doc = MuesliDoc::with_text("abc");
        let whole = doc.create_anchor(0, 3).unwrap();
        assert_eq!(doc.resolve_anchor(&whole), Some((0, 3)));
        let point_at_end = doc.create_anchor(3, 3).unwrap();
        assert_eq!(doc.resolve_anchor(&point_at_end), Some((3, 3)));
        let empty = MuesliDoc::new();
        let zero = empty.create_anchor(0, 0).unwrap();
        assert_eq!(empty.resolve_anchor(&zero), Some((0, 0)));
    }

    // Regression (web-UI agent finding): with OffsetKind::Bytes, yrs sticky indices mixed
    // clock units (always UTF-16) with byte offsets — anchors whose byte offset exceeded the
    // block's UTF-16 length failed to create, and multi-block docs resolved to garbage. The
    // doc now runs UTF-16 internally; these pin the byte-API behaviour on multi-byte text.
    #[test]
    fn anchor_after_multibyte_in_same_block() {
        let doc = MuesliDoc::with_text("a☕b Keep intact\n");
        let text = doc.materialize();
        let start = text.find("intact").unwrap(); // byte 11, utf16 9
        let anchor = doc.create_anchor(start, start + 6).unwrap();
        let (s, e) = doc.resolve_anchor(&anchor).unwrap();
        assert_eq!(&text[s..e], "intact");
        // ...and the end-of-text byte index (18) exceeds the UTF-16 length (16).
        let tail = doc.create_anchor(start, text.len()).unwrap();
        let (s, e) = doc.resolve_anchor(&tail).unwrap();
        assert_eq!(&text[s..e], "intact\n");
    }

    #[test]
    fn anchor_rides_along_multibyte_edits_across_blocks() {
        let doc = MuesliDoc::with_text("a☕b Keep intact\n");
        let start = doc.materialize().find("intact").unwrap();
        let anchor = doc.create_anchor(start, start + 6).unwrap();
        doc.ingest("🥣🥣 a☕b Keep intact\n"); // multibyte insert before, new block
        let (s, e) = doc.resolve_anchor(&anchor).unwrap();
        assert_eq!(&doc.materialize()[s..e], "intact");
        doc.ingest("🥣🥣 a☕b Keep intact — naïve café\n"); // multibyte after
        let (s, e) = doc.resolve_anchor(&anchor).unwrap();
        assert_eq!(&doc.materialize()[s..e], "intact");
    }

    #[test]
    fn apply_edits_with_multibyte_text() {
        let doc = MuesliDoc::with_text("Hällo wörld ☕\n");
        let text = doc.materialize();
        let (ws, we) = (text.find("wörld").unwrap(), text.find("wörld").unwrap() + "wörld".len());
        doc.apply_edits(&[(0, "Hällo".len(), "Hello 🌍".into()), (ws, we, "world".into())]).unwrap();
        assert_eq!(doc.materialize(), "Hello 🌍 world ☕\n");
    }

    #[test]
    fn apply_edits_is_one_atomic_update() {
        let doc = MuesliDoc::with_text("alpha beta gamma\n");
        let update = doc
            .apply_edits(&[
                (0, 5, "ALPHA".into()),
                (11, 16, "GAMMA".into()),
            ])
            .unwrap();
        assert_eq!(doc.materialize(), "ALPHA beta GAMMA\n");
        // The single update brings a fresh replica fully up to date.
        let replica = MuesliDoc::with_text("");
        replica.apply_update(&doc.encode_full_update()).unwrap();
        assert_eq!(replica.materialize(), "ALPHA beta GAMMA\n");
        assert!(!update.is_empty());
    }

    #[test]
    fn apply_edits_rejects_bad_ops() {
        let doc = MuesliDoc::with_text("hello 🥣 world\n");
        // out of bounds
        assert!(doc.apply_edits(&[(0, 999, "x".into())]).is_err());
        // overlapping
        assert!(doc.apply_edits(&[(0, 5, "a".into()), (3, 8, "b".into())]).is_err());
        // splits the emoji (bytes 6..10)
        assert!(doc.apply_edits(&[(7, 8, "x".into())]).is_err());
        // nothing was applied
        assert_eq!(doc.materialize(), "hello 🥣 world\n");
    }

    #[test]
    fn concurrent_edits_converge() {
        let a = MuesliDoc::with_text("shared base\n");
        let b = MuesliDoc::new();
        b.apply_update(&a.encode_full_update()).unwrap();

        // Concurrent, divergent edits on each side.
        a.ingest("A's edit\nshared base\n");
        b.ingest("shared base\nB's edit\n");

        // Exchange deltas both ways.
        let to_b = a.diff_update(&b.state_vector()).unwrap();
        let to_a = b.diff_update(&a.state_vector()).unwrap();
        b.apply_update(&to_b).unwrap();
        a.apply_update(&to_a).unwrap();

        assert_eq!(a.materialize(), b.materialize());
        let merged = a.materialize();
        assert!(merged.contains("A's edit") && merged.contains("B's edit"));
    }
}
