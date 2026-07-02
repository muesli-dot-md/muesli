// Theme mode (light / dark / system), persisted under "muesli:theme".
// index.html runs the same resolution inline before first paint (no flash);
// this store takes over once the app boots: it applies mode changes live and
// follows the OS preference while in system mode. Yjs-free.

export type ThemeMode = "light" | "dark" | "system";

const KEY = "muesli:theme";
const mq = window.matchMedia("(prefers-color-scheme: dark)");

function storedMode(): ThemeMode {
  let v: string | null = null;
  try {
    v = localStorage.getItem(KEY);
  } catch {
    // storage unavailable — system it is
  }
  return v === "light" || v === "dark" ? v : "system";
}

let mode: ThemeMode = $state(storedMode());

function apply() {
  const dark = mode === "dark" || (mode === "system" && mq.matches);
  document.documentElement.dataset.theme = dark ? "muesli-dark" : "muesli";
}

mq.addEventListener("change", () => {
  if (mode === "system") apply();
});
apply();

export const theme = {
  get mode(): ThemeMode {
    return mode;
  },
  set mode(m: ThemeMode) {
    mode = m;
    try {
      localStorage.setItem(KEY, m);
    } catch {
      // applies for this page either way
    }
    apply();
  },
};
