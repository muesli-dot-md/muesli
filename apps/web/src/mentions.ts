// shared-core candidate (sub-project ①): keep this file byte-identical with
// apps/desktop/src/lib/collab/mentions.ts (like presence.ts).
//
// @mention support for comment composers (sub-project ④b). A mention is the literal
// token `@[Display Name](muesli:user/<uuid>)` stored verbatim in a comment/reply body;
// the SERVER re-parses it authoritatively (crates/muesli-server/src/mentions.rs) and
// writes the mention records. The client side here is pure text<->cursor logic so it can
// drive any composer (textarea/input) and be unit-tested without a DOM:
//   - detectTrigger:  is the caret in an active "@query"?
//   - filterMembers:  fuzzy member picker (filter by display_name)
//   - insertMention:  replace the "@query" with the chip token at the caret
//   - chipDeletion:   backspace right after a chip removes the WHOLE chip atomically
//   - renderMentions: post-process a stored body into chip segments for display
//
// colorFromId (presence.ts, sub-project ⑤) is the single source of per-user color; the
// renderer reuses it so a mention chip matches the person's presence color everywhere.
import { colorFromId } from "./presence";

export type Member = {
  id: string;
  display_name: string | null;
  avatar_url?: string | null;
  kind: string;
};

/** Build the literal mention token a chip serializes to. */
export function mentionToken(member: Member): string {
  return `@[${member.display_name ?? ""}](muesli:user/${member.id})`;
}

/** Matches a chip token, capturing (1) the display label and (2) the user uuid. Global so
 *  callers can iterate every chip in a body. The label is any run without `]`. */

export const MENTION_RE = /@\[([^\]]*)\]\(muesli:user\/([0-9a-fA-F-]{36})\)/g;

export type Trigger = { query: string; start: number };

/**
 * If the caret sits inside an active `@query` (an `@` at a word boundary, followed by
 * non-whitespace, no intervening space, up to the caret), return that query and the index
 * of the `@`. Otherwise null. A query never contains whitespace — a space closes it.
 */
export function detectTrigger(text: string, cursor: number): Trigger | null {
  // Walk back from the caret to the nearest `@` without crossing whitespace.
  let i = cursor - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "@") break;
    if (/\s/.test(ch)) return null; // whitespace closes any query
    i--;
  }
  if (i < 0 || text[i] !== "@") return null;
  // The `@` must be at a word boundary (start, or after whitespace) — not mid-word like
  // an email address ("name@host").
  const before = i === 0 ? "" : text[i - 1];
  if (before && !/\s/.test(before)) return null;
  return { query: text.slice(i + 1, cursor), start: i };
}

/** True if every char of `needle` appears in order within `hay` (subsequence match). */
function fuzzyMatch(hay: string, needle: string): boolean {
  let h = 0;
  for (let n = 0; n < needle.length; n++) {
    const c = needle[n];
    while (h < hay.length && hay[h] !== c) h++;
    if (h >= hay.length) return false;
    h++;
  }
  return true;
}

/** Members whose display_name fuzzily matches `query` (case-insensitive subsequence),
 *  preserving input order. Empty query returns all. */
export function filterMembers(members: Member[], query: string): Member[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...members];
  return members.filter((m) => fuzzyMatch((m.display_name ?? "").toLowerCase(), q));
}

export type Edit = { text: string; cursor: number };

/** Replace the active `@query` (from `trigger.start` to `cursor`) with the member's chip
 *  token plus a trailing space, returning the new text and caret position. */
export function insertMention(
  text: string,
  cursor: number,
  trigger: Trigger,
  member: Member,
): Edit {
  const token = mentionToken(member);
  const head = text.slice(0, trigger.start);
  const tail = text.slice(cursor);
  const inserted = `${token} `;
  return { text: head + inserted + tail, cursor: head.length + inserted.length };
}

/**
 * If a chip token ends exactly at the caret, return the body with that whole chip removed
 * (atomic delete-on-backspace). Otherwise null, so the caller falls back to a normal
 * single-character backspace.
 */
export function chipDeletion(text: string, cursor: number): Edit | null {
  const head = text.slice(0, cursor);
  // Re-scan from the start; the LAST chip ending at the caret is the one to remove.
  const re = new RegExp(MENTION_RE.source, "g");
  let match: RegExpExecArray | null;
  let found: { start: number; end: number } | null = null;
  while ((match = re.exec(head)) !== null) {
    const end = match.index + match[0].length;
    if (end === cursor) found = { start: match.index, end };
  }
  if (!found) return null;
  return { text: text.slice(0, found.start) + text.slice(found.end), cursor: found.start };
}

export type MentionSegment =
  | { kind: "text"; text: string }
  | { kind: "chip"; name: string; id: string; color: string; known: boolean };

/**
 * Split a stored body into plain-text and chip segments for rendering. A chip whose id is
 * not in `knownIds` is flagged `known: false` so the UI can render it muted (removed user).
 * Color comes from colorFromId (sub-project ⑤) — the single source of per-user color.
 */
export function renderMentions(body: string, knownIds?: Set<string>): MentionSegment[] {
  const out: MentionSegment[] = [];
  const re = new RegExp(MENTION_RE.source, "g");
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    if (match.index > last) out.push({ kind: "text", text: body.slice(last, match.index) });
    const [, name, id] = match;
    const known = knownIds ? knownIds.has(id) : true;
    out.push({ kind: "chip", name, id, color: colorFromId(id).color, known });
    last = match.index + match[0].length;
  }
  if (last < body.length) out.push({ kind: "text", text: body.slice(last) });
  return out;
}
