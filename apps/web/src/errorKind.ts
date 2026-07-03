// Error-surface classification (Commit 2). Maps an API/load failure to one of a
// small set of friendly, on-brand error pages instead of surfacing raw error
// text or JSON. DOM-free so it's unit-testable in the node test environment.

export type ErrorKind = "not-found" | "no-access" | "doc-not-found" | "generic";

/** Classify a failed document load by HTTP status.
 *
 *  404 → the document doesn't exist.
 *  401/403 → a permission problem. We only reach a doc view when NOT gated to
 *  the AuthPage (signed in, or a share link), so a 401/403 here reads as
 *  "you're here but not allowed", distinct from not-found.
 *  Anything else → a generic "something went wrong".
 */
export function classifyDocError(status: number): ErrorKind {
  if (status === 404) return "doc-not-found";
  if (status === 401 || status === 403) return "no-access";
  return "generic";
}

// --- generic API failures (toasts / inline errors) --------------------------------

export type ApiErrorPresentation =
  | { kind: "actionable"; message: string }
  | { kind: "unexpected"; detail: string };

/** Split a failed API call into "show the server's words" vs "hide the guts".
 *
 *  4xx bodies are messages the server wrote FOR the user ("name already taken",
 *  "endpoint and bucket are required") — user-actionable, shown as-is. Everything
 *  else — 5xx (config/internal, e.g. "google drive is not configured on the
 *  server (set MUESLI_GOOGLE_CLIENT_ID …)"), network failures, parse errors — is
 *  not the user's fault and not theirs to fix: those get the friendly catch-all,
 *  with the technical detail kept for the console only.
 *
 *  Every API error class (WorkspaceApiError, AccountApiError, GraphApiError, the
 *  collab/notifications ApiErrors) is an Error carrying a numeric `status`. */
export function presentApiError(e: unknown): ApiErrorPresentation {
  const status = e !== null && typeof e === "object" ? (e as { status?: unknown }).status : null;
  const message = e instanceof Error ? e.message : String(e);
  if (typeof status === "number" && status >= 400 && status < 500 && message.trim()) {
    return { kind: "actionable", message };
  }
  return { kind: "unexpected", detail: message };
}
