//! Tauri commands and app wiring for live, single-source transcription.
//!
//! Topology: microphone -> mpsc channel -> STT worker thread -> [`AppEmitter`]
//! which fans transcript events out to the frontend (`transcript://partial` /
//! `transcript://final`) and appends finals to a Markdown sink on disk.
//!
//! Teardown is by disconnect: `stop_capture` drops the [`MicHandle`] (which owns
//! the cpal stream and the channel `Sender`). With the sender gone the worker's
//! `rx` iterator ends, the worker finalizes any in-flight utterance and returns,
//! and we `join()` its thread.

use std::path::PathBuf;
use std::sync::mpsc::{channel, sync_channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter as _, Manager, State};

use crate::audio::mic;
use crate::audio::system;
use crate::audio::vad::SileroVad;
use crate::audio::Source;
use crate::output::markdown::MarkdownSink;
use crate::stt::engine::SttEngine;
use crate::stt::model::ParakeetPaths;
use crate::stt::parakeet::ParakeetEngine;
use crate::stt::worker::{self, Emitter, TranscriptEvent};

/// Cadence at which partial transcripts are emitted during a spoken utterance.
const PARTIAL_INTERVAL: Duration = Duration::from_millis(700);

// ---------------------------------------------------------------------------
// AppEmitter — fans transcript events to the UI and the Markdown sink
// ---------------------------------------------------------------------------

/// Worker [`Emitter`] that pushes events to the Tauri frontend and writes finals
/// to a Markdown file. Shared across the worker thread via `Arc`.
pub struct AppEmitter {
    app: AppHandle,
    sink: Arc<Mutex<MarkdownSink>>,
}

impl AppEmitter {
    fn new(app: AppHandle, sink: Arc<Mutex<MarkdownSink>>) -> Self {
        Self { app, sink }
    }
}

impl Emitter for AppEmitter {
    fn partial(&self, e: &TranscriptEvent) {
        if let Err(err) = self.app.emit("transcript://partial", e) {
            eprintln!("[commands] failed to emit transcript://partial: {err}");
        }
    }

    fn final_(&self, e: &TranscriptEvent) {
        if let Err(err) = self.app.emit("transcript://final", e) {
            eprintln!("[commands] failed to emit transcript://final: {err}");
        }
        // Append to the markdown sink; log (don't panic) on a write/lock error so a
        // transient disk problem never tears down the worker thread.
        match self.sink.lock() {
            Ok(mut sink) => {
                if let Err(err) = sink.append_final(e.source, &e.text, e.t0) {
                    eprintln!("[commands] markdown append_final failed: {err}");
                }
            }
            Err(err) => eprintln!("[commands] markdown sink mutex poisoned: {err}"),
        }
    }
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

/// A live capture session.
///
/// The cpal `MicHandle` is `!Send`, so it can't live in Tauri-managed state
/// (which requires `Send + Sync`). Instead a dedicated *mic thread* owns the
/// `MicHandle`; we hold a one-shot `stop` sender that unblocks it. On stop the
/// mic thread drops the handle (closing the frame channel's `Sender`), which
/// disconnects the worker's receiver; the worker finalizes and returns. We then
/// join both threads.
struct CaptureSession {
    /// Send `()` to tell the mic thread to drop the `MicHandle` and exit.
    stop: std::sync::mpsc::SyncSender<()>,
    mic_thread: JoinHandle<()>,
    worker: JoinHandle<()>,
    /// The system-audio ("Them") lane. `None` if Screen Recording permission was
    /// denied or ScreenCaptureKit failed to start — the mic lane still runs.
    system: Option<SystemLane>,
    path: PathBuf,
}

/// Handles for the optional system-audio ("Them") lane, torn down exactly like
/// the mic lane: signal `stop` → the system thread drops its `SystemHandle`
/// (stopping the `SCStream` and closing the frame `Sender`) → the worker's `rx`
/// disconnects → both threads join.
struct SystemLane {
    stop: std::sync::mpsc::SyncSender<()>,
    system_thread: JoinHandle<()>,
    worker: JoinHandle<()>,
}

/// Tauri-managed state: `Some` while a capture is running, `None` otherwise.
#[derive(Default)]
pub struct AppState {
    session: Mutex<Option<CaptureSession>>,
    /// Pre-loaded speech-model engines kept warm so `start_capture` is instant.
    /// One per lane (mic / system). `start_capture` takes them; they're refilled
    /// in the background after each capture (and at app startup via warm_models).
    warm_mic: Mutex<Option<Box<dyn SttEngine>>>,
    warm_sys: Mutex<Option<Box<dyn SttEngine>>>,
}

// ---------------------------------------------------------------------------
// transcription_supported
// ---------------------------------------------------------------------------

/// Whether live transcription is available on this platform. Transcription is
/// macOS-only (ScreenCaptureKit system audio + the bundled Parakeet model). The
/// frontend calls this once at startup and hides every transcription affordance
/// when it returns `false`.
#[tauri::command]
pub fn transcription_supported() -> bool {
    cfg!(target_os = "macos")
}

// ---------------------------------------------------------------------------
// platform_is_macos
// ---------------------------------------------------------------------------

/// Whether this build runs on macOS. The frontend keychain-consent flow gates
/// its explainer dialog on this — the consent dialog (and the closed-at-startup
/// Rust keychain gate) exist only on macOS (spec 2026-07-02).
#[tauri::command]
pub fn platform_is_macos() -> bool {
    cfg!(target_os = "macos")
}

// ---------------------------------------------------------------------------
// check_permissions
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    microphone: bool,
    screen_recording: bool,
}

