import { describe, it, expect, vi } from "vitest";
import { openPopup, pollUntil } from "./ide-launch";

const noSleep = () => Promise.resolve();

describe("pollUntil", () => {
  it("resolves with the first value that satisfies done", async () => {
    const values = ["installing", "installing", "ready"];
    const fetch = vi.fn(async () => values.shift()!);
    const r = await pollUntil({
      fetch,
      done: (s) => s === "ready",
      intervalMs: 3000,
      timeoutMs: 60_000,
      cancelled: () => false,
      sleep: noSleep,
    });
    expect(r).toEqual({ status: "done", value: "ready" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("stops polling once the page is gone", async () => {
    let gone = false;
    const fetch = vi.fn(async () => {
      gone = true; // the user navigates away after the first check
      return "installing";
    });
    const r = await pollUntil({
      fetch,
      done: (s) => s === "ready",
      intervalMs: 3000,
      timeoutMs: 60_000,
      cancelled: () => gone,
      sleep: noSleep,
    });
    expect(r).toEqual({ status: "cancelled" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("gives up at the deadline", async () => {
    let t = 0;
    const r = await pollUntil({
      fetch: async () => "installing",
      done: (s) => s === "ready",
      intervalMs: 3000,
      timeoutMs: 10_000,
      cancelled: () => false,
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
    });
    expect(r).toEqual({ status: "timeout" });
  });
});

describe("openPopup", () => {
  it("reports a window the browser blocked", () => {
    const open = vi.fn(() => null);
    expect(openPopup("/x", "n", "popup", open)).toBe(false);
    expect(open).toHaveBeenCalledWith("/x", "n", "popup");
  });

  it("reports a window that opened", () => {
    expect(openPopup("/x", "n", "popup", () => ({}) as Window)).toBe(true);
  });
});
