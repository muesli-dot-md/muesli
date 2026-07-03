#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VadEvent {
    Silence,
    SpeechStarted,
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

    in_speech: bool,
    speech_run: u32,
    silence_run: u32,
}

impl SpeechGate {
    pub fn new(threshold: f32, onset_chunks: u32, end_chunks: u32) -> Self {
        Self {
            enter_threshold: threshold,
            exit_threshold: (threshold - 0.15).max(0.01),
            onset_chunks,
            end_chunks,
            in_speech: false,
            speech_run: 0,
            silence_run: 0,
        }
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
                    VadEvent::SpeechEnded
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
            // end after 38 silence chunks (~1.2s). Continuous transcription quality
            // depends on keeping whole thoughts together (Parakeet needs the context),
            // so we only break at genuinely long pauses, not every breath.
            gate: SpeechGate::new(0.5, 2, 38),
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

            // Highest-priority transition wins: SpeechStarted > SpeechEnded > Speaking > Silence.
            // A single accept() call is expected to span fewer than (onset_chunks + end_chunks)
            // = ~21 chunks, so it cannot span a full speech→silence cycle. Real audio frames are
            // ~100ms (~3 chunks); a frame larger than ~2s would be anomalous.
            debug_assert!(
                chunks_this_call < 64,
                "single accept() call processed {} chunks; an audio frame >~2s is anomalous",
                chunks_this_call
            );

            last_event = match (last_event, event) {
                (_, VadEvent::SpeechStarted) => VadEvent::SpeechStarted,
                (VadEvent::SpeechStarted, _) => VadEvent::SpeechStarted,
                (_, VadEvent::SpeechEnded) => VadEvent::SpeechEnded,
                (VadEvent::SpeechEnded, _) => VadEvent::SpeechEnded,
                (_, VadEvent::Speaking) => VadEvent::Speaking,
                (other, _) => other,
            };
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
                match g.update(0.9) {
                    VadEvent::SpeechStarted => starts += 1,
                    _ => {}
                }
            }
            // 10 silence chunks (> end_chunks=8, so SpeechEnded must fire once)
            for _ in 0..10 {
                match g.update(0.05) {
                    VadEvent::SpeechEnded => ends += 1,
                    _ => {}
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
