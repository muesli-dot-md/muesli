// The editor's right collab sidebar: tab strip (comments / suggestions /
// history with badges) + panel host + collapse. Port of src/Sidebar.svelte.
// The panels themselves live in @/components/collab and take the store as an
// explicit prop (stage-2 contract).
import { ChevronsRight, History, MessageCircle, PencilLine, type LucideIcon } from "lucide-react";

import { useT, type MessageKey } from "@/state/i18n";
import { useCollabSnapshot, type CollabStore, type SidebarTab } from "@/state/collabStore";
import { Button } from "@/components/ui/button";
import CommentsPanel from "@/components/collab/CommentsPanel";
import SuggestionsPanel from "@/components/collab/SuggestionsPanel";
import HistoryPanel from "@/components/collab/HistoryPanel";

// Label keys, not labels: t() runs at render so language switches apply.
const tabs: { id: SidebarTab; labelKey: MessageKey; icon: LucideIcon }[] = [
  { id: "comments", labelKey: "sidebar.comments", icon: MessageCircle },
  { id: "suggestions", labelKey: "sidebar.suggestions", icon: PencilLine },
  { id: "history", labelKey: "sidebar.history", icon: History },
];

export default function CollabSidebar({
  store,
  docId,
  shareToken,
}: {
  store: CollabStore;
  /** Doc slug + share token, threaded to CommentsPanel for its backlinks section. */
  docId?: string;
  shareToken?: string | null;
}) {
  const t = useT();
  useCollabSnapshot(store);

  const sidebarOpen = store.sidebarOpen;
  const tab = store.tab;

  function openTab(next: SidebarTab) {
    store.tab = next;
    store.sidebarOpen = true;
  }

  const badge = (id: SidebarTab): number =>
    id === "comments"
      ? store.openThreads.length + store.orphanedThreads.length
      : id === "suggestions"
        ? store.pendingGroups.length
        : 0;

  // History loads lazily: HistoryPanel self-loads the first page on mount, and
  // it only mounts when its tab is open — no host-side trigger needed.

  if (store.availability === "volatile") {
    return (
      <aside className="flex w-12 flex-col items-center border-l border-border bg-background py-3">
        <span
          className="opacity-40"
          title={t("sidebar.collabUnavailable")}
          aria-label={t("sidebar.collabUnavailableLabel")}
        >
          <MessageCircle className="h-5 w-5" aria-hidden="true" />
        </span>
      </aside>
    );
  }

  if (!sidebarOpen) {
    return (
      <aside className="flex w-12 flex-col items-center gap-1 border-l border-border bg-background py-2">
        {tabs.map((tb) => {
          const Icon = tb.icon;
          const count = badge(tb.id);
          return (
            <Button
              key={tb.id}
              variant="ghost"
              size="icon-sm"
              className="relative"
              title={t(tb.labelKey)}
              onClick={() => openTab(tb.id)}
            >
              {count > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[0.6rem] font-semibold leading-none text-primary-foreground">
                  {count}
                </span>
              )}
              <Icon aria-hidden="true" />
            </Button>
          );
        })}
      </aside>
    );
  }

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-background">
      {/* Compact icon tabs, label shown only on the active tab (mirrors the
          desktop app's RightSidebar). */}
      <div className="flex items-center gap-1 px-2 py-2">
        <div role="tablist" className="flex flex-1 items-center gap-1">
          {tabs.map((tb) => {
            const Icon = tb.icon;
            const count = badge(tb.id);
            const selected = tab === tb.id;
            return (
              <button
                key={tb.id}
                role="tab"
                aria-selected={selected}
                className="flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium transition-colors"
                style={
                  selected
                    ? {
                        background: "var(--lift)",
                        color: "var(--color-base-content)",
                        boxShadow: "var(--shadow-lift)",
                      }
                    : { color: "var(--text-muted)" }
                }
                onClick={() => (store.tab = tb.id)}
                title={t(tb.labelKey)}
              >
                <Icon className="h-[15px] w-[15px] shrink-0" aria-hidden="true" />
                {selected && <span>{t(tb.labelKey)}</span>}
                {count > 0 && (
                  <span className="rounded-full bg-muted px-1.5 text-[0.65rem] font-semibold text-muted-foreground">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          title={t("sidebar.collapse")}
          onClick={() => (store.sidebarOpen = false)}
        >
          <ChevronsRight aria-hidden="true" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "comments" ? (
          <CommentsPanel store={store} docId={docId} shareToken={shareToken} />
        ) : tab === "suggestions" ? (
          <SuggestionsPanel store={store} />
        ) : (
          <HistoryPanel store={store} />
        )}
      </div>
    </aside>
  );
}
