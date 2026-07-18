// Multica/Linear-style workspace + account switcher for the desktop sidebar —
// ported from WorkspaceMenu.svelte. A selector face (square letter avatar +
// active workspace name + chevron) opens a tight dropdown with: the signed-in
// sync identity (avatar/initials + name + email) when logged in, the
// registered workspace list (a check marks the OPEN one), Open local folder… /
// Create remote workspace…, a Settings entry, and a red Sign out. Selection/
// hover use a NEUTRAL rounded background (hover:bg-surface-hover), never the
// accent. Tight metrics: p-1 panel, h-8 rows, px-1.5 py-1 gap-2, size-4 icons.
//
// Adapted to the desktop's local-first model: "account" is the optional sync
// identity (workspaces.identity, may be null); workspaces are local/cloud/
// cloned folders (workspaces.list); the active one is whichever folder is open
// in the tree. The add/clone/move/promote/create-remote flows live HERE (one
// dropdown, no second picker): a cloud-only row clones on click, a cloned row
// grows a "Move folder…" trailing action, a local-only row grows "Promote".
//
// `open` is controlled ({open, onOpenChange}) so AppShell can open the menu
// programmatically (command palette, no-last-workspace fallback, onboarding's
// local fork).

import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  Cloud,
  FolderOpen,
  FolderSymlink,
  LogOut,
  Settings,
} from "lucide-react";
import { colorFromId, initials as initialsFrom } from "@/services/presence";
import { pickFolder, prepareCloneDir, type WorkspaceView } from "@/services/tauri";
import { workspacesStore, useWorkspaces } from "@/state/workspaces";
import { useWorkspace } from "@/state/workspace";
import { CreateWorkspaceModal } from "@/components/setup/CreateWorkspaceModal";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";

export interface WorkspaceMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the desktop settings view in the main panel. */
  onSettings: () => void;
  /** Opens AppShell's sign-in dialog (server shown + Change…) — the dialog is
   *  upstream of workspaces.login(); this menu never calls login directly. */
  onSignIn: () => void;
}

