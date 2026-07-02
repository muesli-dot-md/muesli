<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { onMount, onDestroy } from "svelte";
  import { createTranscriptStore } from "$lib/transcript.svelte";
  import { subscribeToTranscriptEvents } from "$lib/events";
  import TranscriptLane from "$lib/TranscriptLane.svelte";

  interface Props {
    /** Workspace root directory to write the transcript into. When absent the
     *  default ~/Documents/muesli-transcripts/ is used. */
    workspaceDir?: string | null;
    /** Called with the note path after the user stops capture and the file
     *  is finalised on disk. */
    onStop?: (path: string) => void;
    /**
     * Shared capture status, bound by the parent (AppShell). The parent reads
     * this to know whether capture is running without duplicating state.
     * 'idle' | 'running' | 'error'
     */
    captureStatus?: "idle" | "running" | "error";
    /**
     * Shared output path, bound by the parent (AppShell). The parent reads
     * this to open the note after a palette-initiated stop.
     */
    capturePath?: string | null;
    /**
     * When the parent flips this to `true` (e.g. command-palette "Start"),
     * the panel calls startCapture() internally so all state updates go
     * through one code path. The parent should reset it to `false` after.
     */
    triggerStart?: boolean;
  }

  let {
    workspaceDir = null,
    onStop,
    captureStatus = $bindable("idle"),
    capturePath = $bindable(null),
    triggerStart = $bindable(false),
  }: Props = $props();

  const store = createTranscriptStore();

  let statusText = $state("");
  let unlisten: (() => void) | null = null;

  onMount(async () => {
    // Subscribe to transcript events
    unlisten = await subscribeToTranscriptEvents(store);

    // Check permissions and model on mount (best-effort; commands may not exist yet)
    try {
      const perms = await invoke<{ microphone: boolean; screenRecording: boolean }>(
        "check_permissions",
      );
      statusText = `Mic: ${perms.microphone ? "granted" : "not available"}`;
    } catch {
      statusText = "Permission check unavailable";
    }
    try {
      await invoke("ensure_model");
    } catch {
      // model check not yet implemented
    }
  });

  onDestroy(() => {
    unlisten?.();
  });

  // When the parent sets triggerStart=true, kick off capture and reset the flag.
  $effect(() => {
    if (triggerStart) {
      triggerStart = false;
      startCapture();
    }
  });

  async function startCapture() {
    try {
      captureStatus = "running";
      statusText = "Capturing…";
      // Pass workspaceDir so Rust writes the file into the active workspace.
      // Tauri camelCases snake_case args: workspace_dir → workspaceDir.
      const path = await invoke<string>("start_capture", workspaceDir ? { workspaceDir } : {});
      if (path) capturePath = path;
    } catch (e) {
      captureStatus = "error";
      statusText = `Error: ${e}`;
    }
  }

  async function stopCapture() {
    try {
      await invoke("stop_capture");
      captureStatus = "idle";
      statusText = "Stopped.";
      if (capturePath && onStop) {
        onStop(capturePath);
      }
    } catch (e) {
      captureStatus = "error";
      statusText = `Error: ${e}`;
    }
  }

  async function revealOutput() {
    try {
      await invoke("reveal_output");
    } catch {
      // not yet implemented
    }
  }

  let meLines = $derived(store.lines("me"));
  let themLines = $derived(store.lines("them"));
</script>

<main class="app">
  <header class="header">
    <h1 class="app-title">muesli</h1>
    <div class="controls">
      <button class="btn btn-start" onclick={startCapture} disabled={captureStatus === "running"}>
        Start
      </button>
      <button class="btn btn-stop" onclick={stopCapture} disabled={captureStatus !== "running"}>
        Stop
      </button>
    </div>
    <div class="status-row">
      {#if statusText}
        <span class="status-text">{statusText}</span>
      {/if}
      {#if capturePath}
        <span class="output-path">{capturePath}</span>
        <button class="btn btn-reveal" onclick={revealOutput}>Reveal</button>
      {:else}
        <span class="output-path muted">Output file: not yet available</span>
      {/if}
    </div>
  </header>

  <div class="lanes">
    <TranscriptLane title="Me" lines={meLines} />
    <TranscriptLane title="Them" lines={themLines} />
  </div>
</main>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 1rem;
    box-sizing: border-box;
    font-family: Inter, Avenir, Helvetica, Arial, sans-serif;
    color: var(--color-base-content);
    background-color: var(--color-base-100);
  }

  .header {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .app-title {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 700;
  }

  .controls {
    display: flex;
    gap: 0.5rem;
  }

  .status-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .status-text {
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .output-path {
    font-size: 0.8rem;
    font-family: monospace;
    color: var(--color-base-content);
    word-break: break-all;
  }

  .output-path.muted {
    color: var(--text-muted);
    font-style: italic;
  }

  .lanes {
    display: flex;
    gap: 1rem;
    flex: 1;
    min-height: 0;
  }

  .btn {
    border-radius: 6px;
    border: 1px solid transparent;
    padding: 0.4em 1em;
    font-size: 0.9rem;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition:
      border-color 0.2s,
      opacity 0.2s;
  }

  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-start {
    background: var(--color-primary);
    color: var(--color-primary-content);
  }

  .btn-start:hover:not(:disabled) {
    opacity: 0.9;
  }

  .btn-stop {
    background: var(--color-error, oklch(0.63 0.22 25));
    color: oklch(0.98 0.01 25);
  }

  .btn-stop:hover:not(:disabled) {
    opacity: 0.9;
  }

  .btn-reveal {
    background: var(--color-base-200);
    color: var(--color-base-content);
    border: 1px solid var(--arc-border);
  }

  .btn-reveal:hover {
    background: var(--color-base-300);
  }
</style>
