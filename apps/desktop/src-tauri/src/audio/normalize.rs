//! EBU R128 loudness normalization for the system ("Them") lane.
//!
//! ScreenCaptureKit audio has no AGC anywhere in its path: remote voices
//! arrive at whatever level the sender's mic, the meeting app, and the user's
//! output volume produce — routinely >20 dB apart. Quiet speakers can hover
//! below Silero's enter threshold and be dropped entirely. This normalizer
//! corrects each frame toward a consistent loudness BEFORE the VAD, so the
//! gate thresholds mean the same thing for every remote participant.
//!
//! The mic ("Me") lane is deliberately NOT normalized: it already runs through
//! the macOS VoiceProcessingIO AGC; stacking a second gain loop with a
//! different time constant is a classic pumping recipe.
//!
//! Design (2026-07-14-stt-improvements-design.md, addendum section 12): gated
//! short-term R128 with a measure/gate split. The 3 s short-term loudness
//! drives the gain (adapts per speaker turn, immune to syllable-rate pumping);
//! the 400 ms momentary loudness gates whether the gain may UPDATE at all
//! (closes within ~400 ms of a pause, long before a 3 s window reads silence,
//! so gain never winds up between turns).

use std::sync::atomic::{AtomicBool, Ordering};

use ebur128::{EbuR128, Mode};

use crate::audio::SAMPLE_RATE;

/// Kill switch. A compile-time constant, not a user setting: if normalization
/// interacts badly with Silero or Parakeet in the field, reverting is this
/// one-line change — no UI, no config surface, no contract impact.
pub const SYSTEM_LOUDNESS_NORMALIZATION: bool = true;

/// The EBU R128 reference level. The goal is consistency into the model, not a
/// particular absolute level; -23 leaves ~20 dB of true-peak headroom, so even
/// a max-boosted quiet source stays far from clipping.
const TARGET_LUFS: f64 = -23.0;
/// Gain updates only while MOMENTARY loudness exceeds this — someone is
/// plausibly speaking right now. The moment it drops below, gain freezes,
/// within ~400 ms of pause onset. Sits well above ebur128's -70 absolute gate
/// and well below quiet speech. Deliberately never evaluated on the short-term
/// measure: a 3 s window still reads ~-26 LUFS 1.5 s into a pause and would
/// let the gain wind toward max boost in every inter-turn gap.
const GATE_LUFS: f64 = -50.0;
/// Gain clamp. Covers the realistic spread of meeting-app output levels while
/// bounding the worst side effect of boosting: noise-floor amplification into
/// Silero. A bounded gain means a bounded shift in VAD behavior, which is what
/// lets the shared 0.5/0.35 gate thresholds stay untouched.
const MAX_BOOST_DB: f32 = 12.0;
const MAX_CUT_DB: f32 = -12.0;
/// Gain moves toward its target by at most this much per 100 ms of audio.
/// Adapts fully to a new +/-12 dB speaker within ~1.2-2.4 s (one conversational
/// turn) but cannot pump within a word. The normalizer has no VAD knowledge,
/// so slew-limiting IS the anti-pump mechanism.
const MAX_SLEW_DB_PER_100MS: f32 = 1.0;
/// Until this much audio has been metered the short-term window is unfilled
/// and the measure is garbage; hold unity gain. Cost: the first utterance of a
/// session may be un-normalized — it degrades to exactly today's behavior.
const STARTUP_UNITY_S: f64 = 3.0;
/// Per-frame peak guard: if the post-gain peak of a frame would exceed this,
/// that frame's APPLIED gain is scaled down to fit. The smoothed gain state is
/// not updated by this — transparent limiting, no waveshaping color.
const CLIP_CEIL: f32 = 0.99;

/// Stateful gated-R128 normalizer. One instance per system-lane capture,
/// living beside the `Resampler` in `AudioOutput` (audio/system.rs).
pub struct LoudnessNormalizer {
    /// One meter, two readings: Mode::M (momentary, the gate) | Mode::S
    /// (short-term, the level measure).
    meter: EbuR128,
    /// Smoothed gain in dB, slewed toward the gated target. 0.0 = unity.
    gain_db: f32,
    /// Total samples metered, for the startup-unity window.
    samples_seen: u64,
}

impl LoudnessNormalizer {
    pub fn new() -> anyhow::Result<Self> {
        let meter = EbuR128::new(1, SAMPLE_RATE, Mode::M | Mode::S)
            .map_err(|e| anyhow::anyhow!("ebur128 init failed: {e}"))?;
        Ok(Self {
            meter,
            gain_db: 0.0,
            samples_seen: 0,
        })
    }

    /// Smoothed gain in dB (observability for tests; 0.0 = unity).
    pub fn gain_db(&self) -> f32 {
        self.gain_db
    }

