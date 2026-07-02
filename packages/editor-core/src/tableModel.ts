// Pure table model helpers shared by both apps' live-preview TableWidget and the
// reading-view renderer. DOM-free and @codemirror-free so they run headlessly
// (Vitest, node environment).
//
// The canonical source is always GFM pipe-table markdown (ADR 0001/0004); these
// helpers parse it into a ParsedTable, mutate that model (add/remove rows &
// columns), serialize it back to clean GFM (`tableMarkdownFromParsed`, the
// inverse of `parseTableMarkdown`), and evaluate formula cells (`=SUM(...)`).
//
// Formula model (sub-project ⑥ design B):
//   - A cell whose TRIMMED RAW text starts with `=` is a formula.
//   - References are A1-style: columns A,B,C… left→right; rows 1-based over the
//     BODY/DATA rows only, EXCLUDING the header (so the first data row is A1, the
//     second is A2, …). The header cannot be referenced by number — intended.
//   - Functions: SUM, AVERAGE, COUNT, MIN, MAX. Ranges (B2:B5) and comma lists
//     (B2,B4,C3) supported. Non-numeric referenced cells are skipped (COUNT
//     counts numeric cells only).
//   - v1 does NOT follow formula→formula chains: a referenced cell that is
//     itself a formula contributes nothing (skipped). Self-reference is guarded.
//   - A malformed/unparseable formula yields an error sentinel (never throws).

export type Align = "left" | "center" | "right" | null;

export type ParsedTable = {
  header: string[];
  align: Align[];
  rows: string[][];
};

// --- parse (mirrors transform.ts parseTableMarkdown; kept here as the shared,
// headless-testable source of truth) ----------------------------------------

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\" && trimmed[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

/** Parse a GFM table's raw markdown into header/alignment/body cells.
 * Returns null when the text is not a well-formed table. */
export function parseTableMarkdown(src: string): ParsedTable | null {
  const lines = src.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return null;
  const header = splitRow(lines[0]);
  const delim = splitRow(lines[1]);
  if (delim.length === 0 || !delim.every((c) => /^:?-+:?$/.test(c))) return null;
  const align: Align[] = delim.map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
  const rows = lines.slice(2).map(splitRow);
  return { header, align, rows };
}

// --- serialize (inverse of parseTableMarkdown) ------------------------------

/** Escape a cell value for GFM: pipes become `\|`; newlines collapse to a
 * space (multi-line cells are not representable in a pipe table). */
function escapeCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function delimCell(align: Align): string {
  switch (align) {
    case "left":
      return ":--";
    case "center":
      return ":-:";
    case "right":
      return "--:";
    default:
      return "---";
  }
}

/**
 * Serialize a ParsedTable back into clean, valid GFM pipe-table markdown:
 * a header row, a delimiter row carrying the alignment, then the body rows.
 * Round-trips with parseTableMarkdown (cell text is trimmed on parse, so
 * leading/trailing whitespace is not preserved — alignment and escaped pipes
 * are). Column count is normalized to the header width.
 */
export function tableMarkdownFromParsed(table: ParsedTable): string {
  const cols = table.header.length;
  const renderRow = (cells: string[]): string => {
    const padded: string[] = [];
    for (let i = 0; i < cols; i++) padded.push(escapeCell(cells[i] ?? ""));
    return `| ${padded.join(" | ")} |`;
  };
  const lines: string[] = [];
  lines.push(renderRow(table.header));
  const delim: string[] = [];
  for (let i = 0; i < cols; i++) delim.push(delimCell(table.align[i] ?? null));
  lines.push(`| ${delim.join(" | ")} |`);
  for (const row of table.rows) lines.push(renderRow(row));
  return lines.join("\n");
}

// --- structural mutations (return a NEW ParsedTable; never mutate in place) ---
//
// LIMITATION (intended v1 behavior): literal A1 formula references (e.g.
// `=SUM(B2:B3)`) are NOT auto-adjusted when rows/columns are inserted or
// removed by addRow/removeRow/addColumn/removeColumn. Formulas are stored as
// literal cell text and there is no dependency graph in v1 (matches the spec's
// YAGNI stance), so a structural mutation can leave a formula pointing at
// now-shifted coordinates. Future maintainers adding ref-rewriting should do it
// here, in these helpers.

function cloneRows(rows: string[][]): string[][] {
  return rows.map((r) => [...r]);
}

/** Insert an empty body row at index `at` (clamped to [0, rows.length]). */
export function addRow(table: ParsedTable, at: number): ParsedTable {
  const cols = table.header.length;
  const rows = cloneRows(table.rows);
  const idx = Math.max(0, Math.min(at, rows.length));
  rows.splice(idx, 0, new Array(cols).fill(""));
  return { header: [...table.header], align: [...table.align], rows };
}

