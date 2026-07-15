use std::sync::mpsc::{Receiver, Sender};

/// All audio downstream of a source is 16 kHz mono f32.
pub const SAMPLE_RATE: u32 = 16_000;

pub type FrameSender = Sender<Vec<f32>>;
pub type FrameReceiver = Receiver<Vec<f32>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Me,
    Them,
}

impl Source {
    pub fn label(&self) -> &'static str {
        match self {
            Source::Me => "me",
            Source::Them => "them",
        }
    }
}

pub mod mic;
// System-lane loudness normalization (EBU R128). Pure DSP, cross-platform so
// its tests run in CI; only the macOS system capture path constructs it.
pub mod normalize;
pub mod resample;
pub mod vad;
// System / application output audio is captured via ScreenCaptureKit, which is
// macOS-only. The non-macOS path is a stub that returns a clean error (the UI
// hides all transcription affordances off macOS, so this is never reached).
pub mod system;
