# demo_muesli MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A macOS Tauri app that captures the user's mic and the meeting's system audio, transcribes each independently with Parakeet v3 (VAD-segmented streaming), shows live Me/Them lanes, and writes finalized lines to a new markdown file.

**Architecture:** Two capture sources (cpal mic, ScreenCaptureKit system audio) each resample to 16 kHz mono and feed a per-source STT worker. A worker runs a `Vad` to segment utterances and an `SttEngine` (Parakeet v3 via `parakeet-rs`/ONNX) to produce rolling partials + full-context finals, emitted through an `Emitter`. The app fans emitted events to two consumers: the Svelte UI and a markdown file sink. Engine and VAD are traits so the worker is testable with fakes and the engine is swappable later.

**Tech Stack:** Tauri 2, Svelte 5 + Vite + TypeScript, Rust (edition 2021), cpal, rubato, `voice_activity_detector` (Silero), `parakeet-rs` (ONNX Runtime / `ort`, CPU), `screencapturekit`, pnpm.

## Global Constraints

- Platform: **macOS first** (system audio via ScreenCaptureKit is macOS-only). The app must still compile and run mic-only on macOS before system audio exists.
- Frontend: **Svelte 5 + Vite + TypeScript**, SPA (no SvelteKit SSR). Package manager **pnpm**.
- Audio interchange format everywhere downstream of a source: **16 kHz, mono, `f32`**.
- STT engine on macOS uses the **CPU** ONNX execution provider (CoreML is broken for Parakeet).
- Model: **`parakeet-tdt-0.6b-v3` int8 ONNX**, resolved from app-data, downloaded on first run if absent. Never commit model files (already gitignored: `*.onnx`, `models/`).
- Transcript event payload (Rust-serialized, TS-consumed) is exactly: `{ source: "me" | "them", text: string, t0: number, t1: number, utteranceId: number }` where `t0`/`t1` are elapsed **seconds** from session start.
- Output markdown: `~/Documents/muesli-transcripts/meeting-YYYY-MM-DD-HHMM.md`, one line per **final** (partials never written), flushed after each line.
- Commits: clean messages, **no AI-attribution trailer** (Julian's repo preference). Build happens on a `build/mvp` branch off `main`.
- TDD: write the failing test first where the unit is deterministic (resample, markdown sink, worker-with-fakes, frontend store, VAD on fixtures). Integration-only units (cpal mic, real Parakeet inference, ScreenCaptureKit) get a smoke/manual verification step instead, clearly marked.
- Third-party crate APIs (`parakeet-rs`, `screencapturekit`, `voice_activity_detector`) MUST be verified against docs.rs / crate source / the reference app at `~/Code/Handy` before writing calls — do not invent signatures. Each such task starts with a verification step.

---

## File Structure

```
demo_muesli/
├── package.json, pnpm-lock.yaml, vite.config.ts, tsconfig.json, svelte.config.js, index.html
├── src/                              # Svelte frontend
│   ├── main.ts
│   ├── App.svelte
│   └── lib/
│       ├── types.ts                  # TranscriptEvent type (mirrors Rust payload)
│       ├── events.ts                 # Tauri event subscriptions
│       ├── transcript.svelte.ts      # reactive transcript store (keyed by source+utteranceId)
│       └── TranscriptLane.svelte     # renders one source's lines
└── src-tauri/
    ├── Cargo.toml, tauri.conf.json, build.rs
    ├── entitlements / Info.plist additions (mic + screen recording usage strings)
    └── src/
        ├── main.rs, lib.rs           # Tauri wiring, app state
        ├── commands.rs               # start_capture, stop_capture, check_permissions, ensure_model, reveal_output
        ├── audio/
        │   ├── mod.rs                # Frame channel types, Source enum, SAMPLE_RATE
        │   ├── resample.rs           # rubato → 16kHz mono f32
        │   ├── vad.rs                # Vad trait + Silero impl + FixedVad (test fake lives in tests)
        │   ├── mic.rs                # cpal capture source
        │   └── system.rs             # ScreenCaptureKit capture source (added last)
        ├── stt/
        │   ├── mod.rs
        │   ├── engine.rs             # SttEngine trait
        │   ├── parakeet.rs           # SttEngine impl over parakeet-rs
        │   ├── model.rs              # model path resolution + download
        │   └── worker.rs             # per-source orchestration; Emitter trait
        └── output/
            └── markdown.rs           # markdown file sink
```

---

## Task 1: Scaffold Tauri 2 + Svelte 5 + module skeleton

**Files:**
- Create: whole project via scaffolder, then prune to the structure above
- Create: `src-tauri/src/audio/mod.rs`, `src-tauri/src/stt/mod.rs`, `src-tauri/src/stt/engine.rs`, `src-tauri/src/output/markdown.rs` (stubs)
- Modify: `src-tauri/src/lib.rs` to declare modules
- Test: `cargo test` (compiles), `pnpm check`

**Interfaces:**
- Produces:
  - `audio::SAMPLE_RATE: u32 = 16_000`
  - `audio::Source` enum `{ Me, Them }` with `fn label(&self) -> &'static str` → `"me"`/`"them"`
  - `audio::FrameSender` / `audio::FrameReceiver` type aliases over `std::sync::mpsc` of `Vec<f32>`
  - `stt::engine::SttEngine` trait (signatures below)
  - `output::markdown` module present (impl in Task 3)

- [ ] **Step 1: Scaffold the app**

Run from `/Users/julianbeaulieu/Code/demo_muesli` (note: dir already contains `docs/` and git history — scaffold into a temp dir then move files in, or use the current dir if the tool allows non-empty):
```bash
cd /Users/julianbeaulieu/Code/demo_muesli
git checkout -b build/mvp
pnpm create tauri-app@latest tmp-scaffold -- --template svelte-ts --manager pnpm --yes
# Move generated files (src/, src-tauri/, configs) into repo root, then remove tmp-scaffold/
rsync -a tmp-scaffold/ ./ && rm -rf tmp-scaffold
pnpm install
```
Expected: a `src/` (Svelte 5 + TS) and `src-tauri/` (Tauri 2) exist. Verify Svelte major version is 5 in `package.json`; if the template pins 4, upgrade to `svelte@^5`.

- [ ] **Step 2: Create the module skeleton**

`src-tauri/src/audio/mod.rs`:
```rust
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

pub mod resample;
pub mod vad;
pub mod mic;
```
(Leave `pub mod system;` commented until Task 11. Create empty `resample.rs`, `vad.rs`, `mic.rs` with `// impl in later task` so it compiles, or gate modules so the crate builds.)

`src-tauri/src/stt/mod.rs`:
```rust
pub mod engine;
pub mod parakeet;
pub mod model;
pub mod worker;
```

`src-tauri/src/stt/engine.rs`:
```rust
/// Speech-to-text engine. One instance per audio source.
/// Implementations are full-context: `transcribe_partial` runs on the
/// in-progress utterance buffer (called repeatedly, must be cheap),
/// `transcribe_final` runs once on the complete utterance.
pub trait SttEngine: Send {
    fn transcribe_partial(&mut self, samples: &[f32]) -> anyhow::Result<String>;
    fn transcribe_final(&mut self, samples: &[f32]) -> anyhow::Result<String>;
}
```

Create `stt/parakeet.rs`, `stt/model.rs`, `stt/worker.rs`, `output/markdown.rs` as empty stubs (`// impl in later task`). Add `mod stt; mod output;` and `pub mod audio;` to `lib.rs`.

- [ ] **Step 3: Add dependencies to `src-tauri/Cargo.toml`**

```toml
anyhow = "1"
crossbeam-channel = "0.5"   # if preferred over std mpsc; otherwise omit
rubato = "0.16"
cpal = "0.15"
voice_activity_detector = "0.2"
serde = { version = "1", features = ["derive"] }
# parakeet-rs and screencapturekit added in their own tasks after API verification
```
(Pin versions to whatever resolves; record the resolved versions in the commit.)

- [ ] **Step 4: Verify it builds and runs**

Run:
```bash
cargo build --manifest-path src-tauri/Cargo.toml
pnpm check
pnpm tauri dev   # confirm an empty window opens, then quit
```
Expected: builds clean; window opens.

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "scaffold: Tauri 2 + Svelte 5 app with module skeleton"
```

---

## Task 2: Resampler (rubato → 16 kHz mono)

**Files:**
- Create/impl: `src-tauri/src/audio/resample.rs`
- Test: inline `#[cfg(test)]` in the same file

**Interfaces:**
- Produces: `Resampler::new(input_rate: u32, input_channels: u16) -> Self`; `fn process(&mut self, interleaved: &[f32]) -> Vec<f32>` returning 16 kHz mono f32. Downmix multi-channel by averaging; resample rate to 16 kHz.

- [ ] **Step 1: Write the failing test**
```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml resample`
Expected: FAIL (Resampler not defined).

- [ ] **Step 3: Implement**

Implement `Resampler` using `rubato` (verify `rubato 0.16` API on docs.rs first: `SincFixedIn` or `FftFixedIn` constructor signature). Approach:
1. De-interleave + downmix to mono by averaging channels.
2. If `input_rate == 16_000`, skip resampling (return downmixed mono).
3. Else feed mono through a rubato resampler with ratio `16_000 / input_rate`, buffering remainder samples between calls (rubato is chunk-based; keep an internal leftover buffer).

Write the real implementation (no placeholder). Handle the variable input length by maintaining an internal `leftover: Vec<f32>` of mono samples not yet consumed by a full rubato chunk.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml resample`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat(audio): rubato resampler to 16kHz mono"
```

---

## Task 3: Markdown sink

**Files:**
- Create/impl: `src-tauri/src/output/markdown.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Consumes: `audio::Source`.
- Produces:
  - `MarkdownSink::create_in(dir: &std::path::Path, started: &str) -> anyhow::Result<MarkdownSink>` — creates `meeting-<started>.md` (where `started` is the `YYYY-MM-DD-HHMM` stamp) with a header, returns the sink holding the open file + path.
  - `fn append_final(&mut self, source: Source, text: &str, t0_secs: f64) -> anyhow::Result<()>` — appends one formatted line and flushes.
  - `fn path(&self) -> &std::path::Path`.

- [ ] **Step 1: Write the failing test**
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::Source;

    #[test]
    fn writes_header_and_one_line_per_final() {
        let dir = tempfile::tempdir().unwrap();
        let mut sink = MarkdownSink::create_in(dir.path(), "2026-06-23-1432").unwrap();
        sink.append_final(Source::Them, "Hi everyone.", 1.0).unwrap();
        sink.append_final(Source::Me, "Hello.", 6.0).unwrap();
        let body = std::fs::read_to_string(sink.path()).unwrap();
        assert!(body.starts_with("# Meeting — 2026-06-23-1432\n"));
        assert!(body.contains("**Them** (00:01): Hi everyone.\n"));
        assert!(body.contains("**Me** (00:06): Hello.\n"));
    }
}
```
Add `tempfile = "3"` to `[dev-dependencies]`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml markdown`
Expected: FAIL.

- [ ] **Step 3: Implement**

Implement `MarkdownSink`:
- `create_in`: `std::fs::create_dir_all(dir)`, open file `meeting-<started>.md` for write, write `format!("# Meeting — {started}\n\n")`, flush, store `File` + `PathBuf`.
- `append_final`: format elapsed `t0_secs` as `MM:SS` (`let s = t0_secs as u64; format!("{:02}:{:02}", s/60, s%60)`), capitalize source label (`Me`/`Them`), write `**{Label}** ({mmss}): {text}\n`, flush.
- `path`: return `&self.path`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml markdown`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat(output): markdown session sink"
```

---

## Task 4: Worker orchestration (with fakes) + Emitter & Vad traits

**Files:**
- Impl: `src-tauri/src/stt/worker.rs`
- Impl (trait only): `src-tauri/src/audio/vad.rs` — add the `Vad` trait + `VadEvent` enum here (Silero impl in Task 6)
- Test: inline `#[cfg(test)]` in `worker.rs` with a fake `SttEngine`, fake `Vad`, and capturing `Emitter`

**Interfaces:**
- Consumes: `audio::{FrameReceiver, Source, SAMPLE_RATE}`, `stt::engine::SttEngine`, `audio::vad::{Vad, VadEvent}`.
- Produces:
  - `audio::vad::Vad` trait: `fn accept(&mut self, samples: &[f32]) -> VadEvent;`
  - `audio::vad::VadEvent` enum: `Silence`, `SpeechStarted`, `Speaking`, `SpeechEnded`.
  - `stt::worker::TranscriptEvent { source: Source, text: String, t0: f64, t1: f64, utterance_id: u64 }` (serde `Serialize`, renamed fields to match payload: `source` serializes as its `label()` string — use a custom serialize or map to a `&str` field).
  - `stt::worker::Emitter` trait: `fn partial(&self, e: &TranscriptEvent); fn final_(&self, e: &TranscriptEvent);`
  - `stt::worker::run_worker(source: Source, rx: FrameReceiver, vad: Box<dyn Vad>, engine: Box<dyn SttEngine>, emitter: Arc<dyn Emitter>, started: Instant, partial_interval: Duration)` — blocking loop; returns when `rx` disconnects.

- [ ] **Step 1: Write the failing test**
```rust
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
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml worker`
Expected: FAIL (run_worker/Emitter/Vad not defined).

- [ ] **Step 3: Implement the worker + traits**

`audio/vad.rs` (trait + enum only this task):
```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VadEvent { Silence, SpeechStarted, Speaking, SpeechEnded }

pub trait Vad: Send {
    fn accept(&mut self, samples: &[f32]) -> VadEvent;
}
```

`stt/worker.rs` logic:
- Maintain `buffer: Vec<f32>`, `utterance_id: u64 = 0`, `speaking_samples_since_partial: usize`.
- For each `frame` received from `rx`:
  - `match vad.accept(&frame)`:
    - `SpeechStarted` → clear buffer, extend with frame, record `t0 = started.elapsed()`.
    - `Speaking` → extend buffer with frame; if elapsed-since-last-partial ≥ `partial_interval` (track via accumulated samples → seconds, or an `Instant`), call `engine.transcribe_partial(&buffer)`, build `TranscriptEvent` (t1 = now), `emitter.partial(&e)`.
    - `SpeechEnded` → extend buffer with frame; `engine.transcribe_final(&buffer)`; emit `emitter.final_(&e)` with `t0`/`t1`; `utterance_id += 1`; clear buffer.
    - `Silence` → ignore.
- On `rx` disconnect: if buffer non-empty (mid-utterance), finalize it.
- `TranscriptEvent` derives `Clone` and `Serialize`. To serialize `source` as the label string, add `#[derive(Serialize)]` with a helper: store `source: Source` but implement `Serialize` manually OR add `#[serde(serialize_with)]`. Simplest: give `TranscriptEvent` a `source_label: &'static str` populated from `source.label()` and `#[serde(rename = "source")]`, plus `#[serde(rename = "utteranceId")] utterance_id`. Match the Global Constraints payload exactly: keys `source`, `text`, `t0`, `t1`, `utteranceId`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml worker`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat(stt): worker orchestration with Vad/Emitter traits (fakes-tested)"
```

---

## Task 5: Silero VAD implementation

**Files:**
- Impl: `src-tauri/src/audio/vad.rs` (add `SileroVad` implementing `Vad`)
- Test: inline `#[cfg(test)]` with synthetic silence vs. tone fixtures

**Interfaces:**
- Consumes: `Vad`, `VadEvent` (Task 4).
- Produces: `SileroVad::new() -> anyhow::Result<SileroVad>` (loads the bundled Silero ONNX via `voice_activity_detector`); implements `Vad`. Internally tracks speech/silence state with hysteresis (N consecutive speech frames → `SpeechStarted`/`Speaking`; M consecutive silence frames after speech → `SpeechEnded`).

- [ ] **Step 1: Verify the crate API**

Read docs.rs for `voice_activity_detector` (current version): confirm constructor, required chunk size (it typically needs fixed sample-count chunks, e.g. 512 samples @ 16 kHz), and the predict call returning a probability `f32`. Note the required chunk size — the worker feeds arbitrary frame lengths, so `SileroVad::accept` must internally re-chunk into the VAD's required window and aggregate.

- [ ] **Step 2: Write the failing test**
```rust
#[cfg(test)]
mod silero_tests {
    use super::*;

    fn silence(n: usize) -> Vec<f32> { vec![0.0; n] }
    fn tone(n: usize) -> Vec<f32> {
        (0..n).map(|i| (i as f32 * 0.1).sin() * 0.5).collect()
    }

    #[test]
    fn silence_never_starts_speech() {
        let mut v = SileroVad::new().unwrap();
        let mut started = false;
        for _ in 0..20 {
            if matches!(v.accept(&silence(1600)), VadEvent::SpeechStarted) { started = true; }
        }
        assert!(!started);
    }

    #[test]
    fn tone_then_silence_yields_one_speech_then_end() {
        let mut v = SileroVad::new().unwrap();
        let mut starts = 0; let mut ends = 0;
        for _ in 0..10 { if matches!(v.accept(&tone(1600)), VadEvent::SpeechStarted) { starts += 1; } }
        for _ in 0..10 { if matches!(v.accept(&silence(1600)), VadEvent::SpeechEnded) { ends += 1; } }
        assert_eq!(starts, 1, "exactly one speech onset");
        assert_eq!(ends, 1, "exactly one speech end");
    }
}
```
Note: Silero may not classify a pure sine as speech. If empirically it doesn't, replace `tone()` with a short bundled real speech WAV fixture (add `tests/fixtures/speech_1s_16k.wav`, load via `hound`) and adjust. Decide during implementation based on observed probabilities; keep the *assertions* (one onset, one end).

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml silero`
Expected: FAIL.

- [ ] **Step 4: Implement `SileroVad`**

- Construct the `voice_activity_detector` predictor (sample rate 16 kHz, the chunk size it requires).
- `accept`: append incoming samples to an internal buffer; while ≥ chunk size, take a chunk, predict probability, push into a small smoothing window. Maintain state machine: threshold ~0.5; `speech_frames`/`silence_frames` counters with hysteresis (e.g. onset after 2 speech chunks, end after ~8 silence chunks ≈ ~0.25s). Return the appropriate `VadEvent` for this `accept` call (the highest-priority transition observed; otherwise `Speaking`/`Silence`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml silero`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add -A && git commit -m "feat(audio): Silero VAD with hysteresis segmentation"
```

---

## Task 6: Model resolution + download

**Files:**
- Impl: `src-tauri/src/stt/model.rs`
- Test: inline `#[cfg(test)]` for path logic (not the network download)

**Interfaces:**
- Produces:
  - `model::ParakeetPaths { encoder, decoder, joiner, tokens, ... }` — whatever file set `parakeet-rs` requires (verify in Task 7 first; this task may be merged into Task 7 if the path set depends on the crate). Minimum: `fn resolve(app_data: &Path) -> ParakeetPaths` and `fn is_present(&self) -> bool`.
  - `async fn ensure(app_data: &Path, progress: impl Fn(u64, u64)) -> anyhow::Result<ParakeetPaths>` — downloads the int8 ONNX artifact set to `app_data/models/parakeet-tdt-0.6b-v3/` if absent.

- [ ] **Step 1: Determine the artifact set & URL**

From Task 7's verification of `parakeet-rs`, determine which ONNX files the crate loads (encoder/decoder/joiner/tokens, or a single bundle) and a download source (e.g. a Hugging Face repo of int8 ONNX exports, such as `istupakov/parakeet-tdt-0.6b-v3-onnx`, or the same artifacts `~/Code/Handy` fetches). Record exact filenames + URLs. If `parakeet-rs` exposes its own download helper, prefer that and make `ensure` a thin wrapper.

- [ ] **Step 2: Write the failing test (path logic only)**
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn is_present_false_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let p = ParakeetPaths::resolve(dir.path());
        assert!(!p.is_present());
    }
}
```

- [ ] **Step 3–4: Implement & verify**

Implement `resolve`/`is_present` (pure path checks) and `ensure` (download with progress via `reqwest` blocking or `ureq` + a simple byte-counter; add the dep). Verify the path test passes; manually run `ensure` once to confirm a real download lands the files.

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat(stt): parakeet model resolution + first-run download"
```