/// Best-effort permission report. `microphone` is true if a default input device
/// exists; `screenRecording` is probed by attempting to enumerate ScreenCaptureKit
/// shareable content — success (at least one display) means the Screen Recording
/// permission is granted. This runs on a dedicated thread because the
/// ScreenCaptureKit query path is `!Send`-flavoured and we never want it on the
/// Tauri command thread's reentrant context.
#[tauri::command]
pub fn check_permissions() -> Permissions {
    use cpal::traits::HostTrait;
    let microphone = cpal::default_host().default_input_device().is_some();
    Permissions {
        microphone,
        screen_recording: screen_recording_granted(),
    }
}

/// Best-effort Screen Recording permission probe. Returns `true` only if
/// ScreenCaptureKit can enumerate at least one shareable display. A denial (or
/// any error) returns `false`. Runs the query on a short-lived thread and joins
/// it so a hung query can never wedge the command.
///
/// Screen Recording / ScreenCaptureKit is macOS-only; off macOS there is no such
/// permission, so this returns `false`.
#[cfg(target_os = "macos")]
fn screen_recording_granted() -> bool {
    use screencapturekit::prelude::SCShareableContent;
    std::thread::spawn(|| {
        SCShareableContent::get()
            .map(|c| !c.displays().is_empty())
            .unwrap_or(false)
    })
    .join()
    .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn screen_recording_granted() -> bool {
    false
}

// ---------------------------------------------------------------------------
// ensure_model
// ---------------------------------------------------------------------------

/// Resolve the app-data dir and, if the Parakeet model is absent, download +
/// extract it on a blocking thread, emitting `model://progress` `{done,total}`
/// events. Returns `Ok(())` once the artifacts are present. The download is
/// ~478 MB on first run.
#[tauri::command]
pub async fn ensure_model(app: AppHandle) -> Result<(), String> {
    // Transcription is macOS-only; never download the ~478 MB Parakeet model on
    // platforms where the feature is hidden and unusable.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        ensure_model_macos(app).await
    }
}

/// macOS implementation of [`ensure_model`]: resolves the app-data dir and
/// downloads + extracts the Parakeet model if absent.
#[cfg(target_os = "macos")]
async fn ensure_model_macos(app: AppHandle) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;

    let paths = ParakeetPaths::resolve(&app_data);
    if paths.is_present() {
        return Ok(());
    }

    let app_for_progress = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::stt::model::ensure(&app_data, |done, total| {
            let _ = app_for_progress.emit("model://progress", ModelProgress { done, total });
        })
        .map(|_| ())
        .map_err(|e| format!("model download failed: {e}"))
    })
    .await
    .map_err(|e| format!("model download task panicked: {e}"))?
}

