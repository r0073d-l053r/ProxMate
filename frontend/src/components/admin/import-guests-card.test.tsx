import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
  },
  apiError: (e: unknown) => String(e),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// A native <select> stands in for the popover select, which jsdom can't open.
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) => (
    <select aria-label="Owner" value={value} onChange={(e) => onValueChange(e.target.value)}>
      <option value="">Choose a user</option>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
}));

import { ImportGuestsCard, guestSummary, type ImportableGuest } from "./import-guests-card";

const guest = (over: Partial<ImportableGuest> = {}): ImportableGuest => ({
  vmid: 200,
  node: "pve1",
  name: "legacy-web",
  type: "qemu",
  status: "running",
  cpu: 2,
  ramMb: 2048,
  diskGb: 20,
  ...over,
});

beforeEach(() => {
  get.mockReset().mockImplementation((url: string) =>
    Promise.resolve({
      data: url === "/users" ? [{ id: "u2", email: "u2@example.com", displayName: "Tenant Two" }] : [guest()],
    }),
  );
  post.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

describe("ImportGuestsCard", () => {
  it("lists importable guests with node, VMID, type and resources", async () => {
    render(<ImportGuestsCard />);
    await screen.findByText("legacy-web");
    expect(screen.getByText(/VMID 200 on pve1 · VM · 2 vCPU · 2 GB · 20 GB · running/)).toBeTruthy();
    expect(guestSummary(guest({ type: "lxc", ramMb: 512 }))).toMatch(/^Container · 2 vCPU · 512 MB/);
  });

  it("requires an owner, then imports for that owner", async () => {
    render(<ImportGuestsCard />);
    await screen.findByText("legacy-web");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    const confirm = await screen.findAllByRole("button", { name: /Import/ });
    fireEvent.click(confirm[confirm.length - 1]!);
    await screen.findByText(/Choose who will own this machine/);
    expect(post).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "u2" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirm[confirm.length - 1]!);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/admin/guests/import", { vmid: 200, ownerId: "u2", quotaExempt: true }),
    );
  });

  it("shows the server's refusal in the dialog", async () => {
    post.mockRejectedValueOnce("Importing this guest would exceed u2@example.com's quota");
    render(<ImportGuestsCard />);
    await screen.findByText("legacy-web");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    fireEvent.change(await screen.findByLabelText("Owner"), { target: { value: "u2" } });
    const confirm = screen.getAllByRole("button", { name: /Import/ });
    fireEvent.click(confirm[confirm.length - 1]!);
    await screen.findByText(/would exceed u2@example.com's quota/);
  });

  it("says so when every guest is managed", async () => {
    get.mockImplementation(() => Promise.resolve({ data: [] }));
    render(<ImportGuestsCard />);
    await screen.findByText(/already managed/);
  });
});