---

## Task 7: Parakeet engine implementation

**Files:**
- Impl: `src-tauri/src/stt/parakeet.rs`
- Test: gated integration test (`#[ignore]` unless model present) transcribing a known WAV

**Interfaces:**
- Consumes: `SttEngine` trait, `model::ParakeetPaths`.
- Produces: `ParakeetEngine::load(paths: &ParakeetPaths) -> anyhow::Result<ParakeetEngine>` implementing `SttEngine` (both methods run a full-context transcribe on the provided samples; CPU EP).

- [ ] **Step 1: Verify the `parakeet-rs` API**

Read `parakeet-rs` on docs.rs / its GitHub (`altunenes/parakeet-rs`) and cross-check `~/Code/Handy`'s `transcribe-rs` Parakeet usage. Determine: how to load the v3 model, the transcribe call signature (input sample format — expects 16 kHz mono f32), how to force the CPU execution provider, and whether int8 is selected by file or flag. Add `parakeet-rs = "<resolved>"` to `Cargo.toml`. Write down the real call sequence before coding.

- [ ] **Step 2: Write the gated integration test**
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::stt::{engine::SttEngine, model::ParakeetPaths};

    #[test]
    #[ignore = "requires downloaded model + fixture WAV"]
    fn transcribes_known_clip() {
        let app_data = directories_path_for_test();   // helper: use a fixed local models dir
        let paths = ParakeetPaths::resolve(&app_data);
        assert!(paths.is_present(), "run model download first");
        let mut eng = ParakeetEngine::load(&paths).unwrap();
        let samples = load_wav_16k_mono("tests/fixtures/hello_16k.wav");
        let text = eng.transcribe_final(&samples).unwrap().to_lowercase();
        assert!(text.contains("hello"), "got: {text}");
    }
}
```
Add a small real `hello_16k.wav` fixture (record or generate) saying a known word.

- [ ] **Step 3: Implement `ParakeetEngine`**

Load the model per the verified API into a struct; implement `transcribe_partial`/`transcribe_final` (both call the crate's transcribe on `samples`). Ensure CPU EP. Keep the model loaded across calls (load once in `load`).

- [ ] **Step 4: Verify**

Run (after `model::ensure` has fetched the model):
```bash
cargo test --manifest-path src-tauri/Cargo.toml parakeet -- --ignored
```
Expected: PASS (transcript contains the known word).

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat(stt): Parakeet v3 engine over parakeet-rs (CPU)"
```

