import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { updatesStore, useUpdates } from "@/state/updates";
import { settingsStore, useSettings } from "@/state/settings";

/**
 * Arc-style "update ready" pill at the bottom of the left sidebar with a
 * popover on hover/click/focus. AppShell renders this only while
 * `updates.pillVisible` is true, so mounting doubles as the slide-up entrance.
 * Dismissal: outside pointerdown + Escape (window listeners while open), plus
 * mouse-leave since the popover is hover-driven. keymap.ts is untouched: this
 * popover is not an EscapeLayers target, and the window-Escape fallback no-ops
 * when no tracked overlay is open.
 */
export default function UpdatePill() {
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);

  const state = useUpdates((s) => s.state);
  const version = useUpdates((s) => s.version);
  const progress = useUpdates((s) => s.progress);
  const failureMessage = useUpdates((s) => s.failureMessage);
  const autoUpdate = useSettings((s) => s.autoUpdate);

  const label = failureMessage
    ? "Update failed"
    : state === "downloading"
      ? progress?.total
        ? `Downloading… ${Math.min(100, Math.round((progress.downloaded / progress.total) * 100))}%`
        : "Downloading…"
      : "New Muesli version available";

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement)?.closest?.("[data-update-pill]")) setOpen(false);
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeydown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeydown);
    };
  }, [open]);

  async function restartAndUpdate() {
    if (installing) return;
    setInstalling(true);
    try {
      await updatesStore.getState().installAndRelaunch();
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div
      className="relative shrink-0 px-2 pb-2"
      data-update-pill=""
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {/* The pill: full sidebar width minus padding, subtle raised background,
          slide-up entrance. Focus/click open the same popover for keyboard
          users. The trigger sits FIRST in document order so forward Tab reaches
          the popover controls (checkbox → Restart); the popover still renders
          visually above via its absolute bottom-full anchoring. */}
      <button
        type="button"
        className="arc-tap animate-in fade-in slide-in-from-bottom-1 w-full truncate rounded-full px-3 py-1.5 text-left text-xs font-medium duration-150"
        style={{ background: "var(--lift)", boxShadow: "var(--shadow-lift)" }}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {label}
      </button>
      {open && (
        /* Popover anchored above the pill. The visual gap between pill and card
           is PADDING on this wrapper (not margin on the card) so the cursor
           never leaves [data-update-pill] while crossing it — margin is not
           part of the hover hit area and would fire mouseleave mid-crossing. */
        <div className="absolute inset-x-2 bottom-full z-50 pb-1.5">
          <div
            className="bg-surface-raised ring-surface-border rounded-xl p-3 shadow-[var(--menu-shadow)] ring-1"
            role="dialog"
            aria-label="Update Muesli"
          >
            <p className="text-sm font-medium">Muesli {version ?? ""}</p>
            {failureMessage && <p className="text-destructive mt-1 text-xs">{failureMessage}</p>}
            <label className="mt-2 flex items-center gap-2 text-xs">
              <Checkbox
                className="size-3.5"
                checked={autoUpdate}
                onCheckedChange={(checked) => settingsStore.getState().setAutoUpdate(!!checked)}
              />
              Automatic Updates
            </label>
            <Button
              size="xs"
              className="mt-2 w-full"
              onClick={() => void restartAndUpdate()}
              disabled={installing || state === "downloading" || state === "checking"}
            >
              Restart and Update
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
