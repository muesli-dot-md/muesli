/**
 * Pure debounced-saver factory.
 * No DOM or Tauri imports — safe for unit testing with fake timers.
 */
export interface DebouncedSaver {
  /** Schedule a write; resets the pending timer. */
  schedule(text: string): void;
  /** Cancel any pending timer and write immediately. Returns the write promise. */
  flush(): Promise<void>;
}

export function makeDebouncedSaver(
  write: (text: string) => Promise<void>,
  delayMs = 500
): DebouncedSaver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: string | null = null;

  function schedule(text: string): void {
    pending = text;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const toWrite = pending;
      pending = null;
      if (toWrite !== null) {
        write(toWrite).catch(() => {
          // Silently ignore write errors during autosave;
          // flush() callers get the rejection.
        });
      }
    }, delayMs);
  }

  async function flush(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const toWrite = pending;
    pending = null;
    if (toWrite !== null) {
      await write(toWrite);
    }
  }

  return { schedule, flush };
}
