use std::fs;
use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::audio::Source;

/// One speaker turn: a run of consecutive finals from the same source, merged
/// into a single block. A new turn starts when the other speaker takes over.
struct Turn {
    source: Source,
    t0: f64,
    text: String,
}

/// Writes a Granola-style meeting transcript: consecutive utterances from the
/// same speaker collapse into one block; a new block begins on speaker change.
/// The whole (small) file is re-rendered on each final so it stays correct and
/// readable mid-meeting.
pub struct MarkdownSink {
    file: File,
    path: PathBuf,
    started: String,
    turns: Vec<Turn>,
}

impl MarkdownSink {
    pub fn create_in(dir: &Path, started: &str) -> Result<MarkdownSink> {
        fs::create_dir_all(dir)?;
        let path = dir.join(format!("meeting-{started}.md"));
        let file = File::create(&path)?;
        let mut sink = MarkdownSink {
            file,
            path,
            started: started.to_string(),
            turns: Vec::new(),
        };
        sink.render()?; // write the header immediately
        Ok(sink)
    }

    /// Add a finalized utterance. Merges into the current speaker's block if the
    /// previous turn was the same source; otherwise starts a new block.
    pub fn append_final(&mut self, source: Source, text: &str, t0_secs: f64) -> Result<()> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(());
        }
        match self.turns.last_mut() {
            Some(turn) if turn.source == source => {
                turn.text.push(' ');
                turn.text.push_str(text);
            }
            _ => self.turns.push(Turn {
                source,
                t0: t0_secs,
                text: text.to_string(),
            }),
        }
        self.render()
    }

    fn render(&mut self) -> Result<()> {
        let mut out = format!("# Meeting \u{2014} {}\n\n", self.started);
        for turn in &self.turns {
            let s = turn.t0 as u64;
            let mmss = format!("{:02}:{:02}", s / 60, s % 60);
            let label = match turn.source {
                Source::Me => "You",
                Source::Them => "Them",
            };
            out.push_str(&format!("**{label}** \u{2014} {mmss}\n{}\n\n", turn.text));
        }
        self.file.seek(SeekFrom::Start(0))?;
        self.file.set_len(0)?;
        self.file.write_all(out.as_bytes())?;
        self.file.flush()?;
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::Source;

    #[test]
    fn writes_header() {
        let dir = tempfile::tempdir().unwrap();
        let sink = MarkdownSink::create_in(dir.path(), "2026-06-23-1432").unwrap();
        let body = std::fs::read_to_string(sink.path()).unwrap();
        assert!(body.starts_with("# Meeting \u{2014} 2026-06-23-1432\n"));
    }

    #[test]
    fn groups_consecutive_same_speaker_into_one_block() {
        let dir = tempfile::tempdir().unwrap();
        let mut sink = MarkdownSink::create_in(dir.path(), "2026-06-23-1432").unwrap();
        sink.append_final(Source::Them, "Hi everyone.", 1.0)
            .unwrap();
        sink.append_final(Source::Me, "Hello.", 6.0).unwrap();
        sink.append_final(Source::Me, "How are you?", 9.0).unwrap();
        let body = std::fs::read_to_string(sink.path()).unwrap();

        // Them block, then a single merged You block (first t0 wins).
        assert!(body.contains("**Them** \u{2014} 00:01\nHi everyone.\n"));
        assert!(body.contains("**You** \u{2014} 00:06\nHello. How are you?\n"));
        // The two Me finals merged — exactly one "You" header.
        assert_eq!(
            body.matches("**You**").count(),
            1,
            "consecutive same-speaker must merge"
        );
    }

    #[test]
    fn speaker_change_starts_a_new_block() {
        let dir = tempfile::tempdir().unwrap();
        let mut sink = MarkdownSink::create_in(dir.path(), "2026-06-23-1432").unwrap();
        sink.append_final(Source::Me, "First.", 0.0).unwrap();
        sink.append_final(Source::Them, "Second.", 2.0).unwrap();
        sink.append_final(Source::Me, "Third.", 4.0).unwrap();
        let body = std::fs::read_to_string(sink.path()).unwrap();
        // Three distinct blocks in order.
        assert_eq!(body.matches("**You**").count(), 2);
        assert_eq!(body.matches("**Them**").count(), 1);
        let you1 = body.find("First.").unwrap();
        let them = body.find("Second.").unwrap();
        let you2 = body.find("Third.").unwrap();
        assert!(you1 < them && them < you2, "blocks preserve arrival order");
    }

    #[test]
    fn empty_finals_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let mut sink = MarkdownSink::create_in(dir.path(), "2026-06-23-1432").unwrap();
        sink.append_final(Source::Me, "   ", 1.0).unwrap();
        let body = std::fs::read_to_string(sink.path()).unwrap();
        assert!(!body.contains("**You**"));
    }
}
