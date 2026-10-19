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
const success = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => success(...a), error: vi.fn() } }));

import { SharePanel } from "./share-panel";

beforeEach(() => {
  get.mockReset().mockResolvedValue({
    data: [{ id: "s1", email: "pat@example.com", role: "operator", createdAt: "2026-10-01T00:00:00.000Z" }],
  });
  post.mockReset().mockResolvedValue({ data: { message: "If that person has a ProxMate account, the VM is now shared with them." } });
  del.mockReset().mockResolvedValue({});
  success.mockReset();
});
afterEach(cleanup);

describe("SharePanel", () => {
  it("lists shares by the address shared with and revokes by share id", async () => {
    render(<SharePanel vmId="vm1" />);
    expect(await screen.findByText("pat@example.com")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Revoke access"));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/vms/vm1/shares/s1"));
  });

  it("shows the server's answer after sharing, not a claim that it worked", async () => {
    render(<SharePanel vmId="vm1" />);
    await screen.findByText("pat@example.com");
    fireEvent.change(screen.getByLabelText("User email"), { target: { value: "new@example.com" } });
    fireEvent.submit(screen.getByLabelText("User email").closest("form")!);
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("If that person has a ProxMate account, the VM is now shared with them."),
    );
  });
});