/** Square letter avatar shared by the selector face and the workspace rows. */
function SquareAvatar({ letter, className }: { letter: string; className: string }) {
  return (
    <span
      className={`${className} flex items-center justify-center rounded-md bg-muted text-xs font-medium text-foreground/80`}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

const rowClass =
  "arc-tap flex h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-surface-hover";

export function WorkspaceMenu({ open, onOpenChange, onSettings, onSignIn }: WorkspaceMenuProps) {
  const list: WorkspaceView[] = useWorkspaces((s) => s.list);
  const rawIdentity = useWorkspaces((s) => s.identity);
  const activeServer: string | null = useWorkspaces((s) => s.activeServer);
  const cloning: boolean = useWorkspaces((s) => s.cloning);
  const busy: boolean = useWorkspaces((s) => s.busy);
  const root: string | null = useWorkspace((s) => s.root);

  // Refresh the list on every open, however the menu was opened (face click,
  // palette command, startup fallback).
  useEffect(() => {
    if (open) void workspacesStore.getState().refresh();
  }, [open]);

  /** The active workspace is the one whose folder matches the open tree root. */
  const isActive = (view: WorkspaceView): boolean => !!view.local_path && view.local_path === root;
  const activeName = list.find(isActive)?.name ?? "Select workspace";
  const activeLetter = (activeName.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();

  // Identity header: derived from the optional sync identity. Initials + a
  // stable color come from the shared presence helper (same derivation as the
  // webapp / presence stack), keyed on the user id so a person is one color
  // everywhere.
  const identity = (() => {
    const id = rawIdentity;
    if (!id || (!id.email && !id.display_name)) return null;
    const name: string = id.display_name?.trim() || id.email?.trim() || "—";
    return {
      name,
      email: id.email as string | null,
      avatarUrl: (id.avatar_url ?? null) as string | null,
      initials: initialsFrom(name),
      color: colorFromId(id.id ?? name).color,
    };
  })();
  // Whether sign-in even applies (open servers need no login).
  const openMode = rawIdentity?.mode === "open";
  const loggedIn = rawIdentity != null && !!activeServer;

  // ── Create-remote entry (runs the shared setup wizard) ────────────────────
  const [showCreateWizard, setShowCreateWizard] = useState(false);

  const close = () => onOpenChange(false);
  /** Run an action, then dismiss the menu. */
  function act(fn: () => void) {
    fn();
    close();
  }

  async function selectWorkspace(view: WorkspaceView) {
    const ws = workspacesStore.getState();
    // Cloud-only clones on click: pick where the workspace's folder goes; the
    // folder itself is created for it, named after the workspace.
    if (view.state === "cloud-only") {
      if (ws.cloning) return;
      const parent = await pickFolder();
      if (!parent) return;
      close();
      const path = await prepareCloneDir(parent, view.name);
      // openWorkspaceView flips workspaces.cloning while the pull runs.
      await workspacesStore.getState().openWorkspaceView(view, path);
      return;
    }
    close();
    await workspacesStore.getState().openWorkspaceView(view);
  }

  async function move(view: WorkspaceView) {
    if (workspacesStore.getState().busy || !view.local_path) return;
    const parent = await pickFolder();
    if (!parent) return;
    close();
    await workspacesStore.getState().relocateWorkspace(view, parent);
  }

  async function promote(view: WorkspaceView) {
    if (workspacesStore.getState().busy) return;
    const ok = confirm(
      `Promote "${view.name}" to a shared workspace on the server? ` +
        `Your local files stay where they are and start syncing.`,
    );
    if (!ok) return;
    close();
    await workspacesStore.getState().promoteLocalToRemote(view);
  }

  async function openLocal() {
    close();
    const path = await pickFolder();
    if (!path) return;
    const name = path.split("/").filter(Boolean).pop() ?? path;
    await workspacesStore.getState().openLocalFolder(path, name);
  }

  return (
    <>
      <div className="relative min-w-0 flex-1" data-workspace-menu>
        <Popover open={open} onOpenChange={(next: boolean) => onOpenChange(next)}>
          {/* selector face: square letter avatar + workspace name + chevron,
              subtle neutral hover (no accent). */}
          <PopoverTrigger
            className={`arc-tap flex h-8 w-full items-center gap-2 rounded-lg px-1.5 text-left hover:bg-surface-hover ${
              open ? "bg-surface-hover" : ""
            }`}
            aria-haspopup="menu"
            aria-expanded={open}
          >
            <SquareAvatar letter={activeLetter} className="size-5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{activeName}</span>
            <ChevronDown
              size={14}
              className={`shrink-0 opacity-50 transition-transform duration-150 ${
                open ? "rotate-180" : ""
              }`}
              aria-hidden="true"
            />
          </PopoverTrigger>

          {/* dropdown: raised surface, menu-tier shadow over a hairline ring
              (not a hard border). Content-hugging (w-max) floored at min-w-56
              and capped at max-w-72 so a long email truncates. Tight p-1 / h-8
              rows / size-4 icons. */}
          <PopoverContent
            align="start"
            sideOffset={4}
            className="block w-max min-w-56 max-w-72 gap-0 rounded-lg p-1"
            role="menu"
          >
            {identity ? (
              <>
                {/* identity header: 32px avatar (photo or id-colored initials)
                    + name + muted email, tight leading. */}
                <div className="flex items-center gap-2 px-1.5 py-1.5">
                  {identity.avatarUrl ? (
                    <img
                      src={identity.avatarUrl}
                      alt=""
                      className="size-8 shrink-0 rounded-full object-cover"
                    />
                  ) : (
                    <span
                      className="flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-medium text-white"
                      style={{ backgroundColor: identity.color }}
                      aria-hidden="true"
                    >
                      {identity.initials}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm leading-tight font-medium">{identity.name}</p>
                    {identity.email ? (
                      <p className="truncate text-xs leading-tight opacity-60">{identity.email}</p>
                    ) : null}
                  </div>
                </div>
                <div className="my-1 h-px bg-border" aria-hidden="true" />
              </>
            ) : null}

            {/* workspaces: sentence-case muted eyebrow. Each row is the switch
                target; cloned rows grow a trailing "Move folder…" action,
                local-only rows (when signed in) a "Promote" action. */}
            <p className="px-1.5 pt-0.5 pb-1 text-xs font-medium text-muted-foreground">
              Workspaces
            </p>
            {list.map((view) => (
              <div key={view.id} className="flex items-center gap-0.5">
                <button
                  type="button"
                  className="arc-tap flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-surface-hover"
                  role="menuitem"
                  onClick={() => void selectWorkspace(view)}
                >
                  <SquareAvatar
                    letter={(view.name.trim()[0] ?? "?").toUpperCase()}
                    className="size-5 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate">{view.name}</span>
                  {view.state === "cloud-only" ? (
                    cloning ? (
                      <Spinner className="size-3.5 shrink-0" />
                    ) : (
                      <span className="shrink-0 text-[10px] opacity-40">not downloaded</span>
                    )
                  ) : isActive(view) ? (
                    <Check size={16} className="shrink-0 text-primary" aria-hidden="true" />
                  ) : null}
                </button>

                {view.state === "cloned" ? (
                  <button
                    type="button"
                    className="arc-tap flex size-8 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-surface-hover hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
                    title="Move folder…"
                    disabled={busy}
                    onClick={() => void move(view)}
                  >
                    <FolderSymlink size={15} aria-hidden="true" />
                  </button>
                ) : null}

                {view.state === "local-only" && loggedIn ? (
                  <button
                    type="button"
                    className="arc-tap flex size-8 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-surface-hover hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
                    title="Promote to a shared workspace"
                    disabled={busy}
                    onClick={() => void promote(view)}
                  >
                    {busy ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      <Cloud size={15} aria-hidden="true" />
                    )}
                  </button>
                ) : null}
              </div>
            ))}

            <button
              type="button"
              className={`${rowClass} opacity-80 hover:opacity-100`}
              role="menuitem"
              onClick={() => void openLocal()}
            >
              <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
                <FolderOpen size={16} />
              </span>
              <span className="min-w-0 flex-1 truncate">Open local folder…</span>
            </button>

            {loggedIn ? (
              <button
                type="button"
                className={`${rowClass} opacity-80 hover:opacity-100 disabled:pointer-events-none disabled:opacity-40`}
                role="menuitem"
                disabled={busy}
                onClick={() => act(() => setShowCreateWizard(true))}
              >
                <span
                  className="flex size-5 shrink-0 items-center justify-center"
                  aria-hidden="true"
                >
                  <Cloud size={16} />
                </span>
                <span className="min-w-0 flex-1 truncate">Create remote workspace…</span>
              </button>
            ) : null}

            <div className="my-1 h-px bg-border" aria-hidden="true" />

            {/* settings (opens the desktop settings view in the main panel;
                theme selection lives there — Appearance → Theme cards — by
                user choice, no quick toggle here) */}
            <button
              type="button"
              className={rowClass}
              role="menuitem"
              onClick={() => act(onSettings)}
            >
              <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
                <Settings size={16} className="opacity-70" />
              </span>
              <span className="min-w-0 flex-1 truncate">Settings</span>
            </button>

            {/* auth: Sign out when signed in; Sign in when an auth-gated
                server has no identity. Open servers need no sign-in, so
                neither row shows. */}
            {identity ? (
              <>
                <div className="my-1 h-px bg-border" aria-hidden="true" />
                <button
                  type="button"
                  className="arc-tap flex h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm text-destructive hover:bg-destructive/10"
                  role="menuitem"
                  onClick={() => act(() => void workspacesStore.getState().logout())}
                >
                  <span
                    className="flex size-5 shrink-0 items-center justify-center"
                    aria-hidden="true"
                  >
                    <LogOut size={16} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">Sign out</span>
                </button>
              </>
            ) : !openMode ? (
              <>
                <div className="my-1 h-px bg-border" aria-hidden="true" />
                <button
                  type="button"
                  className={rowClass}
                  role="menuitem"
                  onClick={() => act(onSignIn)}
                >
                  <span
                    className="flex size-5 shrink-0 items-center justify-center"
                    aria-hidden="true"
                  >
                    <LogOut size={16} className="opacity-70" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">Sign in…</span>
                </button>
              </>
            ) : null}
          </PopoverContent>
        </Popover>
      </div>

      {showCreateWizard ? (
        <CreateWorkspaceModal onClose={() => setShowCreateWizard(false)} />
      ) : null}
    </>
  );
}
