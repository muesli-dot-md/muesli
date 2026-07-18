// ⌘O quick switcher — the same cmdk-in-CommandDialog shell as CommandPalette,
// fuzzy-matching over every file in the open workspace tree (flattened,
// workspace-relative display paths). Selecting opens the note in a tab.
import { useEffect, useMemo, useState } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { fuzzyFilter } from "@/services/fuzzy";
import type { WorkspaceNode } from "@/services/tauri";
import { tabsStore } from "@/state/tabs";
import { useWorkspace } from "@/state/workspace";

interface FileItem {
  path: string;
  /** Workspace-relative path shown in the list. */
  display: string;
}

function flattenTree(node: WorkspaceNode, root: string): FileItem[] {
  if (!node.isDir) {
    const display = node.path.startsWith(root + "/")
      ? node.path.slice(root.length + 1)
      : node.path;
    return [{ path: node.path, display }];
  }
  if (!node.children) return [];
  return node.children.flatMap((child) => flattenTree(child, root));
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function QuickSwitcher({ open, onClose }: Props) {
  const [query, setQuery] = useState("");
  const tree = useWorkspace((s: { tree: WorkspaceNode | null }) => s.tree);
  const root = useWorkspace((s: { root: string | null }) => s.root);

  const allFiles = useMemo(
    () => (tree && root ? flattenTree(tree, root) : []),
    [tree, root],
  );
  const filtered = useMemo(
    () => fuzzyFilter(allFiles, query, (f) => f.display),
    [allFiles, query],
  );

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  function openFile(file: FileItem) {
    const name = file.path.split("/").at(-1) ?? file.path;
    tabsStore.getState().open(file.path, name);
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) onClose();
      }}
      title="Quick switcher"
      description="Open a note by name…"
    >
      <Command shouldFilter={false} onKeyDown={handleKeyDown}>
        <CommandInput
          placeholder="Open note…"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>
            {allFiles.length === 0
              ? "No workspace open or no notes found"
              : `No notes match "${query}"`}
          </CommandEmpty>
          {filtered.map((file) => (
            <CommandItem
              key={file.path}
              value={file.path}
              onSelect={() => openFile(file)}
            >
              <span className="truncate">{file.display}</span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

export default QuickSwitcher;
