import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

interface ResizeHandleProps {
  /**
   * CSS length shifting the hit area + indicator off the flex boundary so the
   * blue line can hug a floating pane edge that is inset from the boundary —
   * e.g. the editor card's `--inset-card` left margin.
   */
  shift?: string;
  /**
   * Live pointer position (clientX) during the drag. The parent writes the
   * mapped width STRAIGHT to the DOM (no React re-render per move) — the
   * resize contract from Multica's sidebar (base.css).
   */
  onDrag: (clientX: number) => void;
  /** Final pointer position on release — the parent commits to the sidebars store. */
  onEnd: (clientX: number) => void;
  label?: string;
}

/**
 * A zero-width flex item with an absolutely-positioned hit area centered on the
 * boundary it sits at. Arc-style: a colored line on hover/drag. While dragging,
 * `html[data-sidebar-resizing]` is set so base.css forces the ew-resize cursor
 * everywhere and disables width transitions.
 */
export default function ResizeHandle({
  shift = "0px",
  onDrag,
  onEnd,
  label = "Resize sidebar",
}: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  // Callbacks in a ref so a mid-drag re-render never rebinds stale handlers.
  const cbRef = useRef({ onDrag, onEnd });
  cbRef.current = { onDrag, onEnd };

  // Unmount safety: never leave the resize cursor/select-lock stuck if the
  // handle disappears mid-drag (e.g. the sidebar collapses via keyboard).
  useEffect(() => {
    return () => {
      document.documentElement.removeAttribute("data-sidebar-resizing");
      document.body.style.userSelect = "";
    };
  }, []);

  function start(e: React.PointerEvent<HTMLButtonElement>) {
    e.preventDefault();
    setDragging(true);
    document.documentElement.setAttribute("data-sidebar-resizing", "true");
    document.body.style.userSelect = "none";

    let lastX = e.clientX;
    const move = (ev: PointerEvent) => {
      lastX = ev.clientX;
      cbRef.current.onDrag(ev.clientX);
    };
    const up = (ev: PointerEvent) => {
      setDragging(false);
      document.documentElement.removeAttribute("data-sidebar-resizing");
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      cbRef.current.onEnd(Number.isFinite(ev.clientX) ? ev.clientX : lastX);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <div
      className="relative z-20 w-0 shrink-0 self-stretch"
      role="separator"
      aria-orientation="vertical"
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={label}
        className="group absolute inset-y-0 flex w-2 -translate-x-1/2 cursor-col-resize justify-center border-0 bg-transparent p-0"
        style={{ left: shift }}
        onPointerDown={start}
      >
        <span
          className={cn(
            "h-full w-0.5 rounded-full transition-colors duration-100",
            dragging ? "bg-primary" : "bg-transparent group-hover:bg-primary",
          )}
        />
      </button>
    </div>
  );
}