/** Insert an empty body row above/below the body row at `atBodyIndex`. A thin
 * positional wrapper over addRow used by the right-click context menu. */
export function insertRow(
  table: ParsedTable,
  atBodyIndex: number,
  where: "above" | "below",
): ParsedTable {
  const at = where === "below" ? atBodyIndex + 1 : atBodyIndex;
  return addRow(table, at);
}

/** Remove the body row at index `at`. No-op (returns a copy) if out of range. */
export function removeRow(table: ParsedTable, at: number): ParsedTable {
  const rows = cloneRows(table.rows);
  if (at >= 0 && at < rows.length) rows.splice(at, 1);
  return { header: [...table.header], align: [...table.align], rows };
}

/** Insert a column at index `at` (clamped). New header cell + empty body cells;
 * the new column gets a default (null) alignment. */
export function addColumn(table: ParsedTable, at: number): ParsedTable {
  const idx = Math.max(0, Math.min(at, table.header.length));
  const header = [...table.header];
  header.splice(idx, 0, "");
  const align = [...table.align];
  align.splice(idx, 0, null);
  const rows = table.rows.map((r) => {
    const next = [...r];
    // pad short rows up to the insertion point so the new cell lands correctly
    while (next.length < idx) next.push("");
    next.splice(idx, 0, "");
    return next;
  });
  return { header, align, rows };
}

/** Insert an empty column left/right of the column at `atColIndex`. A thin
 * positional wrapper over addColumn used by the right-click context menu. The
 * new column gets a default (null) alignment; existing columns keep theirs. */
export function insertColumn(
  table: ParsedTable,
  atColIndex: number,
  where: "left" | "right",
): ParsedTable {
  const at = where === "right" ? atColIndex + 1 : atColIndex;
  return addColumn(table, at);
}

/** Remove the column at index `at`. Guarded so the table always keeps ≥1
 * column (removing the last column is a no-op). */
export function removeColumn(table: ParsedTable, at: number): ParsedTable {
  if (table.header.length <= 1) {
    return { header: [...table.header], align: [...table.align], rows: cloneRows(table.rows) };
  }
  if (at < 0 || at >= table.header.length) {
    return { header: [...table.header], align: [...table.align], rows: cloneRows(table.rows) };
  }
  const header = [...table.header];
  header.splice(at, 1);
  const align = [...table.align];
  align.splice(at, 1);
  const rows = table.rows.map((r) => {
    const next = [...r];
    if (at < next.length) next.splice(at, 1);
    return next;
  });
  return { header, align, rows };
}

/** Set a single cell's raw value and return a new table. `row` is 0-based into
 * the body rows; `row === -1` targets the header. Out-of-range rows/cols are
 * padded/ignored gracefully. */
export function setCell(table: ParsedTable, row: number, col: number, value: string): ParsedTable {
  const cols = table.header.length;
  if (col < 0 || col >= cols) {
    return { header: [...table.header], align: [...table.align], rows: cloneRows(table.rows) };
  }
  if (row === -1) {
    const header = [...table.header];
    header[col] = value;
    return { header, align: [...table.align], rows: cloneRows(table.rows) };
  }
  const rows = cloneRows(table.rows);
  if (row >= 0 && row < rows.length) {
    while (rows[row].length < cols) rows[row].push("");
    rows[row][col] = value;
  }
  return { header: [...table.header], align: [...table.align], rows };
}

// --- formula cells ----------------------------------------------------------

/** Error sentinel returned by evalTableFormula for a malformed formula. */
export type FormulaError = { error: true; message: string };

export type FormulaResult = number | FormulaError;

export function isFormula(raw: string): boolean {
  return raw.trim().startsWith("=");
}

export function isFormulaError(r: FormulaResult): r is FormulaError {
  return typeof r === "object" && r !== null && (r as FormulaError).error === true;
}

/** A1 cell position within the table's body grid: `row` is a 0-based index into
 * the BODY rows (the header is excluded from numbering and uses the sentinel
 * `row: -1`, which no parsed A1 ref can produce). So A1 = first body row col A,
 * A2 = second body row col A. */
export type CellPos = { row: number; col: number };

/** Parse an A1 reference like "B2" → {row:1, col:1} (0-based BODY row index;
 * header excluded, so A1 → body row 0, A2 → body row 1, …). Multi-letter columns
 * (AA, AB…) supported. Returns null on malformed input. */
