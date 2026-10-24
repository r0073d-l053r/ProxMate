import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { startPoll } from "./poll";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("startPoll", () => {
  it("does not let a hung request block the polls after it", async () => {
    const signals: AbortSignal[] = [];
    const run = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      // The first request never answers; later ones answer at once.
      return run.mock.calls.length === 1 ? new Promise<void>(() => undefined) : Promise.resolve();
    });
    const stop = startPoll({ run, intervalMs: 2500, timeoutMs: 15_000 });

    expect(run).toHaveBeenCalledTimes(1);
    // While the hung request is inside its timeout, ticks are skipped (no stacking).
    await vi.advanceTimersByTimeAsync(12_500);
    expect(run).toHaveBeenCalledTimes(1);
    expect(signals[0]!.aborted).toBe(false);

    // Past the timeout it is abandoned and the next tick polls again.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(signals[0]!.aborted).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(4);
    stop();
  });

  it("skips a tick while the previous request is still going", async () => {
    let answer!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => (answer = r)));
    const stop = startPoll({ run, intervalMs: 2500, timeoutMs: 15_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(1);
    answer();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it("keeps polling after a failed request", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("502")).mockResolvedValue(undefined);
    const stop = startPoll({ run, intervalMs: 2500 });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it("pauses while inactive and stops when told", async () => {
    let visible = false;
    const run = vi.fn(() => Promise.resolve());
    const stop = startPoll({ run, intervalMs: 2500, active: () => visible });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).not.toHaveBeenCalled();
    visible = true;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(run).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
