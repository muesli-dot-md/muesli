// Leading-YAML-frontmatter detection, shared by mdCommands (list/block
// transforms must not touch metadata) and the apps' live-preview transform
// (which suppresses decoration inside the range and styles it as dim
// metadata). Lezer has no frontmatter notion — the --- fences parse as
// setext/thematic-break noise — so this is a plain regex over the doc head.

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Same {from, to} shape as render.ts ranges (UTF-16 offsets). */
export function frontmatterRange(docText: string): { from: number; to: number } | null {
  const m = FRONTMATTER.exec(docText);
  return m ? { from: 0, to: m[0].length } : null;
}
