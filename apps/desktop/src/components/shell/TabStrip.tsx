import { Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { IconButton } from "./IconButton";
import { tabsStore, useTabs, type Tab } from "@/state/tabs";
import { useWorkspace, workspaceStore } from "@/state/workspace";
import { createNote } from "@/services/tauri";

/**
 * Pill tabs in the title strip (`.ttab*` classes from app.css): dirty dot,
 * close button, + new-note button, thin horizontal scroll (`.tab-scroll`).
 */
export default function TabStrip() {
  const open = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const root = useWorkspace((s) => s.root);

  async function handleNewTab() {
    const ws = workspaceStore.getState();
    if (!ws.root) return;
    const newPath = await createNote(ws.root, "Untitled.md");
    await workspaceStore.getState().refresh();
    const name = newPath.split("/").at(-1) ?? newPath;
    tabsStore.getState().open(newPath, name);
  }

  return (
    <div
      className="tab-scroll flex h-full items-center gap-1 overflow-x-auto"
      data-tauri-drag-region=""
    >
      {open.map((tab: Tab) => {
        const isActive = tab.id === activeId;
        return (
          <div
            key={tab.id}
            className={cn(
              "ttab flex max-w-[180px] items-center gap-1 py-1 pr-1 pl-2.5 text-sm whitespace-nowrap select-none",
              isActive ? "ttab-active" : "ttab-inactive",
            )}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
          >
            <button
              type="button"
              className="flex min-w-0 cursor-default items-center gap-1 border-0 bg-transparent p-0 text-sm text-inherit"
              onClick={() => tabsStore.getState().activate(tab.id)}
              aria-label={`Activate ${tab.name}`}
            >
              {tab.dirty && <span className="bg-primary h-1.5 w-1.5 shrink-0 rounded-full" />}
              <span className="truncate">{tab.name}</span>
            </button>
            {/* Close: always present (in flow) so the tab width stays consistent
                and the X never overlaps the filename. */}
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground hover:bg-foreground/10 shrink-0 rounded p-0.5 transition-colors"
              aria-label={`Close ${tab.name}`}
              onClick={(e) => {
                e.stopPropagation();
                tabsStore.getState().close(tab.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}

      <IconButton label="New note" onClick={() => void handleNewTab()} disabled={!root}>
        <Plus size={16} />
      </IconButton>
    </div>
  );
}