    /// Normalize one 16 kHz mono frame in place. Total: every input frame
    /// produces an output frame of the same length under all conditions —
    /// meter errors and non-finite loudness read as "gate closed" (gain
    /// freezes, audio passes at the frozen gain).
    pub fn process(&mut self, frame: &mut [f32]) {
        if !SYSTEM_LOUDNESS_NORMALIZATION || frame.is_empty() {
            return;
        }

        // The startup check uses the count BEFORE this frame, so the frame
        // that completes the window still passes at unity and normalization
        // starts on the next one — "the first 3 s pass through bit-identical".
        let in_startup = (self.samples_seen as f64) < STARTUP_UNITY_S * f64::from(SAMPLE_RATE);

        let metered = match self.meter.add_frames_f32(frame) {
            Ok(()) => true,
            Err(e) => {
                // One-shot log (mirrors the resampler): pass the audio through
                // at the frozen gain rather than dropping the frame.
                static LOGGED: AtomicBool = AtomicBool::new(false);
                if !LOGGED.swap(true, Ordering::Relaxed) {
                    eprintln!("[normalize] ebur128 add_frames failed: {e}; gain frozen");
                }
                false
            }
        };
        self.samples_seen += frame.len() as u64;

        if in_startup {
            return; // bit-identical passthrough; gain_db stays 0.0
        }

        if metered {
            // Gate on MOMENTARY loudness: update the desired gain only while
            // someone is plausibly speaking right now. Non-finite or absent
            // readings count as gate-closed (freeze).
            let momentary = self.meter.loudness_momentary().unwrap_or(f64::NEG_INFINITY);
            if momentary.is_finite() && momentary >= GATE_LUFS {
                let short_term = self.meter.loudness_shortterm().unwrap_or(f64::NEG_INFINITY);
                if short_term.is_finite() {
                    let desired =
                        ((TARGET_LUFS - short_term) as f32).clamp(MAX_CUT_DB, MAX_BOOST_DB);
                    // Slew toward the target, scaled by this frame's duration.
                    let max_step =
                        MAX_SLEW_DB_PER_100MS * (frame.len() as f32 / (SAMPLE_RATE as f32 * 0.1));
                    self.gain_db += (desired - self.gain_db).clamp(-max_step, max_step);
                }
            }
        }

        let lin = 10f32.powf(self.gain_db / 20.0);
        // Clip guard: scale THIS frame's applied gain to keep the peak under
        // CLIP_CEIL; the smoothed gain state is not touched. No division by
        // measured loudness anywhere — gain is always a clamped, slewed value.
        let peak = frame.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        let applied = if peak * lin > CLIP_CEIL {
            CLIP_CEIL / peak
        } else {
            lin
        };
        for s in frame.iter_mut() {
            *s *= applied;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 100 ms (1600-sample) frame of 220 Hz sine at `db_fs` dBFS peak.
    fn frame_at(db_fs: f32) -> Vec<f32> {
        let amp = 10f32.powf(db_fs / 20.0);
        (0..1600)
            .map(|i| amp * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / 16_000.0).sin())
            .collect()
    }

    fn silence_frame() -> Vec<f32> {
        vec![0.0f32; 1600]
    }

    fn rms(frame: &[f32]) -> f32 {
        (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt()
    }

    #[test]
    fn quiet_sine_is_boosted_toward_target() {
        let mut n = LoudnessNormalizer::new().unwrap();
        // 8 s of -40 dBFS (~-43 LUFS): the desired correction (~+20 dB) clamps
        // at MAX_BOOST_DB.
        let mut rms_series = Vec::new();
        let mut gain_series = Vec::new();
        for _ in 0..80 {
            let mut f = frame_at(-40.0);
            n.process(&mut f);
            rms_series.push(rms(&f));
            gain_series.push(n.gain_db());
        }
        // After the 3 s startup window (30 frames) the gain and output RMS
        // rise monotonically toward the clamp and never exceed it.
        for w in gain_series[30..].windows(2) {
            assert!(
                w[1] >= w[0] - 1e-6,
                "gain must not fall: {} -> {}",
                w[0],
                w[1]
            );
        }
        for w in rms_series[30..].windows(2) {
            assert!(w[1] >= w[0] - 1e-6, "output RMS must rise monotonically");
        }
        let last = *gain_series.last().unwrap();
        assert!(
            last >= 11.0,
            "gain should approach MAX_BOOST_DB, got {last}"
        );
        assert!(gain_series.iter().all(|g| *g <= MAX_BOOST_DB + 1e-4));
    }

    #[test]
    fn hot_sine_is_cut_toward_target() {
        let mut n = LoudnessNormalizer::new().unwrap();
        // 8 s of -6 dBFS (~-9 LUFS): desired correction (~-14 dB) clamps at
        // MAX_CUT_DB.
        for _ in 0..80 {
            let mut f = frame_at(-6.0);
            n.process(&mut f);
        }
        let g = n.gain_db();
        assert!(g < 0.0, "hot input must be cut, got {g}");
        assert!(g >= MAX_CUT_DB - 1e-4, "cut bounded by MAX_CUT_DB, got {g}");
        assert!(
            g <= MAX_CUT_DB + 1.0,
            "cut should approach the clamp, got {g}"
        );
    }

    #[test]
    fn silence_never_blows_up() {
        let mut n = LoudnessNormalizer::new().unwrap();
        // 10 s of digital silence: output stays zero, gain stays unity (the
        // gate never opens), nothing goes non-finite.
        for _ in 0..100 {
            let mut f = silence_frame();
            n.process(&mut f);
            assert!(f.iter().all(|s| *s == 0.0), "silence must stay silence");
            assert!(f.iter().all(|s| s.is_finite()));
        }
        assert_eq!(
            n.gain_db(),
            0.0,
            "gate never opens on silence; gain stays unity"
        );
    }

    #[test]
    fn gain_freezes_below_gate() {
        let mut n = LoudnessNormalizer::new().unwrap();
        // 5 s of -30 dBFS speech-level tone (~-33 LUFS): past startup the gain
        // adapts upward toward roughly +10 dB — deliberately BELOW the clamp,
        // so any wind-up toward MAX_BOOST_DB during silence would be visible.
        for _ in 0..50 {
            let mut f = frame_at(-30.0);
            n.process(&mut f);
        }
        let at_pause = n.gain_db();
        assert!(
            at_pause > 0.0,
            "gain should have adapted upward during speech"
        );

        // 3 s of digital silence. The 400 ms momentary window still contains
        // speech for its first ~4 frames; by 500 ms it reads silence and the
        // gate MUST be closed. (Only implementable because the gate signal is
        // momentary: the 3 s short-term measure still reads ~-26 LUFS 1.5 s
        // into the pause, so a short-term-gated design could not pass this.)
        let mut gains = Vec::new();
        for _ in 0..30 {
            let mut f = silence_frame();
            n.process(&mut f);
            gains.push(n.gain_db());
        }
        let frozen = gains[4]; // gain after 500 ms of silence
        for (i, g) in gains.iter().enumerate().skip(5) {
            assert_eq!(
                *g, frozen,
                "gain must be exactly flat after the gate closes (frame {i})"
            );
        }
        assert!(
            frozen < MAX_BOOST_DB,
            "frozen gain must not wind toward MAX_BOOST_DB"
        );
    }

    #[test]
    fn slew_is_bounded() {
        let mut n = LoudnessNormalizer::new().unwrap();
        // 4 s at -40 dBFS, then a 30 dB upward step to -10 dBFS: the gain may
        // never move more than MAX_SLEW_DB_PER_100MS per 100 ms frame, in
        // either direction, anywhere in the run.
        let mut prev = n.gain_db();
        for i in 0..100 {
            let mut f = frame_at(if i < 40 { -40.0 } else { -10.0 });
            n.process(&mut f);
            let g = n.gain_db();
            assert!(
                (g - prev).abs() <= MAX_SLEW_DB_PER_100MS + 1e-3,
                "gain stepped {} dB in one 100 ms frame",
                (g - prev).abs()
            );
            prev = g;
        }
    }

    #[test]
    fn clip_guard_holds_ceiling() {
        let mut n = LoudnessNormalizer::new().unwrap();
        // Wind the gain to the boost clamp on quiet input...
        for _ in 0..60 {
            let mut f = frame_at(-40.0);
            n.process(&mut f);
        }
        assert!(n.gain_db() >= 11.0, "precondition: gain near MAX_BOOST_DB");
        // ...then a near-full-scale burst arrives while boosted.
        let mut burst = frame_at(-1.0);
        n.process(&mut burst);
        assert!(
            burst.iter().all(|s| s.abs() <= CLIP_CEIL + 1e-6),
            "no output sample may exceed CLIP_CEIL"
        );
        // The clip guard scales only THIS frame's applied gain; the smoothed
        // state moved by at most one ordinary slew step.
        assert!(n.gain_db() >= 11.0 - MAX_SLEW_DB_PER_100MS - 1e-3);
    }

    #[test]
    fn unity_during_startup() {
        let mut n = LoudnessNormalizer::new().unwrap();
        // The first 3 s of any input (30 x 100 ms frames) pass through
        // bit-identical at exactly unity gain.
        for _ in 0..30 {
            let original = frame_at(-30.0);
            let mut f = original.clone();
            n.process(&mut f);
            assert_eq!(f, original, "startup frames must be bit-identical");
            assert_eq!(n.gain_db(), 0.0, "gain is exactly unity during startup");
        }
    }
}
