import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useIdeInstallFlag } from "./use-ide-install";

const render = (initial: string | null) =>
  renderHook(({ state }: { state: string | null }) => useIdeInstallFlag(state), { initialProps: { state: initial } });

describe("useIdeInstallFlag", () => {
  it("clears once the polled VM shows the install ready, without waiting for the install flow", () => {
    const h = render("none");
    act(() => h.result.current[1](true));
    expect(h.result.current[0]).toBe(true);
    h.rerender({ state: "installing" });
    expect(h.result.current[0]).toBe(true);
    h.rerender({ state: "ready" });
    expect(h.result.current[0]).toBe(false);
  });

  it("clears on a failed install too", () => {
    const h = render("none");
    act(() => h.result.current[1](true));
    h.rerender({ state: "installing" });
    h.rerender({ state: "failed" });
    expect(h.result.current[0]).toBe(false);
  });

  it("is not cleared by the state from before the install started (a reinstall of a ready IDE)", () => {
    const h = render("ready");
    act(() => h.result.current[1](true));
    h.rerender({ state: "ready" });
    expect(h.result.current[0]).toBe(true);
    h.rerender({ state: "installing" });
    h.rerender({ state: "ready" });
    expect(h.result.current[0]).toBe(false);
  });

  it("is cleared by the caller when the flow ends", () => {
    const h = render("none");
    act(() => h.result.current[1](true));
    act(() => h.result.current[1](false));
    expect(h.result.current[0]).toBe(false);
  });
});
