import { describe, it, expect } from "vitest";
import {
  parseTableMarkdown,
  tableMarkdownFromParsed,
  addRow,
  removeRow,
  addColumn,
  removeColumn,
  insertRow,
  insertColumn,
  setCell,
  isFormula,
  isFormulaError,
  parseA1,
  evalTableFormula,
  formatFormulaValue,
  type ParsedTable,
} from "./tableModel";

describe("tableMarkdownFromParsed round-trips with parseTableMarkdown", () => {
  it("round-trips a basic table", () => {
    const src = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";
    const parsed = parseTableMarkdown(src)!;
    const out = tableMarkdownFromParsed(parsed);
    expect(parseTableMarkdown(out)).toEqual(parsed);
  });

  it("preserves all three alignments (:--, :-:, --:)", () => {
    const src = "| L | C | R |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |";
    const parsed = parseTableMarkdown(src)!;
    expect(parsed.align).toEqual(["left", "center", "right"]);
    const out = tableMarkdownFromParsed(parsed);
    expect(out).toContain("| :-- | :-: | --: |");
    expect(parseTableMarkdown(out)).toEqual(parsed);
  });

  it("default (no colon) alignment serializes to --- and parses back as null", () => {
    const parsed: ParsedTable = { header: ["x"], align: [null], rows: [["1"]] };
    const out = tableMarkdownFromParsed(parsed);
    expect(out).toContain("| --- |");
    expect(parseTableMarkdown(out)).toEqual(parsed);
  });

  it("escapes pipes inside cells and round-trips them", () => {
    const parsed: ParsedTable = { header: ["a|b"], align: [null], rows: [["c|d"]] };
    const out = tableMarkdownFromParsed(parsed);
    expect(out).toContain("a\\|b");
    expect(out).toContain("c\\|d");
    const reparsed = parseTableMarkdown(out)!;
    expect(reparsed.header).toEqual(["a|b"]);
    expect(reparsed.rows[0]).toEqual(["c|d"]);
  });

  it("normalizes ragged rows to header width", () => {
    const parsed: ParsedTable = {
      header: ["a", "b", "c"],
      align: [null, null, null],
      rows: [["1"]],
    };
    const out = tableMarkdownFromParsed(parsed);
    const reparsed = parseTableMarkdown(out)!;
    expect(reparsed.rows[0]).toEqual(["1", "", ""]);
  });

  it("collapses newlines in a cell to a space", () => {
    const parsed: ParsedTable = { header: ["a"], align: [null], rows: [["line1\nline2"]] };
    const out = tableMarkdownFromParsed(parsed);
    expect(out).not.toContain("\nline2 |");
    expect(parseTableMarkdown(out)!.rows[0]).toEqual(["line1 line2"]);
  });
});

