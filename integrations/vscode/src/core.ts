// VS-Code-API-free core for the Muesli presence extension (ADR 0014, Tier 2).
//
// Everything in this file runs in plain Node (tested headlessly via node's
// type-stripping — keep it free of `vscode` imports and of relative `.ts`
// imports). It mirrors the CLI's local state layout (crates/muesli-cli/src/store.rs)
// and the web app's awareness conventions (apps/web/src/collab.ts +
// y-codemirror.next's `cursor` field).
//
// IMPORTANT (ADR 0014): the extension is presence-only. This session never
// writes to the ytext — content flows through `muesli open` / the file on disk.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { WebSocket as NodeWebSocket } from "ws";

/** Shared text root — must match muesli_core::TEXT_ROOT and apps/web/src/collab.ts. */
export const TEXT_ROOT = "content";

// ---------------------------------------------------------------------------
// Server URL normalization (mirrors store.rs http_base / ws_base).
// ---------------------------------------------------------------------------

/** Normalize any server argument (`ws://…/ws`, `http://…`) to the HTTP base URL. */
export function httpBase(server: string): string {
  let s = server.replace(/\/+$/, "");
  if (s.endsWith("/ws")) s = s.slice(0, -"/ws".length);
  if (s.startsWith("wss://")) return `https://${s.slice("wss://".length)}`;
  if (s.startsWith("ws://")) return `http://${s.slice("ws://".length)}`;
  return s;
}

/** The websocket endpoint for a server argument. */
export function wsBase(server: string): string {
  const http = httpBase(server);
  let ws: string;
  if (http.startsWith("https://")) ws = `wss://${http.slice("https://".length)}`;
  else if (http.startsWith("http://")) ws = `ws://${http.slice("http://".length)}`;
  else ws = http;
  return `${ws}/ws`;
}

// ---------------------------------------------------------------------------
// Links index + token store (read-only mirrors of the CLI's store.rs).
// ---------------------------------------------------------------------------

export interface Link {
  file: string;
  doc: string;
  server: string;
}

// dirs::data_dir(): macOS ~/Library/Application Support, linux $XDG_DATA_HOME
// or ~/.local/share, windows %APPDATA% (Roaming).
function dataDir(): string {
  switch (process.platform) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support");
    case "win32":
      return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    default:
      return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  }
}

// dirs::config_dir(): same as data_dir on macOS/windows, ~/.config on linux.
function configDir(): string {
  switch (process.platform) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support");
    case "win32":
      return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    default:
      return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  }
}

/** Path of the CLI's links index. `MUESLI_LINKS_PATH` overrides (tests). */
export function linksPath(): string {
  return process.env.MUESLI_LINKS_PATH ?? path.join(dataDir(), "muesli", "links.json");
}

/** Path of the CLI's credentials-file fallback. `MUESLI_CREDENTIALS_PATH` overrides (tests). */
export function credentialsPath(): string {
  return process.env.MUESLI_CREDENTIALS_PATH ?? path.join(configDir(), "muesli", "credentials.json");
}

export function loadLinks(): Link[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(linksPath(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (l): l is Link =>
        l != null && typeof l.file === "string" && typeof l.doc === "string" && typeof l.server === "string",
    );
  } catch {
    return [];
  }
}

/** Canonicalize a path for comparison (resolves symlinks: macOS /tmp → /private/tmp). */
export function canonicalPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Find the links.json entry for a file, comparing canonicalized paths. */
export function findLink(file: string): Link | undefined {
  const target = canonicalPath(file);
  return loadLinks().find((l) => canonicalPath(l.file) === target);
}

/**
 * Token lookup: MUESLI_TOKEN env, else the credentials.json file fallback keyed
 * by httpBase(server). Tokens stored only in the OS keychain are NOT readable
 * here — set MUESLI_TOKEN for those servers.
 */
