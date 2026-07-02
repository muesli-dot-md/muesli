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
