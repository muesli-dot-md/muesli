// UTF-8 byte offset <-> UTF-16 code unit offset conversion.
//
// The server addresses document text in UTF-8 BYTE offsets (Rust strings);
// CodeMirror and Yjs address it in UTF-16 code units (JS strings). These
// helpers convert at every boundary. They are deliberately DOM-free so the
// headless tests (scripts/ui-byteoffset-test.mjs, ui-flows-e2e.mjs) exercise
// the exact same code the UI uses.
//
// Both directions clamp: out-of-range offsets clamp to the text bounds, and a
// byte offset that lands *inside* a multi-byte sequence clamps back to the
// start of that code point (never produces a position inside a surrogate
// pair, which CodeMirror would reject).

function codePointUtf8Length(cp: number): number {
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  if (cp <= 0xffff) return 3;
  return 4;
}

/** UTF-16 code unit offset in `text` -> UTF-8 byte offset. O(offset). */
export function utf16ToByte(text: string, utf16Offset: number): number {
  const end = Math.max(0, Math.min(utf16Offset, text.length));
  let bytes = 0;
  let i = 0;
  while (i < end) {
    const cp = text.codePointAt(i) as number;
    const units = cp > 0xffff ? 2 : 1;
    if (i + units > end) {
      // The offset splits a surrogate pair. TextEncoder would emit U+FFFD
      // (3 bytes) for the lone surrogate; match that so round-trips stay sane.
      bytes += 3;
      break;
    }
    bytes += codePointUtf8Length(cp);
    i += units;
  }
  return bytes;
}

/** UTF-8 byte offset -> UTF-16 code unit offset in `text`. O(offset). */
export function byteToUtf16(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i) as number;
    const len = codePointUtf8Length(cp);
    if (bytes + len > byteOffset) return i; // inside this code point: clamp to its start
    bytes += len;
    i += cp > 0xffff ? 2 : 1;
    if (bytes === byteOffset) return i;
  }
  return text.length;
}

export type ByteRange = { start: number; end: number };
export type Utf16Range = { from: number; to: number };

/** Server byte range -> CodeMirror UTF-16 range, clamped to `text`. */
export function byteRangeToUtf16(text: string, range: ByteRange): Utf16Range {
  const from = byteToUtf16(text, range.start);
  const to = byteToUtf16(text, range.end);
  return { from: Math.min(from, to), to: Math.max(from, to) };
}

/** CodeMirror UTF-16 range -> server byte range. */
export function utf16RangeToByte(text: string, range: Utf16Range): ByteRange {
  const start = utf16ToByte(text, range.from);
  const end = utf16ToByte(text, range.to);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}
