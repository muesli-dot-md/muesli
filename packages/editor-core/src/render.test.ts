import { describe, it, expect, beforeAll } from "vitest";
import {
  renderMarkdown,
  slugify,
  setSanitizer,
  PURIFY_CONFIG,
  SVG_PURIFY_CONFIG,
  KATEX_TRUST,
} from "./render";
// Structural type: enough of the bound DOMPurify instance for these tests.
let purify: { sanitize: (html: string, cfg?: object) => string };

// In the node test environment DOMPurify.isSupported is false (no DOM).
// We inject a real sanitizer backed by a jsdom window so the <script>-strip
// assertion is a genuine security check, not a vacuous passthrough.
beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const { window: jsdomWindow } = new JSDOM("");
  // dompurify is a CJS/ESM hybrid; grab the factory and bind it to jsdom's window.
  const { default: DOMPurify } = await import("dompurify");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  purify = DOMPurify(jsdomWindow as any);
  setSanitizer((html) => purify.sanitize(html, PURIFY_CONFIG));
});

describe("renderMarkdown", () => {
  it("renders a heading", () => {
    expect(renderMarkdown("# Hello")).toContain("<h1");
  });
  it("sanitizes script tags", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).not.toContain("<script");
  });
  it("renders ==highlight== as a mark", () => {
    expect(renderMarkdown("==hi==")).toContain("<mark");
  });
  it("renders a [[wikilink]] as an anchor", () => {
    const html = renderMarkdown("[[My Note]]");
    expect(html).toContain("wikilink");
    expect(html.toLowerCase()).toContain("my-note");
  });
  it("renders a GitHub callout into an alert block", () => {
    expect(renderMarkdown("> [!NOTE]\n> hi")).toContain("callout");
  });
  it("renders inline math via katex", () => {
    expect(renderMarkdown("$x^2$")).toContain("katex");
  });
  it("returns a string and never throws on bad input", () => {
    expect(typeof renderMarkdown("> [!\n$$\\bad")).toBe("string");
  });
  it("empty input → empty-ish string", () => {
    expect(renderMarkdown("")).toBe("");
  });

  it("renders a GFM table", () => {
    const html = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("<td");
  });

  it("computes a formula cell in the reading view (not the literal text)", () => {
    // Body rows are numbered from 1 (header excluded): B1=2, B2=3 → SUM = 5.
    const md = [
      "| item | qty |",
      "| --- | --- |",
      "| a | 2 |",
      "| b | 3 |",
      "| total | =SUM(B1:B2) |",
    ].join("\n");
    const html = renderMarkdown(md);
    expect(html).toContain("cm-live-formula-value");
    expect(html).toContain(">5<"); // 2 + 3
    expect(html).not.toContain("=SUM");
  });

  it("renders an error chip for a malformed formula in the reading view", () => {
    const html = renderMarkdown(["| x |", "| --- |", "| =SUM( |"].join("\n"));
    expect(html).toContain("cm-live-formula-error");
    expect(html).toContain("#ERR");
  });
});

// Regression guards for security review finding 32: the live-preview widgets
// and mermaid injection lean on these settings staying locked down.
describe("finding 32 regression guards", () => {
  it("KATEX_TRUST stays false (trust:true would enable \\href/\\html* output)", () => {
    expect(KATEX_TRUST).toBe(false);
  });

  it("katex \\href does not emit a javascript: link", () => {
    // With trust:false KaTeX refuses \href and renders the source as error
    // TEXT — the payload may appear escaped in text content, but must never
    // become a live href attribute.
    const html = renderMarkdown("$\\href{javascript:alert(1)}{click}$");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("href='javascript:");
  });

  it("PURIFY_CONFIG strips scripts but keeps KaTeX MathML", () => {
    expect(
      purify.sanitize(
        "<math><semantics><annotation encoding='x'>t</annotation></semantics></math><script>1</script>",
        PURIFY_CONFIG,
      ),
    ).not.toContain("<script");
    const math = purify.sanitize(renderMarkdown("$x^2$"), PURIFY_CONFIG);
    expect(math).toContain("<math");
    expect(math).toContain("annotation");
  });

  it("SVG_PURIFY_CONFIG keeps mermaid foreignObject labels but sanitizes their content", () => {
    const svg =
      `<svg><g><foreignObject width="10" height="10">` +
      `<div xmlns="http://www.w3.org/1999/xhtml">label<script>alert(1)</script>` +
      `<img src=x onerror="alert(1)"></div></foreignObject></g></svg>`;
    const out = purify.sanitize(svg, SVG_PURIFY_CONFIG);
    expect(out).toContain("foreignObject");
    expect(out).toContain("label");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onerror");
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("My Note")).toBe("my-note");
  });
});