---

## Task 8: Microphone source (cpal)

**Files:**
- Impl: `src-tauri/src/audio/mic.rs`
- Test: smoke (manual) — no deterministic unit test for live capture

**Interfaces:**
- Consumes: `audio::{FrameSender, SAMPLE_RATE}`, `resample::Resampler`.
- Produces: `mic::start(tx: FrameSender) -> anyhow::Result<MicHandle>` — opens the default input device, spawns capture, resamples each callback buffer to 16 kHz mono, sends `Vec<f32>` frames on `tx`. `MicHandle` stops capture on drop.

- [ ] **Step 1: Verify cpal default-input pattern**

Confirm the cpal 0.15 default input stream pattern (host → default_input_device → default_input_config → build_input_stream with an f32 callback; handle non-f32 sample formats by converting). The callback must not block: do resample + `tx.send` (cheap) only.

- [ ] **Step 2: Implement `mic::start`**

Open default input device + config; create a `Resampler::new(config.sample_rate, config.channels)`; in the data callback, convert/copy samples to `&[f32]`, `resampler.process(...)`, `tx.send(frame)`. Store the `Stream` in `MicHandle` so dropping it stops capture. Add `Info.plist` `NSMicrophoneUsageDescription` (Task 10 wiring).

- [ ] **Step 3: Smoke-verify**

