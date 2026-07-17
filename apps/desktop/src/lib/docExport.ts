// Desktop (Tauri) export delivery for the document toolbar.
//
// The pure HTML builder — `buildHtmlExport` — is shared with the web app in
// @muesli/editor-core/docExport. Only the *delivery* differs: the web app can
// use `<a download>` and `window.open`, but neither works inside a WKWebView.
// So here we deliver via native Tauri APIs instead:
//   - HTML: a native save dialog + a Rust command that writes the chosen path.
//   - PDF:  a Rust command writes the render to a temp file and opens it in the
//           user's default browser, where a load-time `print()` raises the
//           print sheet — the WKWebView can't drive `window.print()`/
//           `window.open` itself, and the opener capability doesn't grant the
//           webview open-path, so this all happens Rust-side.

import { buildHtmlExport } from "@muesli/editor-core/docExport";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { exportFile, printExport } from "$lib/tauri";

/** Drop a trailing extension so a suggested export filename doesn't become
 *  "note.md.html": tab names carry their ".md" (see FileTree), and that name
 *  is what the toolbar passes in as the title. */
function baseName(title: string): string {
  return title.replace(/\.[^/.]+$/, "") || title;
}

/**
 * Export the document as a standalone `.html` file. The native save dialog is
 * opened Rust-side by the `export_file` command (defaulting to `<name>.html`),
 * which writes the render to the chosen location and returns its path; a cancel
 * (null) is a no-op. The path is owned by the OS/user, never supplied by the
 * webview. Reveals the saved file afterwards.
 */
export async function exportHtmlFile(title: string, markdownSrc: string): Promise<void> {
  const base = baseName(title);
  const savedPath = await exportFile(base, buildHtmlExport(base, markdownSrc));
  if (!savedPath) return;
  // Confirm the export landed by revealing it; non-fatal if the OS refuses.
  try {
    await revealItemInDir(savedPath);
  } catch {
    /* reveal is a courtesy — the file is already written */
  }
}

/**
 * "Export → PDF": render the document to a standalone HTML file in a temp dir
 * and open it in the user's default browser, where an injected load handler
 * fires the print sheet so they can "Save as PDF". The write-and-open runs in
 * a Rust command (`print_export`) because the WKWebView can't drive
 * `window.print()`/`window.open` reliably and the opener capability doesn't
 * grant open-path to the webview — but a real browser honors `print()` fine.
 */
export async function printDocument(title: string, markdownSrc: string): Promise<void> {
  const base = baseName(title);
  // Injected only into the PRINT copy (never the saved .html):
  //  - `@page { margin: 0 }` drops the browser's own header/footer band (the
  //    file name, date, URL/path and "page 1/1" it stamps into page margins);
  //    body padding restores readable page margins so text isn't at the edge.
  //  - a load handler auto-raises the browser's print dialog.
  const inject =
    "<style>@page{margin:0}@media print{body{padding:1.5cm 1.2cm}}</style>" +
    "<script>addEventListener('load',function(){print()})</script>";
  const html = buildHtmlExport(base, markdownSrc).replace("</body>", `${inject}</body>`);
  await printExport(base, html);
}
