// Home's left sidebar (Multica/Linear): workspace selector · search · the
// user's workspaces list · Graph pinned at the bottom. The sidebar carries
// identity + nav, so there's no separate top app header. Extracted from the
// old Home.svelte's inline <aside> during the React decomposition.

import { Network, Plus, Search } from "lucide-react";

import { useT } from "@/state/i18n";
import type { AuthInfo } from "@/services/identity";
import { avatarLetter } from "@/services/workspaceMenu";
import type { WorkspaceSummary } from "@/services/workspaceApi";
import { openSearchPalette, searchShortcutHint } from "@/components/search/SearchPalette";
import { WorkspaceMenu } from "./WorkspaceMenu";

interface Props {
  auth: AuthInfo;
  workspaces: WorkspaceSummary[];
  selectedWorkspaceId: string | null;
  graphOpen: boolean;
  /** Localized display label (personal-workspace fallback lives in the owner). */
  workspaceLabel: (w: WorkspaceSummary) => string;
  onSelectWorkspace: (id: string) => void;
  onNewWorkspace: () => void;
  onOpenGraph: () => void;
  onSignOut: () => void | Promise<void>;
}

export function Sidebar({
  auth,
  workspaces,
  selectedWorkspaceId,
  graphOpen,
  workspaceLabel,
  onSelectWorkspace,
  onNewWorkspace,
  onOpenGraph,
  onSignOut,
}: Props) {
  const t = useT();

  return (
    <aside className="flex w-64 shrink-0 flex-col gap-1 px-2 pt-2 pb-2">
      {/* workspace selector + account dropdown (§1) */}
      <WorkspaceMenu auth={auth} onSignOut={onSignOut} />

      {/* search row (§2): opens the ⌘K / `/` palette; darkens on hover to the
          same neutral veil as the nav rows. Mirrors Multica's search trigger —
          a muted-foreground row with a size-4 icon and a light ⌘K kbd chip. */}
      <button
        type="button"
        className="arc-tap flex h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left text-muted-foreground hover:bg-[var(--color-base-200)] hover:text-foreground"
        onClick={() => openSearchPalette()}
        title={t("home.search")}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center" aria-hidden="true">
          <Search className="h-[18px] w-[18px]" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{t("search.placeholder")}</span>
        <kbd className="pointer-events-none inline-flex h-5 shrink-0 items-center rounded border border-[var(--color-base-300)] bg-[var(--color-base-200)] px-1.5 font-mono text-[10px] font-medium tabular-nums text-muted-foreground select-none">
          {searchShortcutHint}
        </kbd>
      </button>

      {/* workspaces list (§2): the user's workspaces. Clicking one selects it as
          the active workspace, loading its docs into the main pane. The active
          row takes the neutral-gray lifted pill (.ws-row → --lift / --row-hover,
          gray, NOT the accent). A "Workspaces" header carries the (+) New
          workspace affordance (file/folder creation stays in the main toolbar). */}
      <nav
        className="mt-1 flex min-h-0 flex-1 flex-col overflow-y-auto"
        aria-label={t("home.workspaces")}
      >
        <div className="mb-1 flex items-center justify-between gap-1 px-2 pt-1">
          <p className="truncate text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            {t("home.workspaces")}
          </p>
          <button
            type="button"
            className="arc-tap flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--color-base-200)] hover:text-foreground"
            title={t("home.newWorkspace")}
            aria-label={t("home.newWorkspace")}
            onClick={onNewWorkspace}
          >
            <Plus className="h-4 w-4" strokeWidth={2.25} aria-hidden="true" />
          </button>
        </div>
        {workspaces.length === 0 ? (
          <p className="px-2 pt-2 text-xs opacity-50">{t("home.treeEmpty")}</p>
        ) : (
          workspaces.map((w) => {
            const wsLabel = workspaceLabel(w);
            return (
              <button
                key={w.id}
                type="button"
                className={`ws-row arc-tap mb-0.5 flex h-10 w-full cursor-pointer items-center gap-2.5 px-2 text-left ${
                  !graphOpen && selectedWorkspaceId === w.id ? "active" : ""
                }`}
                onClick={() => onSelectWorkspace(w.id)}
              >
                <span
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-base-300)] text-xs font-medium text-foreground/80"
                  aria-hidden="true"
                >
                  {avatarLetter(wsLabel)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{wsLabel}</span>
              </button>
            );
          })
        )}
      </nav>

      {/* Graph pinned at the bottom (§3), same row styling */}
      <div className="mt-1 border-t border-[var(--color-base-300)]/60 pt-1.5">
        <button
          type="button"
          className={`tree-row arc-tap flex w-full cursor-pointer items-center gap-1.5 ${
            graphOpen ? "active" : ""
          }`}
          style={{ padding: "3px 7px 3px 22px" }}
          onClick={onOpenGraph}
        >
          <Network className="h-[15px] w-[15px] shrink-0 opacity-60" aria-hidden="true" />
          <span className="truncate text-sm">{t("home.graph")}</span>
        </button>
      </div>
    </aside>
  );
}

export default Sidebar;