Add a temporary `#[ignore]` test or a tiny example that starts the mic for 2s and asserts ≥1 frame arrives on the receiver with the expected length multiple. Run manually:
```bash
cargo test --manifest-path src-tauri/Cargo.toml mic_smoke -- --ignored
```
Expected: frames received (grant mic permission when prompted).

- [ ] **Step 4: Commit**
```bash
git add -A && git commit -m "feat(audio): cpal microphone source"
```

---

## Task 9: Frontend — transcript store, events, UI

**Files:**
- Create: `src/lib/types.ts`, `src/lib/transcript.svelte.ts`, `src/lib/events.ts`, `src/lib/TranscriptLane.svelte`
- Modify: `src/App.svelte`
- Test: `src/lib/transcript.test.ts` (vitest)

**Interfaces:**
- Consumes: Tauri events `transcript://partial`, `transcript://final` with the payload from Global Constraints; commands `start_capture`, `stop_capture`, `check_permissions`, `reveal_output` (Task 10).
- Produces: a reactive store with `applyPartial(e)`, `applyFinal(e)`, and per-source ordered line lists.

- [ ] **Step 1: Write the failing store test**
```ts
import { describe, it, expect } from 'vitest';
import { createTranscriptStore } from './transcript.svelte';

const ev = (source: 'me'|'them', text: string, utteranceId: number) =>
  ({ source, text, t0: 0, t1: 1, utteranceId });

describe('transcript store', () => {
  it('promotes a partial to a final for the same source+utteranceId', () => {
    const s = createTranscriptStore();
    s.applyPartial(ev('me', 'hel', 0));
    s.applyFinal(ev('me', 'hello', 0));
    const meLines = s.lines('me');
    expect(meLines).toHaveLength(1);
    expect(meLines[0].text).toBe('hello');
    expect(meLines[0].final).toBe(true);
  });

  it('keeps me and them lanes separate', () => {
    const s = createTranscriptStore();
    s.applyFinal(ev('me', 'a', 0));
    s.applyFinal(ev('them', 'b', 0));
    expect(s.lines('me')).toHaveLength(1);
    expect(s.lines('them')).toHaveLength(1);
  });
});
```
Add vitest to devDeps + a `test` script if absent.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run`
Expected: FAIL.

- [ ] **Step 3: Implement the store**

`types.ts`: `export interface TranscriptEvent { source: 'me'|'them'; text: string; t0: number; t1: number; utteranceId: number }`.
`transcript.svelte.ts`: `createTranscriptStore()` holding `$state` maps keyed by `${source}:${utteranceId}`; `applyPartial` upserts a line `{text, final:false}`; `applyFinal` upserts `{text, final:true}`; `lines(source)` returns that source's lines sorted by utteranceId.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run`
Expected: PASS.

