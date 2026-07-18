// Reusable fixed-position context menu (Drive-style), ported from the Svelte
// desktop's ContextMenu.svelte. Closes on click-away, Escape, scroll, and
// resize; ArrowUp/Down + Home/End move focus, Enter activates. The caller owns
// position + items. Styled with the Multica menu recipe (surface-raised panel,
// hairline ring, menu-tier shadow, p-1 with rounded-md rows) and grouped via
// "separator" entries.

import { useLayoutEffect, useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";

/** A lucide-react icon component. */
export type MenuIcon = LucideIcon;

/** One entry of a context menu; "separator" draws a divider between groups. */
export type MenuItem =
  | {
      label: string;
      action: () => void;
      disabled?: boolean;
      danger?: boolean;
      icon?: MenuIcon;
    }
  | "separator";

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const elRef = useRef<HTMLDivElement | null>(null);
  // Clamp into the viewport after first render (menu size is content-driven).
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
  }, [x, y, items]);

  useEffect(() => {
    const away = (e: Event) => {
      const el = elRef.current;
      if (el && !el.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const close = () => onClose();
    // capture-phase so a scroll inside any container closes the menu too
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  const buttons = (): HTMLButtonElement[] =>
    elRef.current
      ? [...elRef.current.querySelectorAll<HTMLButtonElement>("button:not([disabled])")]
      : [];

  // Focus the first item on open so Enter/arrows work immediately.
  useEffect(() => {
    queueMicrotask(() => buttons()[0]?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  function onKeyDown(e: React.KeyboardEvent) {
    const bs = buttons();
    if (bs.length === 0) return;
    const i = bs.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === "ArrowDown") next = i < 0 ? 0 : (i + 1) % bs.length;
    else if (e.key === "ArrowUp") next = i < 0 ? bs.length - 1 : (i - 1 + bs.length) % bs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = bs.length - 1;
    else if (e.key === "Tab") {
      onClose();
      return;
    } else return;
    e.preventDefault();
    bs[next]?.focus();
  }

  function run(item: Exclude<MenuItem, "separator">) {
    onClose();
    item.action();
  }

  return (
    <div
      ref={elRef}
      className="fixed z-50 min-w-52 rounded-lg bg-surface-raised p-1 shadow-[var(--menu-shadow)] ring-1 ring-surface-border animate-in fade-in-0 zoom-in-95 duration-100 motion-reduce:animate-none"
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        // Render offscreen-invisible until the clamp has measured once, so the
        // unclamped first frame never flashes at the raw cursor coordinates.
        visibility: pos ? "visible" : "hidden",
      }}
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item === "separator" ? (
          <div key={i} className="my-1 h-px bg-border" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            className={`arc-tap flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-surface-hover focus:bg-surface-hover focus:outline-none disabled:opacity-40 disabled:hover:bg-transparent ${
              item.danger ? "text-destructive" : "text-foreground"
            }`}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => run(item)}
          >
            {item.icon ? (
              <item.icon size={15} className="shrink-0 opacity-70" aria-hidden="true" />
            ) : null}
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