export function loadToken(server: string): string | undefined {
  const env = process.env.MUESLI_TOKEN;
  if (env) return env;
  try {
    const creds = JSON.parse(fs.readFileSync(credentialsPath(), "utf8"));
    const t = creds?.[httpBase(server)];
    return typeof t === "string" ? t : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Presence session.
// ---------------------------------------------------------------------------

export interface UserInfo {
  name: string;
  color: string;
  /** Defaults to "vscode". */
  kind?: string;
  colorLight?: string;
}

/** Absolute UTF-16 code-unit offsets into the synced ytext. */
export interface CursorRange {
  anchor: number;
  head: number;
}

export interface Participant {
  clientId: number;
  name: string;
  color: string;
  colorLight?: string;
  kind: string;
  cursor: CursorRange | null;
}

/**
 * A presence-only participant in a Muesli doc room.
 *
 * Syncs the Y.Doc (read-only — needed to resolve relative cursor positions),
 * publishes its own awareness (`user` + `cursor` fields in exactly the format
 * y-codemirror.next uses), and decodes remote participants. Never mutates the
 * ytext.
 */
export class PresenceSession {
  readonly ydoc: Y.Doc;
  readonly ytext: Y.Text;
  readonly provider: WebsocketProvider;
  /** Resolves once the initial sync with the room completes. */
  readonly whenSynced: Promise<void>;

  constructor(wsUrl: string, docId: string, user: UserInfo, token?: string) {
    this.ydoc = new Y.Doc();
    this.ytext = this.ydoc.getText(TEXT_ROOT);

    // Bearer auth rides the ws upgrade as an Authorization header, exactly like
    // the CLI (muesli-cli/src/main.rs). y-websocket instantiates its polyfill as
    // `new WS(url, protocols)`, so a subclass injects the header via ws options.
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    class AuthWebSocket extends NodeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols, { headers });
      }
    }

    this.provider = new WebsocketProvider(wsUrl, docId, this.ydoc, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WebSocketPolyfill: AuthWebSocket as any,
      disableBc: true,
    });

    this.provider.awareness.setLocalStateField("user", {
      name: user.name,
      color: user.color,
      colorLight: user.colorLight ?? `${user.color}33`,
      kind: user.kind ?? "vscode",
    });

    this.whenSynced = new Promise((resolve) => {
      this.provider.on("sync", (isSynced: boolean) => {
        if (isSynced) resolve();
      });
    });
  }

  /** Current room text (the source of truth for cursor offsets). */
  text(): string {
    return this.ytext.toString();
  }

  /**
   * Publish our cursor as awareness field "cursor" = { anchor, head }, each a
   * Yjs relative-position JSON — byte-for-byte what y-codemirror.next's
   * remote-selections plugin writes (y-remote-selections.js:170). Offsets are
   * UTF-16 code units into the ytext; they are clamped to its current length.
   * Pass null to clear (cursor left this document).
   */
  setCursor(anchor: number | null, head?: number): void {
    const awareness = this.provider.awareness;
    if (anchor == null) {
      awareness.setLocalStateField("cursor", null);
      return;
    }
    const len = this.ytext.length;
    const clamp = (n: number) => Math.max(0, Math.min(Math.floor(n), len));
    const rel = (n: number) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.ytext, clamp(n)));
    awareness.setLocalStateField("cursor", { anchor: rel(anchor), head: rel(head ?? anchor) });
  }

  /** Decoded remote awareness states (everyone but us). */
  participants(): Participant[] {
    const out: Participant[] = [];
    const ownId = this.provider.awareness.clientID;
    for (const [clientId, state] of this.provider.awareness.getStates()) {
      if (clientId === ownId) continue;
      const user = (state as Record<string, any>).user ?? {};
      out.push({
        clientId,
        name: typeof user.name === "string" ? user.name : "Anonymous",
        color: typeof user.color === "string" ? user.color : "#888888",
        colorLight: typeof user.colorLight === "string" ? user.colorLight : undefined,
        kind: typeof user.kind === "string" ? user.kind : "unknown",
        cursor: this.decodeCursor((state as Record<string, any>).cursor),
      });
    }
    return out;
  }

  /** Relative-position JSON → absolute UTF-16 offsets against the synced ytext. */
  private decodeCursor(cursor: unknown): CursorRange | null {
    const c = cursor as { anchor?: unknown; head?: unknown } | null | undefined;
    if (c == null || c.anchor == null || c.head == null) return null;
    try {
      const anchor = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(c.anchor),
        this.ydoc,
      );
      const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(c.head), this.ydoc);
      if (anchor == null || head == null) return null;
      if (anchor.type !== this.ytext || head.type !== this.ytext) return null;
      return { anchor: anchor.index, head: head.index };
    } catch {
      return null;
    }
  }

  /** Fires on any awareness change (joins, leaves, cursor moves). Returns a disposer. */
  onAwarenessChange(cb: () => void): () => void {
    const handler = () => cb();
    this.provider.awareness.on("change", handler);
    return () => this.provider.awareness.off("change", handler);
  }

  /** Fires when the room text changes (remote edits arriving). Returns a disposer. */
  onTextChange(cb: () => void): () => void {
    const handler = () => cb();
    this.ytext.observe(handler);
    return () => this.ytext.unobserve(handler);
  }

  destroy(): void {
    this.provider.destroy();
    this.ydoc.destroy();
  }
}
