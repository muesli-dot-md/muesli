import { describe, it, expect } from "vitest";
import { docContext } from "./docContext";

describe("docContext", () => {
  it("derives a flat-file slug for a synced doc", () => {
    expect(docContext("/ws/notes.md", "/ws", true)).toEqual({
      slug: "notes",
      isRemote: true,
    });
  });

  it("joins nested path components with '-' (via slug.ts rules)", () => {
    expect(docContext("/ws/sub/deep.md", "/ws", true)).toEqual({
      slug: "sub-deep",
      isRemote: true,
    });
  });

  it("is not remote for a local-only (non-syncing) doc, but still derives a slug", () => {
    expect(docContext("/ws/notes.md", "/ws", false)).toEqual({
      slug: "notes",
      isRemote: false,
    });
  });

  it("falls back to the basename when no workspace root is known", () => {
    expect(docContext("/somewhere/else/Note.md", null, true)).toEqual({
      slug: "note",
      isRemote: true,
    });
  });

  it("returns a null slug for an empty path", () => {
    expect(docContext(null, "/ws", true)).toEqual({ slug: null, isRemote: false });
  });
});
