// DOM wiring that turns a parsed GFM table into a WYSIWYG-editable surface,
// shared by both apps' live-preview TableWidget. The pure model lives in
// tableModel.ts; this module owns the DOM: contenteditable cells, formula
// rendering, a Quip-style right-click structural context menu (insert/delete
// rows & columns), and transient column resize.
//
// Canonical-markdown invariant (ADR 0001/0004): the ONLY thing ever written
// back is GFM pipe-table markdown produced by tableMarkdownFromParsed. Column
// widths and the in-cell edit buffer are transient and never touch the doc.
//
// The module is view-agnostic. It calls `onCommit(newMarkdown)` whenever a cell
// edit or a structural mutation produces a new table; the app's widget resolves
// the table's source range (via the CodeMirror view) and dispatches the replace.
// Rendering markdown for a cell is delegated via `renderCell` so each app reuses
// its own sanitized renderMarkdown (and we avoid a hard render.ts dependency in
// jsdom tests). Formula evaluation is built in (pure, from tableModel).

import {
  evalTableFormula,
  formatFormulaValue,
  isFormula,
  isFormulaError,
  setCell,
  insertRow,
  removeRow,
  insertColumn,
  removeColumn,
  tableMarkdownFromParsed,
  type Align,
  type CellPos,
  type ParsedTable,
} from "./tableModel";

export interface TableLabels {
  /** Right-click context-menu items (Quip-style). */
  insertRowAbove: string;
  insertRowBelow: string;
  insertColumnLeft: string;
  insertColumnRight: string;
  deleteRow: string;
  deleteColumn: string;
  resizeColumn: string;
  formulaError: string;
}

export interface TableInteractionOptions {
  /** Render a non-formula cell's raw markdown to sanitized HTML (app-provided). */
  renderCell: (raw: string) => string;
  /** Called with the full regenerated table markdown after any edit/mutation. */
  onCommit: (markdown: string) => void;
  /** Localized (web) or literal (desktop) control labels. */
  labels: TableLabels;
  /** True while the doc is read-only (suggest mode): editing is suppressed. */
  readOnly?: boolean;
}

const alignStyle: Record<string, string> = {
  left: "left",
  center: "center",
  right: "right",
};

/** Body grid position for a cell → A1 CellPos: body rows are 0-based; the header
 * uses the sentinel row -1 (the header is excluded from A1 numbering). */
function gridPos(headerRow: boolean, bodyRow: number, col: number): CellPos {
  return { row: headerRow ? -1 : bodyRow, col };
}

/**
 * Build a WYSIWYG-editable `<table>` from a parsed table and append it (plus
 * hover controls) into `root` (the `.cm-live-table` container). Returns nothing;
 * all state is captured in the closure and torn down with the DOM when CM
 * replaces the widget.
 *
 * `widths` is a shared transient map (column index → px) owned by the widget
 * instance so resize survives the cheap selection-driven widget rebuilds within
 * a single instance lifetime (it resets on a source edit, which makes a new
 * widget — exactly the "transient, never in markdown" behavior the design wants).
 */
