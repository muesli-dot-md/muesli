# demo_muesli — Live Meeting Transcriber (Foundation)

**Date:** 2026-06-23
**Status:** Approved design — ready for implementation planning
**Scope:** Minimal, extensible foundation. We will build a lot on top of this, so the priority is clean seams over features.

---

## 1. Goal

A macOS desktop app that records a meeting and transcribes it live, capturing **both sides** of the conversation:

- **What I say** — the microphone.
- **What the meeting app plays** — the system/output audio of the other participants.

Each side is transcribed independently and shown as a separate labelled lane (`Me` / `Them`), giving free speaker separation. Transcription is multilingual and runs fully on-device. As the meeting runs, finalized lines are **written to a new markdown file** on disk — that file is the concrete deliverable of v1.

This is a foundation for the larger `muesli` product (a markdown editor with live transcription and live server sync at `~/Code/muesli`). For this prototype we deliberately **do not** integrate with muesli's CRDT/editor model — the transcript simply lands in a fresh `.md` file. Direct insertion into a live muesli document is future work; the architecture leaves a clean seam for it. Persistence beyond the markdown file, summarization, and cross-platform support are also out of scope for v1.

> Note: muesli's web editor is Svelte 5 + CodeMirror 6 + Yjs; choosing **Svelte 5** here keeps the frontend aligned for an eventual merge.

---

