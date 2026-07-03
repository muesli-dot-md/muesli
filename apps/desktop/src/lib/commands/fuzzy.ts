/**
 * Subsequence fuzzy filter with a simple scoring heuristic:
 *  - +10 per contiguous matching run
 *  - +5 if first matched char is at start of a word (preceded by space, dash, _)
 *  - +20 if first matched char is at position 0 of the key string
 * Sorted best-first. Empty query returns all items in original order.
 * Case-insensitive.
 */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  key: (t: T) => string
): T[] {
  if (!query) return items;

  const q = query.toLowerCase();
  const scored: { item: T; score: number }[] = [];

  for (const item of items) {
    const k = key(item).toLowerCase();
    const result = scoreSubsequence(k, q);
    if (result !== null) {
      scored.push({ item, score: result });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

/**
 * Returns null if query is not a subsequence of str.
 * Otherwise returns a score (higher = better match).
 */
function scoreSubsequence(str: string, query: string): number | null {
  let si = 0; // position in str
  let qi = 0; // position in query
  let score = 0;
  let firstMatchPos = -1;
  let inRun = false;
  let runLen = 0;

  while (qi < query.length && si < str.length) {
    if (str[si] === query[qi]) {
      if (firstMatchPos === -1) firstMatchPos = si;

      if (inRun) {
        runLen++;
        score += runLen * 2; // reward longer contiguous runs
      } else {
        inRun = true;
        runLen = 1;
        score += 10; // new contiguous run start
        // Start-of-word bonus
        if (si === 0) {
          score += 20;
        } else {
          const prev = str[si - 1];
          if (prev === ' ' || prev === '-' || prev === '_') {
            score += 5;
          }
        }
      }
      qi++;
    } else {
      inRun = false;
      runLen = 0;
    }
    si++;
  }

  if (qi < query.length) return null; // not all query chars matched

  // Bonus: start of string match
  if (firstMatchPos === 0) score += 20;

  return score;
}
