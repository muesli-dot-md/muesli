// Command palette registry. Port of src/lib/commands/registry.svelte.ts.

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

export interface Command {
  id: string;
  title: string;
  hotkey?: string;
  run: () => void;
}

export interface CommandsState {
  commands: Command[];
  register(cmd: Command): void;
  registerAll(cmds: Command[]): void;
  all(): Command[];
}

export const commandsStore = createStore<CommandsState>()((set, get) => ({
  commands: [],
  register(cmd) {
    // Replace if same id already registered
    const list = get().commands;
    const idx = list.findIndex((c) => c.id === cmd.id);
    if (idx !== -1) {
      set({ commands: [...list.slice(0, idx), cmd, ...list.slice(idx + 1)] });
    } else {
      set({ commands: [...list, cmd] });
    }
  },
  registerAll(cmds) {
    for (const cmd of cmds) get().register(cmd);
  },
  all() {
    return get().commands;
  },
}));

export const useCommands = <T>(sel: (s: CommandsState) => T): T => useStore(commandsStore, sel);