## 2. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Platform | **macOS first** | ScreenCaptureKit (system audio) is macOS-only. |
| App shell | **Tauri 2** | Rust backend for audio/ML, webview UI. |
| Frontend | **Svelte 5 + Vite + TypeScript** (SPA, no SSR) | Simple, fast, no SvelteKit server complexity in a desktop app. |
| Package manager | **pnpm** | Already installed; lockfile-friendly. |
| Mic capture | **cpal** | Cross-platform, simple default-input capture. |
| System/meeting audio | **ScreenCaptureKit** | Native, no driver install; one-time Screen Recording permission. |
| STT engine | **Parakeet TDT 0.6b v3** (int8 ONNX) via **`parakeet-rs`** (ONNX Runtime / `ort` crate) | Multilingual (25 European langs + auto language-ID), fast (~20–30× real-time on Apple Silicon CPU), full-context accuracy. |
| Mac execution provider | **CPU** | CoreML is broken for Parakeet (onnxruntime#26355); v3 on M-series CPU is fast and beats Whisper-on-Metal for short clips. |
| Streaming strategy | **VAD-segmented streaming** (Silero VAD) | v3 is an offline/full-context model. VAD-segmented gives full batch-accuracy finals at utterance-level latency — ideal for meeting notes — plus cheap rolling partials for live feel. |
| Transcript shape | **Two labelled streams** (`Me` / `Them`) | Free speaker separation; one recognizer per source. |
| Output | **New markdown file per session** | Finalized lines appended to a fresh timestamped `.md` on disk. The concrete v1 deliverable. |
| Engine abstraction | **`SttEngine` trait** | De-risks the single-maintainer `parakeet-rs` crate: swap to whisper-rs / sherpa-onnx / Nemotron true-streaming later with zero ripple. |

### Why VAD-segmented, not token-by-token streaming
Parakeet TDT v3 is **offline / full-context** — it is not a cache-aware streaming model. Naive fixed-chunk streaming of v3 incurs ~46% relative WER degradation. Instead:
- **Live partials:** while a source is actively speaking, re-run v3 on the in-progress utterance buffer every ~700 ms and emit greyed partial text. Cheap because v3 runs ~20–30× real-time.
- **Accurate finals:** when Silero VAD detects end-of-utterance (a pause), transcribe the **complete** utterance with full context and emit the final line at v3's full accuracy.

The only cost vs. true streaming is that a line finalizes on speaker pause rather than word-by-word — exactly the granularity meeting transcription wants. If we later need sub-second token streaming, the `SttEngine` trait lets us drop in the Nemotron 3.5 multilingual cache-aware streaming model (also supported by `parakeet-rs`) behind the same interface.

---

## 3. Architecture

```
┌─ Rust backend (src-tauri) ───────────────────────────────────────────────┐
│                                                                            │
│  MIC source (cpal)                  SYSTEM source (ScreenCaptureKit)       │
│     │ f32 @ device rate                │ f32 @ device rate                 │
│     ▼ resample → 16 kHz mono           ▼ resample → 16 kHz mono            │
│  ┌──────────────────┐               ┌──────────────────┐                  │
│  │ STT worker       │               │ STT worker       │                  │
│  │  Silero VAD      │               │  Silero VAD      │                  │
│  │  SttEngine (v3)  │               │  SttEngine (v3)  │                  │
│  │  label = "me"    │               │  label = "them"  │                  │
│  └────────┬─────────┘               └────────┬─────────┘                  │
│           └──────────── Tauri events ────────┘                            │
│             transcript://partial   transcript://final                     │
│             { source, text, t0, t1, utteranceId }                         │
│                                  │                                         │
│                                  ├──────────────► Markdown sink            │
│                                  │   (finals appended to session .md)      │
└────────────────────────────────│──────────────────────────────────────────┘
                                  ▼
   Svelte UI: Start/Stop · permission status · Me/Them lanes · output file path
              (greyed partials promote to committed finals)
```

The `final` event stream has **two consumers**: the Svelte UI (live display) and the markdown sink (writes to disk). Both subscribe to the same events; neither blocks the other.

### Markdown output
- **Location:** `~/Documents/muesli-transcripts/` by default (created if missing); one file per session.
- **Filename:** `meeting-YYYY-MM-DD-HHMM.md`.
- **Format (Granola-style speaker blocks):** a header, then one block per speaker *turn*. Consecutive finals from the same source merge into one block; a new block begins when the other speaker takes over. Partials are **not** written (only finals). The whole (small) file is re-rendered on each final, so it stays correct and readable mid-meeting.

```markdown
# Meeting — 2026-06-23-1432

**Them** — 00:01
Hi everyone, thanks for joining. Did everyone get a chance to review the doc?

**You** — 00:08
Happy to be here. I had a couple of questions on section three.
```

Labels: mic = **You**, system audio = **Them**. The block timestamp is the start of that turn. Blocks are ordered by finalization (a turn finalizes ~hangover after the speaker pauses); the timestamps disambiguate true chronology.

### Data flow
1. User clicks **Start**. Backend checks/requests mic + Screen Recording permissions.
2. Two capture sources start, each producing a stream of `f32` samples, resampled to **16 kHz mono**.
3. Each source has its own **STT worker** running on a dedicated thread:
   - Frames are accumulated into the current utterance buffer.
   - **Silero VAD** classifies speech/silence frame-by-frame with hysteresis.
   - While speaking: every ~700 ms, run the engine on the buffer-so-far → emit `transcript://partial`.
   - On end-of-utterance (silence past threshold): run the engine on the full buffer → emit `transcript://final`, clear buffer, increment `utteranceId`.
4. Svelte UI listens for both events and renders partials (greyed) that promote to finals per `(source, utteranceId)`.
5. User clicks **Stop** → sources stop, in-flight utterances are finalized.

---

## 4. Components (each small, single-purpose)

### Rust (`src-tauri/src/`)
- **`audio/mic.rs`** — cpal default-input capture. Exposes `start(tx) -> StopHandle`, pushing 16 kHz mono `f32` frames to a channel. Owns its capture thread.
- **`audio/system.rs`** — ScreenCaptureKit audio capture (SCStream, audio sample buffers). Same channel contract as `mic.rs`. Requests Screen Recording permission on first start.
- **`audio/resample.rs`** — shared rubato-based resampler: device-rate/N-channel → 16 kHz mono `f32`.
- **`audio/vad.rs`** — Silero VAD wrapper (ONNX): frame-level speech probability + smoothed utterance boundary detection (start / active / end with hysteresis).
- **`stt/engine.rs`** — `SttEngine` trait:
  ```rust
  trait SttEngine: Send {
      /// Transcribe the current utterance buffer so far (cheap, repeated). Returns interim text.
      fn transcribe_partial(&mut self, samples: &[f32]) -> anyhow::Result<String>;
      /// Transcribe the complete utterance with full context. Returns final text.
      fn transcribe_final(&mut self, samples: &[f32]) -> anyhow::Result<String>;
  }
  ```
- **`stt/parakeet.rs`** — `SttEngine` impl over `parakeet-rs` with `parakeet-tdt-0.6b-v3` int8. Loads the model once; both methods are full-context transcribe calls (partial = on growing buffer, final = on complete buffer).
- **`stt/worker.rs`** — per-source orchestration loop: pulls frames → VAD → drives partial/final emission → emits Tauri events with the source label.
- **`output/markdown.rs`** — markdown sink. On session start, creates a fresh file `meeting-<YYYY-MM-DD-HHMM>.md` in the output dir and writes a header. On each `final` event, appends a labelled, timestamped line. Owns the file handle; flushes per write so the file is usable mid-meeting. Exposes the resolved path so the UI can show it / reveal in Finder.
- **`model.rs`** — model resolution: locate `parakeet-tdt-0.6b-v3` int8 ONNX in app-data; download on first run if absent (with progress events).
- **`commands.rs`** — Tauri commands: `start_capture`, `stop_capture`, `check_permissions`, `ensure_model`, `reveal_output` (returns/opens the session file path).
- **`lib.rs` / `main.rs`** — Tauri app wiring, state (active capture handles), event registration.

### Frontend (`src/`)
- **`App.svelte`** — layout: header (Start/Stop, permission/model status), two transcript lanes.
- **`lib/transcript.svelte.ts`** — reactive store keyed by `(source, utteranceId)`; applies partial/final updates.
- **`lib/events.ts`** — subscribes to `transcript://partial` / `transcript://final` / model-download progress; typed payloads.
- **`lib/TranscriptLane.svelte`** — renders one source's lines (partials greyed, finals solid).

### Interface contracts (the seams between subagents)
- **Audio source → worker:** `tokio::mpsc`/`crossbeam` channel of `Vec<f32>` frames at 16 kHz mono. Defined in `audio/mod.rs`.
- **Worker → UI:** Tauri events `transcript://partial` and `transcript://final` with payload `{ source: "me" | "them", text: string, t0: number, t1: number, utteranceId: number }`.
- **Engine:** the `SttEngine` trait above.

These three contracts are fixed up front so the audio, STT, and UI pieces can be built independently and in parallel.

---

## 5. Permissions (macOS)
- **Microphone** — `NSMicrophoneUsageDescription` in Info.plist; triggered by cpal on first capture.
- **Screen Recording** — required by ScreenCaptureKit for system audio. Cannot be requested silently; the app surfaces status via `check_permissions` and guides the user to System Settings → Privacy & Security → Screen Recording on first denial. App may need a restart after grant (document this).

---

## 6. Error handling
- **Permission denied** (mic or screen recording): worker for that source does not start; UI shows a clear, actionable status for that lane; the other source still runs.
- **Model missing / download fails:** `ensure_model` surfaces progress and a retry path; capture is blocked until the model is present.
- **Engine panic** (per the parakeet-rs single-maintainer risk): wrap engine calls in `catch_unwind` (Handy-style) so one bad inference doesn't poison the worker; log and continue from the next utterance.
- **Device disconnect / format change:** capture thread reports the error on the channel; worker emits a status event and stops that lane gracefully.

---

## 7. Testing
- **`audio/resample.rs`** — unit tests: known input rate/channels → expected 16 kHz mono length and basic signal sanity.
- **`audio/vad.rs`** — unit tests on short fixtures (silence clip → no utterance; speech-then-silence clip → exactly one utterance boundary).
- **`stt/parakeet.rs`** — integration test (gated behind the model being present): a short known WAV → non-empty plausible transcript.
- **`stt/worker.rs`** — test with a fake `SttEngine` and a synthetic frame stream: assert partial→final event sequence and `utteranceId` increment, no real model needed.
- **`output/markdown.rs`** — unit tests: a sequence of finals produces a file with the expected header + one line per final, correct labels/timestamps, and partials are ignored.
- **Frontend** — `transcript.svelte.ts` store unit tests: partial promotes to final per `(source, utteranceId)`; out-of-order updates handled.
- Manual smoke test: real meeting, confirm both lanes populate.

---

## 8. Build approach (subagent-driven)
The three interface contracts (§4) let the work fan out after scaffolding:
1. **Scaffold (sequential, first):** Tauri 2 + Svelte 5 + TS project, builds and runs an empty window. Establishes module layout and the contract stubs (channel types, `SttEngine` trait, event payload types).
2. **Parallel after scaffold:**
   - Audio sources (`mic.rs`, `system.rs`, `resample.rs`, `vad.rs`).
   - STT (`engine.rs`, `parakeet.rs`, `model.rs`) — verified with the fixture test.
   - Frontend (`App.svelte`, store, events, lane) — verified against mocked events.
3. **Integration (sequential):** wire `worker.rs` + `commands.rs`, connect sources → workers → events → UI; end-to-end smoke test.

Each subagent gets a focused scope, the relevant contract(s), and a clear "done" criterion.

---

## 9. Out of scope (v1) — seams preserved
- **Integration into the `muesli` editor** (the eventual target). v1 writes a standalone `.md`; later, the same `final` event stream feeds muesli's CRDT insertion seam instead of / in addition to the file — `ytext.insert()` on web, `session.localEdit()` on the native client. The markdown sink is the stand-in for that consumer.
- Summarization / LLM post-processing (consume the final-event stream alongside the markdown sink).
- Richer persistence / meeting history / search (the `.md` files are the current store).
- Cross-platform system audio (Windows WASAPI loopback / Linux PipeWire — new `audio/system_*.rs` impls behind the same channel contract).
- True token-by-token streaming (drop the Nemotron 3.5 cache-aware model behind `SttEngine`).
- Diarization beyond mic-vs-system split.
