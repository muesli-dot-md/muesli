//! Text-diff computation for out-of-band ingest (internal/design/ingest-and-materialization.md):
//! line-level diff via `similar` (Myers + semantic post-processing), with changed regions
//! refined to character level so small intra-line edits don't replace whole lines.

use similar::{ChangeTag, TextDiff};

/// One edit against the *base* text: delete `old_len` bytes at `start`, then insert `insert`.
/// `start`/`old_len` are UTF-8 byte offsets into the base (always on char boundaries).
/// Edits are returned in ascending, non-overlapping order; apply them in reverse.
#[derive(Debug, PartialEq, Eq)]
pub struct Edit {
    pub start: usize,
    pub old_len: usize,
    pub insert: String,
}

/// Compute the edits turning `base` into `new`.
pub fn compute_edits(base: &str, new: &str) -> Vec<Edit> {
    let mut edits = Vec::new();
    let line_diff = TextDiff::from_lines(base, new);
    for block in grouped_blocks(&line_diff) {
        if block.old_len > 0 && !block.insert.is_empty() {
            // A replaced region: refine to character level within it.
            let old_slice = &base[block.start..block.start + block.old_len];
            let char_diff = TextDiff::from_chars(old_slice, block.insert.as_str());
            for mut sub in grouped_blocks(&char_diff) {
                sub.start += block.start;
                edits.push(sub.into_edit());
            }
        } else {
            edits.push(block.into_edit());
        }
    }
    edits
}

struct Block {
    start: usize,
    old_len: usize,
    insert: String,
}

impl Block {
    fn into_edit(self) -> Edit {
        Edit {
            start: self.start,
            old_len: self.old_len,
            insert: self.insert,
        }
    }
}

/// Walk a diff's changes in order, grouping contiguous delete/insert runs (separated by
/// unchanged stretches) into blocks positioned by byte offset in the old text.
fn grouped_blocks<'a>(diff: &TextDiff<'a, 'a, '_, str>) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut old_pos = 0usize;
    let mut current: Option<Block> = None;

    for change in diff.iter_all_changes() {
        let v = change.value();
        match change.tag() {
            ChangeTag::Equal => {
                if let Some(b) = current.take() {
                    blocks.push(b);
                }
                old_pos += v.len();
            }
            ChangeTag::Delete => {
                let b = current.get_or_insert_with(|| Block {
                    start: old_pos,
                    old_len: 0,
                    insert: String::new(),
                });
                b.old_len += v.len();
                old_pos += v.len();
            }
            ChangeTag::Insert => {
                let b = current.get_or_insert_with(|| Block {
                    start: old_pos,
                    old_len: 0,
                    insert: String::new(),
                });
                b.insert.push_str(v);
            }
        }
    }
    if let Some(b) = current.take() {
        blocks.push(b);
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(base: &str, edits: &[Edit]) -> String {
        let mut s = base.to_string();
        for e in edits.iter().rev() {
            s.replace_range(e.start..e.start + e.old_len, &e.insert);
        }
        s
    }

    #[test]
    fn edits_reproduce_target() {
        let cases = [
            ("abc", "abc"),
            ("abc", "axc"),
            ("hello world\n", "hello brave world\n"),
            ("l1\nl2\nl3\n", "l1\nl3\n"),
            ("l1\nl3\n", "l1\nl2\nl3\n"),
            ("", "non-empty\n"),
            ("non-empty\n", ""),
            ("tab\there\n", "tab\tthere\n"),
            ("🥣🥣🥣\n", "🥣🌍🥣\n"),
        ];
        for (base, new) in cases {
            let edits = compute_edits(base, new);
            assert_eq!(apply(base, &edits), new, "base={base:?} new={new:?}");
        }
    }

    #[test]
    fn intra_line_edit_is_char_precise() {
        let base = "The quick brown fox jumps over the lazy dog.\n";
        let new = "The quick red fox jumps over the lazy dog.\n";
        let edits = compute_edits(base, new);
        let touched: usize = edits.iter().map(|e| e.old_len + e.insert.len()).sum();
        assert!(
            touched < 12,
            "expected char-level refinement, touched {touched} bytes: {edits:?}"
        );
        assert_eq!(apply(base, &edits), new);
    }
}
