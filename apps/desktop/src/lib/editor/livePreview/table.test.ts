// @vitest-environment jsdom
//
// Widget-interaction tests for the WYSIWYG TableWidget (sub-project ⑥ B). Mirror
// of apps/web/src/livePreview/table.test.ts — identical behavior, desktop import
// path + literal-string labels. The table renders as a contenteditable grid
// while the cursor is outside it; cell edits and structural mutations dispatch
// regenerated GFM back into the doc, and formula cells render their computed
// value (not the literal `=…` text).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { fenceLanguage, livePreview } from "$lib/editor/livePreview/index";

function mkView(doc: string): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: fenceLanguage }),
        livePreview(),
      ],
    }),
    parent: host,
  });
  return { view, host };
}

const TABLE = ["before", "", "| a | b |", "| --- | --- |", "| 1 | 2 |", "", "after"].join("\n");

let view: EditorView;
let host: HTMLElement;
afterEach(() => {
  view?.destroy();
  host?.remove();
});

describe("TableWidget renders as a WYSIWYG grid", () => {
  beforeEach(() => {
    ({ view, host } = mkView(TABLE));
  });

  it("renders a table widget while the cursor is outside it", () => {
    const grid = view.dom.querySelector(".cm-live-table-grid");
    expect(grid).not.toBeNull();
    expect(grid!.querySelectorAll("th").length).toBe(2);
    expect(grid!.querySelectorAll("tbody tr").length).toBe(1);
  });

  it("exposes editable cells and the resize handle (no floating ×/+ clutter)", () => {
    expect(view.dom.querySelector(".cm-live-cell-editable")).not.toBeNull();
    expect(view.dom.querySelector(".cm-live-col-resize")).not.toBeNull();
    // The old always-visible add/delete controls are gone — replaced by the
    // right-click context menu (no menu is open until a cell is right-clicked).
    expect(view.dom.querySelector(".cm-live-add-row")).toBeNull();
    expect(view.dom.querySelector(".cm-live-add-col")).toBeNull();
    expect(view.dom.querySelector(".cm-live-del-row")).toBeNull();
    expect(view.dom.querySelector(".cm-live-del-col")).toBeNull();
    expect(document.querySelector(".cm-live-table-menu")).toBeNull();
  });
});

describe("column resize handle is reachable and resizes the whole column", () => {
  beforeEach(() => {
    ({ view, host } = mkView(TABLE));
  });

  it("attaches a resize handle per column as a child of the table grid (not just <th>)", () => {
    const grid = view.dom.querySelector<HTMLElement>(".cm-live-table-grid")!;
    const handles = grid.querySelectorAll<HTMLElement>(".cm-live-col-resize");
    expect(handles.length).toBe(2);
    handles.forEach((h) => {
      expect(h.parentElement).toBe(grid);
      expect(h.closest("th")).toBeNull();
    });
  });

  it("pointerdown + move on a handle sets a px width on every cell in that column", () => {
    const grid = view.dom.querySelector<HTMLElement>(".cm-live-table-grid")!;
    const handle = grid.querySelector<HTMLElement>('.cm-live-col-resize[data-col="0"]')!;
    expect(handle).not.toBeNull();

    handle.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 100, pointerId: 1 }),
    );
    handle.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, clientX: 160, pointerId: 1 }),
    );
    handle.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 160, pointerId: 1 }));

    const table = grid as HTMLTableElement;
    for (const row of Array.from(table.rows)) {
      const cell = row.cells[0] as HTMLElement | undefined;
      expect(cell).toBeTruthy();
      expect(cell!.style.width).toMatch(/px$/);
    }
  });
});

// Right-click a cell → assert the context menu opens, then click an item by its
// visible label. The menu is appended to document.body (so it can't be clipped),
// hence the document-level queries.
function rightClick(cell: HTMLElement): void {
  cell.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
  );
}
function menuItem(label: string): HTMLButtonElement {
  const items = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".cm-live-table-menu .cm-live-table-menu-item"),
  );
  const hit = items.find((b) => b.textContent === label);
  if (!hit) throw new Error(`menu item not found: ${label} (have: ${items.map((b) => b.textContent).join(", ")})`);
  return hit;
}

