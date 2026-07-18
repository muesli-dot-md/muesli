// Sign-in server picker (spec 2026-07-02 §1): pure, rune-free normalization
// for the server address a user types into the sign-in dialog (house pattern:
// onboardingGate.ts — pure functions + table tests). Mirrors httpBase.ts's
// scheme mapping (http↔ws, https↔wss) and its trailing-slash + "/ws"-suffix
// stripping, in the inverse direction: any reasonable input → the canonical
// ws(s)://…/ws form that settings.wsBase stores.

/**
 * Normalize raw user input to the canonical `ws(s)://host[:port][/path]/ws`
 * form, or return null when the input is empty/whitespace or unparseable
 * (inner spaces, unknown scheme, no host). Bare `host[:port]` gets wss —
 * self-hosters get TLS by default. Query strings and fragments are dropped:
 * the server address is host[:port][/path] only.
 */
export function normalizeServerInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || /\s/.test(trimmed)) return null;

  // Drop any query string or fragment ("?foo=1", "#frag", a lone "#") —
  // they must never be folded into the /ws path.
  const input = trimmed.replace(/[?#].*$/, "");

  let secure = true;
  let rest = input; // bare host[:port] → wss
  if (input.startsWith("https://")) {
    rest = input.slice("https://".length);
  } else if (input.startsWith("http://")) {
    secure = false;
    rest = input.slice("http://".length);
  } else if (input.startsWith("wss://")) {
    rest = input.slice("wss://".length);
  } else if (input.startsWith("ws://")) {
    secure = false;
    rest = input.slice("ws://".length);
  } else if (input.includes("://")) {
    return null; // unknown scheme (ftp://, file://, …)
  }

  // Strip trailing slashes, then one "/ws" suffix (never doubled), then any
  // slashes exposed by that strip ("host//ws" must not become "host/" — a
  // trailing slash here would pollute the Rust http_base() token key). Same
  // stripping httpBaseOf does, so "…/ws/" and "…/ws" both work.
  let hostAndPath = rest.replace(/\/+$/, "");
  if (hostAndPath.endsWith("/ws")) {
    hostAndPath = hostAndPath.slice(0, -"/ws".length).replace(/\/+$/, "");
  }
  if (hostAndPath === "") return null;

  // Validate host[:port] via the URL parser (catches "https://:8787",
  // out-of-range ports, and other garbage that survived the checks above).
  try {
    const parsed = new URL(`${secure ? "https" : "http"}://${hostAndPath}`);
    if (!parsed.hostname) return null;
  } catch {
    return null;
  }

  return `${secure ? "wss" : "ws"}://${hostAndPath}/ws`;
}

/**
 * The friendly label for a stored wsBase: scheme and the trailing "/ws"
 * stripped (`wss://app.muesli.md/ws` → `app.muesli.md`, `ws://localhost:8787/ws` →
 * `localhost:8787`). Purely cosmetic — never written back to settings.
 */
export function displayHost(wsBase: string): string {
  let s = wsBase.replace(/\/+$/, "");
  if (s.endsWith("/ws")) s = s.slice(0, -"/ws".length).replace(/\/+$/, "");
  if (s.startsWith("wss://")) return s.slice("wss://".length);
  if (s.startsWith("ws://")) return s.slice("ws://".length);
  return s;
}

/**
 * The EDITABLE form of a stored wsBase — what URL inputs prefill with, so
 * users only ever see and type a plain address (`wss://app.muesli.md/ws` →
 * `https://app.muesli.md`). Inverse of normalizeServerInput on canonical values:
 * normalizeServerInput(displayUrl(x)) === x. Tolerant of legacy
 * un-normalized values (trailing slashes, an already-https string).
 */
export function displayUrl(wsBase: string): string {
  let s = wsBase.replace(/\/+$/, "");
  if (s.endsWith("/ws")) s = s.slice(0, -"/ws".length).replace(/\/+$/, "");
  if (s.startsWith("wss://")) return `https://${s.slice("wss://".length)}`;
  if (s.startsWith("ws://")) return `http://${s.slice("ws://".length)}`;
  return s;
}