describe("structural mutations", () => {
  const base: ParsedTable = {
    header: ["a", "b"],
    align: ["left", "right"],
    rows: [
      ["1", "2"],
      ["3", "4"],
    ],
  };

  it("addRow inserts an empty row at the index", () => {
    const t = addRow(base, 1);
    expect(t.rows).toEqual([
      ["1", "2"],
      ["", ""],
      ["3", "4"],
    ]);
    expect(base.rows.length).toBe(2); // original untouched
  });

  it("addRow clamps out-of-range index to the end", () => {
    const t = addRow(base, 99);
    expect(t.rows.length).toBe(3);
    expect(t.rows[2]).toEqual(["", ""]);
  });

  it("removeRow deletes the body row", () => {
    const t = removeRow(base, 0);
    expect(t.rows).toEqual([["3", "4"]]);
  });

  it("addColumn inserts header + cells and a null alignment", () => {
    const t = addColumn(base, 1);
    expect(t.header).toEqual(["a", "", "b"]);
    expect(t.align).toEqual(["left", null, "right"]);
    expect(t.rows).toEqual([
      ["1", "", "2"],
      ["3", "", "4"],
    ]);
  });

  it("removeColumn deletes header + cells + alignment", () => {
    const t = removeColumn(base, 0);
    expect(t.header).toEqual(["b"]);
    expect(t.align).toEqual(["right"]);
    expect(t.rows).toEqual([["2"], ["4"]]);
  });

  it("removeColumn refuses to drop the last column", () => {
    const single: ParsedTable = { header: ["only"], align: [null], rows: [["x"]] };
    expect(removeColumn(single, 0)).toEqual(single);
  });

  const mid: ParsedTable = {
    header: ["a", "b", "c"],
    align: ["left", "center", "right"],
    rows: [
      ["1", "2", "3"],
      ["4", "5", "6"],
      ["7", "8", "9"],
    ],
  };

  it("insertRow above a middle body row", () => {
    const t = insertRow(mid, 1, "above");
    expect(t.rows).toEqual([
      ["1", "2", "3"],
      ["", "", ""],
      ["4", "5", "6"],
      ["7", "8", "9"],
    ]);
    expect(mid.rows.length).toBe(3); // original untouched
  });

  it("insertRow below a middle body row", () => {
    const t = insertRow(mid, 1, "below");
    expect(t.rows).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
      ["", "", ""],
      ["7", "8", "9"],
    ]);
  });

  it("insertColumn left of a middle column preserves alignment of the others", () => {
    const t = insertColumn(mid, 1, "left");
    expect(t.header).toEqual(["a", "", "b", "c"]);
    expect(t.align).toEqual(["left", null, "center", "right"]); // new col default null
    expect(t.rows[0]).toEqual(["1", "", "2", "3"]); // new cells empty
  });

  it("insertColumn right of a middle column preserves alignment of the others", () => {
    const t = insertColumn(mid, 1, "right");
    expect(t.header).toEqual(["a", "b", "", "c"]);
    expect(t.align).toEqual(["left", "center", null, "right"]);
    expect(t.rows[0]).toEqual(["1", "2", "", "3"]);
  });

  it("setCell updates a body cell", () => {
    const t = setCell(base, 0, 1, "=SUM(A2:A3)");
    expect(t.rows[0]).toEqual(["1", "=SUM(A2:A3)"]);
  });

  it("setCell with row -1 updates the header", () => {
    const t = setCell(base, -1, 0, "renamed");
    expect(t.header).toEqual(["renamed", "b"]);
  });
});

describe("parseA1", () => {
  it("maps A1 to body row 0, col A (header excluded)", () => {
    expect(parseA1("A1")).toEqual({ row: 0, col: 0 });
  });
  it("maps B2 to col 1, body row 1 (second data row)", () => {
    expect(parseA1("B2")).toEqual({ row: 1, col: 1 });
  });
  it("handles multi-letter columns", () => {
    expect(parseA1("AA1")).toEqual({ row: 0, col: 26 });
    expect(parseA1("AB3")).toEqual({ row: 2, col: 27 });
  });
  it("is case-insensitive", () => {
    expect(parseA1("c4")).toEqual({ row: 3, col: 2 });
  });
  it("returns null on garbage", () => {
    expect(parseA1("1A")).toBeNull();
    expect(parseA1("A")).toBeNull();
    expect(parseA1("A0")).toBeNull();
  });
});

describe("isFormula", () => {
  it("detects leading = after trimming", () => {
    expect(isFormula("=SUM(A2:A3)")).toBe(true);
    expect(isFormula("  =MAX(B2:B5) ")).toBe(true);
    expect(isFormula("42")).toBe(false);
    expect(isFormula("a = b")).toBe(false);
  });
});