- [ ] **Step 5: Build the UI**

`events.ts`: subscribe via `@tauri-apps/api/event` `listen('transcript://partial' | 'transcript://final')` → store methods.
`TranscriptLane.svelte`: props `{ title, lines }`; render lines, partials greyed (`opacity-60`), finals solid.
`App.svelte`: header with Start/Stop buttons (invoke commands), permission + model status text, output file path with a "Reveal" button (invoke `reveal_output`), and two `TranscriptLane`s (Me / Them). Wire `events.ts` on mount.

- [ ] **Step 6: Commit**
```bash
git add -A && git commit -m "feat(ui): transcript store + Me/Them lanes"
```

---

## Task 10: Commands + app wiring (mic → worker → events + markdown) — single-source end-to-end

**Files:**
- Impl: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
- Modify: `src-tauri/tauri.conf.json`, `Info.plist` (mic usage string), enable required Tauri plugins (e.g. opener for reveal)

**Interfaces:**
- Consumes: everything above.
- Produces: Tauri commands `start_capture`, `stop_capture`, `check_permissions`, `ensure_model`, `reveal_output`. A `TauriEmitter` implementing `Emitter` (emits `transcript://partial`/`final` via `AppHandle`), and a composite that also drives the `MarkdownSink` on finals.

- [ ] **Step 1: Implement the app-level Emitter**

