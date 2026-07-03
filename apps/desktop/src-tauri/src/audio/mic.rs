//! Microphone capture for the "You" lane.
//!
//! On macOS this routes the mic through the OS **Voice Processing I/O** unit
//! (acoustic echo cancellation + noise suppression + automatic gain control)
//! via `AVAudioEngine`'s input node. The OS uses current system playback as the
//! echo reference and subtracts it from the mic in real time — the same feature
//! Zoom/FaceTime use. This cancels audio playing out the Mac speakers (e.g. a
//! Google Meet call on speakerphone) out of the mic capture, so it no longer
//! bleeds into the "You" transcript.
//!
//! Every delivered buffer is downmixed/resampled to **16 kHz mono f32** via
//! [`Resampler`] and forwarded on a [`FrameSender`]. The returned [`MicHandle`]
//! stops capture on drop.
//!
//! On non-macOS targets this falls back to a plain `cpal` capture (no AEC).
//!
//! ## Threading / `!Send`
//! The macOS [`MicHandle`] owns Objective-C objects (`AVAudioEngine`) and is
//! `!Send`. `commands.rs` creates and drops it on one dedicated "mic-capture"
//! thread, so this is fine as long as it is never stored in shared state. The
//! tap block runs on a real-time audio thread; it only extracts floats,
//! resamples, and `tx.send`s — never blocking.

#[cfg(target_os = "macos")]
pub use macos::{start, MicHandle};

#[cfg(not(target_os = "macos"))]
pub use fallback::{start, MicHandle};

// ---------------------------------------------------------------------------
// macOS: AVAudioEngine voice-processing path (AEC)
// ---------------------------------------------------------------------------
#[cfg(target_os = "macos")]
mod macos {
    use anyhow::{anyhow, Result};
    use std::sync::Mutex;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::AllocAnyThread;
    use objc2_avf_audio::{AVAudioEngine, AVAudioFormat, AVAudioPCMBuffer, AVAudioTime};

    use crate::audio::resample::Resampler;
    use crate::audio::FrameSender;

    /// Bus 0 is the only input bus on the engine's input node.
    /// `AVAudioNodeBus` is `usize`.
    const INPUT_BUS: usize = 0;
    /// Tap buffer size hint (frames). The OS may deliver smaller/larger buffers.
    const TAP_BUFFER_SIZE: u32 = 4096;

    /// Owns the live `AVAudioEngine` with voice processing enabled. Dropping this
    /// value removes the tap and stops the engine.
    ///
    /// `!Send` because it holds Objective-C objects; must be created and dropped
    /// on the same thread (the dedicated "mic-capture" thread in `commands.rs`).
    pub struct MicHandle {
        engine: Retained<AVAudioEngine>,
    }

    impl Drop for MicHandle {
        fn drop(&mut self) {
            unsafe {
                let input = self.engine.inputNode();
                input.removeTapOnBus(INPUT_BUS);
                self.engine.stop();
            }
        }
    }

