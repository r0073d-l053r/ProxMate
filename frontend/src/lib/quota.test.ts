import { describe, it, expect } from "vitest";
import { ramGbField, ramMbToSave } from "./quota";

describe("RAM quota field", () => {
  it("shows the quota rounded to whole GB", () => {
    expect(ramGbField(1536)).toBe(2);
    expect(ramGbField(4096)).toBe(4);
  });

  it("keeps a non-GB quota exactly when the RAM field was left alone", () => {
    expect(ramMbToSave(1536, ramGbField(1536))).toBe(1536);
    expect(ramMbToSave(512, ramGbField(512))).toBe(512);
    expect(ramMbToSave(1280, ramGbField(1280))).toBe(1280);
  });

  it("saves the typed GB value once the admin changes it", () => {
    expect(ramMbToSave(1536, 3)).toBe(3072);
    expect(ramMbToSave(4096, 0)).toBe(0);
  });
});
