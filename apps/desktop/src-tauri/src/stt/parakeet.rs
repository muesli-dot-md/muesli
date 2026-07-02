//! Parakeet TDT 0.6b v3 (int8 ONNX) speech-to-text engine.
//!
//! Wraps `transcribe-rs`'s Parakeet ONNX model behind our [`SttEngine`] trait.
//! Runs full-context on the CPU ONNX execution provider (CoreML is broken for
//! Parakeet on macOS). The model is loaded once in [`ParakeetEngine::load`] and
//! reused across `transcribe_partial`/`transcribe_final` calls.

use anyhow::{Context, Result};

use transcribe_rs::{
    accel::{set_ort_accelerator, OrtAccelerator},
    onnx::{
        parakeet::{ParakeetModel, ParakeetParams, TimestampGranularity},
        Quantization,
    },
};

use crate::stt::engine::SttEngine;
use crate::stt::model::ParakeetPaths;

/// Loaded Parakeet v3 engine. Holds the model in memory for the lifetime of the
/// instance.
pub struct ParakeetEngine {
    model: ParakeetModel,
}

impl ParakeetEngine {
    /// Load the Parakeet v3 int8 model from the resolved artifact directory using
    /// the CPU ONNX execution provider. Fails if artifacts are missing or the
    /// model cannot be loaded.
    pub fn load(paths: &ParakeetPaths) -> Result<Self> {
        anyhow::ensure!(
            paths.is_present(),
            "Parakeet model artifacts not present at {}",
            paths.model_dir().display()
        );

        // Force the CPU execution provider — CoreML is broken for Parakeet on Mac.
        set_ort_accelerator(OrtAccelerator::CpuOnly);

        let model =
            ParakeetModel::load(paths.model_dir(), &Quantization::Int8).with_context(|| {
                format!(
                    "loading Parakeet v3 model from {}",
                    paths.model_dir().display()
                )
            })?;

        Ok(Self { model })
    }

    /// Run the model over `samples` (16 kHz mono f32) and return the transcript text.
    fn transcribe(&mut self, samples: &[f32]) -> Result<String> {
        if samples.is_empty() {
            return Ok(String::new());
        }
        let params = ParakeetParams {
            timestamp_granularity: Some(TimestampGranularity::Segment),
            ..Default::default()
        };
        let result = self
            .model
            .transcribe_with(samples, &params)
            .map_err(|e| anyhow::anyhow!("Parakeet transcription failed: {e}"))?;
        Ok(result.text.trim().to_string())
    }
}

impl SttEngine for ParakeetEngine {
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

    /// App-data dir used for the gated integration test. Points at this crate's
    /// `tests/models/` so a locally-downloaded model can be reused across runs.
    fn test_app_data() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests")
    }

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
    #[ignore = "requires downloaded model + fixture WAV"]
    fn transcribes_known_clip() {
        let app_data = test_app_data();
        let paths = ParakeetPaths::resolve(&app_data);
        assert!(
            paths.is_present(),
            "run model download first (see tests/models/{})",
            crate::stt::model::MODEL_DIR_NAME
        );

        let mut eng = ParakeetEngine::load(&paths).unwrap();
        let samples = load_wav_16k_mono("tests/fixtures/hello_16k.wav");
        let text = eng.transcribe_final(&samples).unwrap().to_lowercase();
        eprintln!("PARAKEET TRANSCRIPT: {text:?}");
        assert!(text.contains("hello"), "got: {text}");
    }
}
