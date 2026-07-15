# Backend transcription (STT) improvements

**Date:** 2026-07-14
**Status:** Proposed design — ready for adversarial review, then planning
**Scope:** Backend only (`apps/desktop/src-tauri`, `apps/desktop/vendor`). No frontend, no web app, macOS-only. Successor to `2026-06-23-demo-muesli-design.md`.

---

## 1. Context and motivation

The transcription foundation from `2026-06-23-demo-muesli-design.md` shipped: two VAD-segmented lanes (`Me`/`Them`), Parakeet TDT 0.6b v3 int8 ONNX on CPU, Silero VAD, a Granola-style markdown sink. It works. This document addresses five measured pain points that have surfaced since, without changing the Tauri contract the frontend depends on.

The architecture is deliberate and stays: **VAD-segmented utterances, not fixed-chunk streaming.** The original doc records that naive fixed-chunk streaming of v3 costs ~46% relative WER, which is why we segment on speech pauses and decode whole utterances. Every change below is constrained to preserve that quality decision.

Measured pain (all verified against current code):

1. **No panic containment.** `run_worker` calls `engine.transcribe_partial`/`transcribe_final` and only `unwrap_or_default()`s the `Result` (`stt/worker.rs:108`, `:128-130`, `:147`, `:177`). A *panic* inside `transcribe-rs`/`ort` — a real risk for a single-maintainer crate pinned at `transcribe-rs = "=0.3.8"` (`Cargo.toml:39`) — unwinds through `run_worker`, kills the `stt-worker` thread, and silently ends that lane for the rest of the session. The `2026-06-23` doc §6 already called for `catch_unwind` "Handy-style"; it was never implemented.

2. **Partial re-decode is wasteful.** During a spoken utterance the worker re-transcribes the trailing `MAX_PARTIAL_MS = 10_000` (`worker.rs:23`) window every `PARTIAL_INTERVAL = 700 ms` (`commands.rs:32`). For any utterance longer than 10 s, each wall-clock second triggers `1 / 0.7 ≈ 1.43` decodes, each over up to 10 s of audio — up to **~14 audio-seconds decoded per wall-second, per lane**, **~28 across both lanes**. There is no backoff: if a decode runs longer than 700 ms (CPU under load, both speakers active), ticks queue up behind it and partial latency grows unbounded.

3. **Durable (final) latency is unbounded up to the cap.** A final is emitted only on `SpeechEnded` (VAD pause) or the `MAX_UTTERANCE_MS = 25_000` safety cap (`worker.rs:20`, `:106`). The markdown sink and the CRDT-insertion seam only ever see finals. A steady talker who never pauses past the ~1.2 s hangover produces nothing durable for up to **25 s + hangover**.

