import { useEffect, useRef, useState } from "react";
import { History, ListTree, MessageCircle, PencilLine, type LucideIcon } from "lucide-react";

import OutlineRail from "@/components/editor/OutlineRail";
import { CommentsPanel, HistoryPanel, SuggestionsPanel } from "@/components/editor/CollabPanels";
import { useSidebars } from "@/state/sidebars";
import { useDocCollab } from "@/state/docCollab";
import { useCollabSnapshot } from "@/state/collabStore";

// Shared empty-state copy for local-only docs (Global Constraints).
const COLLAB_EMPTY =
  "Comments, suggestions and history become available once this workspace is shared.";

type TabId = "outline" | "comments" | "suggestions" | "history";

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "outline", label: "Outline", icon: ListTree },
  { id: "comments", label: "Comments", icon: MessageCircle },
  { id: "suggestions", label: "Suggestions", icon: PencilLine },
  { id: "history", label: "History", icon: History },
];

/**
 * Right sidebar: a floating card mirroring the editor card (page-canvas
 * surface, rounded-xl, hairline ring + surface shadow, inset on
 * top/right/bottom — the left gap comes from the editor card's right margin)
 * with Outline / Comments / Suggestions / History tabs.
 *
 * `ref` targets the <aside> so AppShell's ResizeHandle can write the width
 * straight to the DOM during a drag (committed to the sidebars store on
 * release).
 */
export default function RightSidebar({ ref }: { ref?: React.Ref<HTMLElement> }) {
  const width = useSidebars((s) => s.right);
  const isRemote = useDocCollab((s) => s.isRemote);
  const store = useDocCollab((s) => s.store);
  // Subscribe to the per-doc CollabStore so `store.tab` reads below stay fresh.
  useCollabSnapshot(store);

  const [active, setActive] = useState<TabId>("outline");

  // Follow the collab store's `tab` when the editor flow switches it (e.g.
  // after creating a comment → "comments", or a suggestion → "suggestions").
  // Tracked off store identity so opening a synced doc doesn't yank the tab on
  // mount; only a CHANGE after the baseline switches the visible tab.
  const storeTab: string | null = store ? (store.tab ?? null) : null;
  const tabStoreRef = useRef<unknown>(null);
  const lastStoreTabRef = useRef<string | null>(null);
  useEffect(() => {
    if (store !== tabStoreRef.current) {
      tabStoreRef.current = store;
      lastStoreTabRef.current = storeTab;
      return;
    }
    if (storeTab && storeTab !== lastStoreTabRef.current) {
      lastStoreTabRef.current = storeTab;
      setActive(storeTab as TabId);
    }
  });

  const activeTab = TABS.find((t) => t.id === active)!;
  const EmptyIcon = activeTab.icon;

  return (
    <aside
      ref={ref}
      className="bg-page-canvas ring-surface-border flex shrink-0 flex-col overflow-hidden rounded-xl shadow-[var(--surface-shadow)] ring-1"
      style={{ width, margin: "0 var(--inset-card) var(--inset-card) 0" }}
    >
      {/* Tab header: compact icon tabs, label shown only on the active tab */}
      <div role="tablist" className="flex shrink-0 items-center gap-1 px-2 py-2">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = active === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className="rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors"
              style={
                isActive
                  ? {
                      background: "var(--lift)",
                      color: "var(--foreground)",
                      boxShadow: "var(--shadow-lift)",
                    }
                  : { color: "var(--text-muted)" }
              }
              onClick={() => setActive(t.id)}
              title={t.label}
            >
              <span className="flex items-center gap-1">
                <Icon size={15} className="shrink-0" />
                {isActive && <span>{t.label}</span>}
              </span>
            </button>
          );
        })}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {active === "outline" ? (
          <OutlineRail />
        ) : isRemote && store ? (
          active === "comments" ? (
            <CommentsPanel store={store} />
          ) : active === "suggestions" ? (
            <SuggestionsPanel store={store} />
          ) : (
            <HistoryPanel store={store} />
          )
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <EmptyIcon size={24} className="text-muted-foreground/70" />
            <p className="text-foreground/70 text-sm font-medium">{activeTab.label}</p>
            <p className="text-muted-foreground/80 text-xs leading-relaxed">{COLLAB_EMPTY}</p>
          </div>
        )}
      </div>
    </aside>
  );
}
