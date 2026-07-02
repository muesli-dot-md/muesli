// Doc-slug derivation, replicating muesli-cli's `slug_from_rel_path` + `slugify`
// (crates/muesli-cli/src/sync.rs) EXACTLY, so Muesli and `muesli sync`
// agree on which websocket room a given file maps to.
//
// Rules (no --prefix here):
//   1. Join the path components with '-'  (split on '/', drop empties).
//   2. If the result ends with ".md" (case-insensitive, len >= 3), strip it.
//   3. slugify: keep ASCII alphanumerics lowercased; every run of anything
//      else collapses to a single '-', with NO leading/trailing dash.
//   4. Empty result -> "untitled".

function slugify(s: string): string {
  let out = "";
  let pendingDash = false;
  for (const ch of s) {
    if (/[A-Za-z0-9]/.test(ch)) {
      if (pendingDash && out.length > 0) out += "-";
      pendingDash = false;
      out += ch.toLowerCase();
    } else {
      pendingDash = true;
    }
  }
  return out;
}

export function deriveSlug(relPath: string): string {
  // Join components with '-' (Rust iterates Component::Normal; splitting on '/'
  // and dropping empty segments matches that for ordinary relative paths).
  let raw = relPath
    .split("/")
    .filter((seg) => seg.length > 0)
    .join("-");

  // Strip a trailing ".md" (case-insensitive), mirroring the Rust truncate.
  if (raw.length >= 3 && raw.slice(-3).toLowerCase() === ".md") {
    raw = raw.slice(0, -3);
  }

  const body = slugify(raw);
  return body.length === 0 ? "untitled" : body;
}
