// Authenticated transport for the desktop collaboration UI.
//
// The desktop's bearer token lives in the OS Keychain (Rust side) and the
// webview NEVER sees it. So every authenticated server call routes through the
// Rust `api_request` Tauri command, which attaches `Authorization: Bearer
// <token>` from the Keychain and returns `{ status, body }`. This JS wrapper
// unwraps that envelope and throws `ApiError` on non-2xx, presenting the same
// shape the webapp's `collabApi` callers expect.

import { invoke } from "@tauri-apps/api/core";

/** Mirrors the webapp's ApiError ({ status, bodyText }). */
export class ApiError extends Error {
  status: number;
  bodyText: string;
  constructor(status: number, bodyText: string) {
    super(bodyText.trim() || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

/** The Rust `api_request` command's return shape. */
type ApiResponse = { status: number; body: unknown };

export type RequestOpts = {
  method?: string;
  path: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
};

function withQuery(path: string, query?: Record<string, string | undefined>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * Issue an authenticated request through the Rust `api_request` command.
 * Returns the parsed JSON body on 2xx; throws `ApiError(status, bodyText)` on
 * status >= 400.
 */
export async function apiRequest<T>(server: string, opts: RequestOpts): Promise<T> {
  const res = (await invoke("api_request", {
    server,
    method: opts.method ?? "GET",
    path: withQuery(opts.path, opts.query),
    body: opts.body,
  })) as ApiResponse;

  if (res.status >= 400) {
    const bodyText =
      typeof res.body === "string" ? res.body : JSON.stringify(res.body ?? {});
    throw new ApiError(res.status, bodyText);
  }
  return res.body as T;
}

/** A function with the same surface as `apiRequest`, bound to a server. */
export type RequestFn = <T>(opts: RequestOpts) => Promise<T>;

/** Bind `apiRequest` to a server, yielding the `requestFn` collabApi consumes. */
export function boundRequest(server: string): RequestFn {
  return <T>(opts: RequestOpts) => apiRequest<T>(server, opts);
}
