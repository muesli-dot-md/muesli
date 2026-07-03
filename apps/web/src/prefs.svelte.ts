// Cross-component UI preferences persisted to localStorage. Home's view mode
// lives here (key "muesli:home-view", predates this module) so the Settings
// modal and the Home toolbar toggle stay in sync. Yjs-free.

export type HomeView = "list" | "grid" | "tree";

const VIEW_KEY = "muesli:home-view";

function initialView(): HomeView {
  const v = localStorage.getItem(VIEW_KEY);
  return v === "grid" || v === "tree" ? v : "list";
}

let homeView: HomeView = $state(initialView());

export const prefs = {
  get homeView(): HomeView {
    return homeView;
  },
  set homeView(v: HomeView) {
    homeView = v;
    localStorage.setItem(VIEW_KEY, v);
  },
};
