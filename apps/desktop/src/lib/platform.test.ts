import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Tauri invoke layer so we can drive both platform commands per-test.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

// Import AFTER the mock is registered. Each test re-imports a fresh module so
// the store's cached init promise doesn't leak across tests.
async function freshPlatform() {
  vi.resetModules();
  return (await import('./platform.svelte')).platform;
}

/** invoke stub answering both platform commands. */
function answer(transcription: boolean, macos: boolean) {
  invoke.mockImplementation(async (cmd: unknown) => {
    if (cmd === 'transcription_supported') return transcription;
    if (cmd === 'platform_is_macos') return macos;
    throw new Error(`unexpected command: ${String(cmd)}`);
  });
}

describe('platform store', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('defaults to transcription = false and macos = false before init', async () => {
    const platform = await freshPlatform();
    expect(platform.transcription).toBe(false);
    expect(platform.macos).toBe(false);
  });

  it('reflects both commands after init (macOS)', async () => {
    answer(true, true);
    const platform = await freshPlatform();
    await platform.init();
    expect(invoke).toHaveBeenCalledWith('transcription_supported');
    expect(invoke).toHaveBeenCalledWith('platform_is_macos');
    expect(platform.transcription).toBe(true);
    expect(platform.macos).toBe(true);
  });

  it('stays false on non-macOS', async () => {
    answer(false, false);
    const platform = await freshPlatform();
    await platform.init();
    expect(platform.transcription).toBe(false);
    expect(platform.macos).toBe(false);
  });

  it('fails closed (both false) when the commands are unavailable', async () => {
    invoke.mockRejectedValue(new Error('command not found'));
    const platform = await freshPlatform();
    await platform.init();
    expect(platform.transcription).toBe(false);
    expect(platform.macos).toBe(false);
  });

  it('init is idempotent — each command invoked exactly once across repeated calls', async () => {
    answer(true, true);
    const platform = await freshPlatform();
    await platform.init();
    await platform.init();
    expect(invoke).toHaveBeenCalledTimes(2); // one per command, not per call
  });

  it('a concurrent second await init() resolves only after the values are populated', async () => {
    // The old boolean latch let a second caller return while the first invoke
    // was still in flight; the cached promise must not.
    let release!: (v: boolean) => void;
    const gate = new Promise<boolean>((resolve) => { release = resolve; });
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'transcription_supported' ? gate : true,
    );
    const platform = await freshPlatform();
    const first = platform.init();
    const second = platform.init();
    release(true);
    await second;
    expect(platform.transcription).toBe(true);
    expect(platform.macos).toBe(true);
    await first;
  });
});