describe("evalTableFormula", () => {
  // Row numbers index the BODY rows only — the header is excluded, so the first
  // data row is A1, the second A2, the third A3.
  // | n  | x | y |   <- header (NOT addressable by number)
  // | -- | - | - |
  // | a  | 1 | 4 |   <- A1/B1/C1
  // | b  | 2 | 5 |   <- A2/B2/C2
  // | c  | 3 | x |   <- A3/B3/C3 (non-numeric in C3)
  const table: ParsedTable = {
    header: ["n", "x", "y"],
    align: [null, null, null],
    rows: [
      ["a", "1", "4"],
      ["b", "2", "5"],
      ["c", "3", "x"],
    ],
  };

  it("SUM over a range", () => {
    expect(evalTableFormula("=SUM(B1:B3)", table)).toBe(6);
  });
  it("AVERAGE over a range", () => {
    expect(evalTableFormula("=AVERAGE(B1:B3)", table)).toBe(2);
  });
  it("MIN and MAX over a range", () => {
    expect(evalTableFormula("=MIN(B1:B3)", table)).toBe(1);
    expect(evalTableFormula("=MAX(B1:B3)", table)).toBe(3);
  });
  it("COUNT counts numeric cells only (skips non-numeric)", () => {
    // C1=4, C2=5, C3="x" → count of numeric = 2
    expect(evalTableFormula("=COUNT(C1:C3)", table)).toBe(2);
  });
  it("SUM skips non-numeric cells", () => {
    expect(evalTableFormula("=SUM(C1:C3)", table)).toBe(9); // 4+5, x skipped
  });
  it("supports comma lists", () => {
    expect(evalTableFormula("=SUM(B1,B3,C1)", table)).toBe(1 + 3 + 4);
  });
  it("supports mixed range + comma list", () => {
    expect(evalTableFormula("=SUM(B1:B2,C3)", table)).toBe(1 + 2); // C3 non-numeric skipped
  });
  it("is case-insensitive on the function name", () => {
    expect(evalTableFormula("=sum(B1:B3)", table)).toBe(6);
  });

  it("reported case: =SUM(A1,A2) over body 0,1 yields 1", () => {
    // header "this", body rows "0", "1": A1=0, A2=1 → sum 1 (header excluded).
    const t: ParsedTable = { header: ["this"], align: [null], rows: [["0"], ["1"]] };
    expect(evalTableFormula("=SUM(A1,A2)", t)).toBe(1);
    expect(evalTableFormula("=SUM(A1:A2)", t)).toBe(1);
  });

  it("malformed formula returns an error sentinel", () => {
    const r = evalTableFormula("=SUM(", table);
    expect(isFormulaError(r)).toBe(true);
  });
  it("unknown function returns an error sentinel", () => {
    const r = evalTableFormula("=FROBNICATE(A1:A2)", table);
    expect(isFormulaError(r)).toBe(true);
  });
  it("bad reference returns an error sentinel", () => {
    const r = evalTableFormula("=SUM(B1:ZZ)", table);
    expect(isFormulaError(r)).toBe(true);
  });

  it("self-reference is skipped (does not loop)", () => {
    // A formula in A1 referencing A1:A3 must not include itself.
    const t: ParsedTable = {
      header: ["x"],
      align: [null],
      rows: [["=SUM(A1:A3)"], ["10"], ["20"]],
    };
    // self at body row 0 (A1); range A1:A3 covers body rows 0,1,2.
    const r = evalTableFormula("=SUM(A1:A3)", t, { row: 0, col: 0 });
    // A1 = self (skipped), A2 = "10", A3 = "20"
    expect(r).toBe(30);
  });

  it("referenced formula cell contributes nothing (no chains in v1)", () => {
    const t: ParsedTable = {
      header: ["x"],
      align: [null],
      rows: [["=SUM(A2:A3)"], ["5"], ["7"]],
    };
    // A1 is a formula; referencing it from elsewhere skips it.
    const r = evalTableFormula("=SUM(A1,A2,A3)", t, { row: 99, col: 99 });
    expect(r).toBe(12); // A1 formula skipped, A2=5, A3=7
  });

  it("empty numeric set → 0 for SUM/AVERAGE/MIN/MAX, 0 for COUNT", () => {
    const t: ParsedTable = { header: ["x"], align: [null], rows: [["nope"]] };
    expect(evalTableFormula("=SUM(A1)", t)).toBe(0);
    expect(evalTableFormula("=AVERAGE(A1)", t)).toBe(0);
    expect(evalTableFormula("=MIN(A1)", t)).toBe(0);
    expect(evalTableFormula("=MAX(A1)", t)).toBe(0);
    expect(evalTableFormula("=COUNT(A1)", t)).toBe(0);
  });
});

describe("formatFormulaValue", () => {
  it("keeps integers as integers", () => {
    expect(formatFormulaValue(6)).toBe("6");
  });
  it("trims float noise", () => {
    expect(formatFormulaValue(2.3333333333)).toBe("2.333333");
    expect(formatFormulaValue(2.5)).toBe("2.5");
  });
});
