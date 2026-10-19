import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    delete: (...a: unknown[]) => del(...a),
  },
  apiError: (e: unknown) => String(e),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { UnmatchedVmsCard, adoptPrompt, type UnmatchedVm } from "./unmatched-vms-card";

const vm = (over: Partial<UnmatchedVm> = {}): UnmatchedVm => ({
  id: "rowa",
  name: "web",
  status: "running",
  proxmoxVmId: 100,
  proxmoxNode: "pve1",
  guest: { present: true, name: "web", taggedForAnotherRow: false, isTemplate: false },
  sharedVmid: false,
  templateRow: false,
  ...over,
});

beforeEach(() => {
  get.mockReset();
  post.mockReset().mockResolvedValue({});
  del.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

describe("UnmatchedVmsCard", () => {
  it("lists unmatched machines and adopts one after confirmation", async () => {
    get.mockResolvedValue({ data: [vm()] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<UnmatchedVmsCard />);
    await screen.findByText("web");
    fireEvent.click(screen.getByRole("button", { name: "Adopt" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/admin/vms/rowa/adopt"));
  });

  it("removes just the row after confirmation", async () => {
    get.mockResolvedValue({ data: [vm()] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<UnmatchedVmsCard />);
    await screen.findByText("web");
    fireEvent.click(screen.getByRole("button", { name: "Remove row" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/vms/rowa?rowOnly=true"));
  });

  it("offers no adoption when the guest belongs to another machine", async () => {
    get.mockResolvedValue({ data: [vm({ guest: { present: true, name: "x", taggedForAnotherRow: true, isTemplate: false } })] });
    render(<UnmatchedVmsCard />);
    await screen.findByText("web");
    expect((screen.getByRole("button", { name: "Adopt" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says so when every machine is confirmed", async () => {
    get.mockResolvedValue({ data: [] });
    render(<UnmatchedVmsCard />);
    await screen.findByText(/Every machine.s guest is confirmed/);
  });

  it("offers no adoption for a template", async () => {
    get.mockResolvedValue({
      data: [
        vm({ id: "a", name: "a", guest: { present: true, name: "tpl", taggedForAnotherRow: false, isTemplate: true } }),
        vm({ id: "b", name: "b", templateRow: true }),
      ],
    });
    render(<UnmatchedVmsCard />);
    await screen.findByText("a");
    for (const b of screen.getAllByRole("button", { name: "Adopt" })) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("does not adopt when the confirmation is declined", async () => {
    get.mockResolvedValue({ data: [vm()] });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<UnmatchedVmsCard />);
    await screen.findByText("web");
    fireEvent.click(screen.getByRole("button", { name: "Adopt" }));
    expect(post).not.toHaveBeenCalled();
  });

  it("the confirmation shows both names and warns when they differ", () => {
    const differ = adoptPrompt(vm({ guest: { present: true, name: "other", taggedForAnotherRow: false, isTemplate: false } }));
    expect(differ).toContain("Machine name: web");
    expect(differ).toContain("Guest name:   other");
    expect(differ).toMatch(/NAMES DIFFER/);
    expect(adoptPrompt(vm())).not.toMatch(/NAMES DIFFER/);
  });
});