describe("right-click context menu", () => {
  beforeEach(() => {
    ({ view, host } = mkView(TABLE));
  });

  it("opens on contextmenu and lists insert/delete actions", () => {
    const cell = view.dom.querySelector<HTMLElement>("tbody td")!;
    rightClick(cell);
    const menu = document.querySelector(".cm-live-table-menu");
    expect(menu).not.toBeNull();
    const labels = Array.from(
      menu!.querySelectorAll(".cm-live-table-menu-item"),
    ).map((b) => b.textContent);
    expect(labels).toEqual([
      "Insert row above",
      "Insert row below",
      "Insert column left",
      "Insert column right",
      "Delete row",
      "Delete column",
    ]);
  });

  it("dismisses on Escape", () => {
    rightClick(view.dom.querySelector<HTMLElement>("tbody td")!);
    expect(document.querySelector(".cm-live-table-menu")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".cm-live-table-menu")).toBeNull();
  });

  it("dismisses on outside pointerdown", () => {
    rightClick(view.dom.querySelector<HTMLElement>("tbody td")!);
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(document.querySelector(".cm-live-table-menu")).toBeNull();
  });
});

describe("cell edit dispatches regenerated markdown", () => {
  beforeEach(() => {
    ({ view, host } = mkView(TABLE));
  });

  it("editing a body cell rewrites the table source", () => {
    const cell = view.dom.querySelectorAll<HTMLElement>("tbody td")[0];
    cell.dispatchEvent(new FocusEvent("focus"));
    cell.textContent = "99";
    cell.dispatchEvent(new FocusEvent("blur"));
    expect(view.state.doc.toString()).toContain("| 99 | 2 |");
  });

  it("Escape cancels the in-cell edit (no dispatch)", () => {
    const before = view.state.doc.toString();
    const cell = view.dom.querySelector<HTMLElement>("tbody td")!;
    cell.dispatchEvent(new FocusEvent("focus"));
    cell.textContent = "changed";
    cell.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    cell.dispatchEvent(new FocusEvent("blur"));
    expect(view.state.doc.toString()).toBe(before);
  });
});

describe("context-menu insert/delete dispatches correct markdown", () => {
  // A 2-body-row table so insert-above/below and delete are distinguishable.
  const T2 = ["before", "", "| a | b |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |", "", "after"].join(
    "\n",
  );
  beforeEach(() => {
    ({ view, host } = mkView(T2));
  });

  it("insert row above the first body row", () => {
    rightClick(view.dom.querySelectorAll<HTMLElement>("tbody td")[0]); // row 0, "1"
    menuItem("Insert row above").click();
    const doc = view.state.doc.toString();
    expect(doc).toMatch(/\| --- \| --- \|\n\|  \|  \|\n\| 1 \| 2 \|/);
    expect(document.querySelector(".cm-live-table-menu")).toBeNull(); // closes after choice
  });

  it("insert row below the first body row", () => {
    rightClick(view.dom.querySelectorAll<HTMLElement>("tbody td")[0]); // row 0
    menuItem("Insert row below").click();
    expect(view.state.doc.toString()).toMatch(/\| 1 \| 2 \|\n\|  \|  \|\n\| 3 \| 4 \|/);
  });

  it("insert column left of the clicked column", () => {
    rightClick(view.dom.querySelectorAll<HTMLElement>("tbody td")[1]); // col 1 ("b")
    menuItem("Insert column left").click();
    expect(view.state.doc.toString()).toContain("| 1 |  | 2 |"); // new empty col between a and b
  });

  it("insert column right of the clicked column", () => {
    rightClick(view.dom.querySelectorAll<HTMLElement>("tbody td")[1]); // col 1 ("b")
    menuItem("Insert column right").click();
    expect(view.state.doc.toString()).toContain("| 1 | 2 |  |");
  });

  it("delete row removes the clicked body row (not the other)", () => {
    rightClick(view.dom.querySelectorAll<HTMLElement>("tbody td")[0]); // row 0, "1"
    menuItem("Delete row").click();
    const doc = view.state.doc.toString();
    expect(doc).not.toContain("| 1 | 2 |");
    expect(doc).toContain("| 3 | 4 |");
    expect(doc).toContain("| a | b |"); // header + separator survive
    expect(doc).toContain("| --- | --- |");
  });

  it("delete column removes the clicked column", () => {
    rightClick(view.dom.querySelectorAll<HTMLElement>("tbody td")[0]); // col 0 ("a")
    menuItem("Delete column").click();
    const doc = view.state.doc.toString();
    expect(doc).toContain("| b |");
    expect(doc).not.toContain("| a | b |");
    expect(doc).toContain("| --- |"); // separator intact for surviving col
  });
});

