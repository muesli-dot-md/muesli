// Persisted, drag-resizable widths for the left (file tree) and right (outline /
// comments) sidebars. Widths are clamped to sane bounds and saved to localStorage.

const LKEY = 'muesli:sidebar-left';
const RKEY = 'muesli:sidebar-right';

const LEFT_MIN = 200, LEFT_MAX = 480, LEFT_DEFAULT = 240;
const RIGHT_MIN = 220, RIGHT_MAX = 540, RIGHT_DEFAULT = 288;

function load(key: string, fallback: number): number {
  if (typeof localStorage === 'undefined') return fallback;
  const raw = localStorage.getItem(key);
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function clamp(px: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(px)));
}

function createSidebars() {
  let left = $state(clamp(load(LKEY, LEFT_DEFAULT), LEFT_MIN, LEFT_MAX));
  let right = $state(clamp(load(RKEY, RIGHT_DEFAULT), RIGHT_MIN, RIGHT_MAX));

  return {
    get left() { return left; },
    get right() { return right; },
    setLeft(px: number) {
      left = clamp(px, LEFT_MIN, LEFT_MAX);
      if (typeof localStorage !== 'undefined') localStorage.setItem(LKEY, String(left));
    },
    setRight(px: number) {
      right = clamp(px, RIGHT_MIN, RIGHT_MAX);
      if (typeof localStorage !== 'undefined') localStorage.setItem(RKEY, String(right));
    },
  };
}

export const sidebars = createSidebars();
