import { describe, it, expect } from "vitest";
import {
  utf16ToByte,
  byteToUtf16,
  byteRangeToUtf16,
  utf16RangeToByte,
} from "./offsets";

describe("offsets byte<->UTF-16 conversion", () => {
  it("round-trips over an ASCII string", () => {
    const text = "hello world";
    for (let i = 0; i <= text.length; i++) {
      const b = utf16ToByte(text, i);
      expect(b).toBe(i); // ASCII: 1 byte == 1 unit
      expect(byteToUtf16(text, b)).toBe(i);
    }
  });

  it("handles a multi-byte string (emoji = 4 UTF-8 bytes / 2 UTF-16 units)", () => {
    const text = "a😀b"; // a=1B/1u, 😀=4B/2u, b=1B/1u
    // byte offsets: a@0, 😀@1, b@5, end@6 ; utf16 units: a@0, 😀@1, b@3, end@4
    expect(utf16ToByte(text, 0)).toBe(0);
    expect(utf16ToByte(text, 1)).toBe(1); // after 'a'
    expect(utf16ToByte(text, 3)).toBe(5); // after emoji's 2 units
    expect(utf16ToByte(text, 4)).toBe(6); // after 'b'

    expect(byteToUtf16(text, 0)).toBe(0);
    expect(byteToUtf16(text, 1)).toBe(1);
    expect(byteToUtf16(text, 5)).toBe(3);
    expect(byteToUtf16(text, 6)).toBe(4);
  });

  it("clamps a byte offset that lands inside the emoji back to its start", () => {
    const text = "a😀b";
    // bytes 2,3,4 are inside the emoji; all clamp to its start (utf16 unit 1)
    expect(byteToUtf16(text, 2)).toBe(1);
    expect(byteToUtf16(text, 3)).toBe(1);
    expect(byteToUtf16(text, 4)).toBe(1);
  });

  it("converts ranges in both directions", () => {
    const text = "a😀b";
    expect(byteRangeToUtf16(text, { start: 1, end: 5 })).toEqual({ from: 1, to: 3 });
    expect(utf16RangeToByte(text, { from: 1, to: 3 })).toEqual({ start: 1, end: 5 });
  });
});
