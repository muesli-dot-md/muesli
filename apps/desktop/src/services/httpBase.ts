// Normalize a desktop server address (`ws://host/ws`, `wss://host/ws`, `http://host`, ...)
// to its HTTP base URL — for one-off browser navigation (e.g. Drive OAuth: openUrl needs a
// real http(s) URL, not the ws:// address workspaces.activeServer stores). Mirrors
// muesli_cli::store::http_base (crates/muesli-cli/src/store.rs) exactly: strip trailing
// slashes, strip a trailing "/ws" path, then map ws-> http / wss -> https.
export function httpBaseOf(server: string): string {
  const trimmed = server.replace(/\/+$/, "");
  const stripped = trimmed.endsWith("/ws") ? trimmed.slice(0, -"/ws".length) : trimmed;
  if (stripped.startsWith("wss://")) return `https://${stripped.slice("wss://".length)}`;
  if (stripped.startsWith("ws://")) return `http://${stripped.slice("ws://".length)}`;
  return stripped;
}
