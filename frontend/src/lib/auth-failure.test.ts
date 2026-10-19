import { describe, it, expect } from "vitest";
import { retryDelayMs } from "./auth-failure";

describe("retryDelayMs", () => {
  it("backs off 5s, 10s, 20s, 40s and caps at 60s", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(retryDelayMs)).toEqual([5000, 10000, 20000, 40000, 60000, 60000, 60000]);
  });
});
