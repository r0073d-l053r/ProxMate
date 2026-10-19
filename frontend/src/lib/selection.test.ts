import { describe, it, expect } from "vitest";
import { visibleSelection } from "./selection";

const vms = [
  { id: "a", name: "web-1" },
  { id: "b", name: "old-db" },
  { id: "c", name: "cache" },
];

describe("visibleSelection", () => {
  it("drops selected items the active filter hides", () => {
    const selected = new Set(["a", "b"]);
    const shown = [vms[1]!, vms[2]!]; // filter now shows only old-db + cache
    expect(visibleSelection(selected, shown)).toEqual([vms[1]]);
  });

  it("keeps the on-screen order and ignores ids that no longer exist", () => {
    const selected = new Set(["c", "gone", "a"]);
    expect(visibleSelection(selected, vms).map((v) => v.id)).toEqual(["a", "c"]);
  });

  it("is empty when nothing visible is selected", () => {
    expect(visibleSelection(new Set(["a"]), [vms[2]!])).toEqual([]);
  });
});
