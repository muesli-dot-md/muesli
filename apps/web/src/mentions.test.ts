import { describe, it, expect } from "vitest";
import {
  detectTrigger,
  filterMembers,
  insertMention,
  chipDeletion,
  renderMentions,
  MENTION_RE,
  type Member,
} from "./mentions";
import { colorFromId } from "./presence";

const members: Member[] = [
  { id: "00000000-0000-0000-0000-0000000000a1", display_name: "Ada Lovelace", kind: "human" },
  { id: "00000000-0000-0000-0000-0000000000b2", display_name: "Alan Turing", kind: "human" },
  { id: "00000000-0000-0000-0000-0000000000c3", display_name: "Grace Hopper", kind: "human" },
];

const tokenFor = (m: Member) => `@[${m.display_name}](muesli:user/${m.id})`;

describe("detectTrigger", () => {
  it("detects an @query immediately before the cursor", () => {
    const text = "hey @ad";
    const r = detectTrigger(text, text.length);
    expect(r).toEqual({ query: "ad", start: 4 });
  });

  it("returns null when there is no @ before the cursor", () => {
    expect(detectTrigger("plain text", 10)).toBeNull();
  });

  it("returns null when whitespace separates the @ from the cursor", () => {
    // "@ada then a space" closes the trigger (a mention query has no spaces)
    expect(detectTrigger("hi @ada done", 12)).toBeNull();
  });

  it("requires the @ to be at a word boundary (not mid-word like an email)", () => {
    expect(detectTrigger("name@host", 9)).toBeNull();
  });

  it("treats a bare @ at the cursor as an empty query", () => {
    const text = "ping @";
    expect(detectTrigger(text, text.length)).toEqual({ query: "", start: 5 });
  });
});

describe("filterMembers", () => {
  it("returns all members for an empty query", () => {
    expect(filterMembers(members, "")).toHaveLength(3);
  });

  it("fuzzy-filters by display_name, case-insensitively", () => {
    const r = filterMembers(members, "al");
    expect(r.map((m) => m.display_name)).toEqual(["Ada Lovelace", "Alan Turing"]);
  });

  it("matches subsequence, not just prefix", () => {
    // "gh" -> Grace Hopper (G..H)
    const r = filterMembers(members, "gh");
    expect(r.map((m) => m.display_name)).toEqual(["Grace Hopper"]);
  });
});

describe("insertMention", () => {
  it("replaces the @query with the chip token and trailing space, moving the cursor past it", () => {
    const text = "hey @ad";
    const out = insertMention(text, text.length, { query: "ad", start: 4 }, members[0]);
    const token = tokenFor(members[0]);
    expect(out.text).toBe(`hey ${token} `);
    expect(out.cursor).toBe(`hey ${token} `.length);
  });

  it("keeps text after the cursor intact", () => {
    const text = "hey @ad!";
    const out = insertMention(text, 7, { query: "ad", start: 4 }, members[0]);
    const token = tokenFor(members[0]);
    expect(out.text).toBe(`hey ${token} !`);
  });
});

describe("chipDeletion (backspace after a chip deletes the whole chip)", () => {
  it("removes the entire chip token when the cursor sits immediately after it", () => {
    const token = tokenFor(members[0]);
    const text = `hey ${token}`;
    const out = chipDeletion(text, text.length);
    expect(out).not.toBeNull();
    expect(out!.text).toBe("hey ");
    expect(out!.cursor).toBe("hey ".length);
  });

  it("returns null when the cursor is not right after a chip", () => {
    expect(chipDeletion("plain word", 10)).toBeNull();
  });

  it("only deletes the chip nearest the cursor, leaving earlier ones", () => {
    const a = tokenFor(members[0]);
    const b = tokenFor(members[1]);
    const text = `${a} and ${b}`;
    const out = chipDeletion(text, text.length);
    expect(out!.text).toBe(`${a} and `);
  });
});

describe("renderMentions", () => {
  it("splits a body into text and chip segments", () => {
    const token = tokenFor(members[0]);
    const segs = renderMentions(`hi ${token} there`);
    expect(segs).toEqual([
      { kind: "text", text: "hi " },
      {
        kind: "chip",
        name: "Ada Lovelace",
        id: members[0].id,
        color: colorFromId(members[0].id).color,
        known: true,
      },
      { kind: "text", text: " there" },
    ]);
  });

  it("uses colorFromId for the chip color (matches presence)", () => {
    const segs = renderMentions(tokenFor(members[1]));
    const chip = segs.find((s) => s.kind === "chip")!;
    expect(chip).toMatchObject({ color: colorFromId(members[1].id).color });
  });

  it("flags an unknown/removed user as a muted chip (known:false)", () => {
    const known = new Set([members[0].id]);
    const segs = renderMentions(`${tokenFor(members[0])} ${tokenFor(members[2])}`, known);
    const chips = segs.filter((s) => s.kind === "chip") as Array<{ known: boolean }>;
    expect(chips.map((c) => c.known)).toEqual([true, false]);
  });

  it("returns a single text segment when there are no chips", () => {
    expect(renderMentions("just words")).toEqual([{ kind: "text", text: "just words" }]);
  });
});

describe("MENTION_RE", () => {
  it("matches a chip token and captures name + id", () => {
    const token = tokenFor(members[2]);
    const m = [...token.matchAll(MENTION_RE)][0];
    expect(m[1]).toBe("Grace Hopper");
    expect(m[2]).toBe(members[2].id);
  });
});
