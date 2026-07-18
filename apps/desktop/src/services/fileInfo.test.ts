import { describe, it, expect } from "vitest";
import { formatBytes, formatTimestamp, collectFolderTargets } from "./fileInfo";
import type { WorkspaceNode } from "./tauri";

describe("formatBytes", () => {
  it("formats bytes under 1KB verbatim", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats KB/MB with one decimal", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });

  it("returns a dash for invalid sizes", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(NaN)).toBe("—");
  });
});

describe("formatTimestamp", () => {
  it("returns a dash for null", () => {
    expect(formatTimestamp(null)).toBe("—");
    expect(formatTimestamp(undefined)).toBe("—");
  });

  it("formats a real timestamp to a non-empty string", () => {
    const s = formatTimestamp(Date.UTC(2026, 0, 15, 12, 0));
    expect(s).not.toBe("—");
    expect(s.length).toBeGreaterThan(0);
  });
});

// ── collectFolderTargets ────────────────────────────────────────────────────

const ROOT = "/ws";

function n(path: string, isDir: boolean, children?: WorkspaceNode[]): WorkspaceNode {
  return { name: path.split("/").at(-1) ?? path, path, isDir, children };
}

// /ws
//   /ws/a          (dir)
//     /ws/a/sub    (dir)
//   /ws/b          (dir)
//   /ws/note.md    (file)
function tree(): WorkspaceNode {
  return n("/ws", true, [
    n("/ws/a", true, [n("/ws/a/sub", true, [])]),
    n("/ws/b", true, []),
    n("/ws/note.md", false),
  ]);
}

describe("collectFolderTargets", () => {
  it("lists the root and all folders for a root-level file", () => {
    const targets = collectFolderTargets(tree(), ROOT, "/ws/note.md");
    expect(targets.map((t) => t.path)).toEqual(["/ws/a", "/ws/a/sub", "/ws/b"]);
    // root excluded — note.md already lives in the root (no-op).
  });

  it("excludes the source folder, its descendants, and its current parent", () => {
    // Moving /ws/a: exclude /ws (parent), /ws/a (self), /ws/a/sub (descendant).
    const targets = collectFolderTargets(tree(), ROOT, "/ws/a");
    expect(targets.map((t) => t.path)).toEqual(["/ws/b"]);
  });

  it("offers the workspace root when the source is nested", () => {
    const targets = collectFolderTargets(tree(), ROOT, "/ws/a/sub");
    // src is /ws/a/sub: parent /ws/a excluded; root + /ws/b allowed.
    expect(targets.map((t) => t.path)).toEqual(["/ws", "/ws/b"]);
    expect(targets[0].label).toBe("ws"); // root uses its workspace name
    expect(targets[0].depth).toBe(0);
  });

  it("uses workspace-relative labels with depth for indentation", () => {
    const targets = collectFolderTargets(tree(), ROOT, "/ws/note.md");
    const sub = targets.find((t) => t.path === "/ws/a/sub")!;
    expect(sub.label).toBe("a/sub");
    expect(sub.depth).toBe(2);
  });
});
