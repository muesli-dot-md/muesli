# Backend STT improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contain engine panics, cut wasted partial-decode CPU, bound durable/markdown latency at natural pauses, and lay the phased (spike-first) groundwork for an Apple Neural Engine inference backend — all backend-only, behind the existing `Vad`/`SttEngine`/`Emitter` seams, with the Tauri contract byte-compatible.

**Architecture:** Three quick-win changes land first in the per-lane STT worker and the VAD wrapper (`stt/worker.rs`, `audio/vad.rs`), all unit-testable through fakes with no model and no audio hardware. Then a time-boxed, feature-gated spike stands up a FluidAudio CoreML engine behind the `SttEngine` trait and measures it against go/no-go criteria. Only on a go decision does Phase 3 productionize that backend (feature gate, both-model-sets download with progress, runtime fallback matrix, warm slots), keeping the CPU ONNX engine as the unconditional fallback.

**Tech Stack:** Rust (edition 2021), Tauri 2, `transcribe-rs` (Parakeet int8 ONNX / `ort`, CPU), vendored `voice_activity_detector` (Silero), `std::panic::catch_unwind`; Phase 2/3 add `fluidaudio-rs` (Path A) behind an `ane` Cargo feature. Source of truth: `apps/desktop/docs/superpowers/specs/2026-07-14-stt-improvements-design.md`.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the design (§3 Invariants, §11 Rollout).

- **Backend only.** Changes are confined to `apps/desktop/src-tauri` and `apps/desktop/vendor`. **Never touch any frontend file** (no `apps/desktop/src`, no Svelte, no `apps/web`). macOS-only stays macOS-only.
- **Tauri contract stays byte-compatible.** Event names `transcript://partial`, `transcript://final`, `model://progress` are unchanged. The `TranscriptEvent` JSON shape stays `{ source, text, t0, t1, utteranceId }` (camelCase), as asserted by `transcript_event_json_shape` (`stt/worker.rs`). Command signatures `ensure_model`, `start_capture`, `stop_capture`, `check_permissions`, `reveal_output`, `transcription_supported`, `platform_is_macos`, `warm_models` keep their current signatures. New capability may add commands/fields, never break existing ones.
- **Markdown sink format unchanged** (`output/markdown.rs` Granola-style merged speaker blocks). Do not edit `output/markdown.rs`.
- **`utteranceId` stays monotonic and unique per emitted final.** `utterance_id` increments only inside the `!text.trim().is_empty()` branch (`stt/worker.rs`). A dropped/panicked utterance consumes **no** id. The frontend dedups finals on `${source}:${utteranceId}`; any change that emits more finals per utterance must keep ids monotonic and unique per finalized segment.
- **`panic = "unwind"` is required.** `catch_unwind` only works with the default unwind panic strategy. No profile in `Cargo.toml` sets `panic = "abort"` today (verified) — keep it that way; a comment next to the guarded helper pins this.
- **The vendored crate `apps/desktop/vendor/voice_activity_detector` MUST NOT be modified.** Verified: it exposes only `VoiceActivityDetector::predict`; the `SpeechGate` state machine and the per-chunk event *collapse* both live in our wrapper `apps/desktop/src-tauri/src/audio/vad.rs`. All VAD-side changes in this plan land in that wrapper. (If while implementing you find the collapse or gate actually lives in the vendored crate, STOP and report — do not plan around it.)
- **CI clippy runs on Linux.** Any macOS-only or `ane`-feature code MUST stay behind `#[cfg(target_os = "macos")]` / `#[cfg(feature = "ane")]` gates so the default Linux clippy build stays green. Never add an `ane`-gated symbol that a default build references unconditionally.
- **Local test invocation needs the Swift runtime fallback path.** The crate links Swift (`screencapturekit`); tests must run with `DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift`.
- **Per-phase gates (all three must be green before a phase is done):**
  ```sh
  DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
  cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml
  cargo clippy --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
  ```
- **Commits:** `<type>(<scope>): summary` with a why-body wrapped ~72 cols. **No AI attribution of any kind**, no session links, no "Generated with" lines — in commits, PR bodies, or code comments. No emoji anywhere. Scopes used here: `stt`, `audio`. One commit per task.

---

## File Structure

```
apps/desktop/src-tauri/
├── Cargo.toml                     # Phase 2: add `ane` feature + optional fluidaudio-rs (macOS target)
├── build.rs                       # Phase 2: Swift-package build glue (spike-scoped)
└── src/
    ├── audio/
    │   ├── vad.rs                 # Phase 1 Task 3: VadEvent::SpeechPaused, extracted collapse(), SpeechGate soft-pause
    │   ├── normalize.rs           # Phase 1.5 Task 9 (new): LoudnessNormalizer, EBU R128 gated normalization + 7 CI tests
    │   ├── mod.rs                 # Phase 1.5 Task 9: `pub mod normalize;` declaration
    │   └── system.rs              # Phase 1.5 Task 9: AudioOutput wiring (after Resampler, before tx.send)
    ├── stt/
    │   ├── worker.rs              # Phase 1 Tasks 1-3: guarded() panic helper, adaptive partials, SpeechPaused arm
    │   ├── engine.rs              # unchanged trait seam (both engines implement it)
    │   ├── parakeet.rs            # unchanged CPU ONNX engine (fallback)
    │   ├── model.rs               # Phase 3 Task 7: both-model-sets download + progress
    │   └── fluidaudio.rs          # Phase 2/3 (new, cfg(all(target_os="macos", feature="ane"))): FluidAudioEngine
    └── commands.rs                # Phase 3 Task 5/8: choose_engine_kind() selection point, warm slots
```

Phase 1 touches only `stt/worker.rs` and `audio/vad.rs`. Phase 2 adds `stt/fluidaudio.rs` and `Cargo.toml`/`build.rs` glue behind the `ane` feature. Phase 3 wires selection in `commands.rs` and extends `model.rs`. Phase 1.5 (Task 9, appended; independent of Phases 2/3) adds `audio/normalize.rs`, the `ebur128` dependency in `Cargo.toml`, and the system-lane wiring in `audio/system.rs`.

---

# PHASE 1 — Quick wins (pure Rust, CI-safe, ship independently)

All three tasks are unit-tested through the `Vad`/`SttEngine`/`Emitter` fakes already present in `stt/worker.rs` and `audio/vad.rs`. They need no model download, no audio hardware, and do not touch the Tauri contract. Ship order: Task 1 (safety), Task 2 (CPU), Task 3 (latency).

---

## Task 1: Panic containment around engine calls (§4)

**Files:**
- Modify: `apps/desktop/src-tauri/src/stt/worker.rs` (four engine call sites: `:108` force-final at cap, `:128-130` partial, `:147` final on `SpeechEnded`, `:177` disconnect-final)
- Test: inline `#[cfg(test)] mod tests` in the same file

**Interfaces:**
- Produces: a private `fn guarded<T: Default>(f: impl FnOnce() -> T) -> T` in `stt/worker.rs`. Later Phase 1 tasks (partial decode in Task 2, soft-final in Task 3) call it too.
- Consumes: nothing new; wraps the existing `engine.transcribe_partial`/`transcribe_final` calls.

**Why:** A panic inside `transcribe-rs`/`ort` currently unwinds the `stt-worker` thread and silently ends that lane for the whole session. `catch_unwind` collapses a panic into the same "no text this round" degradation an `Err` already produces, with salvage semantics per call site (partial: skip and keep buffer; final: drop the utterance text but still reset state and advance). `utterance_id` must be untouched on the panic path so ids stay monotonic and unique per emitted final.

- [ ] **Step 1: Write the failing tests**

Add a `PanickingEngine` and two tests to `stt/worker.rs`'s `mod tests`, reusing the existing `ScriptedVad` + `CapturingEmitter` harness:

```rust
/// SttEngine that panics on demand, to prove the worker contains panics.
struct PanickingEngine {
    panic_partial: bool,
    /// Number of leading `transcribe_final` calls that panic; subsequent calls succeed.
    final_panics_remaining: usize,
}
impl SttEngine for PanickingEngine {
    fn transcribe_partial(&mut self, s: &[f32]) -> anyhow::Result<String> {
        if self.panic_partial {
            panic!("boom in transcribe_partial");
        }
        Ok(format!("partial:{}", s.len()))
    }
    fn transcribe_final(&mut self, s: &[f32]) -> anyhow::Result<String> {
        if self.final_panics_remaining > 0 {
            self.final_panics_remaining -= 1;
            panic!("boom in transcribe_final");
        }
        Ok(format!("final:{}", s.len()))
    }
}

#[test]
fn panic_in_partial_is_swallowed_and_lane_survives() {
    let (tx, rx) = channel::<Vec<f32>>();
    let vad = ScriptedVad {
        script: vec![
            VadEvent::SpeechStarted,
            VadEvent::Speaking,
            VadEvent::Speaking,
            VadEvent::SpeechEnded,
        ],
    };
    let emitter = Arc::new(CapturingEmitter::default());
    let em2 = emitter.clone();
    // 16000-sample frames (1s each); partial_interval 0 fires a partial each
    // Speaking frame — each of those panics and must be swallowed.
    for _ in 0..4 {
        tx.send(vec![0.0f32; 16_000]).unwrap();
    }
    drop(tx);
    run_worker(
        Source::Me,
        rx,
        Box::new(vad),
        Box::new(PanickingEngine { panic_partial: true, final_panics_remaining: 0 }),
        em2,
        Instant::now(),
        Duration::from_millis(0),
    );
    // The non-panicking final still fires; every partial was swallowed.
    let finals = emitter.finals.lock().unwrap();
    assert_eq!(finals.len(), 1);
    assert_eq!(finals[0].utterance_id, 0);
    assert!(emitter.partials.lock().unwrap().is_empty(), "panicked partials emit nothing");
}

#[test]
fn panic_in_final_drops_utterance_without_killing_lane() {
    let (tx, rx) = channel::<Vec<f32>>();
    // Two utterances. transcribe_final panics for the first only.
    let vad = ScriptedVad {
        script: vec![
            VadEvent::SpeechStarted, VadEvent::Speaking, VadEvent::SpeechEnded,
            VadEvent::SpeechStarted, VadEvent::Speaking, VadEvent::SpeechEnded,
        ],
    };
    let emitter = Arc::new(CapturingEmitter::default());
    let em2 = emitter.clone();
    for _ in 0..6 {
        tx.send(vec![0.0f32; 16_000]).unwrap();
    }
    drop(tx);
    run_worker(
        Source::Me,
        rx,
        Box::new(vad),
        Box::new(PanickingEngine { panic_partial: false, final_panics_remaining: 1 }),
        em2,
        Instant::now(),
        Duration::from_secs(100), // no partials
    );
    let finals = emitter.finals.lock().unwrap();
    assert_eq!(finals.len(), 1, "first utterance dropped, second emitted");
    // The panicked first utterance emitted nothing, so it consumed NO id: the
    // second final carries id 0, not 1. Proves state advanced AND id accounting held.
    assert_eq!(finals[0].utterance_id, 0);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```sh
DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml worker::tests::panic_
```
Expected: FAIL — the lane dies on the first panic (thread abort / propagated panic), or the id assertion is wrong, because no `catch_unwind` guard exists yet.

- [ ] **Step 3: Add the `guarded` helper**

Add near the top of `stt/worker.rs` (after imports). Add `use std::sync::atomic::{AtomicBool, Ordering};` to the imports.

```rust
// Engine calls run untrusted C/ONNX (and, later, CoreML) code. A panic must
// degrade to "no text this round", never unwind the lane's worker thread.
// AssertUnwindSafe is sound here: on panic we discard the engine's output and
// reset the utterance buffer, so no observer sees a torn intermediate value.
//
// REQUIRES the default unwind panic strategy. Do NOT set `panic = "abort"` in any
// Cargo profile — it silently defeats this guard and re-exposes the lane-death bug.
// A future "N panics -> mark engine dead and rebuild" policy (the ANE spike question)
// would attach here.
fn guarded<T: Default>(f: impl FnOnce() -> T) -> T {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(v) => v,
        Err(_) => {
            // Rate-limited: log the first panic, silence the rest (mirrors the
            // resampler's one-shot log at audio/resample.rs).
            static LOGGED: AtomicBool = AtomicBool::new(false);
            if !LOGGED.swap(true, Ordering::Relaxed) {
                eprintln!("[stt] engine call panicked; dropping this decode (further panics silenced)");
            }
            T::default()
        }
    }
}
```

- [ ] **Step 4: Wrap the four engine call sites**

`anyhow::Result<String>` does not implement `Default`, so the existing `unwrap_or_default()` moves *inside* the closure (`T = String`). The outer path handles the `catch_unwind` `Err`, the inner one the engine's `Err` — both collapse to an empty string.

Force-final at cap (`:108`):
```rust
let text = guarded(|| engine.transcribe_final(&buffer).unwrap_or_default());
```
Partial decode — replace the whole partial branch body (`:125-141`). Unlike the final sites (`:148`, `:158`), the existing partial branch emits **unconditionally**, so a swallowed panic would still emit an empty-text partial and the Step 1 test would fail. The design (§4) says a panicked partial "emits nothing", so add an emit guard:
```rust
} else if last_partial.elapsed() >= partial_interval {
    // Re-transcribe only the trailing window so partials stay snappy.
    let start = buffer.len().saturating_sub(max_partial_samples);
    let text = guarded(|| engine.transcribe_partial(&buffer[start..]).unwrap_or_default());
    // A panicked or failed partial emits nothing — the next tick or the final
    // recovers (design §4). Finals already guard on non-empty text.
    if !text.trim().is_empty() {
        let t1 = started.elapsed().as_secs_f64();
        let event = TranscriptEvent {
            source,
            text,
            t0,
            t1,
            utterance_id,
        };
        emitter.partial(&event);
    }
    last_partial = Instant::now();
}
```
Note: this intentionally changes behavior for engine-`Err` partials too — they currently emit an empty-text partial; per the design nothing is emitted. `FakeEngine` and (in Task 2) `SlowEngine` return non-empty text, so every other partial-asserting test is unaffected.

Final on `SpeechEnded` (`:147`):
```rust
let text = guarded(|| engine.transcribe_final(&buffer).unwrap_or_default());
```
Disconnect-final (`:177`):
```rust
let text = guarded(|| engine.transcribe_final(&buffer).unwrap_or_default());
```
Do **not** move the `buffer.clear()` / `speech_samples = 0` / state-reset lines: they already sit *after* the `if !text.trim().is_empty()` block, so on a swallowed panic (`text == ""`) they still run — the utterance is dropped and the lane advances without touching `utterance_id`. That is the salvage semantics; no other change is needed.

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```sh
DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml worker::tests::panic_
```
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full phase gate**

Run:
```sh
DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml && \
cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml && \
cargo clippy --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
```
Expected: all green (existing `worker` tests still pass; the JSON-shape test is untouched).

- [ ] **Step 7: Commit**

```sh
git add apps/desktop/src-tauri/src/stt/worker.rs
git commit -m "$(cat <<'EOF'
fix(stt): contain engine panics so one bad decode never kills a lane

run_worker only unwrap_or_default()'d the engine Result, so a panic inside
transcribe-rs/ort unwound the stt-worker thread and silently ended that lane
for the rest of the session. Wrap each engine call in catch_unwind via a
guarded() helper that collapses a panic into the same "no text this round"
degradation an Err already produces. The partial site additionally gains a
non-empty emit guard (finals already had one): a panicked or failed partial
now emits nothing instead of an empty-text event, per the design's skip
semantics. On the panic path the utterance is dropped and state advances
without touching utterance_id, so finalized-final ids stay monotonic and
unique and the frontend dedupe still holds. Requires the default unwind
panic strategy; pinned with a comment.
EOF
)"
```

---

## Task 2: Adaptive partial decoding + shrink partial window (§5)

**Files:**
- Modify: `apps/desktop/src-tauri/src/stt/worker.rs` (`MAX_PARTIAL_MS` const `:23`; the `Speaking` arm partial branch `:125-141`)
- Test: inline `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `guarded` (Task 1).
- Produces: a worker-local `last_partial_cost: Duration` (default `Duration::ZERO`) driving overrun-aware cadence. No public API change. `PARTIAL_INTERVAL` in `commands.rs:32` stays 700 ms (the floor) — **do not change it**.

**Why:** Under load, back-to-back partial decodes starve `rx` and partial text lags further behind live speech. Gate the next partial on `elapsed >= partial_interval.max(last_partial_cost)` so cadence self-throttles to ~one partial per decode-time when decodes blow past the interval, and shrink `MAX_PARTIAL_MS` 10_000 → 5_000 to halve worst-case partial cost (the final still re-decodes the whole utterance).

- [ ] **Step 1: Write the failing tests**

Add a `SlowEngine` and two tests to `mod tests`. Add `use std::time::Duration;` if not already imported in the test module (it is).

```rust
/// SttEngine whose partial decode sleeps, to exercise overrun backoff.
struct SlowEngine {
    partial_sleep: Duration,
}
impl SttEngine for SlowEngine {
    fn transcribe_partial(&mut self, s: &[f32]) -> anyhow::Result<String> {
        std::thread::sleep(self.partial_sleep);
        Ok(format!("partial:{}", s.len()))
    }
    fn transcribe_final(&mut self, s: &[f32]) -> anyhow::Result<String> {
        Ok(format!("final:{}", s.len()))
    }
}

#[test]
fn slow_partials_back_off_instead_of_queueing() {
    let (tx, rx) = channel::<Vec<f32>>();
    // 1 SpeechStarted + 20 Speaking + SpeechEnded. With partial_interval 0, an
    // instant engine would emit ~20 partials; a slow one must emit far fewer
    // because each 50ms decode gates the next partial by ~50ms of wall time.
    let mut script = vec![VadEvent::SpeechStarted];
    script.extend(std::iter::repeat(VadEvent::Speaking).take(20));
    script.push(VadEvent::SpeechEnded);
    let vad = ScriptedVad { script };
    let emitter = Arc::new(CapturingEmitter::default());
    let em2 = emitter.clone();
    for _ in 0..22 {
        tx.send(vec![0.0f32; 16_000]).unwrap();
    }
    drop(tx);
    run_worker(
        Source::Me,
        rx,
        Box::new(vad),
        Box::new(SlowEngine { partial_sleep: Duration::from_millis(50) }),
        em2,
        Instant::now(),
        Duration::from_millis(0),
    );
    let n = emitter.partials.lock().unwrap().len();
    // Inequality, not an exact count: the frames drain near-instantly, so after
    // the first 50ms decode the backoff suppresses the rest of that window.
    assert!(n <= 3, "backoff should bound partials well below 20; got {n}");
}

#[test]
fn partial_window_is_capped_at_max_partial_ms() {
    let (tx, rx) = channel::<Vec<f32>>();
    // 1 SpeechStarted + 10 Speaking frames of 16000 = up to 176000 samples,
    // well past the 5s (80000-sample) window.
    let mut script = vec![VadEvent::SpeechStarted];
    script.extend(std::iter::repeat(VadEvent::Speaking).take(10));
    let vad = ScriptedVad { script };
    let emitter = Arc::new(CapturingEmitter::default());
    let em2 = emitter.clone();
    for _ in 0..11 {
        tx.send(vec![0.0f32; 16_000]).unwrap();
    }
    drop(tx);
    run_worker(
        Source::Me,
        rx,
        Box::new(vad),
        Box::new(FakeEngine),
        em2,
        Instant::now(),
        Duration::from_millis(0),
    );
    // FakeEngine echoes the slice length as "partial:{len}". The window cap is
    // SAMPLE_RATE * MAX_PARTIAL_MS / 1000 = 16000 * 5000 / 1000 = 80000.
    let partials = emitter.partials.lock().unwrap();
    assert!(!partials.is_empty());
    for e in partials.iter() {
        let len: usize = e.text.strip_prefix("partial:").unwrap().parse().unwrap();
        assert!(len <= 80_000, "partial slice {len} exceeds MAX_PARTIAL_MS window");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```sh
DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml worker::tests::slow_partials_back_off_instead_of_queueing worker::tests::partial_window_is_capped_at_max_partial_ms
```
Expected: FAIL — `slow_partials_back_off...` emits ~20 partials (no backoff), and `partial_window_is_capped...` sees slices up to 176000 (window still 10_000 ms = 160000).

- [ ] **Step 3: Shrink the partial window**

Edit the `MAX_PARTIAL_MS` constant (`:23`):
```rust
/// Partials only re-transcribe at most this much trailing audio, so the live text
/// stays responsive as an utterance grows (the final still uses the whole buffer).
/// Halved from 10_000 to bound worst-case partial decode cost (~7 audio-seconds
/// per wall-second per lane, down from ~14); the committed final restores full text.
const MAX_PARTIAL_MS: usize = 5_000;
```

- [ ] **Step 4: Add overrun-aware cadence**

In `run_worker`, add the cost tracker alongside `last_partial` (near `:86`):
```rust
let mut last_partial: Instant = Instant::now();
// Cost of the most recent partial decode; drives overrun backoff. 0 = no prior
// decode, so the partial_interval floor governs the first partial.
let mut last_partial_cost: Duration = Duration::ZERO;
```
Replace the partial branch condition and body in the `Speaking` arm (as rewritten by Task 1 Step 4) so the cadence gate uses the cost and the decode is timed. **The `!text.trim().is_empty()` emit guard from Task 1 MUST be preserved here** — dropping it would silently re-introduce the empty-partial-on-panic bug that Task 1's test pins:
```rust
} else if last_partial.elapsed() >= partial_interval.max(last_partial_cost) {
    // Never spend more than ~half the wall clock on partials: if a decode took
    // longer than the interval, wait at least that long again before the next.
    // Re-transcribe only the trailing window so partials stay snappy.
    let start = buffer.len().saturating_sub(max_partial_samples);
    let decode_start = Instant::now();
    let text = guarded(|| engine.transcribe_partial(&buffer[start..]).unwrap_or_default());
    last_partial_cost = decode_start.elapsed();
    // A panicked or failed partial emits nothing — the next tick or the final
    // recovers (design §4). Finals already guard on non-empty text.
    if !text.trim().is_empty() {
        let t1 = started.elapsed().as_secs_f64();
        let event = TranscriptEvent {
            source,
            text,
            t0,
            t1,
            utterance_id,
        };
        emitter.partial(&event);
    }
    last_partial = Instant::now();
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```sh
DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml worker::tests::slow_partials_back_off_instead_of_queueing worker::tests::partial_window_is_capped_at_max_partial_ms
```
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full phase gate**

Run:
```sh
DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml && \
cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml && \
cargo clippy --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
```
Expected: all green.

- [ ] **Step 7: Commit**

```sh
git add apps/desktop/src-tauri/src/stt/worker.rs
git commit -m "$(cat <<'EOF'
perf(stt): self-throttle partial decodes and halve the partial window

Under load the worker ran back-to-back partial decodes of a 10s window,
starving rx and letting partial text lag ever further behind live speech.
Gate the next partial on elapsed >= max(partial_interval, last_partial_cost)
so cadence backs off to roughly one partial per decode-time when decodes
overrun the interval, and shrink MAX_PARTIAL_MS 10_000 -> 5_000 to halve
worst-case per-partial cost. Finals are untouched and still decode the whole
utterance, so accuracy is unaffected; only the live greyed partial trails.
EOF
)"
```

---

## Task 3: Soft finalization at natural pauses (§6)

**Files:**
- Modify: `apps/desktop/src-tauri/src/audio/vad.rs` (`VadEvent` enum `:1-7`; extract the collapse match `:158-165` into a pure `collapse` fn; `SpeechGate` struct + constructor + `update` `:29-91`; `SileroVad::new` gate construction `:124`)
- Modify: `apps/desktop/src-tauri/src/stt/worker.rs` (new `SpeechPaused` match arm; `SOFT_MIN_SPEECH_MS` constant)
- Test: inline `#[cfg(test)]` in both files

**Interfaces:**
- Produces:
  - `audio::vad::VadEvent::SpeechPaused` — new internal variant (NOT part of the Tauri contract).
  - `audio::vad::collapse(acc: VadEvent, next: VadEvent) -> VadEvent` — pure fold step, private to the module, ranking `SpeechStarted > SpeechEnded > SpeechPaused > Speaking > Silence`.
  - `SpeechGate::with_soft_end(threshold: f32, onset_chunks: u32, soft_end_chunks: u32, end_chunks: u32) -> SpeechGate` — a second constructor that enables the soft-pause. `SpeechGate::new(threshold, onset_chunks, end_chunks)` stays unchanged (soft pause disabled), so every existing gate test is byte-for-byte untouched.
- Consumes: `guarded` (Task 1); the worker's existing `speech_samples`, `buffer`, `t0`, `utterance_id`, `last_partial` locals.

**Why:** The 38-chunk (~1.2 s) hard end keeps a run-on talker's utterance growing to the 25 s cap before anything durable is emitted. A shorter, advisory `SpeechPaused` (18 chunks ~576 ms) finalizes early *only* once the utterance already has ≥ 6 s of confirmed speech, so cuts land at sentence boundaries, not on a timer. The event **must** be ranked into the per-chunk collapse or it is silently swallowed inside a multi-chunk `accept()` call while every `SpeechGate` unit test still passes — so the extracted `collapse` and its unit tests are load-bearing.

The `VadEvent::SpeechPaused` variant couples `vad.rs` and `worker.rs` at compile time (the worker's exhaustive `match` must gain an arm). This task therefore writes all new tests first, observes them fail to compile, then lands the coupled change in one implementation step.

- [ ] **Step 1: Write the failing collapse unit tests (`audio/vad.rs`)**

Add to `vad.rs`'s `mod tests` (a new nested module):
```rust
mod collapse_fn {
    use super::super::{collapse, VadEvent};

    fn fold(events: &[VadEvent]) -> VadEvent {
        events.iter().fold(VadEvent::Silence, |acc, &e| collapse(acc, e))
    }

    #[test]
    fn pause_survives_speaking_on_both_sides() {
        // The common case: within one accept() call the gate returns
        // [Speaking, SpeechPaused, Speaking]; the pause must survive the fold.
        assert_eq!(
            fold(&[VadEvent::Speaking, VadEvent::SpeechPaused, VadEvent::Speaking]),
            VadEvent::SpeechPaused
        );
    }

    #[test]
    fn hard_end_outranks_pause() {
        assert_eq!(fold(&[VadEvent::SpeechPaused, VadEvent::SpeechEnded]), VadEvent::SpeechEnded);
    }

    #[test]
    fn start_outranks_pause() {
        assert_eq!(fold(&[VadEvent::SpeechPaused, VadEvent::SpeechStarted]), VadEvent::SpeechStarted);
    }

    #[test]
    fn existing_priorities_unchanged() {
        assert_eq!(fold(&[VadEvent::Speaking, VadEvent::SpeechEnded]), VadEvent::SpeechEnded);
        assert_eq!(fold(&[VadEvent::SpeechStarted, VadEvent::Speaking]), VadEvent::SpeechStarted);
        assert_eq!(fold(&[VadEvent::Silence, VadEvent::Speaking]), VadEvent::Speaking);
        assert_eq!(fold(&[VadEvent::Silence, VadEvent::Silence]), VadEvent::Silence);
    }
}
```

- [ ] **Step 2: Write the failing gate soft-pause test (`audio/vad.rs`)**

Add to the `mod speech_gate` block:
```rust
#[test]
fn soft_pause_fires_once_at_soft_end_chunks() {
    // Production values: onset 2, soft end 18, hard end 38.
    let mut g = SpeechGate::with_soft_end(0.5, 2, 18, 38);
    g.update(0.9);
    g.update(0.9); // SpeechStarted, now in_speech

    // Exactly soft_end_chunks (18) low probs: the 18th fires SpeechPaused once.
    let mut pauses = 0u32;
    for _ in 0..18 {
        if matches!(g.update(0.1), VadEvent::SpeechPaused) {
            pauses += 1;
        }
    }
    assert_eq!(pauses, 1, "exactly one SpeechPaused at soft_end_chunks");

    // Continue silence to the hard end (through chunk 38): exactly one
    // SpeechEnded and no second SpeechPaused.
    let mut ends = 0u32;
    let mut extra_pauses = 0u32;
    for _ in 0..20 {
        match g.update(0.1) {
            VadEvent::SpeechEnded => ends += 1,
            VadEvent::SpeechPaused => extra_pauses += 1,
            _ => {}
        }
    }
    assert_eq!(ends, 1, "exactly one SpeechEnded at end_chunks");
    assert_eq!(extra_pauses, 0, "SpeechPaused fires at most once per silence run");
}
```

- [ ] **Step 3: Write the failing worker tests (`stt/worker.rs`)**

Add to `worker.rs`'s `mod tests`:
```rust
#[test]
fn soft_pause_before_floor_does_not_fire_final() {
    // NOTE (plan flag): the design scripts only [SpeechStarted, Speaking,
    // SpeechPaused], but leaving a non-empty buffer would make the
    // disconnect-finalize path emit a final. A terminating SpeechEnded whose
    // total speech is below MIN_SPEECH_MS (250ms = 4000 samples) drops the blip
    // and clears the buffer, so finals.len() == 0 holds as the design intends.
    let (tx, rx) = channel::<Vec<f32>>();
    let vad = ScriptedVad {
        script: vec![
            VadEvent::SpeechStarted,
            VadEvent::Speaking,
            VadEvent::SpeechPaused,
            VadEvent::SpeechEnded,
        ],
    };
    let emitter = Arc::new(CapturingEmitter::default());
    let em2 = emitter.clone();
    // 1000-sample frames: total speech stays under both the 6s soft floor and
    // the 250ms min-speech gate.
    for _ in 0..4 {
        tx.send(vec![0.0f32; 1000]).unwrap();
    }
    drop(tx);
    run_worker(
        Source::Me,
        rx,
        Box::new(vad),
        Box::new(FakeEngine),
        em2,
        Instant::now(),
        Duration::from_secs(100),
    );
    assert_eq!(emitter.finals.lock().unwrap().len(), 0, "below-floor pause must not finalize");
}

#[test]
fn soft_pause_after_floor_finalizes_and_starts_new_utterance() {
    let (tx, rx) = channel::<Vec<f32>>();
    // 16000-sample (1s) frames. SpeechStarted + 6 Speaking = 7s of speech
    // (112000 samples), past the 6s (96000-sample) floor. Then SpeechPaused,
    // two Speaking, SpeechEnded.
    let vad = ScriptedVad {
        script: vec![
            VadEvent::SpeechStarted,
            VadEvent::Speaking, VadEvent::Speaking, VadEvent::Speaking,
            VadEvent::Speaking, VadEvent::Speaking, VadEvent::Speaking,
            VadEvent::SpeechPaused,
            VadEvent::Speaking, VadEvent::Speaking,
            VadEvent::SpeechEnded,
        ],
    };
    let emitter = Arc::new(CapturingEmitter::default());
    let em2 = emitter.clone();
    for _ in 0..11 {
        tx.send(vec![0.0f32; 16_000]).unwrap();
    }
    drop(tx);
    run_worker(
        Source::Me,
        rx,
        Box::new(vad),
        Box::new(FakeEngine),
        em2,
        Instant::now(),
        Duration::from_secs(100), // no partials
    );
    let finals = emitter.finals.lock().unwrap();
    assert_eq!(finals.len(), 2, "soft pause splits into two finals");
    // First final: 8 frames = 128000 — 7 pre-pause PLUS the frame that arrived
    // with SpeechPaused (pins append-before-finalize). Second: 3 frames = 48000
    // (two Speaking + the SpeechEnded frame), proving the buffer reset and the
    // paused frame was not double-counted into the successor.
    assert_eq!(finals[0].utterance_id, 0);
    assert_eq!(finals[0].text, "final:128000");
    assert_eq!(finals[1].utterance_id, 1);
    assert_eq!(finals[1].text, "final:48000");
}
```

- [ ] **Step 4: Run the tests to verify they fail (compile error)**

Run:
```sh
DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml 2>&1 | head -40
```
Expected: FAIL to compile — `VadEvent::SpeechPaused`, `collapse`, and `SpeechGate::with_soft_end` do not exist. (A coupled enum change: the worker's exhaustive `match` will also error once the variant lands, which the next step fixes in the same commit.)

- [ ] **Step 5a: Add the `SpeechPaused` variant and extract `collapse` (`audio/vad.rs`)**

Extend the enum (`:1-7`):
```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VadEvent {
    Silence,
    SpeechStarted,
    /// Advisory soft pause: a shorter-than-`SpeechEnded` silence used to finalize
    /// long run-on utterances at a sentence boundary. Does not change gate state.
    /// Internal only — never crosses the Tauri boundary.
    SpeechPaused,
    Speaking,
    SpeechEnded,
}
```
Add the pure collapse fn (module-level, above `SileroVad`), replacing the inline match at `:158-165`:
```rust
/// Fold two per-chunk gate events into one, so a whole `accept()` call collapses
/// to a single `VadEvent`. Priority: SpeechStarted > SpeechEnded > SpeechPaused >
/// Speaking > Silence. SpeechPaused is ranked explicitly ABOVE Speaking so a soft
/// pause fired mid-call (typically `[Speaking, SpeechPaused, Speaking]`) is not
/// masked by a later Speaking chunk, and BELOW SpeechEnded so a hard end in the
/// same call still finalizes the whole buffer.
fn collapse(acc: VadEvent, next: VadEvent) -> VadEvent {
    match (acc, next) {
        (_, VadEvent::SpeechStarted) | (VadEvent::SpeechStarted, _) => VadEvent::SpeechStarted,
        (_, VadEvent::SpeechEnded) | (VadEvent::SpeechEnded, _) => VadEvent::SpeechEnded,
        (_, VadEvent::SpeechPaused) | (VadEvent::SpeechPaused, _) => VadEvent::SpeechPaused,
        (_, VadEvent::Speaking) => VadEvent::Speaking,
        (other, _) => other,
    }
}
```
In `SileroVad::accept`, replace the inline `last_event = match (last_event, event) { ... }` (`:158-165`) with:
```rust
last_event = collapse(last_event, event);
```
Also fix the now-stale comment above the `debug_assert!` in `accept()` (`:148-151`): its first line states the old ranking "SpeechStarted > SpeechEnded > Speaking > Silence", which contradicts the new priority. Drop that ranking line — the authoritative ranking lives on `collapse()`'s doc comment — and keep the frame-size rationale that justifies the `debug_assert!` (a single `accept()` call cannot span a full speech-to-silence cycle).

- [ ] **Step 5b: Add the soft-pause to `SpeechGate` (`audio/vad.rs`)**

Add two fields to the struct (`:29-39`):
```rust
    /// Silence chunks after which an advisory `SpeechPaused` fires (once per run).
    /// `None` disables the soft pause — the default via `new`.
    soft_end_chunks: Option<u32>,
    /// Whether `SpeechPaused` has already fired for the current silence run.
    soft_pause_emitted: bool,
```
Keep `new` unchanged in signature but set the new fields to disabled, and add `with_soft_end`:
```rust
impl SpeechGate {
    pub fn new(threshold: f32, onset_chunks: u32, end_chunks: u32) -> Self {
        Self {
            enter_threshold: threshold,
            exit_threshold: (threshold - 0.15).max(0.01),
            onset_chunks,
            end_chunks,
            soft_end_chunks: None,
            in_speech: false,
            speech_run: 0,
            silence_run: 0,
            soft_pause_emitted: false,
        }
    }

    /// Like `new`, but enables an advisory `SpeechPaused` after `soft_end_chunks`
    /// consecutive silence chunks (must be `< end_chunks`), used to split long
    /// run-on utterances at a sentence boundary.
    pub fn with_soft_end(
        threshold: f32,
        onset_chunks: u32,
        soft_end_chunks: u32,
        end_chunks: u32,
    ) -> Self {
        debug_assert!(soft_end_chunks < end_chunks, "soft end must precede hard end");
        let mut g = Self::new(threshold, onset_chunks, end_chunks);
        g.soft_end_chunks = Some(soft_end_chunks);
        g
    }
```
In `update`, reset `soft_pause_emitted` when speech is active (silence run resets), and emit `SpeechPaused` in the in-speech silence branch. The `active` branch (`:62-73`) gains one line:
```rust
        if active {
            self.silence_run = 0;
            self.soft_pause_emitted = false;
            self.speech_run += 1;
            // ... unchanged onset/Speaking logic ...
```
The in-speech silence branch (`:76-84`) becomes:
```rust
            if self.in_speech {
                self.silence_run += 1;
                if self.silence_run >= self.end_chunks {
                    self.in_speech = false;
                    self.silence_run = 0;
                    self.soft_pause_emitted = false;
                    VadEvent::SpeechEnded
                } else if self
                    .soft_end_chunks
                    .is_some_and(|soft| !self.soft_pause_emitted && self.silence_run >= soft)
                {
                    self.soft_pause_emitted = true;
                    VadEvent::SpeechPaused
                } else {
                    VadEvent::Speaking
                }
            } else {
```
Switch `SileroVad::new` (`:124`) to the soft-pause constructor:
```rust
            // enter 0.5 / stay 0.35 (hysteresis), onset 2 chunks (~64ms),
            // soft pause after 18 silence chunks (~576ms) to split run-on
            // utterances at a sentence boundary, hard end after 38 chunks (~1.2s).
            // The soft pause only ever fires before the hard end, never races it.
            gate: SpeechGate::with_soft_end(0.5, 2, 18, 38),
```

- [ ] **Step 5c: Add the worker `SpeechPaused` arm (`stt/worker.rs`)**

Add the constant near the other window constants (`:14-23`):
```rust
/// Only utterances with at least this much confirmed speech are eligible to split
/// at a soft pause (§6). Below this we keep whole thoughts intact. 6s is ~1-2
/// spoken sentences: past it a >0.5s pause is a sentence/paragraph boundary.
const SOFT_MIN_SPEECH_MS: usize = 6_000;
```
Compute the sample floor alongside the others in `run_worker` (`:72-76`):
```rust
    let soft_min_samples = sr * SOFT_MIN_SPEECH_MS / 1000;
```
Add the arm to the `match vad.accept(&frame)` block (order relative to other arms does not matter). The append-before-finalize order is load-bearing: the soft-reset successor gets no pre-roll (the ring only fills during `Silence` and the gate never leaves in-speech here), so the frame arriving *with* the pause — which can carry the successor's first word onset — must land in the finalizing buffer:
```rust
            VadEvent::SpeechPaused => {
                // Append the arriving frame FIRST (mirrors the SpeechEnded arm):
                // the soft-reset successor has no pre-roll protection, so this
                // frame must not be dropped.
                buffer.extend_from_slice(&frame);
                if speech_samples >= soft_min_samples {
                    // Finalize exactly like a real final, then soft-reset: clear
                    // the buffer and speech_samples and start a fresh t0, but do
                    // NOT touch VAD state — the gate is still in_speech, so the
                    // next frame continues as Speaking into the new utterance.
                    let text = guarded(|| engine.transcribe_final(&buffer).unwrap_or_default());
                    if !text.trim().is_empty() {
                        let t1 = started.elapsed().as_secs_f64();
                        let event = TranscriptEvent {
                            source,
                            text,
                            t0,
                            t1,
                            utterance_id,
                        };
                        emitter.final_(&event);
                        utterance_id += 1;
                    }
                    buffer.clear();
                    speech_samples = 0;
                    t0 = started.elapsed().as_secs_f64();
                    last_partial = Instant::now();
                } else {
                    // Below the floor: keep the utterance whole. The appended
                    // frame is Speaking-equivalent audio.
                    speech_samples += frame.len();
                }
            }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run:
```sh
DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml vad:: worker::tests::soft_pause
```
Expected: PASS — the four collapse tests, `soft_pause_fires_once_at_soft_end_chunks`, and both worker soft-pause tests. All pre-existing `speech_gate` tests still pass (their gate uses `new`, soft pause disabled).

- [ ] **Step 7: Run the full phase gate**

Run:
```sh
DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml && \
cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml && \
cargo clippy --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
```
Expected: all green. (Clippy note: `is_some_and` is stable; if the toolchain rejects it, use `matches!(self.soft_end_chunks, Some(soft) if ...)`.)

- [ ] **Step 8: Commit**

```sh
git add apps/desktop/src-tauri/src/audio/vad.rs apps/desktop/src-tauri/src/stt/worker.rs
git commit -m "$(cat <<'EOF'
feat(audio): finalize long utterances at natural pauses

A run-on talker who never pauses past the ~1.2s hard end grew a single
utterance to the 25s cap before anything durable reached the markdown sink.
Add an advisory SpeechPaused gate event (18 chunks ~576ms) that finalizes
early only once the utterance already has >= 6s of confirmed speech, so cuts
land at sentence boundaries rather than on a timer -- preserving the "keep
whole thoughts together" quality decision. The event is ranked explicitly
into the per-chunk collapse (extracted to a pure, unit-tested function) so it
survives a multi-chunk accept() call instead of being silently swallowed.
The worker appends the paused frame before finalizing so the soft-reset
successor, which has no pre-roll, does not lose its first word. Short turns
below the floor are never split; the hard end is unchanged.
EOF
)"
```

---

# PHASE 2 — ANE spike (time-boxed, behind the `ane` feature, NOT shipped)

Phase 2 is a spike: stand up the FluidAudio CoreML bridge behind an `ane` Cargo feature (Path A, `fluidaudio-rs`), measure it against the design's go/no-go criteria, and record the decision. Default builds (no `ane`) and Linux CI are unaffected. Nothing here is on the shipping path; Phase 3 is conditional on the outcome.

Spike verification runs on an Apple-Silicon machine with the `ane` feature; the standard Linux-green gate (below, without `ane`) must also stay green throughout.

---

## Task 4: FluidAudio CoreML bridge spike (§7)

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml` (new `[features] ane`; optional `fluidaudio-rs` under the macOS target deps)
- Modify: `apps/desktop/src-tauri/build.rs` (Swift-package build glue, if `fluidaudio-rs`'s own `build.rs` does not fully self-contain it — resolve during the spike)
- Create: `apps/desktop/src-tauri/src/stt/fluidaudio.rs` (`#[cfg(all(target_os = "macos", feature = "ane"))]`), declared from `stt/mod.rs` behind the same cfg
- Modify (append findings only, at the end of the spike): `apps/desktop/docs/superpowers/specs/2026-07-14-stt-improvements-design.md`
- Test: gated `#[ignore]` integration test in `fluidaudio.rs`

**Interfaces:**
- Produces (spike-scoped, feature-gated): `FluidAudioEngine::load(...) -> anyhow::Result<FluidAudioEngine>` implementing `SttEngine` via `fluidaudio-rs`'s in-memory batch call (`transcribe_samples(&Vec<f32>)`, NOT `transcribe_file`). Confirm the exact `AsrManager.transcribe(_:source:)` `source:` parameter shape from the crate during the spike (unverified from docs).
- Consumes: `SttEngine` (unchanged), `guarded` (§4, for the decode-panic containment check).

**Why:** The CPU ONNX engine pins Parakeet to the CPU (CoreML EP broken, onnxruntime#26355), leaving the ANE idle and burning CPU/battery. This spike verifies whether a FluidAudio CoreML backend can be built, linked, and shipped, and whether it wins on latency/RAM — before committing to productionization. Compiling a SwiftPM package from source in `build.rs` is NEW to this crate (today's Swift exposure is only prebuilt system frameworks via an rpath arg), so the build integration itself is a primary risk.

- [ ] **Step 1: Add the feature and dependency (keep Linux/default green)**

In `Cargo.toml`, add a features table and the optional dependency under the existing macOS target block. Pin exact versions (design Risk: Path A is version-stale — pin both `fluidaudio-rs` and, transitively, the FluidAudio it wraps, and record them in the commit):
```toml
[features]
# ANE (Apple Neural Engine) inference via FluidAudio CoreML. Spike-only until the
# go/no-go decision. Off by default so the crate builds ONNX-only and Linux CI is
# unaffected. Requires macOS + a Swift 6 toolchain.
ane = ["dep:fluidaudio-rs"]
```
Under `[target.'cfg(target_os = "macos")'.dependencies]`:
```toml
fluidaudio-rs = { version = "=0.12.6", optional = true }
```
Declare the module behind the cfg in `stt/mod.rs`:
```rust
#[cfg(all(target_os = "macos", feature = "ane"))]
pub mod fluidaudio;
```

- [ ] **Step 2: Confirm the default build and Linux clippy are untouched**

Run (no `ane` feature):
```sh
cargo clippy --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings && \
cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml
```
Expected: green — the `ane` code is not compiled, so nothing changes for the default/Linux path. This is the gate the design requires be kept green.

- [ ] **Step 3: Stand up a single round-trip and a gated parity test**

Implement a minimal `FluidAudioEngine` in `fluidaudio.rs` (entire file under `#[cfg(all(target_os = "macos", feature = "ane"))]`): `load` resolves + loads the CoreML model (`AsrModels.downloadAndLoad(version: .v3)` → `AsrManager.configure`, per `fluidaudio-rs`), `transcribe_partial`/`transcribe_final` marshal `&[f32]` through the crate's in-memory batch call and return the text. Mirror `ParakeetEngine`'s shape. Add a gated test mirroring `parakeet.rs::transcribes_known_clip`. Note: `load_wav_16k_mono` is private to `parakeet.rs`'s own `#[cfg(test)] mod tests` (`parakeet.rs:90`) — either copy the loader into `fluidaudio.rs`'s test module or hoist it into a shared `#[cfg(test)]` test utility both engine tests use; do not reference it across test modules as-is:
```rust
#[test]
#[ignore = "requires CoreML model download + Swift link; Apple-Silicon only"]
fn ane_transcribes_known_clip() {
    // Reuse the same fixture as the ONNX engine test.
    let mut eng = FluidAudioEngine::load(/* resolved CoreML paths */).unwrap();
    // load_wav_16k_mono: copied from parakeet.rs's test module (or hoisted to a
    // shared test utility) — it is private to that module today.
    let samples = load_wav_16k_mono("tests/fixtures/hello_16k.wav");
    let text = eng.transcribe_final(&samples).unwrap().to_lowercase();
    assert!(text.contains("hello"), "got: {text}");
}
```
Verify on Apple Silicon:
```sh
DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift cargo test --features ane --manifest-path apps/desktop/src-tauri/Cargo.toml stt::fluidaudio -- --ignored
```
Expected: PASS (transcript contains "hello"). If `swift build`/link fails in this or the CI/release environment, that is a **no-go** input — record it and stop chasing further measurements.

- [ ] **Step 4: Measure the go/no-go inputs (design §7 spike plan 2-4, §9)**

Run and record, into a scratch note for Step 6:
- **Parity:** run `tests/fixtures/hello_16k.wav` through both `ParakeetEngine` (ONNX) and `FluidAudioEngine` (ANE); confirm the transcripts match, plus a manual meeting smoke test.
- **Latency:** ANE final-decode (whole utterance) and partial (5 s window) wall time; compare to CPU ONNX.
- **RAM:** resident memory for **one vs two** `AsrManager` instances (the item-5 question — does CoreML dedupe the compiled `.mlmodelc` across instances, or does two-engine RAM double like ONNX?).
- **Failure behavior:** force a CoreML load failure (missing/renamed model) and a decode panic; confirm clean fallback to `ParakeetEngine` and that a predict panic is contained by the §4 `guarded` helper. Note whether a predict panic appears to poison `AsrManager` state (feeds the "N panics -> rebuild" spike question).
- **Progress plumbing feasibility:** confirm whether FluidAudio can be pointed at a directory we populate ourselves (via `ModelRegistry.baseURL` / `REGISTRY_URL`), so a HuggingFace download we drive can keep `model://progress` honest for the CoreML bundle. Record the CoreML bundle size (the ~0.6-1.1 GB figure is unverified — measure it).

- [ ] **Step 5: Decide go / no-go against the design's criteria**

- **GO** if: ANE final-decode latency ≤ CPU ONNX; transcript parity holds on the fixture and a manual smoke test; two-instance RAM is ≤ the current ~1 GB baseline (ideally well under); and clean runtime fallback to ONNX is demonstrated.
- **NO-GO (stay on CPU)** if: the Swift link/toolchain can't be built in CI and the notarized release pipeline; or ANE parity regresses WER noticeably; or two-instance RAM exceeds the baseline with no sharing path. In that case Phase 1's quick wins stand and Phase 3 is shelved.

- [ ] **Step 6: Append the spike findings to the design doc**

Append a new section `## 12. Spike results` to `apps/desktop/docs/superpowers/specs/2026-07-14-stt-improvements-design.md` recording: the measured latency/CPU/RAM numbers, parity outcome, the confirmed `fluidaudio-rs` / FluidAudio versions and `source:` parameter shape, the CoreML bundle size, the progress-plumbing mechanism, the build-integration result (CI + notarized release), and the explicit GO/NO-GO decision with its justification. This is a design-doc edit only — no source change in this step.

- [ ] **Step 7: Commit the spike (feature-gated, does not affect default builds)**

```sh
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/build.rs \
        apps/desktop/src-tauri/src/stt/fluidaudio.rs apps/desktop/src-tauri/src/stt/mod.rs \
        apps/desktop/docs/superpowers/specs/2026-07-14-stt-improvements-design.md
git commit -m "$(cat <<'EOF'
feat(stt): spike a FluidAudio CoreML engine behind the ane feature

Stand up FluidAudioEngine via fluidaudio-rs (Path A) behind an off-by-default
ane Cargo feature so the ANE inference path can be measured without touching
the shipping ONNX build or Linux CI. Records parity, latency, one-vs-two
instance RAM, fallback, and build-integration findings in the design doc's
spike-results section, with the go/no-go decision. Not on the shipping path.
EOF
)"
```

---

# PHASE 3 — ANE productionization (CONDITIONAL — only if Task 4 returned GO)

**Every task in this phase is gated on the Phase 2 spike returning GO.** If the spike was NO-GO, skip Phase 3 entirely: Phase 1 is the shipped outcome and the `ane` feature stays a spike artifact (or is removed). Do not start any task below until the design doc's `## 12. Spike results` records a GO decision. All ANE code stays behind `#[cfg(all(target_os = "macos", feature = "ane"))]` so default/Linux builds remain green.

---

## Task 5: Runtime engine selection + fallback matrix (§7)

> Only if Phase 2 returned GO.

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands.rs` (`load_boxed_engine` `:257-265`, the single selection point)
- Modify: `apps/desktop/src-tauri/src/stt/fluidaudio.rs` (minimal `coreml_bundle_present()` placeholder so this commit boundary compiles under `--features ane`; the real gate lands in Tasks 6-7)
- Test: inline `#[cfg(test)]` in `commands.rs`

**Interfaces:**
- Produces: `fn choose_engine_kind(ane_available: bool) -> EngineKind` where `enum EngineKind { Ane, Onnx }` — a pure, CI-safe decision function. `load_boxed_engine` matches on it to construct the concrete engine. This realizes the fallback matrix: `ane_available` is true only when the `ane` feature is on AND the CoreML bundle is present AND `FluidAudioEngine::load` succeeds; every failure path yields `Onnx`.
- Produces: `stt::fluidaudio::coreml_bundle_present() -> bool` — in this task a conservative placeholder returning `false` (so ANE is never selected on an unverified bundle and every commit boundary stays green); Task 6 replaces it with the real completeness gate.

**Why:** The design requires one place that chooses the impl, with ONNX as the unconditional fallback (CoreML load failure, decode error, or feature-off all degrade to today's behavior). Splitting the *decision* into a pure function makes the fallback logic unit-testable without CoreML.

- [ ] **Step 1: Write the failing test**

`choose_engine_kind`/`EngineKind` are `#[cfg(target_os = "macos")]`, so the test must carry the same gate — an ungated test would fail `cargo test` / `clippy --all-targets` on Linux CI with undefined-symbol errors. (Phase 1's worker/vad tests need no gating; they are cross-platform.)

```rust
#[cfg(target_os = "macos")]
#[test]
fn engine_selection_falls_back_to_onnx_without_ane() {
    assert_eq!(choose_engine_kind(false), EngineKind::Onnx);
    assert_eq!(choose_engine_kind(true), EngineKind::Ane);
}
```

- [ ] **Step 2: Run to verify it fails**

Run:
```sh
DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml commands::tests::engine_selection_falls_back_to_onnx_without_ane
```
Expected: FAIL (`choose_engine_kind`/`EngineKind` undefined).

- [ ] **Step 3: Implement the pure decision + wire it**

Add (cfg-gated to macOS, matching `load_boxed_engine`). Both items need a dead-code allowance for the default (no-`ane`) macOS build: dead-code analysis runs per compilation target, and the **lib target compiles without `cfg(test)`** — there, only the feature-gated selection path references these, so without the attribute `cargo clippy --all-targets -- -D warnings` fails with "enum `EngineKind` is never used" / "function `choose_engine_kind` is never used":
```rust
// Referenced only by the `ane`-gated selection path and the tests; the default
// lib target would otherwise flag them as dead code.
#[cfg(target_os = "macos")]
#[cfg_attr(not(feature = "ane"), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EngineKind {
    Ane,
    Onnx,
}

/// Pure engine selection. ANE is chosen only when a live CoreML engine is
/// available; every failure path (feature off, bundle missing, load failed)
/// falls back to the ONNX engine, which the both-sets download guarantees on disk.
#[cfg(target_os = "macos")]
#[cfg_attr(not(feature = "ane"), allow(dead_code))]
fn choose_engine_kind(ane_available: bool) -> EngineKind {
    if ane_available {
        EngineKind::Ane
    } else {
        EngineKind::Onnx
    }
}
```
Rework `load_boxed_engine` to construct via the kind. The **entire ANE attempt lives inside one `#[cfg(feature = "ane")]` block** so the non-`ane` build falls straight through to `ParakeetEngine::load` with no residual `match` — a cfg-stripped `match choose_engine_kind(..) { _ => {} }` would trip `clippy::match_single_binding` under `-D warnings` and fail the default phase gate:
```rust
#[cfg(target_os = "macos")]
fn load_boxed_engine(paths: &ParakeetPaths) -> Option<Box<dyn SttEngine>> {
    // The whole ANE attempt is feature-gated: without `ane` this function is
    // exactly today's ONNX load, and no CoreML symbol is referenced.
    #[cfg(feature = "ane")]
    if choose_engine_kind(ane_engine_available()) == EngineKind::Ane {
        match crate::stt::fluidaudio::FluidAudioEngine::load(/* CoreML paths */) {
            Ok(e) => return Some(Box::new(e)),
            Err(e) => eprintln!("[warm] ANE engine load failed, falling back to ONNX: {e}"),
        }
    }
    match ParakeetEngine::load(paths) {
        Ok(e) => Some(Box::new(e)),
        Err(e) => {
            eprintln!("[warm] failed to load speech engine: {e}");
            None
        }
    }
}

/// Whether a live ANE engine is selectable: the CoreML bundle is present and
/// complete (refined in Task 7's both-sets download). Compiled only with the
/// `ane` feature; without it `load_boxed_engine` never references this or any
/// CoreML path, and the default/Linux build is untouched.
#[cfg(all(target_os = "macos", feature = "ane"))]
fn ane_engine_available() -> bool {
    crate::stt::fluidaudio::coreml_bundle_present()
}
```
(`choose_engine_kind`/`EngineKind` stay `#[cfg(target_os = "macos")]` without the feature gate, but note the `cfg_attr` dead-code allowance above is load-bearing: in the default no-`ane` build the lib target compiles without `cfg(test)`, so the Step 1 test does NOT count as a use there.)

`coreml_bundle_present` does not exist yet — Task 6 builds the real completeness gate. So this task also adds a minimal placeholder to `stt/fluidaudio.rs` (same `#[cfg(all(target_os = "macos", feature = "ane"))]` gate as the rest of the file) so the `--features ane` gate in Step 5 compiles at this commit boundary:
```rust
/// Whether the CoreML model bundle is on disk. Task 5 placeholder: conservatively
/// `false`, so the ANE engine is never selected before the real completeness gate
/// (the CoremlPaths analogue of ParakeetPaths::is_present) lands in Tasks 6-7.
/// Until then ane builds behave exactly like ONNX-only at runtime.
pub fn coreml_bundle_present() -> bool {
    false
}
```

- [ ] **Step 4: Run to verify it passes**

Run:
```sh
DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml commands::tests::engine_selection_falls_back_to_onnx_without_ane
```
Expected: PASS.

- [ ] **Step 5: Run the full phase gate (default AND ane configs)**

Run the standard gate (default, must stay Linux-green):
```sh
DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml && \
cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml && \
cargo clippy --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
```
And, on Apple Silicon, the `ane` config compiles clean:
```sh
cargo clippy --features ane --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
```
Expected: both green.

- [ ] **Step 6: Commit**

```sh
git add apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/stt/fluidaudio.rs
git commit -m "$(cat <<'EOF'
feat(stt): select ANE engine at the single load point with ONNX fallback

Route engine construction through a pure choose_engine_kind() so the fallback
matrix lives in one testable place: ANE is picked only when a live CoreML
engine is available, and every failure path (feature off, bundle missing,
load failed) degrades to the ONNX engine. The ANE branch is feature-gated so
the default and Linux builds never reference the CoreML path.
coreml_bundle_present() is a conservative false placeholder until the real
completeness gate lands with the both-sets download, so ane builds stay
ONNX-only at runtime for now.
EOF
)"
```

---

## Task 6: FluidAudioEngine as the preferred engine (§7)

> Only if Phase 2 returned GO.

**Files:**
- Modify: `apps/desktop/src-tauri/src/stt/fluidaudio.rs` (promote the spike engine to a production impl: robust `load`, a `coreml_bundle_present()` completeness gate, decode-error handling matching ONNX semantics)
- Test: the gated `ane_transcribes_known_clip` from Task 4 (now the production impl's integration test)

**Interfaces:**
- Produces: `FluidAudioEngine` implementing `SttEngine` with the same error contract as `ParakeetEngine` (a decode error returns `Err`, which the worker's `unwrap_or_default()` collapses to empty text — nothing emitted). A decode panic is contained by §4's `guarded`. `coreml_bundle_present() -> bool` (Task 5's placeholder, made real here) gates selection at Task 5's wiring.

**Why:** The spike produced a minimal round-trip; production needs the completeness gate, error mapping, and load-once semantics wired to the rest of the system. The `SttEngine` seam is unchanged, so `worker.rs` needs no ANE-specific tests — the worker fakes already cover it.

- [ ] **Step 1: Harden the engine**

Confirm (from the spike findings recorded in the design doc) the exact CoreML file set and the `transcribe(_:source:)` `source:` parameter. Replace Task 5's conservative `coreml_bundle_present()` placeholder (which always returns `false`) with the real implementation: a CoreML analogue of `ParakeetPaths::is_present` (all required CoreML artifacts on disk). Load the model once in `load`, and map decode failures to `anyhow::Result` `Err` (never panic deliberately). Keep the whole file under `#[cfg(all(target_os = "macos", feature = "ane"))]`.

- [ ] **Step 2: Verify the gated integration test (Apple Silicon)**

Run:
```sh
DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift cargo test --features ane --manifest-path apps/desktop/src-tauri/Cargo.toml stt::fluidaudio -- --ignored
```
Expected: PASS ("hello").

- [ ] **Step 3: Run the full phase gate (default + ane configs)** — as in Task 5 Step 5. Expected: both green.

- [ ] **Step 4: Commit**

```sh
git add apps/desktop/src-tauri/src/stt/fluidaudio.rs
git commit -m "$(cat <<'EOF'
feat(stt): productionize the FluidAudio CoreML engine

Promote the spike engine to a production SttEngine impl: a completeness gate
over the CoreML artifact set, load-once semantics mirroring ParakeetEngine,
and decode errors mapped to Err so the worker's existing degradation (empty
text, nothing emitted) applies unchanged. Stays behind the ane feature; the
trait seam means the worker needs no ANE-specific changes.
EOF
)"
```

---

## Task 7: Both-model-sets download with preserved `model://progress` (§7)

> Only if Phase 2 returned GO.

**Files:**
- Modify: `apps/desktop/src-tauri/src/stt/model.rs` (multi-file/manifest-driven download extension; a CoreML `is_present` completeness gate; download ONNX **first**, then the CoreML bundle)
- Modify: `apps/desktop/src-tauri/src/commands.rs` (`ensure_model_macos` `:222-243` drives both downloads under `ane`, keeps emitting `model://progress`)
- Test: inline `#[cfg(test)]` path/completeness tests in `model.rs` (CI-safe, no network)

**Interfaces:**
- Produces: a CoreML paths/`is_present` type paralleling `ParakeetPaths`, and a multi-file download that keeps `model://progress` `{done,total}` honest across the CoreML bundle. The existing single-tarball `download_with_progress` (`:122-149`) is extended (or a manifest-driven sibling added) to report aggregate progress over multiple files.

**Why:** Runtime ONNX fallback is only real if the ONNX artifacts are on disk. In `ane` builds, `ensure_model` fetches the ONNX tarball **first** (guaranteeing the fallback engine always loads), then the CoreML bundle. A CoreML download failure then degrades to exactly today's ONNX behavior. FluidAudio has no progress-reporting download API, so honest `model://progress` requires driving the HuggingFace download ourselves into a directory FluidAudio is pointed at (mechanism confirmed in the spike). This is real plumbing, and the design flags first-run UX as a risk if it slips.

- [ ] **Step 1: Write the failing path/completeness tests**

```rust
#[test]
fn coreml_is_present_false_when_missing() {
    let dir = tempfile::tempdir().unwrap();
    let p = CoremlPaths::resolve(dir.path());
    assert!(!p.is_present());
}

#[test]
fn coreml_is_present_true_when_all_files_exist() {
    let dir = tempfile::tempdir().unwrap();
    let p = CoremlPaths::resolve(dir.path());
    std::fs::create_dir_all(&p.dir).unwrap();
    for f in COREML_REQUIRED_FILES {
        std::fs::write(p.dir.join(f), b"x").unwrap();
    }
    assert!(p.is_present());
}
```
(Populate `COREML_REQUIRED_FILES` from the spike-confirmed CoreML artifact set recorded in the design doc.)

- [ ] **Step 2: Run to verify they fail**

Run:
```sh
DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml model::tests::coreml_
```
Expected: FAIL (`CoremlPaths`/`COREML_REQUIRED_FILES` undefined). These path tests are CI-safe and compile regardless of the `ane` feature (they exercise only path logic), so keep the types themselves un-feature-gated but keep the *download* and *engine* usage `ane`-gated.

- [ ] **Step 3: Implement the CoreML paths + both-sets download**

Add `CoremlPaths { dir, ... }` with `resolve`/`is_present` mirroring `ParakeetPaths`. Extend `ensure` (or add `ensure_all`) to: ensure the ONNX tarball first (unchanged path), then fetch the CoreML bundle into a directory FluidAudio loads from, reporting aggregate `{done,total}` across all files. In `commands.rs`, under `#[cfg(feature = "ane")]`, have `ensure_model_macos` call the both-sets path; without the feature it stays exactly as today (ONNX only). Preserve the `model://progress` event name and `{done,total}` shape byte-for-byte.

- [ ] **Step 4: Run to verify the path tests pass**

Run:
```sh
DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml model::tests
```
Expected: PASS (new CoreML tests + all existing `model` tests, including the ONNX `is_present` set).

- [ ] **Step 5: Run the full phase gate (default + ane configs)** — as in Task 5 Step 5. Expected: both green. Manually verify (Apple Silicon, `ane`) that a first run downloads ONNX then CoreML and emits monotonic `model://progress`, and that deleting the CoreML bundle leaves capture running on ONNX.

- [ ] **Step 6: Commit**

```sh
git add apps/desktop/src-tauri/src/stt/model.rs apps/desktop/src-tauri/src/commands.rs
git commit -m "$(cat <<'EOF'
feat(stt): download both model sets with honest progress in ane builds

Runtime ONNX fallback is only real if the ONNX artifacts are on disk, so ane
builds ensure the ONNX tarball first, then the CoreML bundle. FluidAudio has
no progress-reporting download API, so drive the CoreML fetch ourselves into
a directory FluidAudio loads from and report aggregate model://progress over
the multi-file bundle, keeping the event name and {done,total} shape
unchanged. A CoreML download failure degrades to exactly today's ONNX
behavior. Default (non-ane) builds are byte-identical to before.
EOF
)"
```

---

## Task 8: Warm slots hold ANE engines; revisit shared-engine RAM (§7, §9)

> Only if Phase 2 returned GO.

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands.rs` (`fill_warm_slots` `:271-298`, `start_capture_macos` cold-load `:407-412` / `:491-496`, and the dual-engine comment `:484-489`)

**Interfaces:**
- Consumes: `load_boxed_engine` (Task 5, now ANE-aware). The warm slots `warm_mic`/`warm_sys` and the two-lane topology stay structurally identical — they just hold whatever `load_boxed_engine` returns (ANE or ONNX box).

**Why:** Warm slots and per-lane engines are unchanged in structure; they inherit ANE selection for free through `load_boxed_engine`. The shared-single-engine option (to reclaim ~500 MB) was rejected for the CPU path but deferred for ANE, to be revisited **only** with the spike's measured RAM and latency numbers.

- [ ] **Step 1: Confirm warm slots inherit ANE selection**

`fill_warm_slots` already calls `load_boxed_engine`, so with Task 5 in place the warm slots hold ANE engines when available and ONNX otherwise, with no code change. Verify by reading the call path; update the stale `~1 GB` dual-engine comment at `:484-489` to reflect the ANE topology and reference the spike's measured two-instance RAM.

- [ ] **Step 2: Decide shared-engine per the spike numbers**

Using the design doc's `## 12. Spike results` two-instance RAM figure: if two `AsrManager` instances do NOT share ANE memory but a single shared instance decodes fast enough (RTFx-derived sub-quarter-second finals) to serialize both lanes within the partial cadence, implement a single `Mutex`-shared ANE engine for both lanes; otherwise keep the per-lane topology. This is a decision recorded in the commit body — do not implement shared-engine unless the spike numbers justify it (the design explicitly leaves the per-lane design correct for CPU and re-opens sharing only for ANE).

- [ ] **Step 3: Run the full phase gate (default + ane configs)** — as in Task 5 Step 5. Expected: both green.

- [ ] **Step 4: Commit**

```sh
git add apps/desktop/src-tauri/src/commands.rs
git commit -m "$(cat <<'EOF'
feat(stt): warm ANE engines and record the shared-engine RAM decision

Warm slots inherit ANE selection through load_boxed_engine with no structural
change. Refresh the stale dual-engine RAM comment with the spike's measured
two-instance CoreML figure and record whether cross-lane engine sharing is
justified: sharing was rejected for the CPU path (decode contention during
cross-talk) and is adopted for ANE only if the spike shows two instances do
not share memory while a single instance decodes fast enough to serialize
both lanes within the partial cadence.
EOF
)"
```

---

# PHASE 1.5 — System-lane loudness normalization (design addendum §12)

This phase implements the adversarially approved addendum §12 of the design doc. It is **independent of Phases 2 and 3** (and of the already-landed Phase 1 tasks): pure-Rust DSP behind the existing capture seam, no interaction with the ANE track, no Tauri-contract impact. It appears after Phases 2/3 in this document **purely to avoid concurrent `Cargo.toml` edits with the in-flight Phase 2 spike** — do not run Task 9's steps while ANY other task's uncommitted changes are in the working tree (its Step 7 gate runs test/fmt/clippy over the whole crate, so it is only meaningful when every other in-flight task sits at a committed, green boundary); otherwise it may be executed at any point after Phase 1.

---

## Task 9: System-lane loudness normalization (EBU R128, §12)

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml` (add the `ebur128` dependency)
- Create: `apps/desktop/src-tauri/src/audio/normalize.rs` (the `LoudnessNormalizer` + all seven unit tests)
- Modify: `apps/desktop/src-tauri/src/audio/mod.rs` (module declaration)
- Modify: `apps/desktop/src-tauri/src/audio/system.rs` (wiring in `AudioOutput` only: struct `:69-72`, callback `:105-114`, construction `:158-162`)
- Test: inline `#[cfg(test)]` in `normalize.rs` — pure DSP, no model, no hardware, cross-platform (runs on Linux CI)

**Interfaces:**
- Produces: `audio::normalize::LoudnessNormalizer` with `new() -> anyhow::Result<Self>`, `process(&mut self, frame: &mut [f32])` (in-place, total: every input frame yields an output frame of the same length under all conditions), and `gain_db(&self) -> f32` (observability for tests; `0.0` = unity). Also the compile-time kill switch `pub const SYSTEM_LOUDNESS_NORMALIZATION: bool = true`.
- Consumes: `audio::SAMPLE_RATE`; the system lane's existing `AudioOutput`/`Mutex<Resampler>` pattern.

**Why:** ScreenCaptureKit audio has no AGC anywhere in its path — remote meeting voices routinely vary by >20 dB, and quiet speakers can hover below Silero's 0.5 enter threshold and be dropped entirely (never transcribed). §12 adds a gated short-term EBU R128 normalizer in the **system lane only** (the mic lane already has VPIO AGC; stacking two gain loops pumps), applied after the `Resampler` and before `tx.send` so the VAD and engine see one identical signal of record. The load-bearing measure/gate split: the 3 s **short-term** loudness drives the gain; the 400 ms **momentary** loudness gates whether the gain may update at all — a short-term-gated design would wind toward +12 dB in every inter-turn pause because a 3 s window still reads ~-26 LUFS 1.5 s into silence. **The mic lane and `run_worker` are untouched** — no per-lane flag threads through the worker.

Constants (all in `normalize.rs`, rationale inline, exact values from §12's parameter table): `TARGET_LUFS = -23.0`; gate on **momentary** at `GATE_LUFS = -50.0`; clamp `MAX_BOOST_DB = 12.0` / `MAX_CUT_DB = -12.0`; `MAX_SLEW_DB_PER_100MS = 1.0`; `STARTUP_UNITY_S = 3.0`; `CLIP_CEIL = 0.99`; kill switch `SYSTEM_LOUDNESS_NORMALIZATION = true` (compile-time const, not a user setting — reverting is a one-line change).

- [ ] **Step 1: Add the dependency and module declaration**

In `apps/desktop/src-tauri/Cargo.toml`, add to the main `[dependencies]` table (NOT the macOS target block — `ebur128` is pure Rust and cross-platform, which is what lets the tests run on Linux CI):
```toml
ebur128 = "0.1"
```
(Pin to whatever resolves; record the resolved version in the commit. Pure Rust port of libebur128, MIT, no C.)

In `apps/desktop/src-tauri/src/audio/mod.rs`, add alongside the existing module declarations:
```rust
// System-lane loudness normalization (EBU R128). Pure DSP, cross-platform so
// its tests run in CI; only the macOS system capture path constructs it.
pub mod normalize;
```

- [ ] **Step 2: Write the seven failing tests**

Create `apps/desktop/src-tauri/src/audio/normalize.rs` containing, for now, only the test module (the implementation lands in Step 4; the tests reference the not-yet-written `LoudnessNormalizer`, so the failing state is a compile error, as in Task 3). Frames are 1600 samples (100 ms at 16 kHz) to mirror production cadence; 220 Hz at 16 kHz over 1600 samples is exactly 22 cycles, so every frame is phase-identical and RMS comparisons are exact.

```rust
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
            assert!(w[1] >= w[0] - 1e-6, "gain must not fall: {} -> {}", w[0], w[1]);
        }
        for w in rms_series[30..].windows(2) {
            assert!(w[1] >= w[0] - 1e-6, "output RMS must rise monotonically");
        }
        let last = *gain_series.last().unwrap();
        assert!(last >= 11.0, "gain should approach MAX_BOOST_DB, got {last}");
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
        assert!(g <= MAX_CUT_DB + 1.0, "cut should approach the clamp, got {g}");
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
        assert_eq!(n.gain_db(), 0.0, "gate never opens on silence; gain stays unity");
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
        assert!(at_pause > 0.0, "gain should have adapted upward during speech");

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
            assert_eq!(*g, frozen, "gain must be exactly flat after the gate closes (frame {i})");
        }
        assert!(frozen < MAX_BOOST_DB, "frozen gain must not wind toward MAX_BOOST_DB");
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
```

- [ ] **Step 3: Run the tests to verify they fail (compile error)**

Run:
```sh
DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml normalize 2>&1 | head -30
```
Expected: FAIL to compile — `LoudnessNormalizer`, `MAX_BOOST_DB`, `MAX_CUT_DB`, `MAX_SLEW_DB_PER_100MS`, `CLIP_CEIL` do not exist yet.

- [ ] **Step 4: Implement `LoudnessNormalizer`**

Add above the test module in `normalize.rs`:

```rust
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
        let in_startup =
            (self.samples_seen as f64) < STARTUP_UNITY_S * f64::from(SAMPLE_RATE);

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
                let short_term =
                    self.meter.loudness_shortterm().unwrap_or(f64::NEG_INFINITY);
                if short_term.is_finite() {
                    let desired =
                        ((TARGET_LUFS - short_term) as f32).clamp(MAX_CUT_DB, MAX_BOOST_DB);
                    // Slew toward the target, scaled by this frame's duration.
                    let max_step = MAX_SLEW_DB_PER_100MS
                        * (frame.len() as f32 / (SAMPLE_RATE as f32 * 0.1));
                    self.gain_db += (desired - self.gain_db).clamp(-max_step, max_step);
                }
            }
        }

        let lin = 10f32.powf(self.gain_db / 20.0);
        // Clip guard: scale THIS frame's applied gain to keep the peak under
        // CLIP_CEIL; the smoothed gain state is not touched. No division by
        // measured loudness anywhere — gain is always a clamped, slewed value.
        let peak = frame.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        let applied = if peak * lin > CLIP_CEIL { CLIP_CEIL / peak } else { lin };
        for s in frame.iter_mut() {
            *s *= applied;
        }
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```sh
DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml normalize
```
Expected: PASS (7 tests). If `quiet_sine_is_boosted_toward_target` or `hot_sine_is_cut_toward_target` miss their final-gain window by a fraction of a dB, the sine's LUFS estimate is off from the K-weighted reality — adjust the test's input dBFS (not the constants) so the desired correction still clamps.

- [ ] **Step 6: Wire the system lane (and only the system lane)**

In `apps/desktop/src-tauri/src/audio/system.rs`, all inside the `macos` module. A worker-level test is deliberately NOT added: the normalizer lives in the capture path, which the `ScriptedVad`/`FakeEngine` harness starts *after* (at the frame channel); threading it through `run_worker` for testability is the seam choice §12 rejects. `mic.rs` and `worker.rs` are untouched.

Import (with the existing `use` items at `:42-43`):
```rust
use crate::audio::normalize::LoudnessNormalizer;
```
Extend `AudioOutput` (`:69-72`):
```rust
struct AudioOutput {
    tx: FrameSender,
    resampler: Mutex<Resampler>,
    /// System-lane loudness normalization (design addendum section 12). The
    /// mic lane's VPIO AGC covers the "Me" side; this is the only gain stage
    /// on the "Them" side, applied before anything downstream (VAD included)
    /// sees the audio.
    normalizer: Mutex<LoudnessNormalizer>,
}
```
Rework the tail of `did_output_sample_buffer` (`:105-114`) — the frame becomes `mut` and is normalized between resample and send:
```rust
            let mut frame = match self.resampler.lock() {
                Ok(mut r) => r.process(&samples),
                Err(e) => {
                    eprintln!("[system] resampler mutex poisoned: {e}");
                    return;
                }
            };
            if frame.is_empty() {
                return;
            }
            // Normalize toward TARGET_LUFS before the frame channel, so the
            // pre-roll ring, the VAD, and the engine all see one identical
            // signal of record. On a poisoned mutex, pass the frame through
            // un-normalized — degraded level beats a silent lane.
            match self.normalizer.lock() {
                Ok(mut n) => n.process(&mut frame),
                Err(e) => eprintln!("[system] normalizer mutex poisoned: {e}"),
            }
            let _ = self.tx.send(frame);
```
Extend the construction in `start` (`:158-162`):
```rust
        let output = AudioOutput {
            tx,
            resampler: Mutex::new(Resampler::new(CAPTURE_SAMPLE_RATE, CAPTURE_CHANNELS)),
            normalizer: Mutex::new(
                LoudnessNormalizer::new()
                    .context("failed to init system-lane loudness normalizer")?,
            ),
        };
```
(A construction failure fails `start`, which the caller already degrades to mic-only — and `EbuR128::new` with these fixed, valid parameters cannot realistically fail. Flagged in the Self-Review Notes.)

- [ ] **Step 7: Run the full phase gate**

Run:
```sh
DYLD_FALLBACK_LIBRARY_PATH=/usr/lib/swift cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml && \
cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml && \
cargo clippy --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
```
Expected: all green. `normalize.rs` is cross-platform (no cfg gates needed — the dependency and module compile on Linux; only `system.rs`'s macOS module constructs it), so Linux CI runs the seven tests too.

- [ ] **Step 8: Commit**

```sh
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock \
        apps/desktop/src-tauri/src/audio/normalize.rs \
        apps/desktop/src-tauri/src/audio/mod.rs apps/desktop/src-tauri/src/audio/system.rs
git commit -m "$(cat <<'EOF'
feat(audio): normalize system-lane loudness toward -23 LUFS

ScreenCaptureKit audio has no AGC anywhere in its path: remote speakers
arrive >20 dB apart, and quiet ones can sit below Silero's enter threshold
and never be transcribed at all. Add a gated short-term EBU R128 normalizer
(ebur128, pure Rust) in the system lane's capture path, after the resampler
and before the frame channel, so pre-roll, VAD, and engine see one identical
corrected signal. The level is driven by the 3 s short-term measure; the
update gate is the 400 ms momentary measure, so gain freezes within ~400 ms
of a pause and never winds up between turns (a short-term-gated design
would). Gain is clamped to +/-12 dB, slewed at 1 dB per 100 ms, held at
unity for the first 3 s, and peak-guarded at 0.99. The mic lane keeps VPIO
AGC untouched (stacked gain loops pump) and a compile-time kill switch makes
reverting a one-line change.
EOF
)"
```

---

## Self-Review Notes

**Design item -> plan step coverage (every design item maps to at least one step):**

- §4 panic containment: `guarded` helper + salvage semantics at all four call sites + `utterance_id` invariant + rate-limited log + `panic = "unwind"` pin -> **Task 1** (tests `panic_in_partial_is_swallowed_and_lane_survives`, `panic_in_final_drops_utterance_without_killing_lane`, both with exact id assertions). The "N panics -> rebuild engine" policy is deliberately deferred to the ANE spike (§7) — the helper comment marks the attach point; not implemented now (matches design: spike question, not answered).
- §5 adaptive partials: overrun-aware cadence (`last_partial_cost`, `partial_interval.max(...)`) + `MAX_PARTIAL_MS` 10_000 -> 5_000, `PARTIAL_INTERVAL` unchanged floor -> **Task 2** (tests `slow_partials_back_off_instead_of_queueing`, `partial_window_is_capped_at_max_partial_ms`).
- §6 soft finalization: `VadEvent::SpeechPaused` variant + `SpeechGate` soft-pause (`with_soft_end`, 18/38) + extracted pure `collapse` with the load-bearing CI collapse tests + `SileroVad::new` switch + worker `SpeechPaused` arm with append-before-finalize + `SOFT_MIN_SPEECH_MS` 6 s floor -> **Task 3** (tests: four collapse tests, `soft_pause_fires_once_at_soft_end_chunks`, `soft_pause_before_floor_does_not_fire_final`, `soft_pause_after_floor_finalizes_and_starts_new_utterance` with the exact `final:128000`/`final:48000` arithmetic).
- §7 ANE spike (Path A `fluidaudio-rs`, `ane` feature, link+call, parity, latency/CPU/RAM, failure/fallback, progress feasibility, go/no-go, findings appended to design) -> **Task 4**.
- §7 ANE productionization (feature gate, fallback matrix, both-model-sets download with progress, warm slots) -> **Tasks 5-8**, each gated on the GO decision.
- §8 / §9 shared-engine (rejected for CPU, deferred for ANE) -> **Task 8 Step 2** (decision recorded, implemented only if spike numbers justify). No CPU-path work — matches "No CPU-path work is proposed."
- §3 invariants (event names, JSON shape, command signatures, markdown format, dedupe, `panic = "unwind"`) -> **Global Constraints** + preserved by construction in every task (JSON-shape test untouched; markdown sink not edited; frontend not touched).
- §11 phasing (Phase 1 quick wins ship independently; Phase 2 spike; Phase 3 conditional) -> the three-phase structure of this plan.

- §12 (addendum) system-lane loudness normalization: `ebur128` dependency, `audio/normalize.rs` with `LoudnessNormalizer`, all eight §12 constants (`TARGET_LUFS` -23, momentary-gated `GATE_LUFS` -50, `MAX_BOOST_DB`/`MAX_CUT_DB` +/-12, `MAX_SLEW_DB_PER_100MS` 1.0, `STARTUP_UNITY_S` 3.0, `CLIP_CEIL` 0.99, `SYSTEM_LOUDNESS_NORMALIZATION` kill switch), the measure/gate split (`Mode::M | Mode::S`, one instance), wiring only in the system lane's `AudioOutput` after the `Resampler` and before `tx.send`, mic lane and worker untouched, and all seven §12 tests (incl. the re-derived `gain_freezes_below_gate`: gate closed within ~500 ms via momentary, gain exactly flat thereafter) -> **Task 9** (Phase 1.5). §12's rejected alternatives (mic-lane normalization, 80 Hz HPF, plain RMS AGC, integrated loudness, post-VAD placement) and its open questions (-23 vs -16 target, -50 gate tuning, momentary-seeded startup) are decided/deferred in the design, not the plan — correctly absent as work items. No worker-level test, per §12's explicit rationale.
- §13 (addendum) third-repo validation (Meetily): documentation-only — it validates existing choices and motivates §12; no implementable item, correctly absent.

No orphans: every §4-§9 change, every §11 rollout item, and the §12 addendum map to a task. §9's other rejected alternatives (chunk rotation, second streaming model, DTLN, diarization, emission coalescing, async partials) are non-goals with no work — correctly absent.

**Ambiguities / contradictions flagged for the adversarial plan reviewer:**

1. **`soft_pause_before_floor_does_not_fire_final` vs the disconnect-finalize path (Task 3, Step 3).** The design scripts this test as exactly `[SpeechStarted, Speaking, SpeechPaused]` and asserts `finals.len() == 0`. But `run_worker`'s tail (`worker.rs:176-189`) finalizes any non-empty buffer on channel disconnect with no min-speech gate — so the literal 3-event script would leave a 3-frame buffer that the disconnect path emits as one final, making the assertion fail. The plan resolves this by appending a terminating `SpeechEnded` with total confirmed speech below `MIN_SPEECH_MS` (250 ms / 4000 samples) so the blip is dropped and the buffer cleared, honoring the design's intent (`finals.len() == 0`). Reviewer: confirm this reconciliation is acceptable, or specify a different framing (e.g., asserting "no final was emitted *at the pause*" rather than over the whole run).
2. **`speech_samples` accounting on a below-floor `SpeechPaused` frame.** The design says to "still append the frame (it is Speaking-equivalent audio) but ignore the pause." The plan increments `speech_samples` by the frame length on the below-floor branch (Speaking-equivalent) and does **not** increment it on the finalize branch (mirroring the `SpeechEnded` arm, which appends without counting). This is consistent with the exact `final:128000`/`final:48000` arithmetic, but the design does not state the below-floor increment explicitly — flagged for confirmation.
3. **`is_some_and` / clippy toolchain (Task 3, Step 7).** The gate change uses `Option::is_some_and`; if the pinned toolchain predates its stabilization, fall back to a `matches!(... if ...)` guard. Called out inline; no design impact.
4. **Phase 3 CoreML specifics are spike-derived, not invented (Tasks 6-7).** The exact CoreML artifact set (`COREML_REQUIRED_FILES`), the `transcribe(_:source:)` `source:` parameter, the bundle size, and the directory-redirect mechanism are marked in the design as unverified spike inputs. The plan schedules confirming them in Task 4 and consuming them in Tasks 6-7 rather than guessing values — reviewer should verify the plan does not hard-code an unconfirmed CoreML file list.

Task 9 (§12 addendum) translation flags:

5. **Startup boundary semantics (Task 9, Step 4).** §12 says "until 3 s of audio has been metered, hold unity" and the test says "the first 3 s pass through bit-identical", which is ambiguous at frame granularity for the frame that exactly completes the window. The plan resolves it by evaluating the startup check on the sample count *before* the current frame: the frame that completes the 3 s window still passes at unity and normalization starts on the next frame, making `unity_during_startup`'s "30 x 100 ms frames bit-identical" exact.
6. **The gate's "(or the current frame's level)" parenthetical (§12, twice).** The plan implements the momentary reading as the sole gate signal: at 100 ms production frames the momentary window always contains the current frame, so a separate per-frame level check is redundant, and §12's parameter table names momentary as *the* gate. Flagged in case the parenthetical was intended as a required second condition.
7. **Normalizer construction failure (Task 9, Step 6).** §12 does not say what `start` does if `EbuR128::new` fails. The plan propagates the error, failing the system-lane start — which the existing caller already degrades to mic-only. With fixed valid parameters (1 ch, 16 kHz, M|S) this is practically unreachable; the alternative (silently run the lane un-normalized) hides a real bug class for no benefit.
8. **Poisoned normalizer mutex (Task 9, Step 6).** Not covered by §12. The plan passes the frame through un-normalized (log, no drop) rather than returning early like the resampler's poison arm, because §12's totality requirement ("every input frame produces an output frame") argues against dropping audio for a gain-stage failure.

**Type/name consistency:** `guarded` (Task 1) is reused verbatim in Tasks 2 and 3. `VadEvent::SpeechPaused`, `collapse`, `SpeechGate::with_soft_end` are defined and consumed consistently within Task 3. `choose_engine_kind`/`EngineKind` (Task 5) are consumed by `load_boxed_engine` and carry a `cfg_attr(not(feature = "ane"), allow(dead_code))` so the default macOS lib target stays clippy-clean. `coreml_bundle_present` is introduced in Task 5 as a conservative `false` placeholder (so Task 5's `--features ane` gate compiles at its own commit boundary) and replaced by the real completeness gate in Task 6; `CoremlPaths` is produced in Task 7. `FluidAudioEngine::load` signature is fixed in Task 4 and reused in Tasks 5-6.
</content>
</invoke>