#[derive(Serialize, Clone)]
struct ModelProgress {
    done: u64,
    total: u64,
}

// ---------------------------------------------------------------------------
// warm_models — keep speech engines pre-loaded in memory
// ---------------------------------------------------------------------------

/// Load a Parakeet engine as a boxed trait object (None on failure, logged).
#[cfg(target_os = "macos")]
fn load_boxed_engine(paths: &ParakeetPaths) -> Option<Box<dyn SttEngine>> {
    match ParakeetEngine::load(paths) {
        Ok(e) => Some(Box::new(e)),
        Err(e) => {
            eprintln!("[warm] failed to load speech engine: {e}");
            None
        }
    }
}

/// Fill any empty warm slots (mic + system lanes) with freshly-loaded engines.
/// Idempotent and cheap to call: a no-op if the model isn't downloaded yet or the
/// slots are already warm. Runs synchronously on the calling thread.
#[cfg(target_os = "macos")]
fn fill_warm_slots(app: &AppHandle) {
    let Ok(app_data) = app.path().app_data_dir() else {
        return;
    };
    let paths = ParakeetPaths::resolve(&app_data);
    if !paths.is_present() {
        return;
    }
    let state = app.state::<AppState>();
    {
        let mut g = match state.warm_mic.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if g.is_none() {
            *g = load_boxed_engine(&paths);
        }
    }
    {
        let mut g = match state.warm_sys.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if g.is_none() {
            *g = load_boxed_engine(&paths);
        }
    }
}

/// Pre-load both lane engines into memory in the background so the next
/// `start_capture` is instant. Returns immediately; loading runs on a thread.
#[tauri::command]
pub fn warm_models(app: AppHandle) {
    // Transcription is macOS-only; no engines to warm off macOS.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
    #[cfg(target_os = "macos")]
    {
        std::thread::spawn(move || fill_warm_slots(&app));
    }
}

// ---------------------------------------------------------------------------
// start_capture
// ---------------------------------------------------------------------------

/// Output directory for transcripts: `~/Documents/muesli-transcripts/`.
fn transcripts_dir() -> Result<PathBuf, String> {
    let home = dirs_home().ok_or_else(|| "could not resolve home directory".to_string())?;
    Ok(home.join("Documents").join("muesli-transcripts"))
}

/// Resolve the user's home directory without pulling in an extra crate.
fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Resolve the output directory for a capture session.
///
/// When `workspace_dir` is `Some(d)` the transcript is written into the caller's
/// workspace so it appears in the file tree immediately after a refresh.
/// When `None` the default `~/Documents/muesli-transcripts/` is used (back-compat).
pub fn resolve_output_dir(workspace_dir: Option<&str>) -> Result<PathBuf, String> {
    match workspace_dir {
        Some(d) => Ok(PathBuf::from(d)),
        None => transcripts_dir(),
    }
}

/// Local-time stamp for the output filename, `YYYY-MM-DD-HHMMSS`.
fn started_stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d-%H%M%S").to_string()
}

/// Start live transcription from the microphone. Loads the model, opens the mic,
/// spawns the worker, and returns the output Markdown file path. Errors (as
/// strings) if the model is not yet present or any stage fails to start.
///
/// When `workspace_dir` is provided (JS key: `workspaceDir`) the transcript is written
/// into that directory so it appears in the workspace tree after a refresh.
/// When absent the default `~/Documents/muesli-transcripts/` directory is used.
#[tauri::command]
pub fn start_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace_dir: Option<String>,
) -> Result<String, String> {
    // Transcription is macOS-only. The UI hides every record affordance off
    // macOS, so this is never invoked there; if it ever were, fail clearly.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, workspace_dir);
        Err("transcription is only available on macOS".into())
    }

    #[cfg(target_os = "macos")]
    {
        start_capture_macos(app, state, workspace_dir)
    }
}