4. **CPU-only pin.** `ParakeetEngine::load` forces `set_ort_accelerator(OrtAccelerator::CpuOnly)` (`stt/parakeet.rs:39`) because the CoreML execution provider is broken for Parakeet (onnxruntime#26355). The Apple Neural Engine sits idle; decode burns CPU and battery.

5. **~1 GB dual-engine RAM.** Each lane owns its own `Box<dyn SttEngine>` = a full Parakeet instance (`commands.rs:407-412` mic, `:491-496` system; the doubling is called out at `commands.rs:484-489`). Two int8 Parakeet instances are ~1 GB resident, plus warm slots (`AppState::warm_mic`/`warm_sys`, `commands.rs:110-117`) that pre-load a *third/fourth* between sessions.

Items 1–3 and part of 5 are quick, self-contained backend wins. Item 4 (ANE) is a phased spike-first effort that also attacks item 5.

---

## 2. Goals / Non-goals

### Goals
- Contain engine panics so one bad inference degrades gracefully instead of killing a lane.
- Cut wasted partial-decode CPU without regressing perceived partial latency.
- Bound durable/markdown latency below the 25 s cap by finalizing at genuine pauses — without violating "keep whole thoughts together."
- Design an ANE inference backend (FluidAudio CoreML) behind the existing `SttEngine` trait, with the CPU ONNX engine as build-time and runtime fallback, phased spike-first.
- Keep every behavioral change testable through the existing seams (`Vad`, `SttEngine`, `Emitter` traits) in CI with no model download and no audio hardware.

### Non-goals (unchanged from the shortlist)
- **No streaming caption model** (Parakeet EOU / Nemotron second model). We keep one durable engine per lane.
- **No DTLN neural AEC.** macOS VoiceProcessingIO (`mic.rs:81`) stays our echo canceller.
- **No diarization** beyond the mic-vs-system split.
- **No frontend / Svelte / web changes.** The Tauri surface stays backward-compatible (see §3).
- **No cross-platform support.** macOS-only stays macOS-only (`transcription_supported()`, `commands.rs:127-130`).

---

## 3. Invariants this design must not break

The frontend is being modified concurrently on mainline; these are load-bearing and must keep working unchanged:

- **Event names:** `transcript://partial`, `transcript://final`, `model://progress`.
- **`TranscriptEvent` JSON shape:** `{ source, text, t0, t1, utteranceId }`, camelCase (`worker.rs:38-48`), asserted by `transcript_event_json_shape` (`worker.rs:384-402`).
- **Command signatures:** `ensure_model`, `start_capture`, `stop_capture`, `check_permissions`, `reveal_output` (plus `transcription_supported`, `platform_is_macos`, `warm_models`) keep their current signatures. New capability may add commands/fields, never break existing ones.
- **Markdown sink format:** Granola-style merged speaker blocks (`output/markdown.rs:65-81`), covered by the `output::markdown` tests.
- **`recorder.svelte.ts` dedupes finals on `${source}:${utteranceId}`** because finals can re-fire on correction. Any change that emits *more* finals per utterance (soft finalization, §6) must keep `utteranceId` monotonic and unique per finalized segment so dedup still holds.
- **`panic = "unwind"` (new, required by §4):** `catch_unwind` only works with the default unwind panic strategy. No profile in `Cargo.toml` sets `panic = "abort"` today (verified), but a future release-profile tweak would silently defeat panic containment — the crate must keep unwinding panics, and the constraint should be pinned with a comment next to the guarded helper.

The internal seams we build on — `Vad` (`audio/vad.rs:9-11`), `SttEngine` (`stt/engine.rs:5-8`), `Emitter` (`worker.rs:54-57`) — are *not* part of the frontend contract and may be extended.

---

## 4. Change 1 — Panic containment around engine calls

### Current behavior
`run_worker` invokes the engine at four sites (`worker.rs:108`, `:128`, `:147`, `:177`), each `unwrap_or_default()`ing the `anyhow::Result`. A returned `Err` already degrades cleanly (empty string → nothing emitted). A **panic** does not: it unwinds the `stt-worker` thread. `stop_capture` later observes the dead thread only as a `join()` that maps the panic to a `"worker thread panicked"` string (`commands.rs:645`), long after the lane went silent.

### Proposed behavior
Wrap each engine call in `std::panic::catch_unwind(AssertUnwindSafe(...))`, collapsing a panic into the same "no text this round" degradation an `Err` already produces, with salvage semantics per call site:

- **Partial decode (`worker.rs:125-141`):** on panic, skip this partial (emit nothing), keep the buffer, continue. A partial is disposable; the next tick or the final recovers.
- **Final on `SpeechEnded` (`worker.rs:143-163`):** on panic, drop the utterance text but still `buffer.clear()` / reset `speech_samples` and advance state as today. We lose one utterance's words, not the lane.
- **Force-final at cap (`worker.rs:106-124`) and disconnect-final (`worker.rs:176-189`):** same — swallow the panic, reset, continue (or exit cleanly on disconnect).

**`utterance_id` invariant.** `utterance_id` increments only when a non-empty final is actually emitted (`worker.rs:119`, `:158` — the increment sits inside the `!text.trim().is_empty()` branch). A panicked or dropped utterance therefore consumes **no** id: the next successful final carries the id the lost utterance would have had. This is safe for the frontend's `${source}:${utteranceId}` dedupe precisely because the dropped utterance emitted no final — there is no event to collide with, and ids remain monotonic and unique *per emitted final*. Panic containment must preserve this: the salvage paths above swallow the panic *without* touching `utterance_id`.

Encapsulate this in a small private helper so the four sites read uniformly and the `AssertUnwindSafe` justification lives in one place:

```rust
// Engine calls run untrusted C/ONNX (or, later, CoreML) code. A panic must
// degrade to "no text this round", never unwind the lane's worker thread.
// AssertUnwindSafe is sound here: on panic we discard the engine's output and
// the utterance buffer, so no observer sees a torn intermediate value.
fn guarded<T: Default>(f: impl FnOnce() -> T) -> T {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or_default()
}
```

Note the call shape: `anyhow::Result<String>` does not implement `Default`, so the existing `unwrap_or_default()` moves *inside* the closure and `T = String`:

```rust
let text = guarded(|| engine.transcribe_final(&buffer).unwrap_or_default());
```

The outer `unwrap_or_default()` then handles the panic case (`catch_unwind`'s `Err`), the inner one the engine's `Err` — both collapse to an empty string, preserving today's "nothing emitted" semantics.

`SttEngine` (`engine.rs:5`) is `Send` but not `UnwindSafe`; `&mut engine` is captured across the boundary, hence `AssertUnwindSafe`. This is sound because on the panic path we treat the engine's result as absent and reset the utterance — no half-updated value is observed.

**Engine health after a panic.** A panic mid-decode may leave `transcribe-rs`/`ort` internal state inconsistent. For the CPU ONNX engine this is low-risk (each `transcribe_with` is self-contained, `parakeet.rs:53-66`), so we keep using the same instance. We add a spike question for the ANE backend (§7): whether a CoreML predict panic can poison `AsrManager` state and warrant marking the engine dead and rebuilding it. To keep the door open, the guarded helper is where a future "panic count → rebuild engine" policy would attach.

**Deliberately not** wrapping the whole `for frame in &rx` loop in one `catch_unwind`: that would lose the salvage granularity (which utterance, which state to reset) and re-enter an unknown VAD/buffer state.

### Failure modes
- Repeated panics on every decode → lane emits nothing but stays alive and keeps consuming frames; no thread death, no cascading `stop_capture` join error. Acceptable, and observable via a rate-limited `eprintln!` on the panic path (mirroring the resampler's one-shot-log pattern, `resample.rs:82-86`).
- Panic during force-final at the 25 s cap → that 25 s window is lost but the lane continues fresh.

### Testing
- Add a `PanickingEngine` implementing `SttEngine` whose `transcribe_partial`/`transcribe_final` `panic!()`. Reuse the existing `ScriptedVad` + `CapturingEmitter` harness (`worker.rs:208-244`).
- `panic_in_partial_is_swallowed_and_lane_survives`: script `SpeechStarted, Speaking, Speaking, SpeechEnded`; assert `run_worker` returns normally (thread not aborted) and the final still fires from a non-panicking final (use an engine that panics only in `transcribe_partial`).
- `panic_in_final_drops_utterance_without_killing_lane`: two utterances, engine panics in `transcribe_final` for the first only; assert the second utterance's final is emitted with `utteranceId == 0` — **not 1** — because the panicked first utterance emitted nothing and so (per the invariant above) consumed no id. This proves both that state advanced past the panic and that the id accounting stayed correct.
- All in-process, no model, no hardware — runs in CI.

---

## 5. Change 2 — Adaptive partial decoding

### Current behavior
The `Speaking` arm (`worker.rs:125-141`) fires a partial whenever `last_partial.elapsed() >= partial_interval`. The decode is synchronous on the worker thread, so a slow decode simply delays the next `for frame` iteration; when it returns, `last_partial.elapsed()` is already well past the interval and the *next* eligible frame decodes immediately. Under load this means back-to-back decodes with no idle — the worker spends ~all its time decoding stale partials, and partial text lags further and further behind live speech. The 10 s window (`MAX_PARTIAL_MS`) makes each decode as expensive as it can be.

### Proposed behavior
Two independent, purely-worker-local changes:

**(a) Overrun-aware cadence (skip, don't queue).** Measure each partial decode's duration. If a decode took longer than `partial_interval`, require a proportional cooldown before the next partial instead of firing immediately. Concretely, gate the next partial on `last_partial.elapsed() >= max(partial_interval, last_partial_cost)`:

```rust
// Never spend more than ~half the wall clock on partials: if a decode took
// longer than the interval, wait at least that long again before the next one.
let due = last_partial.elapsed() >= partial_interval.max(last_partial_cost);
```

This makes partial cadence self-throttling: when decodes are cheap (short buffers, idle CPU) it stays at 700 ms; when a decode blows past the interval (both lanes busy, long window) it backs off to roughly one partial per decode-time, so the worker keeps draining `rx` and reading fresh audio instead of thrashing on stale windows. Finals are untouched — they still run on the whole buffer at `SpeechEnded`.

Because both lanes are independent worker threads, this also indirectly relieves cross-lane CPU contention: a busy lane stops over-scheduling partials and yields CPU to the other lane's finals.

**(b) Shrink the partial window `MAX_PARTIAL_MS` 10_000 → 5_000.** The partial exists only for live on-screen feel; the final re-decodes the whole utterance at full accuracy. Halving the window halves worst-case partial decode cost (from ~14 to ~7 audio-seconds decoded per wall-second per lane) and tightens partial latency, at the cost of the greyed partial showing only the last ~5 s of a long in-progress utterance. That is acceptable: the committed final restores full text, and 5 s is still ~2–3 spoken sentences of live context. Keep it a named constant with the rationale inline.

**Interaction with soft finalization (§6):** soft finalization caps how long an utterance grows before it finalizes, so in practice the partial window rarely fills. (a) and (b) are the safety net for the non-stop-talker case; §6 is the common-case fix.

### Concrete parameters
| Constant | Now | Proposed | Why |
|---|---|---|---|
| `PARTIAL_INTERVAL` (`commands.rs:32`) | 700 ms | 700 ms (floor) | Unchanged as the *minimum* cadence; overrun backoff raises it adaptively. |
| `MAX_PARTIAL_MS` (`worker.rs:23`) | 10_000 | 5_000 | Halves worst-case partial cost; final still whole-utterance. |
| `last_partial_cost` | — | new worker-local `Duration`, default 0 | Drives the backoff; 0 means "no prior decode, use interval floor." |

### Failure modes
- A single pathologically slow decode sets a large `last_partial_cost` and suppresses partials for one extra interval; self-corrects on the next (cheaper) decode. No permanent starvation because the value is replaced each decode, not accumulated.
- If a decode is *faster* than the interval, behavior is identical to today (floor dominates).

### Testing
- `FakeEngine` (`worker.rs:208`) is instant, so cost-based backoff needs a **`SlowEngine`** whose `transcribe_partial` sleeps a configurable duration. With `partial_interval = 0` and a slow partial, assert that across N speaking frames the number of emitted partials is bounded by wall-time / decode-cost rather than N (i.e. backoff engaged). Deterministic enough for CI if the sleep is large relative to scheduling jitter (e.g. 50 ms) and we assert an inequality, not an exact count.
- `partial_window_is_capped_at_max_partial_ms`: feed an utterance longer than `MAX_PARTIAL_MS`, assert (via a `FakeEngine` that echoes `s.len()`) that the partial slice length never exceeds `SAMPLE_RATE * MAX_PARTIAL_MS / 1000`. This also pins the constant against accidental regression.

---

## 6. Change 3 — Soft finalization at natural pauses

### Current behavior
`SpeechGate` (`audio/vad.rs:29-91`) fires exactly one `SpeechEnded` after `end_chunks` consecutive silence chunks. `SileroVad::new` sets `SpeechGate::new(0.5, 2, 38)` (`vad.rs:124`): enter 0.5, exit 0.35, onset 2 chunks (~64 ms), end **38 chunks (~1.216 s)** at 512 samples / 32 ms per chunk. The long hangover is deliberate (comment at `vad.rs:121-123`): "keep whole thoughts together (Parakeet needs the context), so we only break at genuinely long pauses." Consequently a run-on talker who only takes ~0.6–1.0 s breaths never trips `SpeechEnded`; the utterance grows to the 25 s cap before anything durable is emitted.

### Proposed behavior
Add a **secondary, shorter silence signal** that finalizes early *only* when the utterance is already long enough that splitting it at a clear pause is safe. This bounds durable latency for run-on speakers while leaving short conversational turns exactly as they are today.

**Mechanism — a soft-pause event from the gate.** Extend the internal `VadEvent` enum with a new variant `SpeechPaused` (this enum is internal, not the Tauri contract). In `SpeechGate::update`, while `in_speech`, when `silence_run` reaches a secondary threshold `soft_end_chunks` (which is `< end_chunks`), emit `SpeechPaused` **once** for that silence run, then continue emitting `Speaking` until either speech resumes (reset) or `silence_run` reaches `end_chunks` and the normal `SpeechEnded` fires. `SpeechPaused` is advisory: it does not change `in_speech`.

**The enum extension is NOT the trivial part — the event collapse is.** `SileroVad::accept` processes multiple 512-sample chunks per call (real audio frames are ~100 ms ≈ 3 chunks, per the comment at `vad.rs:149-151`) and collapses the per-chunk gate events into one `VadEvent` via the priority match at `vad.rs:158-165`. That match only knows `SpeechStarted`/`SpeechEnded`/`Speaking`; a new variant that is not given an explicit arm falls through `(other, _) => other` and is dropped or masked by a later `Speaking` chunk in the same call. Since the soft pause will, in practice, always fire *inside* a multi-chunk `accept()` call, an unhandled `SpeechPaused` would make the whole feature dead in the real pipeline while every `SpeechGate` unit test still passes. The collapse must therefore rank the new variant explicitly:

```
SpeechStarted > SpeechEnded > SpeechPaused > Speaking > Silence
```

- **Above `Speaking`:** the chunks after a pause fires keep returning `Speaking` (the gate stays in-speech until `end_chunks`), so within one `accept()` call the sequence is typically `[Speaking, SpeechPaused, Speaking]` — the pause must survive that fold or it is silently swallowed.
- **Below `SpeechEnded`:** if a hard end lands in the same call, the worker's `SpeechEnded` arm finalizes the entire buffer anyway; reporting the pause instead would emit a soft-final and then lose the hard end for that call. (With `end_chunks - soft_end_chunks = 20` chunks between them and ~3-chunk frames, co-occurrence needs an anomalous >640 ms frame, but the ordering must still be correct.)
- **Below `SpeechStarted`:** unchanged top priority; start and pause cannot co-occur from one gate (start requires not-in-speech), so this is defensive.

If speech resumes within the same `accept()` call that carried the pause, the collapsed `SpeechPaused` still reaches the worker and splits there. That is correct: the pause was silence-confirmed for the full `soft_end_chunks` when it fired; speech resuming a chunk later does not un-happen it.

**Make the collapse testable in CI.** Today the collapse only exists inline inside `accept()`, and the sole `SileroVad` test is `#[ignore]`d because it loads the ONNX model (`vad.rs:309-317`) — so a broken collapse is invisible to CI. Extract it into a pure function, e.g. `fn collapse(acc: VadEvent, next: VadEvent) -> VadEvent`, called from `accept()`'s loop, and unit-test it directly with no model: assert `[Speaking, SpeechPaused, Speaking]` folds to `SpeechPaused`, `[SpeechPaused, SpeechEnded]` folds to `SpeechEnded`, `[SpeechPaused, SpeechStarted]` folds to `SpeechStarted`, and the existing priorities are unchanged. This closes the seam gap between the `SpeechGate` unit tests and the `ScriptedVad`-driven worker tests (which bypass `accept()` entirely).

**Worker handling.** Add a `SpeechPaused` arm to `run_worker`. On `SpeechPaused`, **first append the arriving frame to the buffer** (`buffer.extend_from_slice(&frame)`, mirroring the `SpeechEnded` arm at `worker.rs:144`), then, if `speech_samples >= soft_min_samples` (the utterance floor), finalize the buffer exactly like a final (emit `transcript://final`, append to sink, increment `utterance_id`), then **soft-reset**: clear the buffer and `speech_samples`, set a fresh `t0`, but do *not* touch VAD state — the gate is still `in_speech`, so subsequent frames continue as `Speaking` into the new (now-empty) utterance. The append-before-finalize order is load-bearing: unlike a hard `SpeechEnded` → `SpeechStarted` cycle, the soft-reset successor gets **no pre-roll protection** (the pre-roll ring only fills during `Silence`, `worker.rs:164-170`, and the gate never leaves in-speech here), so the ~100 ms frame that arrives *with* the pause event — which in the resumed-speech collapse case can contain the successor's first word onset — must not be dropped; appending it to the finalizing buffer is the only place it can land without being lost. If the utterance is below the floor, still append the frame (it is `Speaking`-equivalent audio) but ignore the pause (today's behavior). Because each soft-final increments `utterance_id`, the frontend's `${source}:${utteranceId}` dedup (`recorder.svelte.ts`) stays correct.

This means: a long talker who pauses ~0.5–0.6 s after ≥ 6 s of speech gets a durable line at the pause; the tail after the pause becomes a new utterance and finalizes on its own next pause (or the 25 s cap, or the next soft pause). Short turns (< floor) are never split. The hard `SpeechEnded` at 38 chunks is unchanged and still governs the end of the whole speech run.

### Concrete parameters and justification
| Constant | Value | Justification |
|---|---|---|
| `soft_end_chunks` | **18 chunks (~576 ms)** | Long enough to be a genuine inter-clause/inter-sentence pause, not a mid-word vowel dip (those are already absorbed by the 0.35 exit threshold + hysteresis, `vad.rs:57-61`). Comfortably below the 38-chunk (~1.2 s) hard end, so soft-final only ever fires *before* the hard end, never races it. |
| `soft_min_samples` | **`SAMPLE_RATE * 6000 / 1000` (6 s)** floor | Only utterances ≥ 6 s are eligible to split. Below this we keep whole thoughts intact, matching today. 6 s is ~1–2 spoken sentences: past this length we are in "run-on paragraph" territory where a >0.5 s pause is a paragraph/sentence boundary. |

**Why 18/6000 and not the reference project's 3 s floor / 5 s cap.** The name-twin (report B) force-rotates a chunk at a 3 s minimum and a hard 5 s timer. For our quality bar that is too aggressive: a 5 s timer *cuts mid-sentence* for a continuous speaker, which is precisely the fixed-chunk behavior the ~46% WER finding warns against. Our design never cuts on a timer at all — it cuts only at a **silence-confirmed pause** (18 consecutive low chunks) that occurs **after** enough speech (6 s). The WER reasoning:

- Parakeet's context need is intra-clause/intra-sentence, not cross-sentence. A ≥ 576 ms pause after 6 s of speech is, in natural speech, a sentence or major-clause boundary. Splitting there gives each side its *own* complete context — the encoder sees a full clause, exactly what it needs — so the expected WER delta is near zero.
- We never split mid-word or mid-clause: hysteresis keeps us in-speech through sub-threshold dips (`vad.rs` `hysteresis_keeps_speech_through_a_dip` test), and the pause must persist 18 chunks. This is categorically different from a fixed-time cut.
- The floor guarantees short answers ("Yes.", "Section three, I had a question") — which are most sensitive to context loss and most common in meetings — are never touched.

**Latency bound.** Worst case for a talker who *never* pauses ≥ 576 ms remains the 25 s cap (unchanged; genuinely no safe split point exists). But any speaker who pauses ≥ 576 ms after 6 s — i.e. nearly all real speech — now produces durable output within ~6–13 s instead of up to 25 s. The markdown sink and CRDT seam get fed continuously rather than in 25 s lurches.

### Failure modes
- **False pause inside a sentence** (e.g. a hesitation ≥ 576 ms after 6 s). We split; the two halves each decode with full context, and the sink merges consecutive same-speaker blocks anyway (`markdown.rs:51-61`), so the reader sees one continuous block. Cost is a possible awkward word-boundary between the two finals — low and bounded, and only for utterances already > 6 s.
- **Soft-final then immediate 25 s-cap edge:** after a soft-final resets `t0` and the buffer, the cap counts from the fresh buffer, so the cap can never fire "early" on a soft-reset utterance.
- **Ordering:** soft-finals interleave with the other lane's finals by arrival, same as today; block ordering in the sink is by finalization arrival with `t0` disambiguating (`markdown.rs` doc + `speaker_change_starts_a_new_block` test), so more-frequent finals do not break the format.

### Testing
- **Collapse unit tests (no model, CI-safe) — the load-bearing new tests.** Unit-test the extracted `collapse` function directly: `[Speaking, SpeechPaused, Speaking]` → `SpeechPaused`; `[SpeechPaused, SpeechEnded]` → `SpeechEnded`; `[SpeechPaused, SpeechStarted]` → `SpeechStarted`; existing priorities regression-pinned. Without these, a swallowed `SpeechPaused` in `accept()` is invisible to CI (the only `SileroVad::accept` test is `#[ignore]`d, `vad.rs:309-317`).
- `SpeechGate` unit tests (no model): `soft_pause_fires_once_at_soft_end_chunks` — feed onset then exactly `soft_end_chunks` low probs, assert one `SpeechPaused`, then that continued silence to `end_chunks` yields exactly one `SpeechEnded` and no second `SpeechPaused`. Extend the existing `exactly_one_speech_started_and_one_speech_ended` style (`vad.rs:242-263`).
- `soft_pause_before_floor_does_not_fire_final`: `ScriptedVad` scripting `SpeechStarted, Speaking, SpeechPaused` with small frames (< 6 s of speech); assert `finals.len() == 0`.
- `soft_pause_after_floor_finalizes_and_starts_new_utterance`: with 16,000-sample (1 s) frames, script `SpeechStarted`, six `Speaking` (buffer 7 s = 112,000 samples, past the 96,000-sample floor), `SpeechPaused`, two `Speaking`, `SpeechEnded`; assert **two** finals with `utteranceId` 0 then 1, texts exactly `final:128000` then `final:48000` (via `FakeEngine`'s `final:{len}` echo). The arithmetic is deliberate and unambiguous: the first final is 8 frames (128,000) — 7 pre-pause **plus the frame that arrived with `SpeechPaused`**, pinning the append-before-finalize order — and the second is 3 frames (48,000: two `Speaking` plus the `SpeechEnded` frame), proving the buffer was reset and the paused frame was not double-counted into the successor.
- All deterministic, in-process, CI-safe.

---

## 7. Change 4 — ANE inference via a FluidAudio CoreML backend (phased, spike-first)

### Current behavior
`ParakeetEngine` (`stt/parakeet.rs`) is the only `SttEngine` impl. It loads `transcribe-rs` int8 ONNX from `<app_data>/models/parakeet-tdt-0.6b-v3/` (`model.rs:18`, downloaded as a tarball from `blob.handy.computer`, `model.rs:21`) and forces the CPU execution provider (`parakeet.rs:39`). CoreML EP is unusable (onnxruntime#26355), so the ANE is never touched.

### Proposed behavior (target state)
Add a second `SttEngine` implementation, `FluidAudioEngine`, that runs Parakeet TDT 0.6b v3 on CoreML / the Apple Neural Engine via the Swift **FluidAudio** package, selected at runtime with the existing `ParakeetEngine` (CPU ONNX) as fallback. Nothing above the `SttEngine` trait (`engine.rs:5-8`) changes: the worker, VAD, emitter, markdown sink, and the entire Tauri contract are untouched. This is the whole point of the trait seam the original design paid for.

Our architecture is a perfect fit for FluidAudio's **batch** API: we already hand the engine a complete `&[f32]` buffer (partial = trailing window, final = whole utterance) and want one decode per call. FluidAudio's `AsrManager.transcribe(_ samples: [Float], source:)` is exactly that (the exact shape of the `source:` parameter is unverified from docs alone — confirm during the spike). We do **not** need FluidAudio's `StreamingAsrManager`/`SlidingWindowAsrManager` — using those would reintroduce the streaming model we listed as a non-goal.

#### Abstraction boundary
```
run_worker ── SttEngine trait ──┬─ ParakeetEngine   (transcribe-rs, ONNX, CPU)      [fallback]
                                └─ FluidAudioEngine (FFI → Swift AsrManager, CoreML/ANE) [preferred]
```
`FluidAudioEngine::transcribe_partial`/`transcribe_final` marshal `&[f32]` across a C FFI boundary to a Swift shim that calls `AsrManager.transcribe(samples)` and returns the text. Loading (model resolution + `AsrManager.configure`) happens once in a `FluidAudioEngine::load`, mirroring `ParakeetEngine::load`. The boxed-trait selection in `commands.rs` (`load_boxed_engine`, `:257-265`; warm slots `:271-298`; cold-load `:407-412`, `:491-496`) is the single place that chooses which impl to construct — see the fallback matrix below.

#### Build integration
FluidAudio is a Swift Package (`.package(url: "https://github.com/FluidInference/FluidAudio.git", ...)`). Two viable paths, both proven to exist:

- **Path A — depend on `fluidaudio-rs`.** FluidInference ships `FluidInference/fluidaudio-rs` (on crates.io as `fluidaudio-rs`, latest `v0.12.6`, 2026-03-24). It already does exactly what we need: a Swift layer exports `@_cdecl` C functions wrapping FluidAudio; Rust calls them via `extern "C"`; its `build.rs` compiles the Swift package and links it directly (no prebuilt framework). The entry point we need is the in-memory batch call, `transcribe_samples(&Vec<f32>)` — **not** `transcribe_file(...)`, which would force writing a temp WAV every 700 ms partial tick. Fastest path to a spike, but two caveats: it is early-stage (single-digit maintainers) — the **same single-maintainer risk** the original doc flagged for `transcribe-rs`, which is *why* we keep a fallback — and it is **version-stale**: `v0.12.6` wraps FluidAudio ~0.12.x while FluidAudio itself is at `v0.15.5` (2026-07-07), roughly 3 minor versions / 4 months behind. New FluidAudio features or model-format changes may require waiting on `fluidaudio-rs` releases or moving to Path B.
- **Path B — vendor our own thin `@_cdecl` shim.** Write a minimal Swift file exposing one `transcribe(samples, len) -> text` C function over `AsrManager`, build it in `build.rs` via `swift build`/`xcodebuild` into a static lib, and link it. More control, no third-party Rust crate, but we own the Swift build glue. This is the same pattern `fluidaudio-rs` uses; Path A is essentially "buy" and Path B is "build" of the identical bridge.

To be plain about novelty: **compiling a SwiftPM package from source in `build.rs` is NEW to this crate.** Today's Swift exposure is limited to prebuilt system frameworks — `build.rs` only adds `-Wl,-rpath,/usr/lib/swift` so the OS Swift runtime that `screencapturekit`/`objc2` reference resolves at launch (see the `libswift_Concurrency.dylib` comment in `build.rs`). Nothing in the current build invokes `swift build`/`xcodebuild` or links a from-source Swift static library; that step is unproven here and is tied directly to the go/no-go criteria below (CI and the notarized release pipeline must build it).

We should isolate the FluidAudio backend behind a Cargo feature (e.g. `ane`) and `#[cfg]`, so the crate still builds and the CPU path still ships if the Swift toolchain/link is unavailable in a given build environment — that is the "build-time fallback" requirement.

#### macOS SDK / deployment target
- The crate already effectively targets **macOS 15.7 (Sequoia)**: `screencapturekit` uses `features = ["macos_15_0"]` and the comment pins the target at 15.7 (`Cargo.toml:64-65`). `tauri.conf.json` sets no explicit `minimumSystemVersion`.
- FluidAudio requires **macOS 14.0+** and Swift 6.0 (some newer models need 15+, but Parakeet v3 does not). Our 15.7 floor is comfortably above FluidAudio's minimum. **Spike question:** confirm the Swift 6 toolchain / `swift-tools-version` requirement is satisfiable in CI and in the notarized release build, and that it does not force a bump to the Xcode/SDK the release pipeline uses.

#### Model download / storage changes
- Today: one tarball from `blob.handy.computer` → `<app_data>/models/parakeet-tdt-0.6b-v3/` with a fixed 5-file set (`model.rs:25-31`), gated by `ensure_model` which emits `model://progress` (`commands.rs:203-243`).
- FluidAudio auto-downloads its CoreML bundle from HuggingFace (`FluidInference/parakeet-tdt-0.6b-v3-coreml`) to `~/.cache/fluidaudio/Models/` by default, overridable via `ModelRegistry.baseURL` / `REGISTRY_URL`.
- **Decision — ANE builds download BOTH model sets.** Runtime fallback to ONNX (the matrix below) is only real if the ONNX artifacts are actually on disk. So in ANE builds, `ensure_model` ensures the **ONNX tarball first** (unchanged path, guaranteeing the fallback engine can always load), then fetches the CoreML bundle. Engine selection at `load_boxed_engine` picks ANE iff the CoreML bundle is present and loads, else ONNX. We explicitly own the cost: first run downloads **~1.1–1.6 GB total** (478 MB ONNX + ~0.6–1.1 GB CoreML, the latter an unverified spike input) instead of today's 478 MB. In exchange, every "fall back to ONNX" row below is unconditionally valid, and a CoreML download failure degrades to exactly today's behavior rather than a dead lane. A capture started between the two downloads simply runs on ONNX.
- **Progress reporting: resolved-against a free ride.** FluidAudio documents **no** separate "download only, with progress callback" API — models auto-download inside `AsrModels.downloadAndLoad()`, opaquely. So keeping `model://progress` honest for the CoreML bundle almost certainly requires custom download plumbing on our side: redirect FluidAudio's model dir (via `ModelRegistry.baseURL` / `REGISTRY_URL`, or point it at files we place ourselves) under `<app_data>/models/`, and drive our own HuggingFace download with progress. Note our existing `download_with_progress` (`model.rs:122-149`) handles a **single tarball**, not a multi-file HF model bundle — it needs a multi-file (or manifest-driven) extension, plus a CoreML analogue of the `ParakeetPaths::is_present` completeness gate (`model.rs:76-78`). This is real work, not glue; it feeds the first-run-experience risk in §10. Residual spike question: the cleanest mechanism to make FluidAudio load from a directory we populated ourselves.

#### Warm-slot and dual-lane RAM implications
- Warm slots (`AppState::warm_mic`/`warm_sys`) and the two-engine topology stay structurally identical — they just hold `FluidAudioEngine` boxes. **Spike question (the RAM prize):** does loading two `AsrManager` instances double CoreML/ANE resident memory the way two ONNX instances do, or does CoreML share the compiled ANE program / weights across instances (Apple's model cache can dedupe compiled `.mlmodelc`)? If two ANE engines are materially cheaper than two ONNX engines, item 5 is largely solved for free. If not, §9's shared-engine option is revisited *specifically for the ANE path*, where a sub-quarter-second ANE decode (RTFx-derived, see §9) makes serialization viable.
- The CoreML bundle size (~0.6–1.1 GB depending on precision — **unverified spike input**, from HF repo variants) vs int8 ONNX (~0.5 GB) is roughly comparable per instance; the win is ANE offload (CPU/battery) and possible cross-instance sharing, not necessarily smaller per-instance size.

### Spike plan (do this before productionizing)
A time-boxed spike behind the `ane` feature flag, not shipped:

1. **Link + call:** get a single `transcribe(&[f32]) -> String` round-trip working from the desktop crate to FluidAudio (`AsrModels.downloadAndLoad(version: .v3)` → `AsrManager.configure` → `transcribe`), via Path A (`fluidaudio-rs`) first because it is fastest to stand up.
2. **Parity:** run the existing gated fixture (`tests/fixtures/hello_16k.wav`, used by `parakeet.rs:121`) through both engines; confirm the ANE transcript matches the ONNX transcript on our known clip.
3. **Measure:** decode latency (partial 5 s window, final whole-utterance), CPU%, and **resident RAM for one vs two `AsrManager` instances** (the item-5 question).
4. **Failure behavior:** force a CoreML load failure (missing/renamed model) and a decode panic; confirm we can fall back to `ParakeetEngine` cleanly and that a predict panic is containable by §4's guard.

**Go / no-go criteria:**
- **Go** if: ANE final-decode latency ≤ CPU ONNX (expected far better), transcript parity holds on the fixture and a manual meeting smoke test, two-instance RAM is ≤ the current ~1 GB (ideally well under), and clean runtime fallback to ONNX is demonstrated.
- **No-go / stay on CPU** if: the Swift link/toolchain can't be made to build in CI and the notarized release pipeline; or ANE parity regresses WER noticeably; or two-instance RAM exceeds the current baseline with no sharing path. In that case we keep the quick wins (§4–§6, §9) and shelve ANE.

### Failure / fallback matrix
| Condition | Behavior |
|---|---|
| `ane` feature off at build time | Crate builds ONNX-only; `FluidAudioEngine` not compiled. Identical to today. |
| `ane` on, Swift link fails at build | Build fails fast in the `ane` config only; release pipeline can pin the ONNX-only config until green. |
| `ane` on, ONNX tarball download fails | `ensure_model` fails as today (capture blocked with a retry path). The ONNX set is fetched *first*, so we never end up with only a CoreML bundle and no fallback. |
| `ane` on, CoreML bundle download fails (ONNX present) | `ensure_model` still succeeds for the ONNX set; `load_boxed_engine` selects `ParakeetEngine` (ONNX). Lane runs on CPU — identical to today. Valid unconditionally because ANE builds always download both sets (see download decision above). |
| `ane` on, `FluidAudioEngine::load` fails at runtime | `load_boxed_engine` returns the ONNX engine instead (single fallback point, `commands.rs:257-265`); ONNX artifacts are guaranteed on disk by the both-sets download. |
| ANE decode returns error | Same as ONNX error today: `unwrap_or_default()` → empty text, nothing emitted. |
| ANE decode panics | §4 guard swallows it; spike question decides whether to also mark the engine dead and rebuild as ONNX. |
| One lane ANE, other lane fails to load ANE | Independent per-lane selection — mixed ANE/ONNX lanes are fine; both implement `SttEngine`. |

### Testing
- `SttEngine` seam is unchanged, so `worker.rs` tests need no ANE. The FluidAudio engine gets its own **`#[ignore]` gated integration test** mirroring `parakeet.rs::transcribes_known_clip` (`parakeet.rs:109-125`): same fixture, asserts "hello". Gated because it needs the CoreML model download + Swift link — never in CI.
- **Fallback selection is unit-testable without CoreML:** refactor engine selection into a small pure function `select_engine(ane_available: bool, ...) -> Box<dyn SttEngine>` and test that `ane_available = false` yields the ONNX path. The `FakeEngine` covers the worker; no model needed.
- CI builds the default (ONNX-only) config; a separate non-CI job exercises the `ane` feature on an Apple-Silicon runner during the spike.

---

## 8. Change 5 (evaluated) — dual-lane engine sharing: **rejected for the CPU path**

See §9 Alternatives. Summary: sharing one engine between the two lanes to reclaim ~500 MB is **not worth it for the CPU ONNX engine** because it introduces decode contention exactly when it hurts most (both speakers active), and it is **deferred as an ANE-path question** where a sub-quarter-second decode (RTFx-derived, see §9) changes the math. No CPU-path work is proposed here.

---

## 9. Alternatives considered

### Shared single engine across both lanes (item 5) — rejected for CPU, deferred for ANE
**Idea:** one `Box<dyn SttEngine>` behind a `Mutex`, shared by both lane workers, to halve the ~1 GB dual-engine RAM (`commands.rs:484-489`).

**Why rejected (CPU ONNX):** the two lanes decode *independently and often*. With `PARTIAL_INTERVAL = 700 ms` and (even shrunk) a 5 s window, each lane wants a decode every ≤ 700 ms. A CPU int8 decode of a multi-second window is a meaningful fraction of that interval, and both lanes peak **simultaneously during cross-talk** — the exact moment a meeting transcriber must not stall. A shared mutex serializes them: worst case one lane's final waits behind the other's partial. The adaptive backoff (§5) would then starve one lane's partials to feed the other. Trading correctness/latency under cross-talk for ~500 MB on machines that have the RAM is a bad deal. The current per-lane engine design is right for CPU.

**Why deferred (ANE):** FluidAudio quotes ~110–190x real-time factor (RTFx) on an M4 Pro. Derived estimates (to be measured in the spike, not asserted): a worst-case 25 s final decodes in ~0.13–0.23 s, and a 5 s partial window in ~0.03–0.05 s. If two `AsrManager` instances *don't* share ANE memory (a §7 spike question) but a single shared instance decodes at those speeds, serializing two lanes through one ANE engine becomes plausible (combined demand fits comfortably within the partial cadence). So sharing is re-opened **only** as part of the ANE productionization, informed by the spike's RAM and latency numbers — not now.

### 3–5 s chunk rotation (reference project's endpointing) — rejected
The name-twin force-rotates a WAV chunk at a 3 s minimum / 5 s hard timer (report B, `StreamingVadController`). A hard timer cuts mid-sentence for a continuous speaker — the fixed-chunk behavior behind the ~46% WER finding. Our §6 soft finalization achieves the same latency goal *without* a timer: it splits only at a silence-confirmed pause (18 chunks) after a 6 s floor, so cuts land at sentence boundaries. We take their goal, reject their mechanism.

### Second streaming caption model (Parakeet EOU / Nemotron) — rejected (explicit non-goal)
The reference runs a separate streaming EOU model for live captions alongside the durable model. That doubles model RAM and inference, adds a reconciliation layer (provisional-tail trimming), and is a large surface — all for word-level live captions we do not need. Our partials (§5) already give the "live feel." Firmly out of scope.

### DTLN neural AEC — rejected (explicit non-goal)
The reference cleans the mic with a DTLN model using the system audio as reference before VAD. We already route the mic through macOS VoiceProcessingIO (AEC+NS+AGC, `mic.rs:81`) and exclude our own process audio on the system lane (`system.rs:154`). Adding a neural AEC stage is a second audio-DSP dependency for marginal gain over the OS canceller. Rejected.

### Diarization — rejected (explicit non-goal)
The reference runs pyannote on the system lane. Our two-lane split already gives free speaker separation (`Me`/`Them`); sub-diarizing "Them" into individual speakers is a product feature, not a transcription-quality fix.

### Partial-event cost coalescing (shortlist item 5, second half) — declined
The shortlist floated coalescing partial *emissions* if achievable purely backend-side. Declined: the dominant cost of a partial is the decode, not the Tauri emit, and §5's adaptive backoff already reduces partial frequency (and therefore emission frequency) as a side effect; any further coalescing (debouncing display updates) is a frontend concern and out of scope.

### Async/threaded partial decoding (decouple decode from the frame loop) — rejected as over-engineering now
We could move partial decodes to a separate thread so a slow decode never blocks frame draining. But it adds a cancellation/staleness protocol (drop superseded partials) and shared-buffer synchronization for a problem §5's synchronous backoff already tames. If the ANE path lands and decodes get cheap, this becomes moot. Not now.

---

## 10. Risks

- **Soft finalization splits a thought at a false pause** (§6). Mitigated by the 6 s floor + 576 ms silence confirmation + same-speaker block merge in the sink. Residual risk is a rare awkward word boundary on long utterances; the adversarial reviewer should pressure-test the 18/6000 constants against real meeting audio.
- **`catch_unwind` masks a genuinely broken engine** (§4): a lane could sit silently swallowing panics. Mitigated by rate-limited logging; the spike should decide a "N panics → rebuild/fall back" policy for the ANE path.
- **FluidAudio / `fluidaudio-rs` single-maintainer risk** (§7) — the very risk that motivated the `SttEngine` fallback. Mitigated by keeping ONNX as a first-class runtime fallback and gating ANE behind a feature.
- **Swift toolchain in CI / notarized release** (§7): building/linking a Swift package in the release pipeline is unproven for this crate beyond the existing `screencapturekit` dependency. This is the single biggest go/no-go risk for item 4.
- **First-run download size / UX** (§7): ANE builds download both model sets, ~1.1–1.6 GB total versus today's 478 MB — a deliberate cost we accept to make runtime ONNX fallback unconditional. Worse, FluidAudio has no progress-reporting download API (resolved-against, §7), so honest `model://progress` requires our own multi-file HF download plumbing (the current `download_with_progress`, `model.rs:122-149`, only handles a single tarball). If that plumbing slips, first-run feels broken (a silent multi-hundred-MB stall); the go/no-go should treat progress honesty as part of "productionizable."
- **Path A version staleness** (§7): `fluidaudio-rs` `v0.12.6` (2026-03-24) wraps FluidAudio ~0.12.x, while FluidAudio itself is at `v0.15.5` (2026-07-07) — ~3 minor versions / ~4 months behind. Depending on Path A means new FluidAudio features, fixes, or model-format changes wait on `fluidaudio-rs` releases (or force a move to Path B, which tracks FluidAudio directly). Pin exact versions of both during the spike.

---

## 11. Rollout / phasing

**Phase 1 — quick wins (no new dependencies, all behind existing seams):**
1. §4 panic containment (`worker.rs`). Smallest, highest safety value; ship first.
2. §5 adaptive partial decoding + `MAX_PARTIAL_MS` 10_000 → 5_000 (`worker.rs`, `commands.rs`).
3. §6 soft finalization (`audio/vad.rs` gate + `worker.rs` arm). New `SpeechPaused` internal event; constants `soft_end_chunks = 18`, `soft_min_samples = 6 s`.

All three are pure-Rust, unit-tested through `Vad`/`SttEngine`/`Emitter` fakes, CI-safe, and independently shippable. They require no model download, no hardware, and do not touch the Tauri contract.

**Phase 2 — ANE spike (§7), time-boxed, behind the `ane` feature:**
4. Stand up the FluidAudio bridge (Path A `fluidaudio-rs` first), run the parity + latency + RAM + fallback spike, decide go/no-go against the criteria.

**Phase 3 — ANE productionization (only if Phase 2 is a go):**
5. `FluidAudioEngine` as the preferred `SttEngine`, ONNX fallback wired at the single `load_boxed_engine` selection point, `ensure_model` extended for the CoreML bundle with `model://progress` preserved. Revisit shared-engine RAM (§9) with the spike's numbers.

Phase 1 delivers the latency and stability wins immediately and is independent of the ANE outcome; Phase 2/3 chase the CPU/battery/RAM prize with an explicit escape hatch back to CPU.

---

## 12. Addendum (2026-07-14) — system-lane loudness normalization (EBU R128)

*Appended after approval of §1–§11; those sections are unchanged. Source of the idea: a third-repo study of github.com/Zackriya-Solutions/meetily (Tauri 2 + Rust meeting app; per the report, same Parakeet v3 int8 ONNX model, CPU-only via raw `ort`), which runs a stateful `ebur128` normalizer targeting -23 LUFS on every mic chunk before Silero/Parakeet (their `frontend/src-tauri/src/audio/pipeline.rs:296-306`, `558-571`). One idea from that study survives comparison with our pipeline; see §13 for what the rest of their pipeline validates.*

### Scoping: which lane, and why not the other

- **Mic ("Me") lane — rejected.** Our mic already runs through the macOS VoiceProcessingIO unit with AGC (plus AEC and NS, `mic.rs:81`). Stacking an R128 normalizer on top would double-process the signal: two gain-control loops with different time constants fighting each other is a classic pumping recipe, and the OS AGC already delivers the "consistent level into the model" property. Meetily normalizes its mic lane precisely because it has *no* VPIO — their gap, not our opportunity.
- **Non-macOS cpal fallback — out of scope.** The entire STT stack is macOS-only (`transcription_supported()`, `commands.rs:127-130`); designing normalization for a lane that can never reach the model is dead code.
- **System ("Them") lane — the real candidate.** ScreenCaptureKit audio (`audio/system.rs`) has no AGC or normalization anywhere in its path: remote meeting-app voices arrive at whatever level the sender's mic, the meeting app's processing, and the user's output volume conspire to produce, and routinely vary by well over 20 dB between participants. Quiet remote speakers are the worst failure mode: they can hover near Silero's 0.5 enter threshold and be dropped *entirely* (never gated in, never transcribed), and even when gated in, int8 Parakeet sees an input far from any consistent level. This lane gets the normalizer.

### Current behavior

The system lane's `AudioOutput::did_output_sample_buffer` converts each `CMSampleBuffer` to f32, resamples 48 kHz -> 16 kHz mono via the `Mutex<Resampler>` (`system.rs:105-111`), and sends the frame (`system.rs:112-114`). The worker feeds every frame to `SileroVad::accept` (`worker.rs:89`) and buffers it for the engine. No gain stage exists anywhere between capture and model.

### Proposed behavior and seam

New module `audio/normalize.rs` with a `LoudnessNormalizer` struct, instantiated **only** in the system lane's `AudioOutput` (`system.rs:158-162`), applied to each frame **after** the resampler and **before** `tx.send` — i.e. after downmix/resample to 16 kHz, before anything downstream sees the audio:

```
SCStream -> bytes-to-f32 -> Resampler (48k -> 16k mono) -> LoudnessNormalizer -> tx -> worker (VAD -> buffer -> engine)
```

Why this seam and not the worker:
- **Lane-specificity by construction.** The mic path never touches this code; no per-lane flag threads through `run_worker`, whose signature and lane-agnostic semantics stay untouched.
- **It mirrors an existing pattern.** `AudioOutput` already owns a `Mutex<Resampler>` for exactly this kind of per-frame stateful DSP on the ScreenCaptureKit dispatch queue; the normalizer sits beside it as `Mutex<LoudnessNormalizer>`. The work per frame is a loudness-meter update and a multiply — trivially cheap relative to the resampler.
- **VAD and ASR see identical audio.** Normalizing in the capture path (rather than, say, only the engine buffer) keeps a single signal of record: the pre-roll ring, the VAD probabilities, and the transcribed buffer all describe the same samples. Splitting them (raw into VAD, normalized into engine) would make gate decisions and transcripts diverge subtly and untestably.

Normalizing **into** the VAD (pre-VAD, as Meetily does) is desired, not incidental: the dropped-quiet-speaker failure is a *VAD* failure first. A consistent level into Silero makes the 0.5/0.35 thresholds mean the same thing for every remote participant.

### Design: gated short-term R128, not integrated loudness, not plain RMS

**Why R128 machinery at all, versus a peak/RMS AGC:** K-weighting approximates perceptual loudness of speech far better than flat RMS, and — decisively — R128 gating ignores silence and low-level noise when measuring. A plain RMS tracker on a meeting stream spends most of its time measuring silence between turns and drifts its gain up to amplify the noise floor, which then marches straight into Silero as false speech energy. A gated loudness measure is driven by speech when speech is present and holds otherwise. Rolling our own "gated, weighted RMS with smoothing" is reimplementing half of libebur128, worse. The `ebur128` crate (pure Rust port of libebur128, MIT, no C, no model, used in Meetily's similar — though differently scoped, mixed-mono mic-side — stack) does this for us; its API is confirmed on docs.rs: `EbuR128::new(channels, rate, Mode)` with combinable modes, incremental `add_frames_f32`, `loudness_shortterm`/`loudness_momentary`, arbitrary rates including 16 kHz mono.

**Why short-term (3 s) as the level measure, not integrated:** integrated loudness is defined over the whole program with relative gating — it converges ever more slowly as the meeting grows and stops adapting to the thing we actually face: *different speakers at different levels within one stream*. The short-term (3 s) measure adapts per speaker turn but is far too slow to track syllables. Momentary (400 ms) is the wrong *level measure* — it would ride individual words (pumping) — but exactly the right *gate signal*, which brings us to the load-bearing split:

**Measure/gate split (load-bearing).** The freeze/update decision must NOT be evaluated on the same 3 s short-term measure that drives the gain, because a 3 s window does not read "silence" until it has almost fully flushed: after speech at -23 LUFS stops, short-term decays as `-23 + 10*log10((3-t)/3)` — still ≈ -26 LUFS at 1.5 s into the pause, ≈ -33 at 2.7 s — and crosses a -50 gate only when the window is >99.5 % flushed (~3 s), or never if the remote noise floor sits above the gate. Gated that way, the gain would wind toward +12 dB in *every* inter-turn pause. So the design uses **two readings from one `EbuR128` instance (`Mode::M | Mode::S`)**: short-term (3 s) is the level the gain corrects toward; **momentary (400 ms) is the activity gate** — the moment momentary (or the current frame's level) drops below `GATE_LUFS`, gain freezes, within ~400 ms of a pause onset, long before the 38-chunk (~1.2 s) `SpeechEnded` hangover completes.

**Parameters** (all named constants in `audio/normalize.rs`, with this rationale inline):

| Constant | Value | Justification |
|---|---|---|
| `TARGET_LUFS` | **-23.0** | The EBU R128 reference level, and what Meetily targets with the same model. The goal is *consistency* into the model, not a particular absolute level; -23 leaves ~20 dB of true-peak headroom, so even a +12 dB-boosted quiet source stays far from clipping. Whether Parakeet WER prefers a hotter target (e.g. -16) is an open measurement, see below. |
| `MEASURE` | level: short-term (3 s); gate: momentary (400 ms) — one `EbuR128` instance, `Mode::M \| Mode::S` | The measure/gate split above. Short-term adapts per speaker turn and is immune to syllable-rate pumping; momentary reacts to a pause within ~400 ms, which a 3 s window cannot. |
| `GATE_LUFS` | **-50.0** | Desired gain only updates while **momentary** loudness (or the current frame's level) exceeds -50 LUFS — i.e. someone is plausibly speaking *right now*. The moment it drops below, gain **freezes**, within ~400 ms of pause onset. -50 sits well above ebur128's -70 absolute gate and well below quiet speech. Deliberately never evaluated on the short-term measure (see the split rationale). |
| `MAX_BOOST_DB` / `MAX_CUT_DB` | **+12 / -12** | Covers the realistic spread of meeting-app output levels while bounding the worst side effect of boosting: noise-floor amplification into Silero. A bounded gain means a bounded shift in VAD behavior, which is what lets us keep the 0.5/0.35 thresholds unchanged (see below). |
| `MAX_SLEW_DB_PER_100MS` | **1.0** (10 dB/s) | Gain moves toward its target by at most 1 dB per 100 ms of audio. Adapts fully to a new ±12 dB speaker within ~1.2–2.4 s (one conversational turn) but cannot pump within a word, and cannot step audibly across a VAD boundary — the normalizer has no VAD knowledge, so slew-limiting *is* the anti-pump mechanism. |
| `STARTUP_UNITY_S` | **3.0** | Until 3 s of audio has been metered, the short-term window is unfilled and the measure is garbage; hold unity gain. Cost: the first utterance of a session may be un-normalized. Accepted — it degrades to exactly today's behavior. |
| `CLIP_CEIL` | **0.99** | Per-frame peak guard: if the post-gain peak of a frame would exceed 0.99, that frame's applied gain is scaled down to fit (the smoothed gain state is *not* updated by this) — transparent limiting without waveshaping color. With -23 LUFS target and +12 dB max boost this engages at most transiently — during the ~1–2 s slew after a quiet-to-loud speaker handoff (see failure modes) — never as a sustained limiter. |
| `SYSTEM_LOUDNESS_NORMALIZATION` | **`true`** (const) | Kill switch. A compile-time constant, not a user setting: if normalization interacts badly with Silero or Parakeet in the field, reverting is a one-line change with no UI, no config surface, no contract impact. |

**Silence behavior:** when momentary loudness drops below the gate, gain freezes at its last speech-driven value (initially unity) within ~400 ms, and every frame passes through at that frozen gain — silence stays silence (a multiply of near-zeros), the meter keeps running so the reading is current when speech resumes, and nothing can blow up (no division by measured loudness anywhere; gain is always a clamped, slewed value).

**Interaction with Silero thresholds:** normalization changes the input statistics the `SpeechGate` constants (0.5 enter / 0.35 exit, `vad.rs:124`) were informally tuned against. We deliberately do **not** retune them in this change: the bounded ±12 dB gain bounds the probability shift, and the direction of the shift is the one we want (quiet speech moves *up* toward the enter threshold; the momentary-gated freeze keeps the noise floor from following). Critically, the fast gate protects §6's machinery: gain freezes ~400 ms into a pause, so during the 38-chunk (~1.2 s) `SpeechEnded` hangover — and the 18-chunk soft-pause window — the noise floor is passed at the frozen speech-level gain, never at a wound-up boost; silence keeps reading as silence to the VAD. If the manual meeting smoke test shows increased false `SpeechStarted` on the system lane, the first lever is lowering `MAX_BOOST_DB`, not touching the shared gate constants.

### Failure modes

- **Boosted background music/noise from the remote side gates in as speech.** Bounded by `MAX_BOOST_DB` and the -50 LUFS gate; residual risk is the same class of false positive the lane has today, at most 12 dB more sensitive. Kill switch if it bites.
- **ebur128 returns an error / NaN (e.g. before window fill).** Treat any non-finite or absent loudness as "gate closed": freeze gain. The normalizer must be total — every input frame produces an output frame of the same length under all conditions.
- **Two speakers at very different levels alternating.** With the momentary gate, gain does *not* move during the gaps between turns — it freezes at the previous speaker's correction and slews toward the new speaker only while they speak (10 dB/s). A loud speaker following a quiet one is therefore over-boosted for the first ~1–2 s of their turn, bounded by the slew rate and caught by `CLIP_CEIL` in the worst case; each turn is progressively corrected, and nothing re-winds toward `MAX_BOOST_DB` during pauses. Strictly better than today (uncorrected) and better than a compromise average.
- **Remote noise floor above the gate (momentary > -50 LUFS in pauses).** For such streams the gate stays open between turns and gain slews toward boosting the floor, bounded by `MAX_BOOST_DB`. First lever: raise `GATE_LUFS` (e.g. -45/-40). If absolute gating proves untunable across real meeting apps, the fallback design is a relative gate (freeze when momentary falls a fixed margin below short-term); the kill switch covers the interim.
- **Contract impact: none.** Same frames, same shapes, same events; `t0`/`t1`, the `TranscriptEvent` shape, and the markdown sink are untouched. The pre-roll ring simply stores normalized samples.

### Testing (CI-safe: pure DSP, no model, no hardware)

Unit tests on `LoudnessNormalizer` with synthetic buffers at 16 kHz mono, feeding ~100 ms frames to mirror production cadence:

- `quiet_sine_is_boosted_toward_target`: a -40 dBFS 220 Hz sine for >3 s; assert output RMS rises monotonically after the startup window and the applied gain approaches (and never exceeds) `MAX_BOOST_DB`.
- `hot_sine_is_cut_toward_target`: a -6 dBFS sine; assert gain goes negative (cut), bounded by `MAX_CUT_DB`.
- `silence_never_blows_up`: all-zero frames for 10 s; assert output is all zeros, gain stays at unity (gate never opens), and no sample is non-finite.
- `gain_freezes_below_gate`: a speech-level sine for 5 s (gain adapts), then 3 s of digital silence; assert the gate closes within ~500 ms of silence onset (momentary decay) and that the gain applied for the remainder of the silence is exactly the frozen value — flat, with zero drift toward `MAX_BOOST_DB`. This test is implementable *only because* the gate signal is momentary: the 3 s short-term measure still reads ≈ -26 LUFS 1.5 s into the pause, so a short-term-gated design could not pass it.
- `slew_is_bounded`: step the input level -40 -> -10 dBFS; assert per-frame gain delta never exceeds `MAX_SLEW_DB_PER_100MS`.
- `clip_guard_holds_ceiling`: a near-full-scale burst arriving while gain is boosted; assert no output sample exceeds `CLIP_CEIL`.
- `unity_during_startup`: assert the first 3 s of any input pass through bit-identical (gain exactly 1.0).

A worker-level test is **not** added: the normalizer lives in the system capture path (`system.rs`), which the worker tests deliberately do not exercise — the `ScriptedVad`/`FakeEngine` harness starts at the frame channel, *after* this seam. Forcing a worker test would mean threading the normalizer through `run_worker` solely for testability, which is the seam choice we rejected above.

### Alternatives considered (addendum-local)

- **Normalizing the mic lane too (Meetily's actual placement)** — rejected: double-processing against VPIO AGC, see scoping above.
- **80 Hz high-pass filter pre-VAD** (also present in Meetily's chain) — declined: on our mic lane VPIO's noise suppression already covers rumble, and the system lane carries meeting-app-processed voice that has been through the sender's own voice filtering; an extra HPF is a dependency and a tuning surface with no identified failure it fixes.
- **Plain peak/RMS AGC (no dependency)** — rejected: ungated RMS tracks silence and amplifies the noise floor into the VAD; building gating + weighting ourselves is reimplementing `ebur128` badly. See design rationale.
- **Integrated-loudness (true R128 program normalization)** — rejected for streaming: converges to a whole-meeting average and stops adapting to per-speaker variance, which is the actual problem.
- **Post-VAD normalization (engine buffer only)** — rejected: leaves the dropped-quiet-speaker VAD failure unfixed and splits the signal of record between VAD and engine.

### Phasing and open questions

Ships as a Phase 1-adjacent quick win (it is independent of §4–§6 and of the ANE track), gated by the `SYSTEM_LOUDNESS_NORMALIZATION` constant, with one new pure-Rust dependency (`ebur128`).

Open questions for the reviewer:
- Is -23 LUFS the right target for int8 Parakeet, or does WER improve at a hotter target (e.g. -16)? Measurable offline with the gated fixture WAV re-scaled to several loudness levels — worth doing before shipping if cheap. Tempering expectations: Parakeet's NeMo front end applies per-utterance feature normalization, so WER sensitivity to absolute input level is likely low — the primary beneficiary of this change is the *VAD* (quiet speakers gated in at all), not the decoder.
- Is -50 LUFS momentary the right absolute gate for real meeting streams, whose pause-time noise floors vary by app and participant? (See the noise-floor failure mode: a floor above the gate keeps gain updating through pauses. Levers: raise `GATE_LUFS`, or fall back to a relative momentary-vs-short-term gate.)
- Should the startup window seed the gain from momentary loudness once ~400 ms is available (faster first-utterance correction, noisier initial estimate)? Nearly free now that `Mode::M` is enabled for the gate; the default in this design remains 3 s of unity gain.

(The earlier short-term-vs-momentary question is folded into the measure/gate split — momentary is now a structural part of the design, not a tuning alternative. The `ebur128` API question is resolved: the crate's incremental `add_frames_f32` and `loudness_shortterm`/`loudness_momentary` at 16 kHz mono are confirmed on docs.rs.)

---

## 13. Addendum — third-repo validation (Meetily)

Per the third-repo research report, Meetily's pipeline converges on our core choices: the same Parakeet TDT 0.6b v3 int8 model, CPU-only ONNX for Parakeet — consistent with the CoreML-EP breakage (onnxruntime#26355) that is the actual evidence behind §7's conclusion that ANE requires the CoreML/FluidAudio route (their public sources do not let us independently verify their ORT constraints, and their README advertises Metal+CoreML for a separate Whisper.cpp backend) — plus, again per the report rather than independently verified (their public VAD config exposes a 400 ms redemption-time parameter, not these constants), Silero at ~0.50/0.35, ~300 ms pre-roll, ~250 ms min-speech, and VAD-segmented whole-utterance decoding. Equally validating are the gaps the report records: no AEC (we have VPIO), a mono-mixed single lane that loses speaker identity (we have two lanes), no partials on Parakeet (we have adaptive partials, §5), uncapped segment length (we have the 25 s cap plus soft finalization, §6), and no `catch_unwind` around inference (§4). Their one idea that improves on our pipeline is the loudness normalization adopted — with different lane scoping — in §12.

---

## 14. Spike results (Phase 2)

Spike executed 2026-07-14 on Apple Silicon (arm64), Swift 6.2.4 (Xcode 26.3, swiftlang-6.2.4.1.4), macOS 15.x, Rust 1.93.0. Feature-gated code landed behind `ane` (`stt/fluidaudio.rs`, `Cargo.toml` optional dep, gated `#[ignore]` integration test). Default and Linux builds are unaffected.

### Decision: **GO**

Every go/no-go criterion in §7 is met: build integration works end-to-end from `build.rs`/`swift build`; transcript parity is exact on the fixture; ANE final-decode latency is well under CPU ONNX; and two-instance ANE RAM is ~122 MB, an order of magnitude under the ~1 GB dual-ONNX baseline. Recommendation: proceed to Phase 3 (Tasks 5-8). The only material caveat is a build-pipeline risk that is engineering, not feasibility (see "Build integration" below).

### Build / toolchain facts

| Item | Value |
|---|---|
| Crate / version used | `fluidaudio-rs = "=0.14.1"` (Path A). **Not `=0.12.6`** — see surprise 1. |
| Wrapped FluidAudio version | `0.14.1` exactly (`Package.resolved`, pinned `exact: "0.14.1"`, rev `d302273`). **Not stale** vs the design's feared 0.12.x-behind-0.15.5 gap. |
| Swift toolchain | Swift 6.2.4; `Package.swift` declares `swift-tools-version:5.10`, platforms `.macOS(.v14)`. Satisfied comfortably by our 15.7 floor. |
| `swift build -c release` (cold, fetch + compile FluidAudio + bridge) | **84.8 s**, peak build RSS ~1.5 GB. Warnings only, no errors. |
| Bridge static lib | `libFluidAudioBridge.a` = **26.7 MB**. Linked with Foundation, AVFoundation, CoreML, Accelerate, Metal, MetalPerformanceShaders, `swiftCore`, `c++`. |
| FluidAudio SwiftPM checkout | ~7 MB source (models are downloaded at runtime, not vendored). |
| First-run ASR init (model download + Neural Engine compile) | ~30-40 s one-time; the gated integration test end-to-end ran in 44 s cold. |

`fluidaudio-rs`'s own `build.rs` fully self-contains the Swift build (runs `swift build -c release`, emits all `rustc-link-lib`/`rustc-link-search`). **Our `build.rs` needed no change** — the link directives propagate from the dependency's build script. The crate ships a `.cargo/config.toml` with `-mmacosx-version-min=14.0`, which does NOT propagate to a consuming crate, but this is harmless: our deployment target (15.7) already exceeds it.

### Parity

Same fixture (`tests/fixtures/hello_16k.wav`) through both engines:
- ONNX `ParakeetEngine`: `"hello world."`
- ANE `FluidAudioEngine`: `"hello world."`

**Exact match.** No WER regression on the known clip.

### Latency (decode wall time, whole-buffer final; 16 kHz mono)

| Buffer | ANE (CoreML) | ONNX (CPU) | ANE speedup |
|---|---|---|---|
| 5 s (80k samples) | **122 ms** (rtfx ~41x) | 223 ms | 1.8x |
| 25 s (400k samples, worst-case cap) | **237 ms** (proc ~237 ms) | 994 ms | 4.2x |

ANE final-decode latency is unambiguously ≤ CPU ONNX and the gap widens with buffer length (the ONNX cost scales roughly linearly with audio length; the ANE cost is dominated by fixed overhead). The worst-case 25 s final decodes in ~0.24 s on ANE — comfortably inside the 700 ms partial cadence, which keeps §9's shared-single-engine option (Task 8) live. (`AsrResult.rtfx` reported 0.0 for the 25 s buffer — a metadata glitch in the crate on long inputs; `processing_time` is reliable and used above. Numbers are from a debug-profile Rust wrapper over release-compiled engines, so they represent the engines faithfully.)

### RAM (resident set, one vs two `AsrManager` instances)

| State | RSS |
|---|---|
| Process baseline | 9 MB |
| One ANE engine (loaded + warmed) | 85 MB |
| Two ANE engines | **122 MB** (second instance adds only **~37 MB**) |

**This is the RAM prize (§7 item 5).** CoreML shares the compiled `.mlmodelc` program/weights across `AsrManager` instances: the second engine costs ~37 MB, not another ~76 MB. Two ANE lanes (~122 MB) are roughly 8x cheaper than the ~1 GB dual-ONNX baseline the design cites. Because two instances are already this cheap, the shared-single-engine complexity (Task 8 Step 2) is likely **unnecessary** for ANE — the per-lane topology is fine. (A clean absolute ONNX RSS was not re-measured here; freed CoreML mappings are not returned to the OS promptly, so the post-drop ONNX reading was confounded. The design's ~500 MB/instance ONNX figure stands as the baseline.)

### Model download / storage (surprise vs the design's assumptions)

- **CoreML bundle size: 469 MB** (measured), NOT the design's guessed 0.6-1.1 GB. It is comparable to the int8 ONNX set (~478 MB tarball / ~640 MB extracted). So both-model-sets first-run download is **~950 MB total**, below the design's 1.1-1.6 GB estimate.
- **Cache path: `~/Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v3/`** (measured + confirmed in `DownloadUtils.swift`), NOT `~/.cache/fluidaudio/Models/` as the design assumed (that path is TTS-only in current FluidAudio).
- **CoreML artifact set** (for Task 7's `COREML_REQUIRED_FILES` completeness gate): `Encoder.mlmodelc/`, `Decoder.mlmodelc/`, `JointDecisionv3.mlmodelc/`, `Preprocessor.mlmodelc/` (each a compiled CoreML *directory*), plus `parakeet_v3_vocab.json`, `parakeet_vocab.json`, `config.json`. Note the `.mlmodelc` entries are directories, so the completeness gate must check directory presence, not just files.

### Progress plumbing feasibility (§7 residual question)

FluidAudio *does* support a caller-supplied model directory: `AsrModels.downloadAndLoad(to directory: URL? = nil, ...)`, `AsrModels.load(from directory:)`, and `AsrModels.modelsExist(at directory:)` all take an explicit directory, and `defaultCacheDirectory(for:)` is public. **However, `fluidaudio-rs` 0.14.1's bridge calls `AsrModels.downloadAndLoad()` with the default (nil) directory and does not expose the override at the Rust boundary.** Two viable Phase 3 mechanisms for honest `model://progress`:
1. **Pre-populate the default path** — drive our own HuggingFace multi-file download (with progress) into `~/Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v3/`, then `init_asr()` finds `modelsExist == true` and loads without re-downloading. No fork required; couples us to FluidAudio's default-path convention.
2. **Move to Path B (own `@_cdecl` shim)** — call `downloadAndLoad(to:)`/`load(from:)` with a directory under `<app_data>/models/`, giving full control. More build glue, but decouples us from the default-path convention and from `fluidaudio-rs` release cadence.

Either is feasible; mechanism 1 is the lower-effort path and is recommended for Task 7. Note `HF_TOKEN`/`HUGGING_FACE_HUB_TOKEN` env vars are honored by FluidAudio's downloader if rate limits bite.

### API shape (surprise vs the design's assumptions)

- The in-memory batch call is `FluidAudio::transcribe_samples(&[f32]) -> AsrResult` — takes a **slice**, and there is **no `source:` parameter** (the design flagged `AsrManager.transcribe(_:source:)`'s `source:` shape as unverified; at the `fluidaudio-rs` boundary it simply does not exist). `AsrResult` exposes `{ text, confidence: f32, duration: f64, processing_time: f64, rtfx: f32 }`.
- Model load is `FluidAudio::new()` then `init_asr()`; internally `AsrModels.downloadAndLoad()` with no `version:` argument (defaults to v3). The engine wrapper is a thin `SttEngine` mirror of `ParakeetEngine`.
- `FluidAudioBridge` is `unsafe impl Send + Sync` (crate asserts internal synchronization), so `FluidAudioEngine` satisfies `SttEngine: Send` and lives in a per-lane worker thread with no wrapping.

### Failure / fallback behavior

- **Load failure → `Err`, not panic.** `FluidAudioEngine::load` maps both bridge-create and `init_asr` failures to `anyhow::Err`, so Phase 3's `load_boxed_engine` (Task 5) can catch it and fall back to `ParakeetEngine`. Verified by construction (compiles under `--features ane`); a full end-to-end renamed-model fallback needs Task 5's `commands.rs` wiring, which is out of scope for this spike.
- **Decode error → `Err` → empty text**, exactly matching ONNX semantics (`unwrap_or_default()` in the worker emits nothing).
- **Decode panic → contained by §4's `guarded`.** Because `FluidAudioEngine` implements `SttEngine`, the worker's existing `catch_unwind` wrapping covers it with no ANE-specific code. Not force-triggered in the spike (no clean way to induce a Swift-side panic from the fixture path). Whether a decode panic poisons `AsrManager` state — feeding the "N panics → rebuild" policy — remains **unassessed** and is deferred to Phase 3 hardening.

### Build-pipeline risk (the one open item for productionization)

`swift build` works locally. The remaining risk the go/no-go flagged is CI + the **notarized release pipeline**: the release build must run `swift build -c release`, link `libFluidAudioBridge.a` and the six Apple frameworks, and the resulting binary must pass notarization/codesigning with the statically-linked Swift bridge. This was not exercised here (spike is local-only). It is an engineering task, not a feasibility unknown — the design's failure matrix already pins the release pipeline to the ONNX-only config until the `ane` build is green. Phase 3 should treat "green in the notarized release pipeline" as a gate before shipping ANE on by default.
