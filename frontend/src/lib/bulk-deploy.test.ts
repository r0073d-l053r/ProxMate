import { describe, it, expect } from "vitest";
import { expandNamePattern, namePatternError } from "./bulk-deploy";

describe("bulk deploy name patterns", () => {
  it("numbers each copy", () => {
    expect(expandNamePattern("web-{n}", 3)).toBe("web-3");
    expect(expandNamePattern("{n}-web-{n}", 12)).toBe("12-web-12");
  });

  it("needs {n} for several copies, but not one per user", () => {
    expect(namePatternError("web", 2)).toMatch(/\{n\}/);
    expect(namePatternError("web", 1)).toBeNull();
    expect(namePatternError("lab", 5, true)).toBeNull();
    expect(namePatternError("web-{n}", 20)).toBeNull();
  });

  it("refuses names the backend would refuse", () => {
    expect(namePatternError("", 1)).toMatch(/Enter a name/);
    expect(namePatternError("web_{n}", 2)).toMatch(/letters, numbers and hyphens/);
    expect(namePatternError(`${"a".repeat(62)}-{n}`, 10)).toMatch(/63/);
  });
});
