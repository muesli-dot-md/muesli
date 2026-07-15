#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VadEvent {
    Silence,
    SpeechStarted,
    /// Advisory soft pause: a shorter-than-`SpeechEnded` silence used to finalize
    /// long run-on utterances at a sentence boundary. Does not change gate state.
    /// Internal only — never crosses the Tauri boundary.
    SpeechPaused,
    Speaking,
    SpeechEnded,
}

pub trait Vad: Send {
    fn accept(&mut self, samples: &[f32]) -> VadEvent;
}

// ---------------------------------------------------------------------------
// SpeechGate — pure hysteresis state machine, no model dependency
// ---------------------------------------------------------------------------

/// Tracks speech/silence state from per-chunk probability scores.
///
/// Uses dual-threshold hysteresis (the Silero scheme): a chunk must exceed
/// `enter_threshold` to *start* speech, but only `exit_threshold`
/// (= `enter - 0.15`) to *stay* in speech. This prevents mid-word probability
/// dips (vowel tails, soft consonants) from prematurely ending an utterance.
///
/// Parameters:
/// - `enter_threshold`: probability to begin speech (default ~0.5)
/// - `exit_threshold`: probability to remain in speech (`enter - 0.15`, ~0.35)
/// - `onset_chunks`: consecutive speech chunks required before `SpeechStarted` fires
/// - `end_chunks`: consecutive silence chunks required after speech before `SpeechEnded` fires
#[derive(Debug)]
pub struct SpeechGate {
    enter_threshold: f32,
    exit_threshold: f32,
    onset_chunks: u32,
    end_chunks: u32,
    /// Silence chunks after which an advisory `SpeechPaused` fires (once per run).
    /// `None` disables the soft pause — the default via `new`.
    soft_end_chunks: Option<u32>,

    in_speech: bool,
    speech_run: u32,
    silence_run: u32,
    /// Whether `SpeechPaused` has already fired for the current silence run.
    soft_pause_emitted: bool,
}

impl SpeechGate {
    pub fn new(threshold: f32, onset_chunks: u32, end_chunks: u32) -> Self {
        Self {
            enter_threshold: threshold,
            exit_threshold: (threshold - 0.15).max(0.01),
            onset_chunks,
            end_chunks,
            soft_end_chunks: None,
            in_speech: false,
            speech_run: 0,
            silence_run: 0,
            soft_pause_emitted: false,
        }
    }

    /// Like `new`, but enables an advisory `SpeechPaused` after `soft_end_chunks`
    /// consecutive silence chunks (must be `< end_chunks`), used to split long
    /// run-on utterances at a sentence boundary.
    pub fn with_soft_end(
        threshold: f32,
        onset_chunks: u32,
        soft_end_chunks: u32,
        end_chunks: u32,
    ) -> Self {
        debug_assert!(
            soft_end_chunks < end_chunks,
            "soft end must precede hard end"
        );
        let mut g = Self::new(threshold, onset_chunks, end_chunks);
        g.soft_end_chunks = Some(soft_end_chunks);
        g
    }

    /// Feed one probability score and return the resulting `VadEvent`.
    pub fn update(&mut self, prob: f32) -> VadEvent {
        // Hysteresis: harder to enter speech than to stay in it.
        let active = if self.in_speech {
            prob >= self.exit_threshold
        } else {
            prob >= self.enter_threshold
        };
        if active {
            self.silence_run = 0;
            self.soft_pause_emitted = false;
            self.speech_run += 1;

            if !self.in_speech && self.speech_run >= self.onset_chunks {
                self.in_speech = true;
                VadEvent::SpeechStarted
            } else if self.in_speech {
                VadEvent::Speaking
            } else {
                VadEvent::Silence
            }
        } else {
            self.speech_run = 0;
            if self.in_speech {
                self.silence_run += 1;
                if self.silence_run >= self.end_chunks {
                    self.in_speech = false;
                    self.silence_run = 0;
                    self.soft_pause_emitted = false;
                    VadEvent::SpeechEnded
                } else if self
                    .soft_end_chunks
                    .is_some_and(|soft| !self.soft_pause_emitted && self.silence_run >= soft)
                {
                    self.soft_pause_emitted = true;
                    VadEvent::SpeechPaused
                } else {
                    VadEvent::Speaking
                }
            } else {
                self.silence_run = 0;
                VadEvent::Silence
            }
        }
    }
}