`AppEmitter { app: AppHandle, sink: Arc<Mutex<MarkdownSink>>, started: Instant }`:
- `partial(e)` → `app.emit("transcript://partial", e)`.
- `final_(e)` → `app.emit("transcript://final", e)` then `sink.lock().append_final(e.source, &e.text, e.t0)`.

- [ ] **Step 2: Implement `start_capture`**

- Resolve app-data dir; `ensure_model` must have run (or call it); load `ParakeetEngine`.
- Create the `MarkdownSink` (compute the `YYYY-MM-DD-HHMM` stamp from local time).
- Create an mpsc channel; `mic::start(tx)`.
- Build `SileroVad`, `ParakeetEngine`, `AppEmitter`; spawn `run_worker(Source::Me, rx, vad, engine, emitter, Instant::now(), Duration::from_millis(700))` on a thread.
- Store handles (mic handle, join handles, sink path) in Tauri-managed state so `stop_capture` can tear down.

- [ ] **Step 3: Implement the remaining commands**

- `stop_capture`: drop mic handle, close channels, join workers, flush sink.
- `check_permissions`: report mic (and later screen-recording) authorization status.
- `ensure_model`: call `model::ensure` with progress events (`emit("model://progress", {done,total})`).
- `reveal_output`: open the sink file / its folder via the opener plugin.

