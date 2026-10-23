import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const post = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { post: (...a: unknown[]) => post(...a) },
  apiError: (e: unknown) => String(e),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { PoolGuestsNotice } from "./pool-guests-notice";
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
  post.mockReset().mockResolvedValue({ data: { pool: "proxmate", moved: [{ vmid: 100, name: "web" }, { vmid: 9000, name: "debian" }] } });
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

  it("renders nothing when every managed guest is in the pool", () => {
    const { container } = render(<PoolGuestsNotice report={report({ outside: [] })} />);
    expect(container.textContent).toBe("");
  });
});
