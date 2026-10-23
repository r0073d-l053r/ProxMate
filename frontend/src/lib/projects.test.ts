import { describe, it, expect } from "vitest";
import { normalizeProjectName, projectOf, plainTags, projectNames } from "./projects";

describe("project tags", () => {
  it("normalizes valid names and refuses the rest", () => {
    expect(normalizeProjectName(" Shop ")).toBe("shop");
    expect(normalizeProjectName("team_a-2")).toBe("team_a-2");
    for (const bad of ["", "-x", "a b", "a:b", "x".repeat(33)]) expect(normalizeProjectName(bad)).toBeNull();
  });

  it("splits the project from the plain labels", () => {
    expect(projectOf("prod,project:shop")).toBe("shop");
    expect(projectOf("prod")).toBeNull();
    expect(plainTags("prod,project:shop,web")).toEqual(["prod", "web"]);
    expect(plainTags(null)).toEqual([]);
  });

  it("collects distinct project names for suggestions", () => {
    expect(projectNames([{ tags: "project:b" }, { tags: null }, { tags: "x,project:a" }, { tags: "project:b" }])).toEqual(["a", "b"]);
  });
});
