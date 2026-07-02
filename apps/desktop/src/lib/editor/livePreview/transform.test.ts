import { describe, it, expect } from "vitest";
import { parseTableMarkdown, frontmatterRange } from "$lib/editor/livePreview/transform";

describe("transform", () => {
  it("parseTableMarkdown parses header + rows", () => {
    const t = parseTableMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(t).not.toBeNull();
    // ParsedTable uses `header` (not `headers`)
    expect(t!.header).toEqual(["a", "b"]);
    expect(t!.rows[0]).toEqual(["1", "2"]);
  });
  it("frontmatterRange finds leading YAML block", () => {
    const r = frontmatterRange("---\ntitle: x\n---\nbody");
    expect(r).not.toBeNull();
    expect(r!.from).toBe(0);
  });
  it("frontmatterRange null when no frontmatter", () => {
    expect(frontmatterRange("# just a heading")).toBeNull();
  });
});
