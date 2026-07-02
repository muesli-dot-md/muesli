//! System / application **output** audio capture via ScreenCaptureKit — the
//! "Them" lane.
//!
//! Mirrors [`super::mic`]: open a capture source, resample every delivered
//! buffer to 16 kHz mono f32, and forward frames on a [`FrameSender`]. The
//! returned [`SystemHandle`] stops capture on drop.
//!
//! Unlike the mic (cpal) path, the source here is an `SCStream`. We configure it
//! to capture **mono f32** system audio at 48 kHz, then resample to 16 kHz. The
//! audio callback runs on a ScreenCaptureKit dispatch queue (any thread), so the
//! handler only needs `Send + Sync`; it owns its own [`Resampler`] behind a
//! `Mutex` and never touches the main thread.
//!
//! Requires the **Screen Recording** permission. If it is denied,
//! [`SCShareableContent::get`] fails (or returns no displays); we surface that as
//! a clear `anyhow` error so the caller can keep the mic-only lane running.
//!
//! ScreenCaptureKit is macOS-only, so this whole capture path is gated to macOS.
//! On other platforms a stub [`start`] returns a clear error — the UI hides every
//! transcription affordance off macOS, so this is never reached in practice.

#[cfg(target_os = "macos")]
pub use macos::{start, SystemHandle};

#[cfg(not(target_os = "macos"))]
pub use fallback::{start, SystemHandle};

// ---------------------------------------------------------------------------
// macOS: ScreenCaptureKit system-audio capture
// ---------------------------------------------------------------------------
#[cfg(target_os = "macos")]
mod macos {
    use anyhow::{anyhow, Context, Result};
    use std::sync::Mutex;

    use screencapturekit::cm::CMSampleBufferExt;
    use screencapturekit::prelude::{
        CMSampleBuffer, SCContentFilter, SCShareableContent, SCStream, SCStreamConfiguration,
        SCStreamOutputTrait, SCStreamOutputType,
    };

    use crate::audio::resample::Resampler;
    use crate::audio::FrameSender;

    /// ScreenCaptureKit delivers audio as 32-bit float PCM. With `channel_count(1)`
    /// the stream is downmixed to a single mono buffer of `f32` samples.
    const CAPTURE_SAMPLE_RATE: u32 = 48_000;
    const CAPTURE_CHANNELS: u16 = 1;

    /// Owns the live `SCStream`. Dropping this value stops capture.
    ///
    /// `SCStream::stop_capture` is also called explicitly on drop; if it errors
    /// (e.g. the stream already stopped) we log rather than panic.
    pub struct SystemHandle {
        stream: SCStream,
    }

    impl Drop for SystemHandle {
        fn drop(&mut self) {
            if let Err(e) = self.stream.stop_capture() {
                eprintln!("[system] stop_capture on drop failed (likely already stopped): {e}");
            }
        }
    }

    /// Stream output handler: converts each audio `CMSampleBuffer` to 16 kHz mono
    /// f32 and sends it on `tx`. Must be `Send + Sync` because ScreenCaptureKit may
    /// invoke it from arbitrary dispatch-queue threads.
    struct AudioOutput {
        tx: FrameSender,
        resampler: Mutex<Resampler>,
    }

    impl SCStreamOutputTrait for AudioOutput {
        fn did_output_sample_buffer(&self, sample: CMSampleBuffer, of_type: SCStreamOutputType) {
            // Only handle system/application audio; ignore screen (and mic, which we
            // don't enable) buffers.
            if of_type != SCStreamOutputType::Audio {
                return;
            }

            let Some(list) = sample.audio_buffer_list() else {
                return;
            };

            // ScreenCaptureKit audio is 32-bit float, non-interleaved (one
            // `AudioBuffer` per channel). With channel_count == 1 there is a single
            // mono buffer; reinterpret its bytes as f32 and resample.
            let Some(buffer) = list.get(0) else {
                return;
            };
            let bytes = buffer.data();
            if bytes.is_empty() {
                return;
            }

            // Bytes -> f32 samples (little-endian, native CoreMedia layout). Guard
            // against a non-multiple length (shouldn't happen for f32 PCM).
            let n = bytes.len() / std::mem::size_of::<f32>();
            let mut samples: Vec<f32> = Vec::with_capacity(n);
            for chunk in bytes.chunks_exact(4) {
                samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
            }

            let frame = match self.resampler.lock() {
                Ok(mut r) => r.process(&samples),
                Err(e) => {
                    eprintln!("[system] resampler mutex poisoned: {e}");
                    return;
                }
            };
            if !frame.is_empty() {
                let _ = self.tx.send(frame);
            }
        }
    }