    /// Open the default mic with voice processing (AEC) enabled, resample each
    /// tap buffer to 16 kHz mono, and forward frames on `tx`.
    pub fn start(tx: FrameSender) -> Result<MicHandle> {
        unsafe {
            let engine = AVAudioEngine::new();
            let input = engine.inputNode();

            // Enable the OS VoiceProcessingIO path (AEC + NS + AGC). Throwing
            // call — surface the NSError as anyhow.
            input
                .setVoiceProcessingEnabled_error(true)
                .map_err(|e| anyhow!("setVoiceProcessingEnabled failed: {e:?}"))?;

            // Enabling VP can change the input format — query it AFTER enabling.
            let format = input.outputFormatForBus(INPUT_BUS);
            let sample_rate = format.sampleRate() as u32;
            let channels = format.channelCount() as u16;
            if sample_rate == 0 || channels == 0 {
                return Err(anyhow!(
                    "invalid input format after enabling voice processing \
                     (sample_rate={sample_rate}, channels={channels})"
                ));
            }
            eprintln!(
                "[mic] voice-processing input format: {sample_rate} Hz, {channels} ch"
            );

            // VoiceProcessingIO is a single DUPLEX (input+output) AudioUnit, so
            // its input and output sides share one clock/sample-rate. The input
            // tap only fires when the engine's output render path is active and
            // PULLING — but that path must run at the SAME sample rate as the
            // VP input (else -10875 kAudioUnitErr_FormatNotSupported). We engage
            // the render path through the main mixer at the input's own rate and
            // mute it so the mic doesn't loop back to the speakers.
            let mixer = engine.mainMixerNode();
            let render_fmt = AVAudioFormat::initStandardFormatWithSampleRate_channels(
                AVAudioFormat::alloc(),
                sample_rate as f64,
                1,
            )
            .ok_or_else(|| anyhow!("failed to build standard render format"))?;
            engine.connect_to_format(&input, &mixer, Some(&render_fmt));
            engine.connect_to_format(&mixer, &engine.outputNode(), Some(&render_fmt));
            // Near-silent rather than exactly 0: keeps the output render path
            // actively pulling (which is what drives the VPIO input side) while
            // staying inaudible. The mixer input is the mic itself, which AEC
            // largely cancels anyway, so there is no audible feedback.
            mixer.setOutputVolume(1.0e-4);
            // We resample MONO -> 16 kHz: the tap downmixes to mono first (it
            // reads each buffer's own format, which may differ from the format
            // queried above once the render graph is connected).
            let resampler = Mutex::new(Resampler::new(sample_rate, 1));

            // The tap block runs on a real-time audio thread. It must be
            // `Fn + Send + 'static`: move `tx` and the `Mutex<Resampler>` in.
            let block = RcBlock::new(
                move |buf: std::ptr::NonNull<AVAudioPCMBuffer>,
                      _when: std::ptr::NonNull<AVAudioTime>| {
                    let buf = buf.as_ref();
                    let frame_count = buf.frameLength() as usize;
                    if frame_count == 0 {
                        return;
                    }

                    // Read the buffer's OWN format — the tap buffer's channel
                    // count and interleaving can differ from the format queried
                    // before the graph was connected.
                    let fmt = buf.format();
                    let buf_ch = fmt.channelCount() as usize;
                    let interleaved_layout = fmt.isInterleaved();
                    if buf_ch == 0 {
                        return;
                    }

                    // floatChannelData(): *mut NonNull<f32>. For non-interleaved
                    // (planar) audio there is one plane pointer per channel; for
                    // interleaved audio there is a single plane holding all
                    // channels. Null when the buffer isn't float.
                    let ch_data = buf.floatChannelData();
                    if ch_data.is_null() {
                        return;
                    }

                    // Downmix to mono in-place.
                    let mut mono: Vec<f32> = Vec::with_capacity(frame_count);
                    if interleaved_layout {
                        // Single plane, samples interleaved: [c0,c1,..,c0,c1,..].
                        let plane = (*ch_data.add(0)).as_ptr();
                        for frame in 0..frame_count {
                            let mut sum = 0.0f32;
                            for c in 0..buf_ch {
                                sum += *plane.add(frame * buf_ch + c);
                            }
                            mono.push(sum / buf_ch as f32);
                        }
                    } else {
                        // One plane per channel.
                        for frame in 0..frame_count {
                            let mut sum = 0.0f32;
                            for c in 0..buf_ch {
                                let plane = (*ch_data.add(c)).as_ptr();
                                sum += *plane.add(frame);
                            }
                            mono.push(sum / buf_ch as f32);
                        }
                    }

                    // Resampler is configured for mono input (1 channel).
                    let frame = match resampler.lock() {
                        Ok(mut r) => r.process(&mono),
                        Err(_) => return,
                    };

                    if !frame.is_empty() {
                        // Ignore send error on teardown; never unwrap on the
                        // audio thread.
                        let _ = tx.send(frame);
                    }
                },
            );

            // installTapOnBus(bus, bufferSize, format: nil, block). Passing
            // `None` for format uses the node's (post-connect) output format.
            input.installTapOnBus_bufferSize_format_block(
                INPUT_BUS,
                TAP_BUFFER_SIZE,
                None,
                RcBlock::as_ptr(&block),
            );

            engine.prepare();

            // Starting a VoiceProcessingIO AVAudioEngine is occasionally flaky:
            // startAndReturnError() returns Ok but isRunning() is briefly false
            // (the VPIO audio unit hasn't fully spun up). Retry a few times with a
            // short settle pause before giving up.
            let mut started = false;
            let mut last_err: Option<String> = None;
            for attempt in 0..5 {
                if attempt > 0 {
                    engine.stop();
                    std::thread::sleep(std::time::Duration::from_millis(120));
                    engine.prepare();
                }
                if let Err(e) = engine.startAndReturnError() {
                    last_err = Some(format!("start error: {e:?}"));
                    continue;
                }
                // Give the VPIO unit a beat to actually come up.
                std::thread::sleep(std::time::Duration::from_millis(40));
                if engine.isRunning() {
                    started = true;
                    break;
                }
                last_err = Some("not running after start".into());
            }
            if !started {
                return Err(anyhow!(
                    "AVAudioEngine reported not running after start ({})",
                    last_err.as_deref().unwrap_or("unknown")
                ));
            }

            Ok(MicHandle { engine })
        }
    }
}