- [ ] **Step 4: End-to-end smoke test**

Run `pnpm tauri dev`. Click Start, speak into the mic. Verify: Me lane shows greyed partials that solidify into finals on pause; the markdown file appears under `~/Documents/muesli-transcripts/` and gains a line per finalized utterance; Reveal opens it. Quit cleanly.

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat: wire mic→worker→events+markdown end-to-end (single source)"
```

---

## Task 11: System audio source (ScreenCaptureKit) — second lane

**Files:**
- Impl: `src-tauri/src/audio/system.rs`
- Modify: `src-tauri/src/audio/mod.rs` (enable `pub mod system;`), `commands.rs` (start second worker as `Source::Them`), `Info.plist`/entitlements (screen recording), `check_permissions`
- Test: smoke (manual)

**Interfaces:**
- Consumes: `audio::{FrameSender, SAMPLE_RATE}`, `resample::Resampler`.
- Produces: `system::start(tx: FrameSender) -> anyhow::Result<SystemHandle>` — captures system/app output audio via ScreenCaptureKit, resamples to 16 kHz mono, sends frames; `SystemHandle` stops on drop. Requires Screen Recording permission.

- [ ] **Step 1: Verify the `screencapturekit` crate API**

Read the `screencapturekit` crate (docs.rs / GitHub) for the current API: how to enumerate shareable content, build an `SCStream` with **audio** capture enabled (`SCStreamConfiguration` `capturesAudio`/`sampleRate`/`channelCount`), and receive audio sample buffers via the stream output delegate. Confirm sample format (interleaved f32 or otherwise) and how permission is requested/checked. Add `screencapturekit = "<resolved>"`. Note the macOS deployment target the crate needs and set it in the build config.

- [ ] **Step 2: Implement `system::start`**

Configure an audio-only (or audio-enabled) `SCStream`; in the audio sample-buffer callback, convert to `&[f32]`, resample to 16 kHz mono, `tx.send(frame)`. Store the stream in `SystemHandle`; stop on drop. Handle the permission-denied case by returning a clear error.

- [ ] **Step 3: Wire the second worker**

In `start_capture`: also create a second channel, call `system::start(tx2)`, build a second `SileroVad` + `ParakeetEngine` (or share one engine if `parakeet-rs` is `Send` + cheap to clone/load twice — otherwise load two instances), and spawn `run_worker(Source::Them, rx2, ...)`. The same `AppEmitter` (markdown + UI) handles both; the sink already distinguishes by `Source`. Update `check_permissions` to include screen-recording status and surface guidance if denied.

- [ ] **Step 4: Smoke-verify both lanes**

Run `pnpm tauri dev`, grant Screen Recording (restart app if required), play audio from a meeting/app while speaking. Verify both Me and Them lanes populate and both appear interleaved in the markdown file.

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat(audio): ScreenCaptureKit system-audio source (Them lane)"
```