    /// Start capturing system/application **output** audio via ScreenCaptureKit,
    /// resample each buffer to 16 kHz mono f32, and forward frames on `tx`.
    ///
    /// Returns a [`SystemHandle`] whose drop stops capture. Errors clearly if the
    /// Screen Recording permission is denied or no shareable content is available.
    pub fn start(tx: FrameSender) -> Result<SystemHandle> {
        // Enumerating shareable content triggers / requires the Screen Recording
        // permission. A denial surfaces here as an error (or as zero displays).
        let content = SCShareableContent::get().map_err(|e| {
            anyhow!(
                "ScreenCaptureKit shareable content unavailable \
             (Screen Recording permission likely denied): {e}"
            )
        })?;

        let displays = content.displays();
        let display = displays.first().ok_or_else(|| {
            anyhow!(
                "no shareable displays found — Screen Recording permission is likely \
             not granted to this app"
            )
        })?;

        // Capture the whole display's audio; we exclude no windows. Audio is global
        // to the display capture, so the visual filter only needs to be valid.
        let filter = SCContentFilter::create()
            .with_display(display)
            .with_excluding_windows(&[])
            .build();

        // Mono f32 @ 48 kHz; exclude our own process audio to avoid feedback loops
        // (our app plays nothing today, but this future-proofs it).
        let config = SCStreamConfiguration::new()
            .with_captures_audio(true)
            .with_sample_rate(CAPTURE_SAMPLE_RATE as i32)
            .with_channel_count(CAPTURE_CHANNELS as i32)
            .with_excludes_current_process_audio(true);

        let mut stream = SCStream::new(&filter, &config);

        let output = AudioOutput {
            tx,
            resampler: Mutex::new(Resampler::new(CAPTURE_SAMPLE_RATE, CAPTURE_CHANNELS)),
        };
        stream.add_output_handler(output, SCStreamOutputType::Audio);

        stream
            .start_capture()
            .context("failed to start ScreenCaptureKit audio capture")?;

        Ok(SystemHandle { stream })
    }
}

// ---------------------------------------------------------------------------
// Non-macOS: stub. System-audio capture relies on ScreenCaptureKit, which only
// exists on macOS. The frontend hides every transcription affordance off macOS,
// so this path is never reached; if it ever were, `start` fails cleanly.
// ---------------------------------------------------------------------------
#[cfg(not(target_os = "macos"))]
mod fallback {
    use anyhow::{bail, Result};

    use crate::audio::FrameSender;

    /// Stub handle. Never constructed off macOS because [`start`] always errors.
    pub struct SystemHandle;

    /// System-audio capture is macOS-only (ScreenCaptureKit). Always errors here.
    pub fn start(_tx: FrameSender) -> Result<SystemHandle> {
        bail!("system audio capture is only available on macOS")
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    /// Smoke test: start system audio for ~1.5s and report whether frames arrive.
    ///
    /// Requires the **Screen Recording** permission to be granted to the test
    /// runner (terminal/IDE) AND audio actively playing on the machine. If the
    /// permission is denied, `system::start` returns an error; if granted but no
    /// audio is playing, zero frames is expected. Neither is a build failure —
    /// this is a manual verification aid.
    ///
    ///   cargo test --manifest-path src-tauri/Cargo.toml system -- --ignored --nocapture
    #[test]
    #[ignore]
    fn smoke_system_captures_frames() {
        let (tx, rx) = mpsc::channel::<Vec<f32>>();

        match start(tx) {
            Ok(handle) => {
                std::thread::sleep(Duration::from_millis(1500));
                drop(handle);
                let frames: Vec<Vec<f32>> = rx.try_iter().collect();
                println!(
                    "smoke_system_captures_frames: received {} frames \
                     (0 is OK if no audio was playing)",
                    frames.len()
                );
                for f in &frames {
                    assert!(!f.is_empty(), "received an empty frame");
                }
            }
            Err(e) => {
                // Permission almost certainly not granted to the test runner.
                println!(
                    "smoke_system_captures_frames: start() failed (expected if \
                     Screen Recording not granted): {e}"
                );
            }
        }
    }
}
