import { describe, it, expect, vi } from "vitest";
import { openReadyIde } from "./ide-open";

function fakeWindow() {
  return { location: { href: "about:blank" }, close: vi.fn() } as unknown as Window & { close: ReturnType<typeof vi.fn> };
}

describe("openReadyIde", () => {
  it("opens the window before awaiting the status check (keeps the click's popup permission)", async () => {
    const order: string[] = [];
    const w = fakeWindow();
    const open = vi.fn(() => {
      order.push("open");
      return w;
    });
    const check = vi.fn(async () => {
      order.push("check");
      return false;
    });
    const p = openReadyIde({ open, proxyUrl: "/api/ide/vm1/proxy/", checkReinstall: check });
    expect(order).toEqual(["open", "check"]);
    expect(await p).toBe("opened");
    expect(w.location.href).toBe("/api/ide/vm1/proxy/");
  });

  it("closes the blank window and reports a reinstall when the install is out of date", async () => {
    const w = fakeWindow();
    const r = await openReadyIde({ open: () => w, proxyUrl: "/x/", checkReinstall: async () => true });
    expect(r).toBe("reinstall");
    expect(w.close).toHaveBeenCalled();
    expect(w.location.href).toBe("about:blank");
  });

  it("still opens the IDE if the status check fails", async () => {
    const w = fakeWindow();
    const r = await openReadyIde({
      open: () => w,
      proxyUrl: "/x/",
      checkReinstall: async () => {
        throw new Error("network");
      },
    });
    expect(r).toBe("opened");
    expect(w.location.href).toBe("/x/");
  });

  it("reports blocked when the browser refuses both the blank window and the retry", async () => {
    const open = vi.fn(() => null);
    const r = await openReadyIde({ open, proxyUrl: "/x/", checkReinstall: async () => false });
    expect(r).toBe("blocked");
    expect(open).toHaveBeenCalledTimes(2);
  });
});
