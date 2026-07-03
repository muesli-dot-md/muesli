import { describe, it, expect } from "vitest";
import { normalizeServerInput, displayHost, displayUrl } from "./signInServer";

// Sign-in server picker (spec 2026-07-02 §1): any reasonable server address a
// self-hoster pastes — https://, http://, wss://, ws://, or a bare host[:port]
// — normalizes to the canonical ws(s)://…/ws form settings.wsBase stores.
describe("normalizeServerInput", () => {
  it.each([
    // https ↔ wss, http ↔ ws (mirrors httpBase.ts's scheme mapping, inverted)
    ["https://muesli.example.com", "wss://muesli.example.com/ws"],
    ["http://localhost:8787", "ws://localhost:8787/ws"],
    // already-websocket inputs pass through; an existing /ws is not doubled
    ["wss://app.muesli.md/ws", "wss://app.muesli.md/ws"],
    ["ws://localhost:8787", "ws://localhost:8787/ws"],
    ["ws://localhost:8787/ws", "ws://localhost:8787/ws"],
    // bare host[:port] → wss (self-hosters get TLS by default)
    ["app.muesli.md", "wss://app.muesli.md/ws"],
    ["muesli.example.com:9443", "wss://muesli.example.com:9443/ws"],
    // trailing slashes stripped, before and after the /ws suffix
    ["https://muesli.example.com/", "wss://muesli.example.com/ws"],
    ["https://muesli.example.com/ws/", "wss://muesli.example.com/ws"],
    // a doubled slash before /ws collapses — "host//ws" must not normalize to
    // "wss://host//ws" (its http_base() token key would carry a trailing slash)
    ["https://muesli.example.com//ws", "wss://muesli.example.com/ws"],
    // a server mounted under a path keeps the path
    ["https://muesli.example.com/team", "wss://muesli.example.com/team/ws"],
    // surrounding whitespace trimmed
    ["  https://muesli.example.com  ", "wss://muesli.example.com/ws"],
    // port preservation on every scheme
    ["http://localhost:8787/ws", "ws://localhost:8787/ws"],
    // query strings and fragments are dropped, never folded into the path
    ["https://muesli.example.com?foo=1", "wss://muesli.example.com/ws"],
    ["https://muesli.example.com#frag", "wss://muesli.example.com/ws"],
    ["https://host/team?x=1#y", "wss://host/team/ws"],
    ["https://muesli.example.com#", "wss://muesli.example.com/ws"],
  ])("normalizes %s → %s", (raw, expected) => {
    expect(normalizeServerInput(raw)).toBe(expected);
  });

  it.each([
    [""], // empty
    ["   "], // whitespace-only
    ["not a url"], // inner spaces
    ["https://"], // no host
    ["ftp://example.com"], // unknown scheme
    ["https://:8787"], // port but no host
  ])("rejects %j with null", (raw) => {
    expect(normalizeServerInput(raw)).toBeNull();
  });
});

// The friendly label for the dialog's Server row: scheme + /ws suffix stripped.
describe("displayHost", () => {
  it.each([
    ["wss://app.muesli.md/ws", "app.muesli.md"],
    ["ws://localhost:8787/ws", "localhost:8787"],
    ["wss://muesli.example.com:9443/ws", "muesli.example.com:9443"],
    ["wss://muesli.example.com/team/ws", "muesli.example.com/team"],
  ])("labels %s as %s", (wsBase, expected) => {
    expect(displayHost(wsBase)).toBe(expected);
  });

  it.each([
    ["https://muesli.example.com", "muesli.example.com"],
    ["muesli.example.com:9443", "muesli.example.com:9443"],
    ["http://localhost:8787", "localhost:8787"],
  ])("round-trips user input %s → label %s", (raw, expectedLabel) => {
    const normalized = normalizeServerInput(raw);
    expect(normalized).not.toBeNull();
    expect(displayHost(normalized!)).toBe(expectedLabel);
  });
});

// The editable form of a stored wsBase: what URL inputs prefill with, so
// users only ever see/type a plain https:// address — never the ws parts.
describe("displayUrl", () => {
  it.each([
    ["wss://app.muesli.md/ws", "https://app.muesli.md"],
    ["ws://localhost:8787/ws", "http://localhost:8787"],
    ["wss://muesli.example.com:9443/ws", "https://muesli.example.com:9443"],
    ["wss://muesli.example.com/team/ws", "https://muesli.example.com/team"],
    // tolerant of legacy un-normalized persisted values
    ["wss://app.muesli.md/ws/", "https://app.muesli.md"],
    ["https://muesli.example.com", "https://muesli.example.com"],
  ])("renders %s as %s", (wsBase, expected) => {
    expect(displayUrl(wsBase)).toBe(expected);
  });

  it.each([
    ["wss://app.muesli.md/ws"],
    ["ws://localhost:8787/ws"],
    ["wss://muesli.example.com/team/ws"],
  ])("round-trips %s through normalizeServerInput unchanged", (wsBase) => {
    expect(normalizeServerInput(displayUrl(wsBase))).toBe(wsBase);
  });
});