// ---------------------------------------------------------------------------
// Non-macOS: plain cpal capture (no AEC)
// ---------------------------------------------------------------------------
#[cfg(not(target_os = "macos"))]
mod fallback {
    use anyhow::{Context, Result};
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::SampleFormat;

    use crate::audio::resample::Resampler;
    use crate::audio::FrameSender;

    /// Owns the live cpal stream. Dropping this value stops capture.
    pub struct MicHandle {
        _stream: cpal::Stream,
    }

    /// Open the default microphone, resample each callback buffer to 16 kHz
    /// mono, and forward frames on `tx`. No echo cancellation on this path.
    pub fn start(tx: FrameSender) -> Result<MicHandle> {
        let host = cpal::default_host();

        let device = host
            .default_input_device()
            .context("no default input device available")?;

        let supported_config = device
            .default_input_config()
            .context("failed to get default input config")?;

        let sample_rate = supported_config.sample_rate().0;
        let channels = supported_config.channels();
        let stream_config: cpal::StreamConfig = supported_config.clone().into();

        let err_fn = |err| eprintln!("[mic] stream error: {err}");

        let stream = match supported_config.sample_format() {
            SampleFormat::F32 => {
                let mut resampler = Resampler::new(sample_rate, channels);
                device.build_input_stream(
                    &stream_config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        let frame = resampler.process(data);
                        if !frame.is_empty() {
                            let _ = tx.send(frame);
                        }
                    },
                    err_fn,
                    None,
                )?
            }
            SampleFormat::I16 => {
                let mut resampler = Resampler::new(sample_rate, channels);
                let tx = tx;
                device.build_input_stream(
                    &stream_config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        let floats: Vec<f32> = data
                            .iter()
                            .map(|&s| s as f32 / i16::MAX as f32)
                            .collect();
                        let frame = resampler.process(&floats);
                        if !frame.is_empty() {
                            let _ = tx.send(frame);
                        }
                    },
                    err_fn,
                    None,
                )?
            }
            SampleFormat::U16 => {
                let mut resampler = Resampler::new(sample_rate, channels);
                let tx = tx;
                device.build_input_stream(
                    &stream_config,
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        let floats: Vec<f32> = data
                            .iter()
                            .map(|&s| (s as f32 - 32768.0) / 32768.0)
                            .collect();
                        let frame = resampler.process(&floats);
                        if !frame.is_empty() {
                            let _ = tx.send(frame);
                        }
                    },
                    err_fn,
                    None,
                )?
            }
            SampleFormat::I32 => {
                let mut resampler = Resampler::new(sample_rate, channels);
                let tx = tx;
                device.build_input_stream(
                    &stream_config,
                    move |data: &[i32], _: &cpal::InputCallbackInfo| {
                        let floats: Vec<f32> = data
                            .iter()
                            .map(|&s| s as f32 / i32::MAX as f32)
                            .collect();
                        let frame = resampler.process(&floats);
                        if !frame.is_empty() {
                            let _ = tx.send(frame);
                        }
                    },
                    err_fn,
                    None,
                )?
            }
            SampleFormat::F64 => {
                let mut resampler = Resampler::new(sample_rate, channels);
                let tx = tx;
                device.build_input_stream(
                    &stream_config,
                    move |data: &[f64], _: &cpal::InputCallbackInfo| {
                        let floats: Vec<f32> = data.iter().map(|&s| s as f32).collect();
                        let frame = resampler.process(&floats);
                        if !frame.is_empty() {
                            let _ = tx.send(frame);
                        }
                    },
                    err_fn,
                    None,
                )?
            }
            fmt => {
                anyhow::bail!("unsupported sample format: {fmt}");
            }
        };

        stream.play().context("failed to start mic stream")?;

        Ok(MicHandle { _stream: stream })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    /// Smoke test: start the mic and assert at least one non-empty 16 kHz mono
    /// frame arrives. On macOS this exercises the voice-processing (AEC) path;
    /// the VoiceProcessingIO unit can take a beat to spin up after `start()`, so
    /// we poll for up to ~4 s for the first frame rather than sleeping a fixed
    /// window.
    ///
    /// Requires Microphone permission to be granted to the test runner. If it
    /// is denied, the capture will produce no frames (or `start` may fail at
    /// the OS prompt) — in that case this needs manual verification rather than
    /// being a real failure. Run manually on a machine with a real mic:
    ///
    /// ```text
    /// DYLD_FALLBACK_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx \
    ///   cargo test --manifest-path src-tauri/Cargo.toml mic -- --ignored --nocapture
    /// ```
    ///
    /// NOTE: this asserts frames *arrive*, not that they are non-silent. With
    /// voice processing on, the OS cancels system playback (the echo reference)
    /// out of the mic, so any audio coming from the speakers will be largely
    /// suppressed — that is correct AEC behaviour. Verifying real speech is
    /// captured (and echo is cancelled) requires speaking into the mic live;
    /// see `.superpowers/sdd/aec-report.md`.
    #[test]
    #[ignore]
    fn smoke_mic_captures_frames() {
        use std::time::Instant;

        let (tx, rx) = mpsc::channel::<Vec<f32>>();

        let handle = start(tx).expect("mic::start should succeed");

        // Poll up to ~4 s for the first frame (VPIO warmup can exceed 1.5 s).
        let start_t = Instant::now();
        let deadline = Duration::from_secs(4);
        let mut frames: Vec<Vec<f32>> = Vec::new();
        let first_at = loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(f) => {
                    let t = start_t.elapsed();
                    frames.push(f);
                    break Some(t);
                }
                Err(_) if start_t.elapsed() >= deadline => break None,
                Err(_) => continue,
            }
        };
        // Collect a little more so the count is representative.
        std::thread::sleep(Duration::from_millis(500));
        frames.extend(rx.try_iter());
        drop(handle);

        assert!(
            first_at.is_some(),
            "expected at least one frame from mic within {deadline:?} \
             (if Microphone permission isn't granted to the test runner, this \
             needs manual verification rather than being a real failure)"
        );
        for f in &frames {
            assert!(!f.is_empty(), "received an empty frame");
        }
        println!(
            "smoke_mic_captures_frames: first frame at {:?}, received {} frames",
            first_at.unwrap(),
            frames.len()
        );
    }
}
