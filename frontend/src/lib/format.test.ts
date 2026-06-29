import { describe, it, expect } from "vitest";
import { formatRam, formatBytes, formatUptime, usedPercent } from "./format";

describe("formatRam", () => {
  it("shows MB under 1 GB and GB at/above 1 GB", () => {
    expect(formatRam(512)).toMatch(/512\s*MB/i);
    expect(formatRam(2048)).toMatch(/2\s*GB/i);
  });
});

describe("formatBytes", () => {
  it("scales to a human unit and dashes empty input", () => {
    expect(formatBytes(0)).toBe("—");
    expect(formatBytes(1024 ** 3)).toMatch(/GB/i);
  });
});

describe("formatUptime", () => {
  it("renders a compact duration and handles missing input", () => {
    expect(formatUptime(undefined)).toBeTypeOf("string");
    expect(formatUptime(3661)).toMatch(/1h/);
  });
});

describe("usedPercent", () => {
  it("computes a clamped percentage and avoids divide-by-zero", () => {
    expect(usedPercent(5, 10)).toBe(50);
    expect(usedPercent(0, 0)).toBe(0);
    expect(usedPercent(20, 10)).toBeLessThanOrEqual(100);
  });
});
