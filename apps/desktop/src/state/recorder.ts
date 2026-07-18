// Toolbar "record" feature: capture audio + transcribe, streaming each finalized
// utterance into the note that was active WHEN RECORDING STARTED (the "target"
// note). Port of src/lib/recorder.svelte.ts. Recording stays pinned to that
// note even if you browse to other files:
//   - while the target note is the active editor → lines are inserted live
//   - while you're viewing another file → lines are buffered in memory and
//     flushed back into the target (into the editor when you return, or to the
//     target file on disk when recording stops).

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readNote, writeNote } from "@/services/tauri";
import type { TranscriptEvent } from "@/services/types";
import { editorStateStore } from "./editorState";
import { tabsStore } from "./tabs";

export type RecorderStatus = "idle" | "starting" | "recording" | "error";

export interface RecorderState {
  recording: boolean;
  /** 'starting' covers the ~few seconds the Rust side spends loading the speech
   *  model before capture is actually live. */
  status: RecorderStatus;
  targetPath: string | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  toggle(): void;
}

// Non-reactive plumbing (module-level, mirroring the Svelte closure vars).
let unlistenFinal: (() => void) | null = null;
// Utterance keys already consumed (final events can re-fire on correction).
let seen = new Set<string>();
// Lines accumulated while the target note is NOT the active editor.
let buffer: string[] = [];

function formatLine(e: TranscriptEvent): string {
  const speaker = e.source === "me" ? "Me" : "Them";
  return `**${speaker}:** ${e.text.trim()}`;
}

/** Append a block of text (one or more lines) to the live active editor. */
function appendToView(text: string) {
  const view = editorStateStore.getState().activeView;
  if (!view) return;
  const end = view.state.doc.length;
  const needsNl = end > 0 && view.state.doc.sliceString(end - 1) !== "\n";
  const insert = `${needsNl ? "\n" : ""}${text}\n`;
  view.dispatch({
    changes: { from: end, insert },
    selection: { anchor: end + insert.length },
    scrollIntoView: true,
    userEvent: "input",
  });
}

export const recorderStore = createStore<RecorderState>()((set, get) => {
  /** Is the target note the file currently shown in the editor? */
  function targetIsActive(): boolean {
    const targetPath = get().targetPath;
    return (
      !!targetPath &&
      tabsStore.getState().active()?.path === targetPath &&
      !!editorStateStore.getState().activeView
    );
  }

  function appendLine(e: TranscriptEvent) {
    if (!get().targetPath) return;
    const key = `${e.source}:${e.utteranceId}`;
    if (seen.has(key)) return;
    if (!e.text.trim()) return;
    seen.add(key);

    const line = formatLine(e);
    if (targetIsActive()) {
      // Returning to the target with buffered lines? Flush them first, in order.
      if (buffer.length) {
        appendToView(buffer.join("\n"));
        buffer = [];
      }
      appendToView(line);
    } else {
      buffer.push(line);
    }
  }

  /** Persist any buffered (away-period) lines to the target file on disk. */
  async function flushBufferToDisk() {
    const targetPath = get().targetPath;
    if (!targetPath || buffer.length === 0) return;
    const text = buffer.join("\n");
    buffer = [];
    try {
      const current = await readNote(targetPath);
      const needsNl = current.length > 0 && !current.endsWith("\n");
      await writeNote(targetPath, `${current}${needsNl ? "\n" : ""}${text}\n`);
    } catch (err) {
      console.error("[recorder] flush to disk failed:", err);
    }
  }

  return {
    recording: false,
    status: "idle",
    targetPath: null,

    async start() {
      if (get().recording || get().status === "starting") return;
      const targetPath = tabsStore.getState().active()?.path ?? null;
      set({ targetPath });
      if (!targetPath) {
        console.warn("[recorder] no active note to record into");
        return;
      }
      // Reflect the click immediately — start_capture spends a few seconds loading
      // the speech model into memory before capture is live.
      set({ status: "starting" });
      try {
        seen = new Set();
        buffer = [];
        unlistenFinal = await listen<TranscriptEvent>("transcript://final", (ev) =>
          appendLine(ev.payload),
        );
        await invoke("start_capture", {});
        set({ recording: true, status: "recording" });
      } catch (e) {
        const msg = String(e);
        console.error("[recorder] start failed:", e);
        unlistenFinal?.();
        unlistenFinal = null;
        // Recover from a stuck/previous capture session so the next click works.
        if (msg.includes("already running")) {
          try {
            await invoke("stop_capture");
          } catch {
            /* ignore */
          }
        }
        set({ recording: false, targetPath: null, status: "idle" });
        window.alert(`Could not start recording: ${msg}`);
      }
    },

    async stop() {
      try {
        await invoke("stop_capture");
      } catch (e) {
        console.error("[recorder] stop failed:", e);
      } finally {
        unlistenFinal?.();
        unlistenFinal = null;
        // If the target note is currently open, flush the buffer into the editor;
        // otherwise persist it to the file on disk.
        if (buffer.length) {
          if (targetIsActive()) {
            appendToView(buffer.join("\n"));
            buffer = [];
          } else {
            await flushBufferToDisk();
          }
        }
        set({ recording: false, status: "idle", targetPath: null });
      }
    },

    toggle() {
      if (get().recording) void get().stop();
      else if (get().status !== "starting") void get().start();
    },
  };
});

export const useRecorder = <T>(sel: (s: RecorderState) => T): T => useStore(recorderStore, sel);