export function parseA1(ref: string): CellPos | null {
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
  if (!m) return null;
  const letters = m[1].toUpperCase();
  let col = 0;
  for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
  col -= 1; // 1-based letters → 0-based index
  const rowNum = parseInt(m[2], 10);
  if (rowNum < 1) return null;
  return { row: rowNum - 1, col }; // row 1 → body index 0 (header excluded)
}

/** The raw text at a body grid position (`row` is a 0-based BODY index; the
 * header is never addressable via A1). Returns null when out of bounds. */
function rawAt(table: ParsedTable, pos: CellPos): string | null {
  if (pos.col < 0 || pos.col >= table.header.length) return null;
  if (pos.row < 0) return null; // header sentinel / out of bounds
  const bodyRow = table.rows[pos.row];
  if (!bodyRow) return null;
  return bodyRow[pos.col] ?? "";
}

/** Expand a reference token (single cell "B2", or a range "B2:B5") into the
 * list of grid positions it covers. Returns null on malformed input. */
function expandRef(token: string): CellPos[] | null {
  const t = token.trim();
  if (t.includes(":")) {
    const [a, b] = t.split(":");
    const pa = parseA1(a);
    const pb = parseA1(b);
    if (!pa || !pb) return null;
    const r0 = Math.min(pa.row, pb.row);
    const r1 = Math.max(pa.row, pb.row);
    const c0 = Math.min(pa.col, pb.col);
    const c1 = Math.max(pa.col, pb.col);
    const out: CellPos[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) out.push({ row: r, col: c });
    }
    return out;
  }
  const single = parseA1(t);
  return single ? [single] : null;
}

const FN_RE = /^([A-Za-z]+)\(([^()]*)\)$/;

/**
 * Evaluate a formula cell against the parsed table.
 *
 * @param formula  the raw cell text (with or without a leading `=`)
 * @param table    the parsed table the formula lives in
 * @param self     the formula cell's OWN body position (row = 0-based body
 *                 index, header = -1), excluded from collected values to guard
 *                 self-reference
 * @returns a number on success, or a FormulaError sentinel on any problem.
 *
 * Semantics: numeric values are collected from every referenced cell, SKIPPING
 *   - the formula's own cell (self-reference guard),
 *   - cells whose trimmed raw text is itself a formula (no formula→formula
 *     chains in v1),
 *   - non-numeric cells (so COUNT counts numeric cells only).
 * SUM/AVERAGE/MIN/MAX over an empty numeric set return 0; COUNT returns 0.
 */
export function evalTableFormula(
  formula: string,
  table: ParsedTable,
  self?: CellPos,
): FormulaResult {
  const err = (message: string): FormulaError => ({ error: true, message });
  let body = formula.trim();
  if (body.startsWith("=")) body = body.slice(1).trim();
  const m = FN_RE.exec(body);
  if (!m) return err(`Unsupported formula: ${formula.trim()}`);
  const fn = m[1].toUpperCase();
  if (!["SUM", "AVERAGE", "COUNT", "MIN", "MAX"].includes(fn)) {
    return err(`Unknown function: ${m[1]}`);
  }
  const argText = m[2].trim();
  const tokens = argText.length === 0 ? [] : argText.split(",");
  const positions: CellPos[] = [];
  for (const tok of tokens) {
    const expanded = expandRef(tok);
    if (!expanded) return err(`Bad reference: ${tok.trim()}`);
    positions.push(...expanded);
  }

  const values: number[] = [];
  for (const pos of positions) {
    if (self && pos.row === self.row && pos.col === self.col) continue; // self-ref guard
    const raw = rawAt(table, pos);
    if (raw === null) continue; // out of bounds → skip
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    if (isFormula(trimmed)) continue; // no formula→formula chains in v1
    const num = Number(trimmed);
    if (!Number.isFinite(num)) continue; // non-numeric → skip
    values.push(num);
  }

  switch (fn) {
    case "SUM":
      return values.reduce((a, b) => a + b, 0);
    case "COUNT":
      return values.length;
    case "AVERAGE":
      return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
    case "MIN":
      return values.length === 0 ? 0 : Math.min(...values);
    case "MAX":
      return values.length === 0 ? 0 : Math.max(...values);
    default:
      return err(`Unknown function: ${fn}`);
  }
}

/** Format a numeric formula result for display: integers stay integers, floats
 * are trimmed to a sane precision (no trailing-zero noise). */
export function formatFormulaValue(value: number): string {
  if (Number.isInteger(value)) return String(value);
  // Round to 6 sig-ish decimals, then strip trailing zeros.
  return String(Number(value.toFixed(6)));
}