/// macOS implementation of [`start_capture`]: loads the model, opens the mic and
/// (best-effort) system-audio lane, spawns the workers, and returns the output
/// Markdown file path.
#[cfg(target_os = "macos")]
fn start_capture_macos(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace_dir: Option<String>,
) -> Result<String, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|e| format!("state mutex poisoned: {e}"))?;
    if guard.is_some() {
        return Err("capture already running".into());
    }

    // Require the model. The frontend calls ensure_model on mount; if it's still
    // absent, tell the user to run it rather than blocking on a 478 MB download.
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    let paths = ParakeetPaths::resolve(&app_data);
    if !paths.is_present() {
        return Err(
            "speech model not downloaded yet — run ensure_model (it downloads ~478 MB on first use)"
                .into(),
        );
    }

    // Mic-lane engine: reuse a pre-warmed instance if available (instant), else
    // cold-load one now (~2s).
    let engine: Box<dyn SttEngine> = match state.warm_mic.lock().ok().and_then(|mut g| g.take()) {
        Some(e) => e,
        None => Box::new(
            ParakeetEngine::load(&paths).map_err(|e| format!("failed to load model: {e}"))?,
        ),
    };

    // Output sink: workspace directory if provided, else ~/Documents/muesli-transcripts/
    let dir = resolve_output_dir(workspace_dir.as_deref())?;
    let stamp = started_stamp();
    let sink = MarkdownSink::create_in(&dir, &stamp)
        .map_err(|e| format!("failed to create output: {e}"))?;
    let path = sink.path().to_path_buf();
    let sink = Arc::new(Mutex::new(sink));

    // Wire mic -> channel -> worker. The cpal stream (MicHandle) is !Send, so it
    // must be created and dropped on its own thread; `start_capture` only ever
    // holds Send/Sync handles.
    let (tx, rx) = channel::<Vec<f32>>();

    // The mic thread builds the stream, signals success/failure back, then blocks
    // until `stop` fires (or the sender is dropped), at which point it drops the
    // MicHandle — closing `tx` and disconnecting the worker.
    let (stop_tx, stop_rx) = sync_channel::<()>(1);
    let (ready_tx, ready_rx) = sync_channel::<Result<(), String>>(1);
    let mic_thread = std::thread::Builder::new()
        .name("mic-capture".into())
        .spawn(move || match mic::start(tx) {
            Ok(handle) => {
                let _ = ready_tx.send(Ok(()));
                // Block until stop is requested or the session is dropped.
                let _ = stop_rx.recv();
                drop(handle); // stops the stream + closes the frame Sender
            }
            Err(e) => {
                let _ = ready_tx.send(Err(format!("failed to start microphone: {e}")));
            }
        })
        .map_err(|e| format!("failed to spawn mic thread: {e}"))?;

    // Wait for the mic to come up so we can surface a real error to the UI.
    match ready_rx.recv() {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let _ = mic_thread.join();
            return Err(e);
        }
        Err(_) => {
            let _ = mic_thread.join();
            return Err("mic thread exited before signalling readiness".into());
        }
    }

    let vad = SileroVad::new().map_err(|e| format!("failed to init VAD: {e}"))?;
    // Shared across both lanes: one emitter (markdown + UI, lanes distinguished by
    // Source) and one start instant (so Me/Them timestamps share a timeline).
    let emitter: Arc<dyn Emitter> = Arc::new(AppEmitter::new(app.clone(), sink));
    let started = Instant::now();

    let worker = {
        let emitter = emitter.clone();
        std::thread::Builder::new()
            .name("stt-worker".into())
            .spawn(move || {
                worker::run_worker(
                    Source::Me,
                    rx,
                    Box::new(vad),
                    engine,
                    emitter,
                    started,
                    PARTIAL_INTERVAL,
                );
            })
            .map_err(|e| format!("failed to spawn worker thread: {e}"))?
    };

    // --- System-audio ("Them") lane (best-effort) ------------------------------
    // Requires Screen Recording permission. If it can't start, we log and keep the
    // mic-only session usable rather than failing start_capture. This loads a
    // SECOND ParakeetEngine instance (the worker owns Box<dyn SttEngine>), roughly
    // doubling model RAM (~1 GB total) — acceptable for the MVP.
    // System-lane engine: reuse a warm instance, else cold-load; if loading fails
    // we simply run mic-only.
    let sys_engine: Option<Box<dyn SttEngine>> = state
        .warm_sys
        .lock()
        .ok()
        .and_then(|mut g| g.take())
        .or_else(|| load_boxed_engine(&paths));
    let system = match sys_engine {
        Some(e) => start_system_lane(e, emitter, started),
        None => None,
    };

    *guard = Some(CaptureSession {
        stop: stop_tx,
        mic_thread,
        worker,
        system,
        path: path.clone(),
    });

    Ok(path.to_string_lossy().into_owned())
}

