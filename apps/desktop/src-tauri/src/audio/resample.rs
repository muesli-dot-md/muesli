use rubato::{FastFixedIn, PolynomialDegree, Resampler as RubatoResampler};

/// Target sample rate for all downstream audio processing.
const TARGET_RATE: u32 = 16_000;

/// Chunk size fed to the rubato resampler per call.
const CHUNK_SIZE: usize = 1024;

enum Inner {
    /// input_rate == TARGET_RATE: nothing to resample.
    Identity,
    /// input_rate != TARGET_RATE: use rubato FastFixedIn.
    Rubato(FastFixedIn<f32>),
}

/// Converts arbitrary-rate, arbitrary-channel interleaved f32 audio to
/// 16 kHz mono f32.
pub struct Resampler {
    input_channels: u16,
    inner: Inner,
    /// Mono samples not yet consumed by a full rubato chunk.
    leftover: Vec<f32>,
}

impl Resampler {
    pub fn new(input_rate: u32, input_channels: u16) -> Self {
        let inner = if input_rate == TARGET_RATE {
            Inner::Identity
        } else {
            let ratio = TARGET_RATE as f64 / input_rate as f64;
            // 1 channel — we downmix to mono before resampling.
            let r = FastFixedIn::<f32>::new(ratio, 1.1, PolynomialDegree::Cubic, CHUNK_SIZE, 1)
                .expect("FastFixedIn construction failed");
            Inner::Rubato(r)
        };
        Self {
            input_channels,
            inner,
            leftover: Vec::new(),
        }
    }

    /// Accept interleaved multi-channel f32 samples, return 16 kHz mono f32.
    pub fn process(&mut self, interleaved: &[f32]) -> Vec<f32> {
        // --- Step 1: downmix to mono ---
        let ch = self.input_channels as usize;
        let frames = interleaved.len() / ch;
        let mut mono: Vec<f32> = Vec::with_capacity(frames);
        for i in 0..frames {
            let mut sum = 0.0f32;
            for c in 0..ch {
                sum += interleaved[i * ch + c];
            }
            mono.push(sum / ch as f32);
        }

        // --- Step 2: resample (or pass through) ---
        match &mut self.inner {
            Inner::Identity => mono,
            Inner::Rubato(resampler) => {
                // Append new mono samples to the leftover buffer.
                self.leftover.extend_from_slice(&mono);

                let mut output = Vec::new();

                loop {
                    let chunk = resampler.input_frames_next();
                    if self.leftover.len() < chunk {
                        break;
                    }
                    let chunk_data: Vec<f32> = self.leftover.drain(..chunk).collect();
                    // rubato expects &[V] where V: AsRef<[T]> — one channel.
                    let wave_in = vec![chunk_data];
                    // This runs on the CoreAudio real-time thread (via the mic
                    // voice-processing tap). A panic here would be UB across the
                    // objc2 block boundary, so log once and drop the chunk
                    // instead of unwrapping — mirrors the mutex-poison handling
                    // in the tap.
                    let result = match resampler.process(&wave_in, None) {
                        Ok(r) => r,
                        Err(_) => {
                            use std::sync::atomic::{AtomicBool, Ordering};
                            static LOGGED: AtomicBool = AtomicBool::new(false);
                            if !LOGGED.swap(true, Ordering::Relaxed) {
                                eprintln!("[resample] rubato process failed; dropping chunk");
                            }
                            break;
                        }
                    };
                    // result is Vec<Vec<f32>>, one channel.
                    output.extend_from_slice(&result[0]);
                }

                output
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmixes_stereo_to_mono_and_keeps_length_for_same_rate() {
        // 16 kHz stereo in -> 16 kHz mono out: identity rate, average channels.
        let mut r = Resampler::new(16_000, 2);
        // 4 stereo frames (L,R interleaved), L==R so mono == L
        let input = vec![0.5, 0.5, -0.25, -0.25, 0.0, 0.0, 1.0, 1.0];
        let out = r.process(&input);
        assert_eq!(out.len(), 4);
        assert!((out[0] - 0.5).abs() < 1e-6);
        assert!((out[3] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn resamples_48k_mono_down_to_16k_roughly_thirds_length() {
        let mut r = Resampler::new(48_000, 1);
        let input = vec![0.0f32; 4800]; // 0.1s @ 48k
        let out = r.process(&input);
        // ~0.1s @ 16k ≈ 1600 samples, allow generous tolerance for filter warmup/chunking
        assert!((out.len() as i32 - 1600).abs() < 400, "got {}", out.len());
    }
}
