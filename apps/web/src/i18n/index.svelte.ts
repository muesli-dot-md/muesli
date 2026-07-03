// Hand-rolled i18n (no library): a reactive locale + flat message catalogs.
// English ships in the main bundle; the other locales are dynamic imports so
// en-only users never download them. The locale persists under "muesli:locale"
// and defaults to the browser language when it matches an available locale.
// Yjs-free, and safe to import from any component or plain module.

import { en, type MessageKey } from "./en";

export type { MessageKey, Messages } from "./en";

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
  de: async () => (await import("./de")).de,
  fr: async () => (await import("./fr")).fr,
  it: async () => (await import("./it")).it,
  es: async () => (await import("./es")).es,
  pt: async () => (await import("./pt")).pt,
};

const loaded: Partial<Record<LocaleCode, Record<MessageKey, string>>> = { en };

let locale: LocaleCode = $state("en");
let messages: Record<MessageKey, string> = $state.raw(en);

async function activate(code: LocaleCode): Promise<void> {
  locale = code; // Intl-based formatting (time.ts) switches immediately
  const have = loaded[code];
  if (have) {
    messages = have;
    return;
  }
  const m = await loaders[code as Exclude<LocaleCode, "en">]();
  loaded[code] = m;
  if (locale === code) messages = m; // a later switch wins the race
}

void activate(initialLocale());

/** The active locale code — reactive (used for Intl date formatting). */
export function currentLocale(): LocaleCode {
  return locale;
}

export function setLocale(code: LocaleCode): void {
  try {
    localStorage.setItem(KEY, code);
  } catch {
    // applies for this page either way
  }
  void activate(code);
}

/** Reactive message lookup with {param} interpolation; any key missing from a
 *  translation falls back to the English string. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = messages[key] ?? en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}