/// Best-effort startup of the system-audio ("Them") lane. Mirrors the mic lane's
/// `!Send` threading pattern: the `SystemHandle` (which owns the `!Send`
/// `SCStream`) is built and dropped on a dedicated thread; `start_capture` only
/// holds Send/Sync handles. Returns `None` (after logging) if the model engine
/// fails to load or ScreenCaptureKit can't start — the caller keeps the mic lane.
#[cfg(target_os = "macos")]
fn start_system_lane(
    engine: Box<dyn SttEngine>,
    emitter: Arc<dyn Emitter>,
    started: Instant,
) -> Option<SystemLane> {
    let vad = match SileroVad::new() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[commands] system lane: failed to init VAD: {e}");
            return None;
        }
    };

    let (tx2, rx2) = channel::<Vec<f32>>();
    let (stop_tx, stop_rx) = sync_channel::<()>(1);
    let (ready_tx, ready_rx) = sync_channel::<Result<(), String>>(1);

    let system_thread = match std::thread::Builder::new()
        .name("system-capture".into())
        .spawn(move || match system::start(tx2) {
            Ok(handle) => {
                let _ = ready_tx.send(Ok(()));
                let _ = stop_rx.recv();
                drop(handle); // stops the SCStream + closes the frame Sender
            }
            Err(e) => {
                let _ = ready_tx.send(Err(format!("{e}")));
            }
        }) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[commands] system lane: failed to spawn system thread: {e}");
            return None;
        }
    };

    // Wait for the stream to come up; on failure (e.g. permission denied) log and
    // give up on this lane only.
    match ready_rx.recv() {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            eprintln!(
                "[commands] system lane disabled (Screen Recording likely denied): {e}; \
                 continuing mic-only"
            );
            let _ = system_thread.join();
            return None;
        }
        Err(_) => {
            eprintln!("[commands] system lane: thread exited before signalling readiness");
            let _ = system_thread.join();
            return None;
        }
    }

    let worker = match std::thread::Builder::new()
        .name("stt-worker-them".into())
        .spawn(move || {
            worker::run_worker(
                Source::Them,
                rx2,
                Box::new(vad),
                engine,
                emitter,
                started,
                PARTIAL_INTERVAL,
            );
        }) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[commands] system lane: failed to spawn worker thread: {e}");
            // Tear down the capture thread we already started.
            let _ = stop_tx.send(());
            let _ = system_thread.join();
            return None;
        }
    };

    eprintln!("[commands] system-audio (Them) lane started");
    Some(SystemLane {
        stop: stop_tx,
        system_thread,
        worker,
    })
}

// ---------------------------------------------------------------------------
// stop_capture
// ---------------------------------------------------------------------------

