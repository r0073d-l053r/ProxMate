import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const post = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { post: (...a: unknown[]) => post(...a) },
  apiError: (e: unknown) => String(e),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { PoolGuestsNotice, poolMovePrompt } from "./pool-guests-notice";
import type { PoolReport } from "@/lib/types";

const report = (over: Partial<PoolReport> = {}): PoolReport => ({
  name: "proxmate",
  exists: true,
  missingOnPool: [],
  guestPrivilegesOnRoot: [],
  outside: [
    { vmid: 100, node: "pve1", name: "web", kind: "qemu", template: false, pool: null },
    { vmid: 9000, node: "pve1", name: "debian", kind: "qemu", template: true, pool: "other" },
  ],
  notVisible: [],
  ...over,
});

beforeEach(() => {
  post.mockReset().mockResolvedValue({
    data: {
      pool: "proxmate",
      moved: [
        { vmid: 100, name: "web", template: false, from: null },
        { vmid: 9000, name: "debian", template: true, from: "other" },
      ],
      failed: [],
    },
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(cleanup);

describe("PoolGuestsNotice", () => {
  it("lists the managed guests outside the pool", () => {
    render(<PoolGuestsNotice report={report()} />);
    expect(screen.getByText(/2 guests ProxMate manages are not in the pool/)).toBeTruthy();
    expect(screen.getByText(/web — in no pool/)).toBeTruthy();
    expect(screen.getByText(/debian \(template\) — in pool other/)).toBeTruthy();
  });

  it("moves them on one click and asks the caller to re-test", async () => {
    const onMoved = vi.fn();
    render(<PoolGuestsNotice report={report()} onMoved={onMoved} />);
    fireEvent.click(screen.getByRole("button", { name: /Move managed guests into the pool/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/admin/settings/proxmox/pool/move-guests"));
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith("Moved 2 guests into proxmate.");
  });

  it("reports a refused move and leaves the list in place", async () => {
    post.mockRejectedValue("Permission check failed (/pool/proxmate, Pool.Allocate)");
    const onMoved = vi.fn();
    render(<PoolGuestsNotice report={report()} onMoved={onMoved} />);
    fireEvent.click(screen.getByRole("button", { name: /Move managed guests into the pool/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Pool\.Allocate/)));
    expect(onMoved).not.toHaveBeenCalled();
    expect(screen.getByText(/web — in no pool/)).toBeTruthy();
  });

  it("asks before moving a guest out of another pool, and does nothing on cancel", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<PoolGuestsNotice report={report()} />);
    fireEvent.click(screen.getByRole("button", { name: /Move managed guests into the pool/ }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/9000 debian \(template\) \(pool other\)/));
    expect(post).not.toHaveBeenCalled();
  });

  it("does not ask when no guest is in another pool", () => {
    expect(poolMovePrompt(report({ outside: [report().outside[0]!] }))).toBeNull();
  });

  it("asks about a machine in another pool too", () => {
    const machine = { vmid: 101, node: "pve1", name: "db", kind: "qemu" as const, template: false, pool: "lab" };
    expect(poolMovePrompt(report({ outside: [machine] }))).toMatch(/101 db \(pool lab\)/);
  });

  it("reports each guest Proxmox refused", async () => {
    post.mockResolvedValue({
      data: {
        pool: "proxmate",
        moved: [{ vmid: 100, name: "web", template: false, from: null }],
        failed: [{ vmid: 9000, name: "debian", template: true, from: "other", error: "Permission check failed (/pool/other, Pool.Allocate)" }],
      },
    });
    render(<PoolGuestsNotice report={report()} />);
    fireEvent.click(screen.getByRole("button", { name: /Move managed guests into the pool/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/9000 debian was not moved: .*Pool\.Allocate/), expect.anything()));
    expect(toast.success).toHaveBeenCalledWith("Moved 1 guest into proxmate.");
  });

  it("renders nothing when every managed guest is in the pool", () => {
    const { container } = render(<PoolGuestsNotice report={report({ outside: [] })} />);
    expect(container.textContent).toBe("");
  });
});
