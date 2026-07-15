//! Parakeet TDT 0.6b v3 (CoreML / Apple Neural Engine) speech-to-text engine.
//!
//! Wraps the Swift **FluidAudio** package via the `fluidaudio-rs` crate (Path A)
//! behind our [`SttEngine`] trait, so the same worker/VAD/emitter path can drive
//! ANE inference instead of the CPU ONNX engine. Entire module is gated on
//! `#[cfg(all(target_os = "macos", feature = "ane"))]`; default and Linux CI
//! builds never compile it. Selected at the single `load_boxed_engine` point
//! (`commands.rs`) with `ParakeetEngine` (CPU ONNX) as the unconditional fallback.
//!
//! We use FluidAudio's in-memory **batch** call `transcribe_samples(&[f32])`
//! (partial = trailing window, final = whole utterance) — one decode per call,
//! matching our architecture exactly. We deliberately do NOT use FluidAudio's
//! streaming managers: that would reintroduce the streaming model listed as a
//! non-goal. Nothing above the `SttEngine` trait changes.
//!
//! API shape (confirmed in the spike, design section 14):
//! - The Rust API is `FluidAudio::transcribe_samples(&[f32]) -> AsrResult`; there
//!   is no `source:` parameter to marshal (the design flagged its shape as
//!   unverified — it simply does not exist at this boundary).
//! - Model load is `FluidAudio::init_asr()`, which internally calls
//!   `AsrModels.downloadAndLoad()` (no `version:` argument) and loads the CoreML
//!   bundle from FluidAudio's default cache path. Task 7's both-sets download
//!   pre-populates that path so `init_asr` finds the models already present.

use anyhow::{anyhow, Result};

use fluidaudio_rs::FluidAudio;

use crate::stt::engine::SttEngine;
use crate::stt::model::{fluidaudio_models_root, CoremlPaths};

/// Whether the CoreML model bundle is present and complete on disk — the ANE
/// analogue of [`ParakeetPaths::is_present`](crate::stt::model::ParakeetPaths).
///
/// Delegates to [`CoremlPaths`] (the single source of truth for the artifact set,
/// shared with the both-sets download) resolved under FluidAudio's default cache
/// root, which `init_asr` loads from and the download pre-populates. A partial or
/// interrupted download reads as absent, so engine selection never picks ANE over
/// an incomplete bundle and cleanly falls back to ONNX.
pub fn coreml_bundle_present() -> bool {
    fluidaudio_models_root()
        .map(|root| CoremlPaths::resolve(&root).is_present())
        .unwrap_or(false)
}

/// Loaded FluidAudio CoreML engine. Owns the Swift bridge (its `AsrManager` +
/// compiled CoreML models) for the lifetime of the instance. The bridge is
/// `Send`/`Sync` (the crate asserts internal synchronization), so this satisfies
/// `SttEngine: Send` and can live in a per-lane worker thread.
pub struct FluidAudioEngine {
    audio: FluidAudio,
}

impl FluidAudioEngine {
    /// Create the FluidAudio bridge and load the ASR (Parakeet v3) CoreML models.
    ///
    /// `init_asr` downloads the CoreML bundle on first run (into FluidAudio's own
    /// cache) and compiles it for the Neural Engine — the crate warns this can
    /// take 20-30 s the first time. Subsequent loads reuse the compiled models.
    pub fn load() -> Result<Self> {
        let audio =
            FluidAudio::new().map_err(|e| anyhow!("creating FluidAudio bridge failed: {e}"))?;
        audio
            .init_asr()
            .map_err(|e| anyhow!("loading FluidAudio ASR (CoreML) models failed: {e}"))?;
        Ok(Self { audio })
    }

    /// Run the CoreML model over `samples` (16 kHz mono f32) and return the text.
    /// Mirrors `ParakeetEngine::transcribe`: empty input short-circuits, a decode
    /// error maps to `Err` (which the worker collapses to "no text this round").
    fn transcribe(&mut self, samples: &[f32]) -> Result<String> {
        if samples.is_empty() {
            return Ok(String::new());
        }
        let result = self
            .audio
            .transcribe_samples(samples)
            .map_err(|e| anyhow!("FluidAudio transcription failed: {e}"))?;
        Ok(result.text.trim().to_string())
    }
}

impl SttEngine for FluidAudioEngine {
    fn transcribe_partial(&mut self, samples: &[f32]) -> Result<String> {
        self.transcribe(samples)
    }

    fn transcribe_final(&mut self, samples: &[f32]) -> Result<String> {
        self.transcribe(samples)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Load a 16 kHz mono WAV fixture into normalized f32 samples. Copied from
    /// `parakeet.rs`'s test module (private there) so the two gated engine tests
    /// share the exact same fixture-loading path.
    fn load_wav_16k_mono(path: &str) -> Vec<f32> {
        let full = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(path);
        let mut reader = hound::WavReader::open(&full)
            .unwrap_or_else(|e| panic!("opening {}: {e}", full.display()));
        let spec = reader.spec();
        assert_eq!(spec.channels, 1, "fixture must be mono");
        assert_eq!(spec.sample_rate, 16_000, "fixture must be 16 kHz");
        match spec.sample_format {
            hound::SampleFormat::Int => {
                let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
                reader
                    .samples::<i32>()
                    .map(|s| s.unwrap() as f32 / max)
                    .collect()
            }
            hound::SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap()).collect(),
        }
    }

    #[test]
    #[ignore = "requires CoreML model download + Swift link; Apple-Silicon only"]
    fn ane_transcribes_known_clip() {
        // Same fixture the ONNX engine test uses: parity is "both contain hello".
        let mut eng = FluidAudioEngine::load().unwrap();
        let samples = load_wav_16k_mono("tests/fixtures/hello_16k.wav");
        let text = eng.transcribe_final(&samples).unwrap().to_lowercase();
        eprintln!("FLUIDAUDIO TRANSCRIPT: {text:?}");
        assert!(text.contains("hello"), "got: {text}");
    }
}
