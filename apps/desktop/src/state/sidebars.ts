// Persisted, drag-resizable widths for the left (file tree) and right (outline /
// comments) sidebars. Widths are clamped to sane bounds and saved to localStorage.
// Port of src/lib/sidebars.svelte.ts.

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

const LKEY = "muesli:sidebar-left";
const RKEY = "muesli:sidebar-right";

const LEFT_MIN = 200,
  LEFT_MAX = 480,
  LEFT_DEFAULT = 240;
const RIGHT_MIN = 220,
  RIGHT_MAX = 540,
  RIGHT_DEFAULT = 288;

function load(key: string, fallback: number): number {
  if (typeof localStorage === "undefined") return fallback;
  const raw = localStorage.getItem(key);
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function clamp(px: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(px)));
}

export interface SidebarsState {
  left: number;
  right: number;
  setLeft(px: number): void;
  setRight(px: number): void;
}

export const sidebarsStore = createStore<SidebarsState>()((set) => ({
  left: clamp(load(LKEY, LEFT_DEFAULT), LEFT_MIN, LEFT_MAX),
  right: clamp(load(RKEY, RIGHT_DEFAULT), RIGHT_MIN, RIGHT_MAX),
  setLeft(px) {
    const left = clamp(px, LEFT_MIN, LEFT_MAX);
    set({ left });
    if (typeof localStorage !== "undefined") localStorage.setItem(LKEY, String(left));
  },
  setRight(px) {
    const right = clamp(px, RIGHT_MIN, RIGHT_MAX);
    set({ right });
    if (typeof localStorage !== "undefined") localStorage.setItem(RKEY, String(right));
  },
}));

export const useSidebars = <T>(sel: (s: SidebarsState) => T): T => useStore(sidebarsStore, sel);
