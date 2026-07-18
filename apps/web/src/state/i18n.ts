// Hand-rolled i18n (no library) — React/zustand port of src/i18n/index.svelte.ts.
// A reactive locale + flat message catalogs. English ships in the main bundle;
// the other locales are dynamic imports so en-only users never download them.
// The locale persists under "muesli:locale" and defaults to the browser
// language when it matches an available locale. Yjs-free, and safe to import
// from any component or plain module (t() reads the store imperatively, so
// non-React code keeps working; components use useT()/useLocale to re-render
// on locale switches).

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { en, type MessageKey } from "./i18n/en";

export type { MessageKey, Messages } from "./i18n/en";

export type LocaleCode = "en" | "de" | "fr" | "it" | "es" | "pt";

export const availableLocales: readonly { code: LocaleCode; label: string }[] = [
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "it", label: "Italiano" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
];

const KEY = "muesli:locale";
const codes = new Set<string>(availableLocales.map((l) => l.code));

function initialLocale(): LocaleCode {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    // storage unavailable — fall through to the browser language
  }
  if (stored && codes.has(stored)) return stored as LocaleCode;
  const nav = typeof navigator === "undefined" ? "" : (navigator.language ?? "");
  const two = nav.slice(0, 2).toLowerCase();
  return codes.has(two) ? (two as LocaleCode) : "en";
}

const loaders: Record<Exclude<LocaleCode, "en">, () => Promise<Record<MessageKey, string>>> = {
  de: async () => (await import("./i18n/de")).de,
  fr: async () => (await import("./i18n/fr")).fr,
  it: async () => (await import("./i18n/it")).it,
  es: async () => (await import("./i18n/es")).es,
  pt: async () => (await import("./i18n/pt")).pt,
};

const loaded: Partial<Record<LocaleCode, Record<MessageKey, string>>> = { en };

export interface I18nState {
  locale: LocaleCode;
  messages: Record<MessageKey, string>;
}

export const i18nStore = createStore<I18nState>()(() => ({
  locale: "en" as LocaleCode,
  messages: en,
}));

async function activate(code: LocaleCode): Promise<void> {
  i18nStore.setState({ locale: code }); // Intl-based formatting (time.ts) switches immediately
  const have = loaded[code];
  if (have) {
    i18nStore.setState({ messages: have });
    return;
  }
  const m = await loaders[code as Exclude<LocaleCode, "en">]();
  loaded[code] = m;
  if (i18nStore.getState().locale === code) {
    i18nStore.setState({ messages: m }); // a later switch wins the race
  }
}

void activate(initialLocale());

/** The active locale code (imperative read — used for Intl date formatting in
 *  plain modules like time.ts; components wanting re-render use useLocale). */
export function currentLocale(): LocaleCode {
  return i18nStore.getState().locale;
}

export function setLocale(code: LocaleCode): void {
  try {
    localStorage.setItem(KEY, code);
  } catch {
    // applies for this page either way
  }
  void activate(code);
}

/** Message lookup with {param} interpolation; any key missing from a
 *  translation falls back to the English string. Reads the store imperatively,
 *  so it works from plain modules; inside components pair it with useT(). */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = i18nStore.getState().messages[key] ?? en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

export const useI18n = <T>(sel: (s: I18nState) => T): T => useStore(i18nStore, sel);

/** The reactive locale code — re-renders on switches (Intl formatting in JSX). */
export function useLocale(): LocaleCode {
  return useI18n((s) => s.locale);
}

/** Subscribe the component to catalog changes and get t back: `const t = useT()`.
 *  The returned function is the module-level t (stable identity); the
 *  subscription on `messages` is what forces a re-render when the locale (or a
 *  late-loaded catalog) lands, so every visible string re-evaluates. */
export function useT(): typeof t {
  useI18n((s) => s.messages);
  return t;
}
