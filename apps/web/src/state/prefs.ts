// Cross-component UI preferences persisted to localStorage — React/zustand
// port of src/prefs.svelte.ts. Home's view mode lives here (key
// "muesli:home-view", predates this module) so the Settings modal and the Home
// toolbar toggle stay in sync. Yjs-free.
// The Svelte `prefs.homeView = v` property setter becomes `setHomeView(v)`.

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

export type HomeView = "list" | "grid" | "tree";

const VIEW_KEY = "muesli:home-view";

function initialView(): HomeView {
  if (typeof localStorage === "undefined") return "list";
  let v: string | null = null;
  try {
    v = localStorage.getItem(VIEW_KEY);
  } catch {
    // storage unavailable — default list
  }
  return v === "grid" || v === "tree" ? v : "list";
}

export interface PrefsState {
  homeView: HomeView;
  setHomeView(v: HomeView): void;
}

export const prefsStore = createStore<PrefsState>()((set) => ({
  homeView: initialView(),
  setHomeView(v) {
    set({ homeView: v });
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // applies for this page either way
    }
  },
}));

export const usePrefs = <T>(sel: (s: PrefsState) => T): T => useStore(prefsStore, sel);
