// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- mocks (registered before the module under test is imported) -----------

const revealItemInDir = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: (...args: unknown[]) => revealItemInDir(...args),
}));

// `export_file` owns the native save dialog Rust-side: it takes (name, contents)
// and returns the chosen path (or null on cancel). There is no JS-supplied path.
const exportFile = vi.fn();
const printExport = vi.fn();
vi.mock("$lib/tauri", () => ({
  exportFile: (...args: unknown[]) => exportFile(...args),
  printExport: (...args: unknown[]) => printExport(...args),
}));

// Deterministic, side-effect-free HTML builder stand-in for the shared one.
// Includes a </body> so the print path's auto-print injection has an anchor.
vi.mock("@muesli/editor-core/docExport", () => ({
  buildHtmlExport: (title: string, src: string) =>
    `<html><!--${title}--><body>${src}</body></html>`,
}));

import { exportHtmlFile, printDocument } from "./docExport";

beforeEach(() => {
  revealItemInDir.mockReset().mockResolvedValue(undefined);
  exportFile.mockReset().mockResolvedValue(null);
  printExport.mockReset().mockResolvedValue(undefined);
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("exportHtmlFile", () => {
  it("passes the base name + built HTML to export_file and reveals the saved path", async () => {
    exportFile.mockResolvedValue("/tmp/My Note.html");

    await exportHtmlFile("My Note", "# hi");

    // The command receives only (name, contents) — never a path chosen in JS.
    expect(exportFile).toHaveBeenCalledWith(
      "My Note",
      "<html><!--My Note--><body># hi</body></html>", // buildHtmlExport(base, src)
    );
    expect(revealItemInDir).toHaveBeenCalledWith("/tmp/My Note.html");
  });

  it("strips the tab's .md extension from the export base name", async () => {
    exportFile.mockResolvedValue("/tmp/untitled.html");

    await exportHtmlFile("untitled.md", "# hi");

    // base name is "untitled" (Rust appends .html for the dialog default).
    expect(exportFile.mock.calls[0][0]).toBe("untitled");
  });

  it("is a no-op when the user cancels the save dialog", async () => {
    exportFile.mockResolvedValue(null);

    await exportHtmlFile("My Note", "# hi");

    expect(revealItemInDir).not.toHaveBeenCalled();
  });

  it("still succeeds if revealing the file fails", async () => {
    exportFile.mockResolvedValue("/tmp/note.html");
    revealItemInDir.mockRejectedValue(new Error("no file manager"));

    await expect(exportHtmlFile("note", "x")).resolves.toBeUndefined();
    expect(exportFile).toHaveBeenCalledTimes(1);
  });
});

describe("printDocument", () => {
  it("sends the document HTML with an injected auto-print to the Rust opener", async () => {
    await printDocument("Doc", "body text");

    expect(printExport).toHaveBeenCalledTimes(1);
    const [name, html] = printExport.mock.calls[0];
    expect(name).toBe("Doc");
    expect(html).toContain("body text");
    expect(html).toContain("<!--Doc-->");
    // The print copy auto-raises the browser's print dialog on load…
    expect(html).toContain("print()");
    // …suppresses the browser's own header/footer chrome (name/date/url/page)…
    expect(html).toContain("@page{margin:0}");
    // …and it must never leave a print iframe in the app document.
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("strips the tab's .md extension from the temp file name", async () => {
    await printDocument("untitled.md", "x");

    expect(printExport.mock.calls[0][0]).toBe("untitled");
  });
});
