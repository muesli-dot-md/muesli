// The shared presenter for failed API calls (toasts and inline errors). Callsites
// that can say something MORE specific (401 → "sign in to do this", 409 → "name in
// use") check those statuses first and fall back to errMsg for the rest — so this
// is the single place that decides what an UNHANDLED failure looks like.

import { presentApiError } from "./errorKind";
import { t } from "./i18n/index.svelte";

/** A display-ready message for a failed API call. User-actionable server messages
 *  (4xx validation, e.g. "name already taken") pass through as-is; config/internal/
 *  network failures become the friendly muesli-voice apology, with the technical
 *  detail logged to the console instead of the UI. */
export function errMsg(e: unknown): string {
  const p = presentApiError(e);
  if (p.kind === "actionable") return p.message;
  console.error("muesli: unexpected API error —", e);
  return t("common.errorFriendly");
}
