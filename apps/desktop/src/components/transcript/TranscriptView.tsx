import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "zustand";
import { FolderOpen, Mic, MonitorSpeaker, RefreshCw, ShieldAlert, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { subscribeToTranscriptEvents } from "@/services/events";
import { createTranscriptStore } from "@/state/transcript";
import { captureUiStore, useCaptureUi } from "@/state/captureUi";
import TranscriptLane from "./TranscriptLane";

interface TranscriptViewProps {
  /** Workspace root directory the transcript note is written into. */
  workspaceDir: string;
  /** Called after the user stops capture (before the note is opened). */
  onStop: () => void;
  /** Called with the meeting-*.md path once Rust reports the file on disk. */
  onSaved: (path: string) => void;
}

interface Permissions {
  microphone: boolean;
  screenRecording: boolean;
}

type SetupPhase =
  | "checking" //  check_permissions in flight
  | "denied" //    at least one permission missing → guidance UI
  | "preparing" // ensure_model (download if needed)
  | "warming" //   warm_models preload
  | "ready";

const SETUP_LABEL: Partial<Record<SetupPhase, string>> = {
  checking: "Checking permissions…",
  preparing: "Preparing transcription model…",
  warming: "Warming models…",
};

/**
 * Meeting transcription view: two lanes "Me" (mic) / "Them" (system audio) fed
 * by Rust `transcript://partial|final` events. Replaces the main canvas while
 * recording. Shared status/path/start-trigger state lives in the captureUi
 * store (read by the shell for the recording footer and palette commands).
 */
export default function TranscriptView({ workspaceDir, onStop, onSaved }: TranscriptViewProps) {
  // Per-view transcript store instance (zustand factory from the state layer).
  const transcriptStoreRef = useRef<ReturnType<typeof createTranscriptStore> | null>(null);
  if (transcriptStoreRef.current === null) {
    transcriptStoreRef.current = createTranscriptStore();
  }
  const transcriptStore = transcriptStoreRef.current;

  // Select the whole (immutably-replaced) state object so the derived
  // `lines(source)` arrays can be computed in render without unstable
  // snapshots.
  const transcript = useStore(transcriptStore);
  const meLines = transcript.lines("me");
  const themLines = transcript.lines("them");

  const captureStatus = useCaptureUi((s) => s.captureStatus);
  const capturePath = useCaptureUi((s) => s.capturePath);

  const [setupPhase, setSetupPhase] = useState<SetupPhase>("checking");
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [statusText, setStatusText] = useState("");

  // ── transcript event subscription (unmount-safe) ─────────────────────────
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void subscribeToTranscriptEvents({
      applyPartial: (e) => transcriptStore.getState().applyPartial(e),
      applyFinal: (e) => transcriptStore.getState().applyFinal(e),
    }).then((fn) => {
      // If we unmounted while the listen() registrations were in flight,
      // release them immediately instead of leaking.
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [transcriptStore]);

  // ── permission + model setup ─────────────────────────────────────────────
  const runGenerationRef = useRef(0);
  const runSetup = useCallback(async () => {
    const generation = ++runGenerationRef.current;
    const alive = () => runGenerationRef.current === generation;

    setSetupPhase("checking");
    let perms: Permissions | null = null;
    try {
      perms = await invoke<Permissions>("check_permissions");
    } catch {
      // Permission check unavailable — proceed best-effort (mirrors Svelte).
      if (alive()) setStatusText("Permission check unavailable");
    }
    if (!alive()) return;
    setPermissions(perms);
    if (perms && (!perms.microphone || !perms.screenRecording)) {
      setSetupPhase("denied");
      return;
    }

    setSetupPhase("preparing");
    try {
      await invoke("ensure_model");
    } catch {
      // model download not available — best-effort
    }
    if (!alive()) return;

    setSetupPhase("warming");
    try {
      await invoke("warm_models");
    } catch {
      // preload not available — best-effort
    }
    if (!alive()) return;
    setSetupPhase("ready");
  }, []);

  useEffect(() => {
    void runSetup();
    return () => {
      // Invalidate any in-flight setup run on unmount.
      runGenerationRef.current++;
    };
  }, [runSetup]);

  // ── capture lifecycle ────────────────────────────────────────────────────
  const startCapture = useCallback(async () => {
    const ui = captureUiStore.getState();
    if (ui.captureStatus === "running") return;
    ui.setStatus("running");
    setStatusText("Capturing…");
    try {
      // Tauri camelCases snake_case args: workspace_dir → workspaceDir.
      const path = await invoke<string>("start_capture", workspaceDir ? { workspaceDir } : {});
      if (path) captureUiStore.getState().setCapturePath(path);
    } catch (e) {
      captureUiStore.getState().setStatus("error", String(e));
      setStatusText(`Error: ${e}`);
    }
  }, [workspaceDir]);

  const stopCapture = useCallback(async () => {
    try {
      await invoke("stop_capture");
      const path = captureUiStore.getState().capturePath;
      captureUiStore.getState().setStatus("idle");
      setStatusText("Stopped.");
      onStop();
      if (path) onSaved(path);
    } catch (e) {
      captureUiStore.getState().setStatus("error", String(e));
      setStatusText(`Error: ${e}`);
    }
  }, [onStop, onSaved]);

  // Consume shell-initiated start requests (palette "Start transcription"):
  // one pending at mount, plus any raised while the view is open.
  useEffect(() => {
    if (captureUiStore.getState().consumeStartRequest()) void startCapture();
    const unsubscribe = captureUiStore.subscribe((state) => {
      if (state.startRequested && captureUiStore.getState().consumeStartRequest()) {
        void startCapture();
      }
    });
    return unsubscribe;
  }, [startCapture]);

  const revealOutput = useCallback(async () => {
    try {
      await invoke("reveal_output");
    } catch {
      // not available on this platform/build
    }
  }, []);

  const running = captureStatus === "running";
  const setupLabel = SETUP_LABEL[setupPhase];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      {/* ── header row ──────────────────────────────────────────────────── */}
      <header className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <Mic className="size-4 text-brand" aria-hidden />
          <h1 className="text-sm font-semibold text-foreground">Transcription</h1>
          {running && (
            <span className="flex items-center gap-1.5 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
              <span className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-destructive" />
              </span>
              Recording
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="brand"
            onClick={() => void startCapture()}
            disabled={running || setupPhase === "denied"}
          >
            <Mic data-icon="inline-start" aria-hidden />
            Start
          </Button>
          <Button variant="destructive" onClick={() => void stopCapture()} disabled={!running}>
            <Square data-icon="inline-start" aria-hidden />
            Stop
          </Button>
        </div>
      </header>

      {/* ── status row ──────────────────────────────────────────────────── */}
      <div className="flex min-h-6 shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
        {setupLabel && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            {setupLabel}
          </span>
        )}
        {statusText && <span className="text-xs text-muted-foreground">{statusText}</span>}
        {capturePath ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-xs text-foreground" title={capturePath}>
              {capturePath}
            </span>
            <Button variant="ghost" size="xs" onClick={() => void revealOutput()}>
              <FolderOpen data-icon="inline-start" aria-hidden />
              Reveal
            </Button>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground italic">
            Output file: not yet available
          </span>
        )}
      </div>

      {/* ── body: permission guidance or the two lanes ──────────────────── */}
      {setupPhase === "denied" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="max-w-md rounded-xl bg-surface p-6 shadow-(--surface-shadow) ring-1 ring-surface-border">
            <div className="flex items-center gap-2">
              <ShieldAlert className="size-5 text-warning" aria-hidden />
              <h2 className="text-sm font-semibold text-surface-foreground">Permissions needed</h2>
            </div>
            <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
              <li className="flex items-center gap-2">
                <Mic className="size-4 shrink-0" aria-hidden />
                Microphone ("Me" lane) — {permissions?.microphone ? "granted" : "not granted"}
              </li>
              <li className="flex items-center gap-2">
                <MonitorSpeaker className="size-4 shrink-0" aria-hidden />
                Screen recording ("Them" system audio lane) —{" "}
                {permissions?.screenRecording ? "granted" : "not granted"}
              </li>
            </ul>
            <p className="mt-3 text-sm text-muted-foreground">
              Grant access in System Settings → Privacy &amp; Security, then check again.
            </p>
            <Button variant="outline" size="sm" className="mt-4" onClick={() => void runSetup()}>
              <RefreshCw data-icon="inline-start" aria-hidden />
              Check again
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3">
          <TranscriptLane
            title="Me"
            lines={meLines}
            icon={<Mic className="size-3.5 text-muted-foreground" aria-hidden />}
          />
          <TranscriptLane
            title="Them"
            lines={themLines}
            icon={<MonitorSpeaker className="size-3.5 text-muted-foreground" aria-hidden />}
          />
        </div>
      )}
    </div>
  );
}