export function buildTableWidget(
  root: HTMLElement,
  parsed: ParsedTable,
  opts: TableInteractionOptions,
  widths?: Map<number, number>,
): void {
  const { renderCell, onCommit, labels } = opts;
  const readOnly = opts.readOnly ?? false;
  const colWidths = widths ?? new Map<number, number>();

  const table = document.createElement("table");
  table.className = "cm-live-table-grid";

  const applyWidth = (cell: HTMLTableCellElement, col: number) => {
    const w = colWidths.get(col);
    if (w !== undefined) cell.style.width = `${w}px`;
  };

  // Render one cell's display content: a formula shows its computed value (or an
  // error chip); everything else renders as inline markdown.
  const renderInto = (cell: HTMLTableCellElement, raw: string, self: CellPos) => {
    cell.textContent = "";
    if (isFormula(raw)) {
      const result = evalTableFormula(raw, parsed, self);
      if (isFormulaError(result)) {
        const chip = document.createElement("span");
        chip.className =
          "cm-live-formula-error badge badge-sm badge-error gap-1 align-middle";
        chip.textContent = "#ERR";
        chip.title = `${labels.formulaError}: ${result.message}`;
        cell.appendChild(chip);
      } else {
        const val = document.createElement("span");
        val.className = "cm-live-formula-value";
        val.textContent = formatFormulaValue(result);
        val.title = raw.trim();
        cell.appendChild(val);
      }
    } else {
      // Sanitized inline markdown (bold/links/code) like the rest of the doc.
      cell.innerHTML = renderCell(raw);
    }
  };

  // Commit a cell edit: read the contenteditable's plain text, rebuild the
  // model, regenerate markdown, hand it to the app. Formula cells keep their
  // literal `=…` text (the user typed the value, but for formulas we keep the
  // raw — see the edit-mode swap below).
  const commitCell = (headerRow: boolean, bodyRow: number, col: number, value: string) => {
    const next = setCell(parsed, headerRow ? -1 : bodyRow, col, value);
    onCommit(tableMarkdownFromParsed(next));
  };

  const makeCell = (
    tag: "th" | "td",
    raw: string,
    col: number,
    headerRow: boolean,
    bodyRow: number,
  ): HTMLTableCellElement => {
    const cell = document.createElement(tag) as HTMLTableCellElement;
    const self = gridPos(headerRow, bodyRow, col);
    const align = parsed.align[col];
    if (align && alignStyle[align]) cell.style.textAlign = alignStyle[align];
    applyWidth(cell, col);
    renderInto(cell, raw, self);

    if (!readOnly) {
      cell.classList.add("cm-live-cell-editable");
      // The raw editing buffer: while editing a cell we show its RAW text
      // (so formulas are editable), not the rendered value.
      let editing = false;
      let original = raw;

      const enterEdit = () => {
        if (editing) return;
        editing = true;
        original = raw;
        cell.textContent = raw; // show raw text for editing
        cell.setAttribute("contenteditable", "plaintext-only");
      };
      const finishEdit = (cancel: boolean) => {
        if (!editing) return;
        editing = false;
        cell.removeAttribute("contenteditable");
        const value = cancel ? original : (cell.textContent ?? "");
        if (cancel || value === original) {
          renderInto(cell, original, self); // restore display
          return;
        }
        commitCell(headerRow, bodyRow, col, value);
      };

      cell.addEventListener("focus", enterEdit);
      cell.addEventListener("blur", () => finishEdit(false));
      cell.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          cell.blur(); // triggers finishEdit(false)
        } else if (e.key === "Escape") {
          e.preventDefault();
          finishEdit(true);
          cell.blur();
        }
      });
      // Coerce pasted rich content to plain text so HTML can't corrupt the cell.
      cell.addEventListener("paste", (e: ClipboardEvent) => {
        e.preventDefault();
        const text = e.clipboardData?.getData("text/plain") ?? "";
        const flat = text.replace(/\r?\n/g, " ");
        if (typeof document.execCommand === "function") {
          document.execCommand("insertText", false, flat);
        } else {
          cell.textContent = (cell.textContent ?? "") + flat;
        }
      });
      // A cell is focusable so it can enter edit mode on click.
      cell.tabIndex = 0;
      // Right-click → Quip-style structural context menu, scoped to THIS cell.
      cell.addEventListener("contextmenu", (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(e.clientX, e.clientY, headerRow, bodyRow, col);
      });
    }
    return cell;
  };

  // --- header ---------------------------------------------------------------
  const thead = table.createTHead();
  const headRow = thead.insertRow();
  parsed.header.forEach((text, col) => {
    headRow.appendChild(makeCell("th", text, col, true, 0));
  });

  // --- body -----------------------------------------------------------------
  const tbody = table.createTBody();
  parsed.rows.forEach((row, bodyRow) => {
    const tr = tbody.insertRow();
    parsed.header.forEach((_, col) => {
      tr.appendChild(makeCell("td", row[col] ?? "", col, false, bodyRow));
    });
  });

  root.appendChild(table);
  root.classList.add("cm-live-table-wysiwyg");

  // Rendered cell links must not navigate; clicking enters edit / moves cursor.
  table.addEventListener("click", (e) => {
    if ((e.target as HTMLElement | null)?.closest("a")) e.preventDefault();
  });

  if (readOnly) return; // suggest mode: no structural controls, no resize

  // --- column resize handles (transient widths) -----------------------------
  // One grabbable strip per column, straddling that column's RIGHT edge and
  // spanning the FULL table height (not just the header cell). Earlier this was
  // a handle on each <th> only, so a body-cell border grab did nothing — the
  // user "sometimes" hit the thin header strip and "sometimes" missed, which
  // was the inconsistent-resize bug. The handles are absolutely positioned
  // against the <table> (position:relative) so they overlay every row.
  //
  // Dragging sets a px width on every cell in that column and records it in
  // `colWidths` so the next within-instance rebuild keeps it. Widths stay
  // transient — never written to markdown (a source edit makes a fresh widget
  // with an empty map, per the canonical-markdown invariant).
  const colCount = parsed.header.length;
  const headerCells = Array.from(headRow.querySelectorAll("th")) as HTMLElement[];
  const handles: HTMLElement[] = [];

  // Reposition each handle over its column's right border. Called after every
  // layout-affecting change (initial mount, live drag) so the strip tracks the
  // moving border. Uses offsetLeft/offsetWidth relative to the table.
  const layoutHandles = () => {
    for (let col = 0; col < handles.length; col++) {
      const th = headerCells[col];
      const handle = handles[col];
      if (!th || !handle) continue;
      const edge = th.offsetLeft + th.offsetWidth;
      handle.style.left = `${edge}px`;
    }
  };

  // The last column has no right-edge resizer (it would resize the table, not a
  // column boundary); resize the boundary BEFORE the last column instead.
  for (let col = 0; col < colCount; col++) {
    const handle = document.createElement("span");
    handle.className = "cm-live-col-resize";
    handle.setAttribute("aria-label", labels.resizeColumn);
    handle.dataset.col = String(col);
    handle.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      // Don't let the grab start a cell edit, a pan, or trip the context-menu
      // outside-dismiss pointerdown listener.
      e.preventDefault();
      e.stopPropagation();
      const th = headerCells[col];
      if (!th) return;
      const startX = e.clientX;
      const startW = th.getBoundingClientRect().width;
      // Pointer capture so a fast drag that leaves the 8px strip still tracks.
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported (jsdom) — listeners below still drive the drag */
      }
      handle.classList.add("cm-live-col-resize-active");

      const onMove = (ev: PointerEvent) => {
        const w = Math.max(40, startW + (ev.clientX - startX));
        colWidths.set(col, w);
        for (const r of table.rows) {
          const c = r.cells[col];
          if (c) (c as HTMLElement).style.width = `${w}px`;
        }
        layoutHandles(); // the border moved — keep every strip on its edge
      };
      const onUp = (ev: PointerEvent) => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("lostpointercapture", onUp);
        handle.classList.remove("cm-live-col-resize-active");
        try {
          handle.releasePointerCapture(ev.pointerId);
        } catch {
          /* already released */
        }
      };
      // With pointer capture, move/up retarget to the handle.
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("lostpointercapture", onUp);
    });
    table.appendChild(handle);
    handles.push(handle);
  }

  // Position the strips once the table has laid out. In a real browser the
  // offsets are available synchronously after append; rAF covers async layout.
  layoutHandles();
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(layoutHandles);
  }

  // --- structural context menu (Quip-style, right-click) --------------------
  // Replaces the old always-visible ×/+ floating controls. A right-click on any
  // cell opens a small daisyUI-styled menu positioned at the pointer, whose
  // actions are all relative to that cell. Every action mutates the parsed model
  // and re-serializes through tableMarkdownFromParsed → onCommit (the SAME
  // write-back path the cell-edit commit uses). The menu is appended to document
  // .body (position:fixed) so the editor/widget overflow can never clip it, and
  // dismisses on outside click, Escape, or after an item is chosen.

  let menuEl: HTMLElement | null = null;

  const closeMenu = () => {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onMenuKeydown, true);
  };

  const onDocPointerDown = (e: Event) => {
    if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
  };
  const onMenuKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
    }
  };

  // Each action takes the right-clicked cell's body row / column and commits.
  // Header cells report bodyRow as their row in the body grid sense; inserts
  // relative to a header click act on the top of the body (index 0).
  const runAction = (fn: () => ParsedTable) => {
    onCommit(tableMarkdownFromParsed(fn()));
    closeMenu();
  };

  function openContextMenu(
    clientX: number,
    clientY: number,
    headerRow: boolean,
    bodyRow: number,
    col: number,
  ): void {
    closeMenu();
    const menu = document.createElement("div");
    menu.className =
      "cm-live-table-menu menu menu-sm bg-base-100 border border-base-300 rounded-box";
    menu.setAttribute("role", "menu");

    // A header right-click has no body row; anchor row inserts/deletes at the
    // top of the body so the menu still does something sensible.
    const rowAnchor = headerRow ? 0 : bodyRow;

    const items: { label: string; act: () => ParsedTable; divider?: boolean }[] = [
      { label: labels.insertRowAbove, act: () => insertRow(parsed, rowAnchor, "above") },
      { label: labels.insertRowBelow, act: () => insertRow(parsed, rowAnchor, "below") },
      { label: labels.insertColumnLeft, act: () => insertColumn(parsed, col, "left") },
      { label: labels.insertColumnRight, act: () => insertColumn(parsed, col, "right") },
      { label: labels.deleteRow, act: () => removeRow(parsed, rowAnchor), divider: true },
      { label: labels.deleteColumn, act: () => removeColumn(parsed, col) },
    ];

    items.forEach((item, i) => {
      const li = document.createElement("li");
      if (item.divider && i > 0) li.classList.add("cm-live-table-menu-sep");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cm-live-table-menu-item active:scale-[0.96]";
      btn.setAttribute("role", "menuitem");
      btn.textContent = item.label;
      // Header-row delete-row is a no-op on an empty body; that's handled by the
      // model helpers (out-of-range removeRow returns a copy), so we always wire.
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        runAction(item.act);
      });
      li.appendChild(btn);
      menu.appendChild(li);
    });

    // Position at the pointer (fixed), then nudge back on-screen if it would
    // overflow the viewport's right/bottom edge.
    menu.style.position = "fixed";
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;
    menu.style.zIndex = "60";
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
    }

    menuEl = menu;
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onMenuKeydown, true);
  }
}

export type { Align, ParsedTable };
