use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::ser::{SerializeStruct, Serializer};
use serde::Serialize;

use crate::audio::{FrameReceiver, Source, SAMPLE_RATE};
use crate::audio::vad::{Vad, VadEvent};
use crate::stt::engine::SttEngine;

/// Milliseconds of pre-speech audio kept in a ring buffer and prepended to an
/// utterance when speech starts, so VAD onset latency doesn't clip the first word.
const PREROLL_MS: usize = 300;
/// Utterances with less than this much confirmed speech (excluding pre-roll) are
/// dropped as spurious blips (clicks, coughs, single "uh"s).
const MIN_SPEECH_MS: usize = 250;
/// Force-finalize an utterance once it reaches this length, even without a pause —
/// a safety cap for non-stop talkers that also bounds per-partial transcription cost.
const MAX_UTTERANCE_MS: usize = 25_000;
/// Partials only re-transcribe at most this much trailing audio, so the live text
/// stays responsive as an utterance grows (the final still uses the whole buffer).
const MAX_PARTIAL_MS: usize = 10_000;

// ---------------------------------------------------------------------------
// TranscriptEvent
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct TranscriptEvent {
    pub source: Source,
    pub text: String,
    pub t0: f64,
    pub t1: f64,
    pub utterance_id: u64,
}

impl Serialize for TranscriptEvent {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("TranscriptEvent", 5)?;
        s.serialize_field("source", self.source.label())?;
        s.serialize_field("text", &self.text)?;
        s.serialize_field("t0", &self.t0)?;
        s.serialize_field("t1", &self.t1)?;
        s.serialize_field("utteranceId", &self.utterance_id)?;
        s.end()
    }
}

// ---------------------------------------------------------------------------
// Emitter trait
// ---------------------------------------------------------------------------

pub trait Emitter: Send + Sync {
    fn partial(&self, e: &TranscriptEvent);
    fn final_(&self, e: &TranscriptEvent);
}

// ---------------------------------------------------------------------------
// run_worker
// ---------------------------------------------------------------------------