/// Fold two per-chunk gate events into one, so a whole `accept()` call collapses
/// to a single `VadEvent`. Priority: SpeechStarted > SpeechEnded > SpeechPaused >
/// Speaking > Silence. SpeechPaused is ranked explicitly ABOVE Speaking so a soft
/// pause fired mid-call (typically `[Speaking, SpeechPaused, Speaking]`) is not
/// masked by a later Speaking chunk, and BELOW SpeechEnded so a hard end in the
/// same call still finalizes the whole buffer.
fn collapse(acc: VadEvent, next: VadEvent) -> VadEvent {
    match (acc, next) {
        (_, VadEvent::SpeechStarted) | (VadEvent::SpeechStarted, _) => VadEvent::SpeechStarted,
        (_, VadEvent::SpeechEnded) | (VadEvent::SpeechEnded, _) => VadEvent::SpeechEnded,
        (_, VadEvent::SpeechPaused) | (VadEvent::SpeechPaused, _) => VadEvent::SpeechPaused,
        (_, VadEvent::Speaking) => VadEvent::Speaking,
        (other, _) => other,
    }
}

// ---------------------------------------------------------------------------
// SileroVad — real model backed by voice_activity_detector crate
// ---------------------------------------------------------------------------

use voice_activity_detector::VoiceActivityDetector;

const SAMPLE_RATE: i64 = 16_000;
const CHUNK_SIZE: usize = 512;

/// VAD backed by the bundled Silero ONNX model.
pub struct SileroVad {
    detector: VoiceActivityDetector,
    gate: SpeechGate,
    buffer: Vec<f32>,
}

impl SileroVad {
    /// Construct a new `SileroVad`. Loads the ONNX model on first call (shared).
    pub fn new() -> anyhow::Result<Self> {
        let detector = VoiceActivityDetector::builder()
            .chunk_size(CHUNK_SIZE)
            .sample_rate(SAMPLE_RATE)
            .build()
            .map_err(|e| anyhow::anyhow!("VAD build error: {e}"))?;

        Ok(Self {
            detector,
            // enter 0.5 / stay 0.35 (hysteresis), onset 2 chunks (~64ms),
            // soft pause after 18 silence chunks (~576ms) to split run-on
            // utterances at a sentence boundary, hard end after 38 chunks (~1.2s).
            // The soft pause only ever fires before the hard end, never races it.
            gate: SpeechGate::with_soft_end(0.5, 2, 18, 38),
            buffer: Vec::with_capacity(CHUNK_SIZE * 4),
        })
    }
}

