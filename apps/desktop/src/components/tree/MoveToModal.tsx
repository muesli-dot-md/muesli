// "Move to…" picker — a centered modal listing every eligible destination
// folder (excludes self, descendants, and the current parent). Reuses the
// vault `move_path` Tauri command. Local-first; no server involvement.
// Ported from MoveToModal.svelte; the flush → move_path → retarget → expand →
// refresh sequence is preserved exactly (flush persists pending autosaves to
// the OLD path first, retarget makes open tabs follow the moved entry).

import { useEffect, useState } from "react";
import { Folder, FolderInput } from "lucide-react";
import { movePath } from "@/services/tauri";
import { collectFolderTargets } from "@/services/fileInfo";
import { workspaceStore, useWorkspace } from "@/state/workspace";
import { tabsStore } from "@/state/tabs";

interface Props {
  /** Absolute path of the file/folder being moved. */
  srcPath: string;
  srcName: string;
  onClose: () => void;
  /** Called with the new path after a successful move. */
  onMoved?: (newPath: string) => void;
}

export function MoveToModal({ srcPath, srcName, onClose, onMoved }: Props) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const tree = useWorkspace((s) => s.tree);
  const root = useWorkspace((s) => s.root);

  const targets = tree && root ? collectFolderTargets(tree, root, srcPath) : [];

  // The modal owns its Escape (capture + preventDefault per the modal
  // contract) so the global fallback in services/keymap.ts never sees it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  async function moveTo(destDir: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await tabsStore.getState().flush(srcPath);
      const newPath = await movePath(srcPath, destDir);
      tabsStore.getState().retarget(srcPath, newPath);
      workspaceStore.getState().expand(destDir);
      await workspaceStore.getState().refresh();
      onMoved?.(newPath);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  function handleBackdropClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/10 pt-[14vh] backdrop-blur-xs"
      onClick={handleBackdropClick}
      role="presentation"
    >
      <div
        className="mx-4 flex max-h-[64vh] w-full max-w-md flex-col overflow-hidden rounded-xl bg-surface-raised shadow-[var(--floating-shadow)] ring-1 ring-surface-border animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 duration-100 motion-reduce:animate-none"
        role="dialog"
        aria-modal="true"
        aria-label={`Move ${srcName}`}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <FolderInput size={16} className="shrink-0 opacity-60" />
          <span className="truncate text-sm font-medium">Move “{srcName}” to…</span>
        </div>

        {error ? <p className="px-4 py-2 text-xs text-destructive">{error}</p> : null}

        <div className="min-h-0 overflow-y-auto py-1">
          {targets.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">No other folder to move into.</p>
          ) : (
            targets.map((t) => (
              <button
                key={t.path}
                type="button"
                className="arc-tap flex min-h-10 w-full items-center gap-2 px-4 py-1.5 text-left text-sm transition-colors hover:bg-surface-hover focus:bg-surface-hover focus:outline-none disabled:opacity-50"
                style={{ paddingLeft: `${12 + t.depth * 14}px` }}
                disabled={busy}
                onClick={() => void moveTo(t.path)}
              >
                <Folder size={15} className="shrink-0 text-muted-foreground" />
                <span className="truncate">{t.label}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
