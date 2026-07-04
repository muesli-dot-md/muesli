// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- mocks (registered before the module under test is imported) -----------

const save = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => save(...args),
}));

const revealItemInDir = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: (...args: unknown[]) => revealItemInDir(...args),
}));

const writeExportFile = vi.fn();
const printExport = vi.fn();
vi.mock("$lib/tauri", () => ({
  writeExportFile: (...args: unknown[]) => writeExportFile(...args),
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
  save.mockReset();
  revealItemInDir.mockReset().mockResolvedValue(undefined);
  writeExportFile.mockReset().mockResolvedValue(undefined);
  printExport.mockReset().mockResolvedValue(undefined);
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("exportHtmlFile", () => {
  it("writes the built HTML to the chosen path and reveals it", async () => {
    save.mockResolvedValue("/tmp/My Note.html");

    await exportHtmlFile("My Note", "# hi");

    expect(save).toHaveBeenCalledWith({
      defaultPath: "My Note.html",
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    expect(writeExportFile).toHaveBeenCalledWith(
      "/tmp/My Note.html",
      "<html><!--My Note--><body># hi</body></html>", // buildHtmlExport(base, src)
    );
    expect(revealItemInDir).toHaveBeenCalledWith("/tmp/My Note.html");
  });

  it("defaults to a .html name, stripping the tab's .md extension", async () => {
    save.mockResolvedValue(null); // don't care about the write path here

    await exportHtmlFile("untitled.md", "# hi");

    expect(save).toHaveBeenCalledWith({
      defaultPath: "untitled.html", // NOT untitled.md.html
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
  });

  it("is a no-op when the user cancels the save dialog", async () => {
    save.mockResolvedValue(null);

    await exportHtmlFile("My Note", "# hi");

    expect(writeExportFile).not.toHaveBeenCalled();
    expect(revealItemInDir).not.toHaveBeenCalled();
  });

  it("still succeeds if revealing the file fails", async () => {
    save.mockResolvedValue("/tmp/note.html");
    revealItemInDir.mockRejectedValue(new Error("no file manager"));

    await expect(exportHtmlFile("note", "x")).resolves.toBeUndefined();
    expect(writeExportFile).toHaveBeenCalledTimes(1);
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
