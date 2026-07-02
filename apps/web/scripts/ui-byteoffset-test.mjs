// Headless test for the UTF-8 byte <-> UTF-16 code unit converters the
// collaboration UI uses at every server boundary (src/offsets.ts).
//
//   node scripts/ui-byteoffset-test.mjs
//
// Verifies, against a TextEncoder reference implementation:
//   - utf16ToByte matches encode(slice).length at every code-point boundary
//   - byteToUtf16 round-trips every boundary back exactly
//   - byte offsets that land inside a multi-byte sequence clamp to the start
//     of that code point (never inside a surrogate pair)
//   - range helpers round-trip on emoji / umlauts / ZWJ sequences
import {
  byteToUtf16,
  utf16ToByte,
  byteRangeToUtf16,
  utf16RangeToByte,
} from "../../../packages/editor-core/src/offsets.ts";

let failures = 0;
const check = (cond, msg) => {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  }
};
const ok = (msg) => console.log(`OK: ${msg}`);

const enc = new TextEncoder();
const refByteLen = (s) => enc.encode(s).length;

const SAMPLES = [
  "",
  "plain ascii text",
  "héllo wörld — über grüße", // umlauts + em-dash (2- and 3-byte)
  "a😀b🌍c", // surrogate pairs (4-byte)
  "👩‍👩‍👧‍👦 family", // ZWJ sequence
  "mixed: $5 ünïcødé 🥣 ok\nnew line ☕",
  "日本語テキスト",
  "🇩🇪🇫🇷 flags",
];

// --- boundary round-trips against the TextEncoder reference -------------------
for (const text of SAMPLES) {
  let allGood = true;
  for (let i = 0; i <= text.length; i++) {
    // Only test code-point boundaries (CodeMirror never yields positions
    // inside a surrogate pair for selections of real text).
    const isBoundary =
      i === 0 ||
      i === text.length ||
      !(text.charCodeAt(i) >= 0xdc00 && text.charCodeAt(i) <= 0xdfff);
    if (!isBoundary) continue;
    const expected = refByteLen(text.slice(0, i));
    const got = utf16ToByte(text, i);
    if (got !== expected) {
      allGood = false;
      check(false, `utf16ToByte(${JSON.stringify(text)}, ${i}) = ${got}, want ${expected}`);
    }
    const back = byteToUtf16(text, expected);
    if (back !== i) {
      allGood = false;
      check(false, `byteToUtf16(${JSON.stringify(text)}, ${expected}) = ${back}, want ${i}`);
    }
  }
  if (allGood)
    ok(`round-trips for ${JSON.stringify(text.slice(0, 24))}${text.length > 24 ? "…" : ""}`);
}

// --- clamping: byte offsets inside a multi-byte char clamp to its start --------
{
  const text = "aöb"; // ö = 2 bytes at byte offset 1..3
  check(
    byteToUtf16(text, 2) === 1,
    `inside 'ö' should clamp to its start (got ${byteToUtf16(text, 2)})`,
  );
  const emoji = "x😀y"; // 😀 = 4 bytes at byte offset 1..5
  for (const b of [2, 3, 4]) {
    const got = byteToUtf16(emoji, b);
    check(got === 1, `byte ${b} inside emoji should clamp to UTF-16 offset 1, got ${got}`);
  }
  check(byteToUtf16(emoji, 5) === 3, "end of emoji maps past the surrogate pair");
  ok("byte offsets inside multi-byte sequences clamp to code point starts");
}

// --- out-of-range clamping ------------------------------------------------------
{
  const text = "héllo";
  check(utf16ToByte(text, -5) === 0, "negative utf16 offset clamps to 0");
  check(utf16ToByte(text, 99) === refByteLen(text), "past-end utf16 offset clamps to byte length");
  check(byteToUtf16(text, -5) === 0, "negative byte offset clamps to 0");
  check(byteToUtf16(text, 999) === text.length, "past-end byte offset clamps to text length");
  ok("out-of-range offsets clamp");
}

// --- range helpers ----------------------------------------------------------------
{
  const text = "# Grüße ☕\n\nHällo wörld 👩‍👩‍👧‍👦 emoji.\n";
  for (const target of ["Grüße", "wörld", "☕", "👩‍👩‍👧‍👦", "emoji"]) {
    const from = text.indexOf(target);
    const to = from + target.length;
    const bytes = utf16RangeToByte(text, { from, to });
    check(
      bytes.start === refByteLen(text.slice(0, from)) &&
        bytes.end === refByteLen(text.slice(0, to)),
      `utf16RangeToByte for ${JSON.stringify(target)}`,
    );
    const back = byteRangeToUtf16(text, bytes);
    check(
      back.from === from && back.to === to,
      `byteRangeToUtf16 round-trip for ${JSON.stringify(target)}: got ${back.from}..${back.to}, want ${from}..${to}`,
    );
    // The decoded byte range must select exactly the target text via slice.
    const sliced = text.slice(back.from, back.to);
    check(
      sliced === target,
      `range slice for ${JSON.stringify(target)} got ${JSON.stringify(sliced)}`,
    );
  }
  ok("byte/UTF-16 range helpers round-trip over emoji, umlauts, and ZWJ sequences");
}

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("ALL BYTE OFFSET CHECKS PASSED");
