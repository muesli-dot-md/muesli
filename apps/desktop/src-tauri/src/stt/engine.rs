/// Speech-to-text engine. One instance per audio source.
/// Implementations are full-context: `transcribe_partial` runs on the
/// in-progress utterance buffer (called repeatedly, must be cheap),
/// `transcribe_final` runs once on the complete utterance.
pub trait SttEngine: Send {
    fn transcribe_partial(&mut self, samples: &[f32]) -> anyhow::Result<String>;
    fn transcribe_final(&mut self, samples: &[f32]) -> anyhow::Result<String>;
}