pub fn run_worker(
    source: Source,
    rx: FrameReceiver,
    mut vad: Box<dyn Vad>,
    mut engine: Box<dyn SttEngine>,
    emitter: Arc<dyn Emitter>,
    started: Instant,
    partial_interval: Duration,
) {
    let sr = SAMPLE_RATE as usize;
    let preroll_cap = sr * PREROLL_MS / 1000;
    let min_speech_samples = sr * MIN_SPEECH_MS / 1000;
    let max_utterance_samples = sr * MAX_UTTERANCE_MS / 1000;
    let max_partial_samples = sr * MAX_PARTIAL_MS / 1000;

    let mut buffer: Vec<f32> = Vec::new();
    // Rolling buffer of the most recent pre-speech audio, prepended on speech-start.
    let mut preroll: VecDeque<f32> = VecDeque::with_capacity(preroll_cap + 1);
    // Confirmed speech samples in the current utterance (excludes pre-roll), for the
    // min-speech-duration drop.
    let mut speech_samples: usize = 0;
    let mut utterance_id: u64 = 0;
    let mut t0: f64 = 0.0;
    let mut last_partial: Instant = Instant::now();

    for frame in &rx {
        match vad.accept(&frame) {
            VadEvent::SpeechStarted => {
                buffer.clear();
                // Prepend the pre-roll so the first word isn't clipped.
                buffer.extend(preroll.drain(..));
                buffer.extend_from_slice(&frame);
                speech_samples = frame.len();
                // Timestamp the utterance at roughly where the speech audio begins
                // (account for the prepended pre-roll).
                let preroll_secs = (buffer.len() - frame.len()) as f64 / sr as f64;
                t0 = (started.elapsed().as_secs_f64() - preroll_secs).max(0.0);
                last_partial = Instant::now();
            }
            VadEvent::Speaking => {
                buffer.extend_from_slice(&frame);
                speech_samples += frame.len();

                if buffer.len() >= max_utterance_samples {
                    // Safety cap: force-finalize a non-stop utterance and continue fresh.
                    let text = engine.transcribe_final(&buffer).unwrap_or_default();
                    if !text.trim().is_empty() {
                        let t1 = started.elapsed().as_secs_f64();
                        let event = TranscriptEvent { source, text, t0, t1, utterance_id };
                        emitter.final_(&event);
                        utterance_id += 1;
                    }
                    buffer.clear();
                    speech_samples = 0;
                    t0 = started.elapsed().as_secs_f64();
                    last_partial = Instant::now();
                } else if last_partial.elapsed() >= partial_interval {
                    // Re-transcribe only the trailing window so partials stay snappy.
                    let start = buffer.len().saturating_sub(max_partial_samples);
                    let text = engine
                        .transcribe_partial(&buffer[start..])
                        .unwrap_or_default();
                    let t1 = started.elapsed().as_secs_f64();
                    let event = TranscriptEvent { source, text, t0, t1, utterance_id };
                    emitter.partial(&event);
                    last_partial = Instant::now();
                }
            }
            VadEvent::SpeechEnded => {
                buffer.extend_from_slice(&frame);
                // Drop utterances with too little confirmed speech (spurious blips).
                if speech_samples >= min_speech_samples {
                    let text = engine
                        .transcribe_final(&buffer)
                        .unwrap_or_default();
                    if !text.trim().is_empty() {
                        let t1 = started.elapsed().as_secs_f64();
                        let event = TranscriptEvent { source, text, t0, t1, utterance_id };
                        emitter.final_(&event);
                        utterance_id += 1;
                    }
                }
                buffer.clear();
                speech_samples = 0;
            }
            VadEvent::Silence => {
                // Maintain the pre-roll ring buffer while idle.
                preroll.extend(frame.iter().copied());
                while preroll.len() > preroll_cap {
                    preroll.pop_front();
                }
            }
        }
    }

    // Channel disconnected — finalize any buffered speech (no min-speech gate; a
    // mid-utterance cutoff should still surface what was said).
    if !buffer.is_empty() {
        let text = engine
            .transcribe_final(&buffer)
            .unwrap_or_default();
        if !text.trim().is_empty() {
            let t1 = started.elapsed().as_secs_f64();
            let event = TranscriptEvent { source, text, t0, t1, utterance_id };
            emitter.final_(&event);
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::{Source, vad::{Vad, VadEvent}};
    use crate::stt::engine::SttEngine;
    use std::sync::{Arc, Mutex};
    use std::sync::mpsc::channel;
    use std::time::{Duration, Instant};

    struct FakeEngine;
    impl SttEngine for FakeEngine {
        fn transcribe_partial(&mut self, s: &[f32]) -> anyhow::Result<String> {
            Ok(format!("partial:{}", s.len()))
        }
        fn transcribe_final(&mut self, s: &[f32]) -> anyhow::Result<String> {
            Ok(format!("final:{}", s.len()))
        }
    }

    /// Emits a scripted sequence of VadEvents, one per accept() call.
    struct ScriptedVad { script: Vec<VadEvent> }
    impl Vad for ScriptedVad {
        fn accept(&mut self, _s: &[f32]) -> VadEvent {
            if self.script.is_empty() { VadEvent::Silence } else { self.script.remove(0) }
        }
    }

    #[derive(Default)]
    struct CapturingEmitter { partials: Mutex<Vec<TranscriptEvent>>, finals: Mutex<Vec<TranscriptEvent>> }
    impl Emitter for CapturingEmitter {
        fn partial(&self, e: &TranscriptEvent) { self.partials.lock().unwrap().push(e.clone()); }
        fn final_(&self, e: &TranscriptEvent) { self.finals.lock().unwrap().push(e.clone()); }
    }

    #[test]
    fn one_utterance_produces_final_and_increments_id() {
        let (tx, rx) = channel::<Vec<f32>>();
        // 5 frames: start speaking, speak, speak, end, then silence
        let vad = ScriptedVad { script: vec![
            VadEvent::SpeechStarted, VadEvent::Speaking, VadEvent::Speaking,
            VadEvent::SpeechEnded, VadEvent::Silence,
        ]};
        let emitter = Arc::new(CapturingEmitter::default());
        let em2 = emitter.clone();
        // Each frame = 16000 samples (1s) so partial_interval of 0 fires a partial each speaking frame.
        for _ in 0..5 { tx.send(vec![0.0f32; 16_000]).unwrap(); }
        drop(tx);
        run_worker(Source::Me, rx, Box::new(vad), Box::new(FakeEngine),
                   em2, Instant::now(), Duration::from_millis(0));
        let finals = emitter.finals.lock().unwrap();
        assert_eq!(finals.len(), 1);
        assert_eq!(finals[0].utterance_id, 0);
        assert!(finals[0].text.starts_with("final:"));
        assert!(!emitter.partials.lock().unwrap().is_empty());
    }

    #[test]
    fn mid_utterance_finalize_on_disconnect() {
        let (tx, rx) = channel::<Vec<f32>>();
        // Start speech, speak, then drop without SpeechEnded
        let vad = ScriptedVad { script: vec![
            VadEvent::SpeechStarted, VadEvent::Speaking,
        ]};
        let emitter = Arc::new(CapturingEmitter::default());
        let em2 = emitter.clone();
        for _ in 0..2 { tx.send(vec![0.0f32; 16_000]).unwrap(); }
        drop(tx);
        run_worker(Source::Them, rx, Box::new(vad), Box::new(FakeEngine),
                   em2, Instant::now(), Duration::from_secs(100));
        let finals = emitter.finals.lock().unwrap();
        assert_eq!(finals.len(), 1, "disconnect should finalize buffered speech");
        assert_eq!(finals[0].utterance_id, 0);
        assert_eq!(finals[0].source.label(), "them");
    }

    #[test]
    fn preroll_is_prepended_on_speech_start() {
        // Two Silence frames fill the pre-roll ring; on SpeechStarted they must be
        // prepended so the first word isn't clipped. FakeEngine reports the sample
        // count, so we can prove the pre-roll made it into the final buffer.
        let (tx, rx) = channel::<Vec<f32>>();
        let vad = ScriptedVad { script: vec![
            VadEvent::Silence, VadEvent::Silence,
            VadEvent::SpeechStarted, VadEvent::Speaking, VadEvent::Speaking,
            VadEvent::SpeechEnded,
        ]};
        let emitter = Arc::new(CapturingEmitter::default());
        let em2 = emitter.clone();
        // 1600 samples/frame (100ms @16k). 2 silence → 3200 pre-roll (< 4800 cap).
        for _ in 0..6 { tx.send(vec![0.1f32; 1600]).unwrap(); }
        drop(tx);
        run_worker(Source::Me, rx, Box::new(vad), Box::new(FakeEngine),
                   em2, Instant::now(), Duration::from_secs(100));
        let finals = emitter.finals.lock().unwrap();
        assert_eq!(finals.len(), 1);
        // started(1600) + speaking(1600*2) + ended(1600) = 6400 of speech,
        // PLUS 3200 pre-roll = 9600. Without pre-roll it would be 6400.
        assert_eq!(finals[0].text, "final:9600", "pre-roll must be prepended");
    }

    #[test]
    fn short_utterance_is_dropped() {
        // A blip with < 250ms (4000 samples) of confirmed speech is dropped.
        let (tx, rx) = channel::<Vec<f32>>();
        let vad = ScriptedVad { script: vec![
            VadEvent::SpeechStarted, VadEvent::SpeechEnded,
        ]};
        let emitter = Arc::new(CapturingEmitter::default());
        let em2 = emitter.clone();
        // 1600 + 1600 = 3200 samples of speech < 4000 min → dropped.
        for _ in 0..2 { tx.send(vec![0.5f32; 1600]).unwrap(); }
        drop(tx);
        run_worker(Source::Me, rx, Box::new(vad), Box::new(FakeEngine),
                   em2, Instant::now(), Duration::from_secs(100));
        assert_eq!(emitter.finals.lock().unwrap().len(), 0, "short blip should be dropped");
    }

    #[test]
    fn transcript_event_json_shape() {
        let event = TranscriptEvent {
            source: Source::Me,
            text: "hello".into(),
            t0: 1.0,
            t1: 2.5,
            utterance_id: 3,
        };
        let json = serde_json::to_string(&event).unwrap();
        // Must contain exact keys
        assert!(json.contains("\"source\":\"me\""), "source key/value: {json}");
        assert!(json.contains("\"text\":\"hello\""), "text: {json}");
        assert!(json.contains("\"t0\":1.0"), "t0: {json}");
        assert!(json.contains("\"t1\":2.5"), "t1: {json}");
        assert!(json.contains("\"utteranceId\":3"), "utteranceId: {json}");
    }
}
