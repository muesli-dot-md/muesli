import { describe, it, expect } from "vitest";
import { deriveSlug } from "./slug";

describe("deriveSlug", () => {
  it("joins nested path components with '-' and slugifies", () => {
    expect(deriveSlug("sub/Deep Note.md")).toBe("sub-deep-note");
  });

  it("strips the .md extension on a flat file", () => {
    expect(deriveSlug("a.md")).toBe("a");
  });

  it("lowercases and dashes spaces", () => {
    expect(deriveSlug("Meeting Notes.md")).toBe("meeting-notes");
  });

  it("falls back to 'untitled' on empty input", () => {
    expect(deriveSlug("")).toBe("untitled");
  });

  it("trims leading/trailing punctuation", () => {
    expect(deriveSlug("!!!Hello!!!.md")).toBe("hello");
  });

  it("collapses runs of punctuation to a single dash", () => {
    expect(deriveSlug("Weird  Näme!!.md")).toBe("weird-n-me");
  });

  it("handles a slug that becomes empty after slugify", () => {
    expect(deriveSlug("---.md")).toBe("untitled");
  });

  it("matches the Rust multi-level example", () => {
    expect(deriveSlug("a/b/c file.MD")).toBe("a-b-c-file");
  });
});
