import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const patch = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { patch: (...a: unknown[]) => patch(...a), get: vi.fn() },
  apiError: (e: unknown) => String(e),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

import { ResizeDialog } from "./resize-dialog";
import type { VmDetail } from "@/lib/types";

const vm = (over: Partial<VmDetail> = {}) =>
  ({ id: "vm1", name: "web", cpu: 2, ram: 1536, storage: 20, ...over }) as VmDetail;

function renderDialog(v: VmDetail) {
  return render(<ResizeDialog vm={v} isAdmin open onOpenChange={() => {}} onResized={() => {}} />);
}

const apply = () => screen.getByRole("button", { name: /apply/i });

beforeEach(() => patch.mockReset().mockResolvedValue({}));
afterEach(cleanup);

describe("ResizeDialog memory", () => {
  it("opens with nothing to change for a VM whose RAM is not a whole GB", () => {
    renderDialog(vm({ ram: 1536 }));
    expect((apply() as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(/memory/i) as HTMLInputElement).value).toBe("1.5");
  });

  it("a disk-only resize never sends a RAM value the user didn't touch", async () => {
    renderDialog(vm({ ram: 1536 }));
    fireEvent.change(screen.getByLabelText(/disk/i), { target: { value: "30" } });
    fireEvent.click(apply());
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch).toHaveBeenCalledWith("/vms/vm1", { storage: 30 });
  });

  it("keeps a sub-GB VM's size (512 MB is not bumped to 1 GB)", async () => {
    renderDialog(vm({ ram: 512 }));
    expect((screen.getByLabelText(/memory/i) as HTMLInputElement).value).toBe("0.5");
    fireEvent.change(screen.getByLabelText(/vcpu/i), { target: { value: "3" } });
    fireEvent.click(apply());
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch).toHaveBeenCalledWith("/vms/vm1", { cpu: 3 });
  });

  it("sends a fractional GB the user typed as exact MB", async () => {
    renderDialog(vm({ ram: 1024 }));
    fireEvent.change(screen.getByLabelText(/memory/i), { target: { value: "2.5" } });
    fireEvent.click(apply());
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch).toHaveBeenCalledWith("/vms/vm1", { ram: 2560 });
  });

  it("shows an awkward size rounded, but keeps the exact value unless the user edits it", async () => {
    renderDialog(vm({ ram: 1000 }));
    expect((screen.getByLabelText(/memory/i) as HTMLInputElement).value).toBe("0.98");
    expect((apply() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/disk/i), { target: { value: "30" } });
    fireEvent.click(apply());
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch).toHaveBeenCalledWith("/vms/vm1", { storage: 30 });
  });
});