/// Stop live transcription. Drops the mic handle (stopping the stream and closing
/// the channel sender), which disconnects the worker's receiver; the worker then
/// finalizes any in-flight utterance and returns, and we join its thread. Each
/// final has already been flushed to disk by the time we return.
#[tauri::command]
pub fn stop_capture(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let session = {
        let mut guard = state
            .session
            .lock()
            .map_err(|e| format!("state mutex poisoned: {e}"))?;
        guard.take()
    };

    let Some(session) = session else {
        // Idempotent: nothing running.
        return Ok(());
    };

    // Signal every capture thread to drop its handle first (stopping its stream
    // and closing its frame Sender, which disconnects the corresponding worker's
    // rx), then join. Sending before joining lets both lanes tear down in
    // parallel. Sends to an already-gone receiver error harmlessly.
    let _ = session.stop.send(());
    if let Some(sys) = &session.system {
        let _ = sys.stop.send(());
    }

    // Mic lane: capture thread drops the handle and exits; worker finalizes.
    session
        .mic_thread
        .join()
        .map_err(|_| "mic thread panicked".to_string())?;
    session
        .worker
        .join()
        .map_err(|_| "worker thread panicked".to_string())?;

    // System ("Them") lane, if it was running.
    if let Some(sys) = session.system {
        sys.system_thread
            .join()
            .map_err(|_| "system thread panicked".to_string())?;
        sys.worker
            .join()
            .map_err(|_| "system worker thread panicked".to_string())?;
    }

    // Re-warm the engines in the background so the next recording starts instantly
    // (the just-stopped capture consumed the warm slots). macOS-only — there is no
    // model or engine off macOS.
    #[cfg(target_os = "macos")]
    std::thread::spawn(move || fill_warm_slots(&app));
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

// ---------------------------------------------------------------------------
// reveal_output
// ---------------------------------------------------------------------------

/// Reveal the current session's output file in Finder. Uses the opener plugin's
/// reveal API; falls back to `open -R` if that errors.
#[tauri::command]
pub fn reveal_output(state: State<'_, AppState>) -> Result<(), String> {
    let path = {
        let guard = state
            .session
            .lock()
            .map_err(|e| format!("state mutex poisoned: {e}"))?;
        guard.as_ref().map(|s| s.path.clone())
    };

    let Some(path) = path else {
        return Err("no output file available — start a capture first".into());
    };

    if let Err(err) = tauri_plugin_opener::reveal_item_in_dir(&path) {
        eprintln!("[commands] opener reveal failed ({err}); falling back to `open -R`");
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .status()
            .map_err(|e| format!("failed to reveal output: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn started_stamp_has_expected_shape() {
        let stamp = started_stamp();
        // YYYY-MM-DD-HHMMSS = 17 chars, e.g. 2026-06-23-143259
        assert_eq!(stamp.len(), 17, "stamp: {stamp}");
        let parts: Vec<&str> = stamp.split('-').collect();
        assert_eq!(parts.len(), 4, "expected 4 dash-separated parts: {stamp}");
        assert_eq!(parts[0].len(), 4, "year: {stamp}");
        assert_eq!(parts[1].len(), 2, "month: {stamp}");
        assert_eq!(parts[2].len(), 2, "day: {stamp}");
        assert_eq!(parts[3].len(), 6, "HHMMSS: {stamp}");
        assert!(stamp.chars().all(|c| c.is_ascii_digit() || c == '-'));
    }

    #[test]
    fn transcripts_dir_ends_with_expected_path() {
        let dir = transcripts_dir().unwrap();
        assert!(
            dir.ends_with("Documents/muesli-transcripts"),
            "dir: {dir:?}"
        );
    }

    #[test]
    fn resolve_output_dir_none_falls_back_to_transcripts_dir() {
        let dir = resolve_output_dir(None).unwrap();
        assert!(
            dir.ends_with("Documents/muesli-transcripts"),
            "dir: {dir:?}"
        );
    }

    #[test]
    fn resolve_output_dir_some_uses_provided_path() {
        let dir = resolve_output_dir(Some("/tmp/my-workspace")).unwrap();
        assert_eq!(dir, PathBuf::from("/tmp/my-workspace"));
    }

    /// AppEmitter routes finals to the markdown sink. We can exercise the sink leg
    /// without a Tauri AppHandle by calling the sink directly (the emit leg needs a
    /// live app and is covered by the manual GUI smoke test).
    #[test]
    fn markdown_sink_receives_finals() {
        let dir = tempfile::tempdir().unwrap();
        let sink = MarkdownSink::create_in(dir.path(), "2026-06-23-1432").unwrap();
        let path = sink.path().to_path_buf();
        let sink = Arc::new(Mutex::new(sink));
        {
            let mut s = sink.lock().unwrap();
            s.append_final(Source::Me, "hello world", 1.0).unwrap();
        }
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(
            body.contains("**You** \u{2014} 00:01\nhello world"),
            "body: {body}"
        );
    }
}