---

## Self-Review Notes

- **Spec coverage:** mic (T8) + system audio (T11) ✓; two labelled lanes (T4 Source, T9 UI, T11) ✓; resample to 16 kHz mono (T2) ✓; VAD-segmented streaming with partials+finals (T4 worker, T5 Silero) ✓; Parakeet v3 int8 CPU via parakeet-rs (T6 model, T7 engine) ✓; SttEngine trait seam (T1) ✓; markdown sink to new file (T3, T10) ✓; permissions (T10 mic, T11 screen recording) ✓; error handling (per-task: permission/model/engine paths) ✓; tests (T2/T3/T4/T5/T9 deterministic; T7/T8/T11 smoke) ✓; Svelte 5 frontend (T1, T9) ✓.
- **Known integration risks (flagged, with verification steps):** `parakeet-rs` API (T7 step 1), model artifact set/URL (T6 step 1), Silero chunk-size handling (T5 step 1), ScreenCaptureKit audio capture API (T11 step 1). These are the only places exact third-party signatures are deferred to a verification step rather than written blind — per Global Constraints.
- **Type consistency:** `SttEngine::{transcribe_partial,transcribe_final}` used consistently (T1, T4 fake, T7 real); `Vad::accept`/`VadEvent` (T4 def, T5 impl, T4 worker consumer); `TranscriptEvent` payload keys identical across Rust serialize (T4) and TS interface (T9) and Global Constraints; `MarkdownSink::{create_in,append_final,path}` consistent (T3 def, T10 consumer); `Source::label` (T1 def, used T3/T4/T11).
- **Deferred decision:** whether one `ParakeetEngine` can be shared across both workers or two instances are loaded — resolved in T11 step 3 based on the crate's `Send`/threading story.
