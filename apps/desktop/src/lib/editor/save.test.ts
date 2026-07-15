import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeDebouncedSaver } from "./save";

describe("makeDebouncedSaver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces: only the last scheduled write fires after the delay", async () => {
    const writes: string[] = [];
    const write = vi.fn(async (text: string) => {
      writes.push(text);
    });

    const saver = makeDebouncedSaver(write, 500);
    saver.schedule("first");
    saver.schedule("second");
    saver.schedule("third");

    // Nothing written yet
    expect(write).not.toHaveBeenCalled();

    // Advance past the delay
    await vi.runAllTimersAsync();

    expect(write).toHaveBeenCalledTimes(1);
    expect(writes).toEqual(["third"]);
  });

  it("flush: writes immediately and cancels the pending timer", async () => {
    const writes: string[] = [];
    const write = vi.fn(async (text: string) => {
      writes.push(text);
    });

    const saver = makeDebouncedSaver(write, 500);
    saver.schedule("pending");

    // Flush before timer fires
    await saver.flush();

    expect(write).toHaveBeenCalledTimes(1);
    expect(writes).toEqual(["pending"]);

    // Confirm the timer was cancelled — advancing time fires nothing more
    await vi.runAllTimersAsync();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("flush: is a no-op when nothing is pending", async () => {
    const write = vi.fn(async (_text: string) => {});
    const saver = makeDebouncedSaver(write, 500);

    await saver.flush();

    expect(write).not.toHaveBeenCalled();
  });

  it("schedule after flush creates a new debounce cycle", async () => {
    const writes: string[] = [];
    const write = vi.fn(async (text: string) => {
      writes.push(text);
    });

    const saver = makeDebouncedSaver(write, 500);
    saver.schedule("first");
    await saver.flush();

    // New cycle
    saver.schedule("second");
    await vi.runAllTimersAsync();

    expect(writes).toEqual(["first", "second"]);
  });

  it("cancel drops the pending write and disarms the timer", async () => {
    const writes: string[] = [];
    const write = vi.fn(async (text: string) => {
      writes.push(text);
    });

    const saver = makeDebouncedSaver(write, 500);
    saver.schedule("doomed");
    saver.cancel();
    await vi.runAllTimersAsync();
    expect(write).not.toHaveBeenCalled();

    // A cancelled saver stays usable, and flush after cancel writes nothing.
    await saver.flush();
    expect(write).not.toHaveBeenCalled();
    saver.schedule("kept");
    await vi.runAllTimersAsync();
    expect(writes).toEqual(["kept"]);
  });

  it("multiple schedules reset the timer each time", async () => {
    const writes: string[] = [];
    const write = vi.fn(async (text: string) => {
      writes.push(text);
    });

    const saver = makeDebouncedSaver(write, 500);

    saver.schedule("a");
    vi.advanceTimersByTime(400); // Not yet fired

    saver.schedule("b");
    vi.advanceTimersByTime(400); // Still not fired (timer reset)

    expect(write).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200); // 400+200 = 600 > 500 from last schedule
    await Promise.resolve(); // let microtasks settle

    expect(write).toHaveBeenCalledTimes(1);
    expect(writes).toEqual(["b"]);
  });
});
