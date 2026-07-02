export interface Command {
  id: string;
  title: string;
  hotkey?: string;
  run: () => void;
}

class CommandRegistry {
  private _commands = $state<Command[]>([]);

  register(cmd: Command): void {
    // Replace if same id already registered
    const idx = this._commands.findIndex((c) => c.id === cmd.id);
    if (idx !== -1) {
      this._commands = [...this._commands.slice(0, idx), cmd, ...this._commands.slice(idx + 1)];
    } else {
      this._commands = [...this._commands, cmd];
    }
  }

  registerAll(cmds: Command[]): void {
    for (const cmd of cmds) this.register(cmd);
  }

  all(): Command[] {
    return this._commands;
  }
}

export const commands = new CommandRegistry();
