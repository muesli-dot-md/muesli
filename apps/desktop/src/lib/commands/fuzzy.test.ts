import { describe, it, expect } from 'vitest';
import { fuzzyFilter } from './fuzzy';

const byTitle = (t: { title: string }) => t.title;

describe('fuzzyFilter', () => {
  it('returns all items in original order for an empty query', () => {
    const items = [
      { title: 'Banana' },
      { title: 'Apple' },
      { title: 'Cherry' },
    ];
    expect(fuzzyFilter(items, '', byTitle)).toEqual(items);
  });

  it('returns [] for a query with no matches', () => {
    const items = [{ title: 'Apple' }, { title: 'Banana' }];
    expect(fuzzyFilter(items, 'xyz', byTitle)).toHaveLength(0);
  });

  it('"nn" ranks "New note" above "Antenna" (case-insensitive)', () => {
    const items = [{ title: 'Antenna' }, { title: 'New note' }];
    const result = fuzzyFilter(items, 'nn', byTitle);
    expect(result.length).toBe(2);
    expect(result[0].title).toBe('New note');
    expect(result[1].title).toBe('Antenna');
  });

  it('is case-insensitive', () => {
    const items = [{ title: 'Apple' }];
    expect(fuzzyFilter(items, 'APPLE', byTitle)).toHaveLength(1);
    expect(fuzzyFilter(items, 'apple', byTitle)).toHaveLength(1);
  });

  it('filters out non-matching items', () => {
    const items = [
      { title: 'New note' },
      { title: 'Antenna' },
      { title: 'Zebra' },
    ];
    const result = fuzzyFilter(items, 'nn', byTitle);
    expect(result.some((r) => r.title === 'Zebra')).toBe(false);
  });

  it('subsequence match: non-contiguous chars match', () => {
    const items = [{ title: 'Toggle sidebar' }];
    // 'ts' is a subsequence of 'toggle sidebar'
    expect(fuzzyFilter(items, 'ts', byTitle)).toHaveLength(1);
  });
});
