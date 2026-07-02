// Date formatting shared by the home screen and the editor-side panels.
// Free of collab imports so Home.svelte can use it without opening a doc room.
// Relative phrases come from the i18n catalog and Intl calls use the active
// locale, so the output is reactive to language switches.

import { currentLocale, t } from "./i18n/index.svelte";

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 45) return t("time.justNow");
  const mins = Math.round(secs / 60);
  if (mins < 60) return t("time.minutesAgo", { count: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("time.hoursAgo", { count: hours });
  const days = Math.round(hours / 24);
  if (days < 30) return t("time.daysAgo", { count: days });
  return new Date(iso).toLocaleDateString(currentLocale());
}

/** Drive-style "Modified" column: time-of-day today, "Jun 10" this year, else "Jun 10, 2025". */
export function driveDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(currentLocale(), { hour: "numeric", minute: "2-digit" });
  }
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(currentLocale(), opts);
}

/** Full date+time, for title/tooltip attributes next to driveDate(). */
export function fullDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(currentLocale());
}