impl Vad for SileroVad {
    /// Accept arbitrary-length audio frames.
    ///
    /// Internally buffers input into 512-sample chunks. Sub-chunk frames are buffered
    /// and returns `Silence` until a full chunk accumulates. Leftover samples persist
    /// between calls and will be processed when the next frame completes the chunk.
    fn accept(&mut self, samples: &[f32]) -> VadEvent {
        self.buffer.extend_from_slice(samples);

        let mut last_event = VadEvent::Silence;
        let mut chunks_this_call = 0u32;

        while self.buffer.len() >= CHUNK_SIZE {
            let chunk: Vec<f32> = self.buffer.drain(..CHUNK_SIZE).collect();
            let prob = self.detector.predict(chunk);
            let event = self.gate.update(prob);
            chunks_this_call += 1;

            // A single accept() call is expected to span fewer than (onset_chunks + end_chunks)
            // = ~21 chunks, so it cannot span a full speech→silence cycle. Real audio frames are
            // ~100ms (~3 chunks); a frame larger than ~2s would be anomalous.
            debug_assert!(
                chunks_this_call < 64,
                "single accept() call processed {} chunks; an audio frame >~2s is anomalous",
                chunks_this_call
            );

            last_event = collapse(last_event, event);
        }

        last_event
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------
    // SpeechGate unit tests — deterministic, no model needed
    // ------------------------------------------------------------------

    mod speech_gate {
        use super::*;

        fn gate() -> SpeechGate {
            // onset=2, end=3 for fast-cycling tests
            SpeechGate::new(0.5, 2, 3)
        }

        #[test]
        fn all_silence_stays_silent() {
            let mut g = gate();
            for _ in 0..20 {
                assert_eq!(g.update(0.1), VadEvent::Silence);
            }
        }

        #[test]
        fn single_high_prob_does_not_trigger_onset() {
            let mut g = gate();
            // onset_chunks=2, so one speech chunk is not enough
            assert_eq!(g.update(0.9), VadEvent::Silence);
        }

        #[test]
        fn two_high_probs_trigger_speech_started() {
            let mut g = gate();
            assert_eq!(g.update(0.9), VadEvent::Silence);
            assert_eq!(g.update(0.9), VadEvent::SpeechStarted);
        }

        #[test]
        fn sustained_speech_emits_speaking_after_onset() {
            let mut g = gate();
            g.update(0.9);
            g.update(0.9); // SpeechStarted
            assert_eq!(g.update(0.9), VadEvent::Speaking);
            assert_eq!(g.update(0.9), VadEvent::Speaking);
        }

        #[test]
        fn silence_after_speech_emits_speech_ended() {
            let mut g = gate();
            g.update(0.9);
            g.update(0.9); // SpeechStarted — now in_speech
            g.update(0.9); // Speaking

            // end_chunks=3, so 3 low probs required
            let e1 = g.update(0.1);
            let e2 = g.update(0.1);
            let e3 = g.update(0.1);

            // First two are still Speaking (silence_run < end_chunks)
            assert_eq!(e1, VadEvent::Speaking);
            assert_eq!(e2, VadEvent::Speaking);
            // Third crosses the threshold
            assert_eq!(e3, VadEvent::SpeechEnded);
        }

        #[test]
        fn exactly_one_speech_started_and_one_speech_ended() {
            let mut g = SpeechGate::new(0.5, 2, 8);
            let mut starts = 0u32;
            let mut ends = 0u32;

            // 10 speech chunks
            for _ in 0..10 {
                if matches!(g.update(0.9), VadEvent::SpeechStarted) {
                    starts += 1;
                }
            }
            // 10 silence chunks (> end_chunks=8, so SpeechEnded must fire once)
            for _ in 0..10 {
                if matches!(g.update(0.05), VadEvent::SpeechEnded) {
                    ends += 1;
                }
            }

            assert_eq!(starts, 1, "exactly one SpeechStarted");
            assert_eq!(ends, 1, "exactly one SpeechEnded");
        }

        #[test]
        fn no_speech_end_without_prior_speech() {
            let mut g = gate();
            // long silence after silence — SpeechEnded must never fire
            for _ in 0..20 {
                assert_ne!(g.update(0.1), VadEvent::SpeechEnded);
            }
        }

        #[test]
        fn speech_run_resets_on_silence_before_onset() {
            let mut g = gate();
            // onset_chunks=2; give one high, then low, then two high
            g.update(0.9); // speech_run=1, not yet onset
            g.update(0.1); // resets speech_run
            let e1 = g.update(0.9); // speech_run=1 again
            let e2 = g.update(0.9); // speech_run=2 → SpeechStarted
            assert_eq!(e1, VadEvent::Silence);
            assert_eq!(e2, VadEvent::SpeechStarted);
        }

        #[test]
        fn hysteresis_keeps_speech_through_a_dip_below_enter_but_above_exit() {
            // enter=0.5, exit=0.35. Once in speech, a 0.40 dip (below enter,
            // above exit) must NOT count as silence — stays Speaking.
            let mut g = SpeechGate::new(0.5, 2, 3);
            g.update(0.9);
            g.update(0.9); // SpeechStarted
                           // Dip to 0.40 three times: above exit (0.35), so still Speaking,
                           // and crucially NOT enough silence to ever fire SpeechEnded.
            assert_eq!(g.update(0.40), VadEvent::Speaking);
            assert_eq!(g.update(0.40), VadEvent::Speaking);
            assert_eq!(g.update(0.40), VadEvent::Speaking);
            // A real dip below exit accrues silence; 3 of them end speech.
            assert_eq!(g.update(0.20), VadEvent::Speaking);
            assert_eq!(g.update(0.20), VadEvent::Speaking);
            assert_eq!(g.update(0.20), VadEvent::SpeechEnded);
        }

        #[test]
        fn soft_pause_fires_once_at_soft_end_chunks() {
            // Production values: onset 2, soft end 18, hard end 38.
            let mut g = SpeechGate::with_soft_end(0.5, 2, 18, 38);
            g.update(0.9);
            g.update(0.9); // SpeechStarted, now in_speech

            // Exactly soft_end_chunks (18) low probs: the 18th fires SpeechPaused once.
            let mut pauses = 0u32;
            for _ in 0..18 {
                if matches!(g.update(0.1), VadEvent::SpeechPaused) {
                    pauses += 1;
                }
            }
            assert_eq!(pauses, 1, "exactly one SpeechPaused at soft_end_chunks");

            // Continue silence to the hard end (through chunk 38): exactly one
            // SpeechEnded and no second SpeechPaused.
            let mut ends = 0u32;
            let mut extra_pauses = 0u32;
            for _ in 0..20 {
                match g.update(0.1) {
                    VadEvent::SpeechEnded => ends += 1,
                    VadEvent::SpeechPaused => extra_pauses += 1,
                    _ => {}
                }
            }
            assert_eq!(ends, 1, "exactly one SpeechEnded at end_chunks");
            assert_eq!(
                extra_pauses, 0,
                "SpeechPaused fires at most once per silence run"
            );
        }
    }

    mod collapse_fn {
        use super::super::{collapse, VadEvent};

        fn fold(events: &[VadEvent]) -> VadEvent {
            events
                .iter()
                .fold(VadEvent::Silence, |acc, &e| collapse(acc, e))
        }

        #[test]
        fn pause_survives_speaking_on_both_sides() {
            // The common case: within one accept() call the gate returns
            // [Speaking, SpeechPaused, Speaking]; the pause must survive the fold.
            assert_eq!(
                fold(&[
                    VadEvent::Speaking,
                    VadEvent::SpeechPaused,
                    VadEvent::Speaking
                ]),
                VadEvent::SpeechPaused
            );
        }

        #[test]
        fn hard_end_outranks_pause() {
            assert_eq!(
                fold(&[VadEvent::SpeechPaused, VadEvent::SpeechEnded]),
                VadEvent::SpeechEnded
            );
        }

        #[test]
        fn start_outranks_pause() {
            assert_eq!(
                fold(&[VadEvent::SpeechPaused, VadEvent::SpeechStarted]),
                VadEvent::SpeechStarted
            );
        }

        #[test]
        fn existing_priorities_unchanged() {
            assert_eq!(
                fold(&[VadEvent::Speaking, VadEvent::SpeechEnded]),
                VadEvent::SpeechEnded
            );
            assert_eq!(
                fold(&[VadEvent::SpeechStarted, VadEvent::Speaking]),
                VadEvent::SpeechStarted
            );
            assert_eq!(
                fold(&[VadEvent::Silence, VadEvent::Speaking]),
                VadEvent::Speaking
            );
            assert_eq!(
                fold(&[VadEvent::Silence, VadEvent::Silence]),
                VadEvent::Silence
            );
        }
    }

    // ------------------------------------------------------------------
    // SileroVad smoke test — requires ONNX model, mark #[ignore]
    // ------------------------------------------------------------------

    #[test]
    #[ignore = "loads ONNX model; run with --ignored to exercise real model"]
    fn silero_model_smoke() {
        let mut vad = SileroVad::new().expect("SileroVad::new should not fail");
        // Zeros are definitely not speech, but the call must not panic
        let zeros = vec![0.0f32; 1600];
        let _event = vad.accept(&zeros);
        // No panic = pass; we do NOT assert speech detection on synthetic audio
    }
}
