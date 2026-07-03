import { describe, it, expect } from 'vitest';
import { sortNodes } from './sortNodes';
import type { WorkspaceNode } from './tauri';

const dir = (name: string): WorkspaceNode => ({ name, path: name, isDir: true, children: [] });
const file = (name: string): WorkspaceNode => ({ name, path: name, isDir: false });

describe('sortNodes', () => {
  // ── asc (default) ──────────────────────────────────────────────────────────

  it('puts folders before files (asc)', () => {
    const result = sortNodes([file('a.md'), dir('b'), dir('a'), file('c.md')]);
    expect(result[0].isDir).toBe(true);
    expect(result[1].isDir).toBe(true);
    expect(result[2].isDir).toBe(false);
    expect(result[3].isDir).toBe(false);
  });

  it('sorts folders alphabetically A→Z among themselves (asc)', () => {
    const result = sortNodes([dir('zebra'), dir('apple'), dir('mango')]);
    expect(result.map(n => n.name)).toEqual(['apple', 'mango', 'zebra']);
  });

  it('sorts files alphabetically A→Z among themselves (asc)', () => {
    const result = sortNodes([file('z.md'), file('a.md'), file('m.md')]);
    expect(result.map(n => n.name)).toEqual(['a.md', 'm.md', 'z.md']);
  });

  it('does not mutate the original array', () => {
    const original = [file('b.md'), dir('a')];
    const result = sortNodes(original);
    expect(original[0].name).toBe('b.md');
    expect(result[0].name).toBe('a');
  });

  // ── desc ───────────────────────────────────────────────────────────────────

  it('puts folders before files (desc)', () => {
    const result = sortNodes([file('a.md'), dir('b'), dir('a'), file('c.md')], 'name-desc');
    expect(result[0].isDir).toBe(true);
    expect(result[1].isDir).toBe(true);
    expect(result[2].isDir).toBe(false);
    expect(result[3].isDir).toBe(false);
  });

  it('sorts folders Z→A among themselves (desc)', () => {
    const result = sortNodes([dir('apple'), dir('zebra'), dir('mango')], 'name-desc');
    expect(result.map(n => n.name)).toEqual(['zebra', 'mango', 'apple']);
  });

  it('sorts files Z→A among themselves (desc)', () => {
    const result = sortNodes([file('a.md'), file('z.md'), file('m.md')], 'name-desc');
    expect(result.map(n => n.name)).toEqual(['z.md', 'm.md', 'a.md']);
  });

  it('mixed files and folders: folders first in desc mode', () => {
    const nodes = [file('z.md'), dir('mango'), file('a.md'), dir('apple')];
    const result = sortNodes(nodes, 'name-desc');
    expect(result.map(n => n.name)).toEqual(['mango', 'apple', 'z.md', 'a.md']);
  });

  it('name-asc is equivalent to default (no mode arg)', () => {
    const nodes = [file('z.md'), dir('mango'), file('a.md'), dir('apple')];
    expect(sortNodes(nodes, 'name-asc')).toEqual(sortNodes(nodes));
  });
});