describe("write-back range survives multi-byte/astral content before the table", () => {
  // Regression guard for the cell-edit write-back math in widgets.ts:
  //   from = view.posAtDOM(div); to = from + source.length
  // This is only correct because CodeMirror positions and JS string `.length`
  // are both UTF-16 code units. If `to` were computed in a unit that disagrees
  // with the surrounding text's encoding, astral chars (emoji = 2 code units)
  // or accented chars before/after the table would shift the range and the
  // dispatch would truncate adjacent prose or eat into the wrong span. Edit a
  // cell and assert the surrounding text stays byte-for-byte intact.
  const BEFORE = "héllo 😀\n\nworld 🎉";
  const AFTER = "tàil 🚀";
  const MB_TABLE = [BEFORE, "", "| a | b |", "| --- | --- |", "| 1 | 2 |", "", AFTER].join("\n");

  it("editing a cell leaves the emoji/accented text before and after intact", () => {
    ({ view, host } = mkView(MB_TABLE));
    const cell = view.dom.querySelectorAll<HTMLElement>("tbody td")[0];
    cell.dispatchEvent(new FocusEvent("focus"));
    cell.textContent = "99";
    cell.dispatchEvent(new FocusEvent("blur"));
    const doc = view.state.doc.toString();
    // (a) text BEFORE the table is byte-for-byte intact, with nothing eaten off
    // its tail (the `from` boundary lands exactly at the table start despite the
    // astral chars in BEFORE shifting code-point vs code-unit offsets).
    expect(doc.startsWith(BEFORE + "\n\n")).toBe(true);
    // (b) text AFTER the table is intact, with no leftover table source spilled
    // ahead of it (the `to` boundary lands exactly at the table end — an
    // off-by-N `to` would leave stray `| … |` fragments before AFTER).
    expect(doc.endsWith("\n\n" + AFTER)).toBe(true);
    // (c) the table block between them is EXACTLY the regenerated GFM — no
    // truncation, no trailing junk. Slicing the doc to just the table span and
    // comparing to the expected table proves `from`/`to` bound it precisely.
    const tableSpan = doc.slice(BEFORE.length + 2, doc.length - (AFTER.length + 2));
    expect(tableSpan).toBe(["| a | b |", "| --- | --- |", "| 99 | 2 |"].join("\n"));
  });
});

describe("formula cells", () => {
  const FORMULA_TABLE = [
    "intro",
    "",
    "| item | qty |",
    "| --- | --- |",
    "| a | 2 |",
    "| b | 3 |",
    "| total | =SUM(B1:B2) |",
    "",
    "end",
  ].join("\n");

  it("renders the computed value, not the literal formula", () => {
    ({ view, host } = mkView(FORMULA_TABLE));
    const valueEl = view.dom.querySelector(".cm-live-formula-value");
    expect(valueEl).not.toBeNull();
    expect(valueEl!.textContent).toBe("5");
    expect(view.dom.querySelector(".cm-live-table-grid")!.textContent).not.toContain("=SUM");
  });

  it("renders an error chip for a malformed formula", () => {
    const bad = ["intro", "", "| x |", "| --- |", "| =SUM( |", "", "end"].join("\n");
    ({ view, host } = mkView(bad));
    const chip = view.dom.querySelector(".cm-live-formula-error");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe("#ERR");
  });
});
