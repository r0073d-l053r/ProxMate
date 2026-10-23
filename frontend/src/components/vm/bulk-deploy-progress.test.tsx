import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const get = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get: (...a: unknown[]) => get(...a) },
  apiError: (e: unknown) => String(e),
}));

import { BulkDeployProgress } from "./bulk-deploy-progress";
import type { DeployBatch } from "@/lib/bulk-deploy";

const batch = (over: Partial<DeployBatch> = {}): DeployBatch => ({
  id: "b1",
  templateName: "Debian 12",
  finishedAt: "2026-10-23T12:00:00Z",
  items: [
    { index: 0, name: "web-1", userId: "u1", vmId: "vm1", proxmoxVmId: 100, node: "pve1", status: "done" },
    { index: 1, name: "web-2", userId: "u1", vmId: "vm2", proxmoxVmId: 101, node: "pve2", status: "failed", error: "storage full" },
  ],
  ...over,
});

// Braces: a function returned from beforeEach would run as its teardown.
beforeEach(() => {
  get.mockReset();
});
afterEach(cleanup);

describe("BulkDeployProgress", () => {
  it("reports each copy's result once the batch has finished", async () => {
    get.mockResolvedValue({ data: batch() });
    render(<BulkDeployProgress batchId="b1" />);
    await screen.findByText(/Finished: 1 deployed, 1 failed/);
    expect(get).toHaveBeenCalledWith("/templates/deploy-bulk/b1");
    expect(screen.getByText(/VMID 101 on pve2 · failed — storage full/)).toBeTruthy();
    // Only a deployed copy links to its machine.
    expect(screen.getAllByText("Open")).toHaveLength(1);
    expect(screen.getByText("Open").closest("a")?.getAttribute("href")).toBe("/vms/vm1");
  });

  it("stops polling and says so when the batch is no longer known", async () => {
    get.mockImplementation(async () => {
      throw Object.assign(new Error("Not Found"), { response: { status: 404 } });
    });
    render(<BulkDeployProgress batchId="b1" />);
    await screen.findByText(/progress is no longer available/);
    await new Promise((r) => setTimeout(r, 3500)); // longer than one poll interval
    expect(get).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Go to machines")).toBeTruthy();
  });

  it("shows progress while copies are still deploying", async () => {
    get.mockResolvedValue({
      data: batch({
        finishedAt: null,
        items: [
          { index: 0, name: "web-1", userId: "u1", vmId: "vm1", proxmoxVmId: 100, node: "pve1", status: "deploying" },
          { index: 1, name: "web-2", userId: "u1", vmId: "vm2", proxmoxVmId: 101, node: "pve1", status: "queued" },
        ],
      }),
    });
    render(<BulkDeployProgress batchId="b1" />);
    await screen.findByText(/0 of 2 deployed/);
    expect(screen.queryByText("Go to machines")).toBeNull();
  });
});
