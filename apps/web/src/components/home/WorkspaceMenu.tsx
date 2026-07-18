// Account-focused dropdown that anchors the top of the sidebar (web variant —
// ported from the web's WorkspaceMenu.svelte, NOT the desktop workspace
// switcher). The button face is the app brand ("Muesli") — workspace SWITCHING
// lives in the sidebar's workspaces list and the active workspace is named
// there, so repeating it here would suggest this menu selects workspaces. It is
// profile/settings/logout only: the signed-in user's identity header, a
// Settings entry, and a red "Log out". Selection/hover use a NEUTRAL gray
// rounded background, never the accent. Yjs-free (identity types only); pure
// identity logic lives in services/workspaceMenu.ts.

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, LogOut, Settings } from "lucide-react";

import { useT } from "@/state/i18n";
import { gotoSettings } from "@/state/route";
import type { AuthInfo } from "@/services/identity";
import { menuIdentity } from "@/services/workspaceMenu";

interface Props {
  auth: AuthInfo;
  onSignOut: () => void | Promise<void>;
}

function SquareAvatar({ letter, className }: { letter: string; className: string }) {
  return (
    <span
      className={`${className} flex items-center justify-center rounded-md bg-[var(--color-base-300)] text-xs font-medium text-foreground/80`}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

export function WorkspaceMenu({ auth, onSignOut }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);

  const identity = useMemo(() => (auth.user ? menuIdentity(auth.user) : null), [auth.user]);

  /** Run an action, then dismiss the menu. */
  function act(fn: () => void) {
    fn();
    setOpen(false);
  }

  // Dismiss on outside-click / Escape (the dropdown is a controlled popover so
  // menu actions can keep their own focus).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement)?.closest?.("[data-workspace-menu]")) setOpen(false);
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

  return (
    <div className="relative" data-workspace-menu>
      {/* brand face: square "M" avatar + "Muesli" + chevron, subtle neutral
          hover (no accent). 40px tall hit area. Opens the account menu
          (workspace switching lives in the sidebar list below). */}
      <button
        type="button"
        className={`arc-tap flex h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left hover:bg-[var(--color-base-200)] ${
          open ? "bg-[var(--color-base-200)]" : ""
        }`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <SquareAvatar letter="M" className="h-6 w-6 shrink-0" />
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium"
          style={{ textWrap: "balance" }}
        >
          Muesli
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 opacity-50 transition-transform duration-150 ${
            open ? "rotate-180" : ""
          }`}
          aria-hidden="true"
        />
      </button>

      {open && (
        // account dropdown: raised surface, soft overlay shadow over a hairline
        // ring (not a hard border). Content-hugging (w-max) so the panel is only
        // as wide as its widest row (usually the email), floored at min-w-56 and
        // capped at max-w-72. Compact p-1, hairline ring, neutral gray hover.
        <div
          className="absolute top-11 left-0 z-30 w-max min-w-56 max-w-72 rounded-xl bg-surface-raised p-1 shadow-[var(--shadow-overlay)] ring-1 ring-surface-border"
          role="menu"
        >
          {identity && (
            <>
              {/* identity header: 32px avatar (photo or id-colored initials) +
                  name + muted email, tight leading. */}
              <div className="flex items-center gap-2 px-1.5 py-1.5">
                {identity.avatarUrl ? (
                  <img
                    src={identity.avatarUrl}
                    alt=""
                    className="h-8 w-8 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium text-white"
                    style={{ backgroundColor: identity.color }}
                    aria-hidden="true"
                  >
                    {identity.initials}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate text-sm leading-tight font-medium"
                    style={{ textWrap: "balance" }}
                  >
                    {identity.name}
                  </p>
                  {identity.email && (
                    <p className="truncate text-xs leading-tight opacity-60">{identity.email}</p>
                  )}
                </div>
              </div>
              <div className="my-1 h-px bg-[var(--color-base-300)]/70" aria-hidden="true" />
            </>
          )}

          {/* settings (workspace switching lives in the sidebar list now) */}
          <button
            type="button"
            className="arc-tap flex h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-surface-hover"
            role="menuitem"
            onClick={() => act(() => gotoSettings())}
          >
            <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
              <Settings className="size-4 opacity-70" />
            </span>
            <span className="min-w-0 flex-1 truncate">{t("common.settings")}</span>
          </button>

          {identity && (
            <>
              <div className="my-1 h-px bg-[var(--color-base-300)]/70" aria-hidden="true" />
              <button
                type="button"
                className="arc-tap flex h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm text-destructive hover:bg-destructive/10"
                role="menuitem"
                onClick={() => act(() => void onSignOut())}
              >
                <span
                  className="flex size-5 shrink-0 items-center justify-center"
                  aria-hidden="true"
                >
                  <LogOut className="size-4" />
                </span>
                <span className="min-w-0 flex-1 truncate">{t("account.signOut")}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default WorkspaceMenu;
