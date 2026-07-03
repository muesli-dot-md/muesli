import { describe, it, expect } from 'vitest';
import { crumbFor, groupHits, flattenGroups, highlightSplit } from './searchGrouping';
import type { SearchHit } from './tauri';

function hit(display: string, name = display.split('/').at(-1) ?? display): SearchHit {
  return {
    path: `/ws/${display}`,
    display,
    name,
    nameMatch: true,
    snippet: null,
    line: null,
    matches: 0,
  };
}

describe('crumbFor', () => {
  it('returns empty for a root-level file', () => {
    expect(crumbFor('note.md')).toEqual([]);
  });

  it('returns the folder chain minus the basename', () => {
    expect(crumbFor('Notes/Sub/file.md')).toEqual(['Notes', 'Sub']);
  });

  it('handles backslash separators', () => {
    expect(crumbFor('Notes\\Sub\\file.md')).toEqual(['Notes', 'Sub']);
  });
});

describe('groupHits', () => {
  it('groups hits by containing folder', () => {
    const groups = groupHits([hit('a/x.md'), hit('a/y.md'), hit('b/z.md')]);
    expect(groups.map((g) => g.key)).toEqual(['a', 'b']);
    expect(groups[0].items.map((h) => h.name)).toEqual(['x.md', 'y.md']);
  });

  it('puts the workspace-root group first', () => {
    const groups = groupHits([hit('z/deep.md'), hit('root.md'), hit('a/nested.md')]);
    expect(groups[0].key).toBe(''); // root-level group leads
    expect(groups[0].crumb).toEqual([]);
    expect(groups.slice(1).map((g) => g.key)).toEqual(['a', 'z']);
  });

  it('preserves backend ranking within a group (insertion order)', () => {
    const groups = groupHits([hit('a/3.md'), hit('a/1.md'), hit('a/2.md')]);
    expect(groups[0].items.map((h) => h.name)).toEqual(['3.md', '1.md', '2.md']);
  });

  it('orders folder groups case-insensitively', () => {
    const groups = groupHits([hit('Zeta/a.md'), hit('alpha/b.md')]);
    expect(groups.map((g) => g.key)).toEqual(['alpha', 'Zeta']);
  });
});

describe('flattenGroups', () => {
  it('flattens groups back into render order', () => {
    const groups = groupHits([hit('b/z.md'), hit('a/x.md'), hit('a/y.md')]);
    // root-first/alpha ordering: a group (x,y) then b group (z)
    expect(flattenGroups(groups).map((h) => h.name)).toEqual(['x.md', 'y.md', 'z.md']);
  });
});

describe('highlightSplit', () => {
  it('splits around the first case-insensitive match', () => {
    expect(highlightSplit('Hello World', 'world')).toEqual({
      pre: 'Hello ',
      hit: 'World',
      post: '',
    });
  });

  it('returns null when there is no match', () => {
    expect(highlightSplit('abc', 'xyz')).toBeNull();
  });

  it('returns null for an empty needle', () => {
    expect(highlightSplit('abc', '   ')).toBeNull();
  });
});
