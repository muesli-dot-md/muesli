// ⌘P command palette — cmdk Command inside the shadcn CommandDialog shell at
// top-1/3 (Multica style). Filtering goes through the app's own subsequence
// fuzzy scorer (services/fuzzy) instead of cmdk's built-in matcher so ranking
// matches the Svelte palette exactly; cmdk still provides list semantics,
// arrow-key navigation and Enter-to-select. Escape is handled here with
// preventDefault (modal-owns-Escape convention; keymap.ts only has the
// fallback).
import { useEffect, useMemo, useState } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { fuzzyFilter } from "@/services/fuzzy";
import { useCommands } from "@/state/commands";

/** Structural mirror of the registry's Command (state/commands). */
interface PaletteCommand {
  id: string;
  title: string;
  hotkey?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: Props) {
  const [query, setQuery] = useState("");
  const all = useCommands((s: { all: () => PaletteCommand[] }) => s.all());

  const filtered = useMemo(() => fuzzyFilter(all, query, (c) => c.title), [all, query]);

  // Reset the query on every open so the palette always starts fresh.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  function runCommand(cmd: PaletteCommand) {
    onClose();
    cmd.run();
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
      title="Command palette"
      description="Type a command to run…"
    >
      {/* cmdk's own filter is off — ranking comes from services/fuzzy. */}
      <Command shouldFilter={false} onKeyDown={handleKeyDown}>
        <CommandInput placeholder="Type a command…" value={query} onValueChange={setQuery} />
        <CommandList>
          <CommandEmpty>No commands found</CommandEmpty>
          {filtered.map((cmd) => (
            <CommandItem key={cmd.id} value={cmd.id} onSelect={() => runCommand(cmd)}>
              <span className="truncate">{cmd.title}</span>
              {cmd.hotkey ? <Kbd className="ml-auto shrink-0">{cmd.hotkey}</Kbd> : null}
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

export default CommandPalette;
