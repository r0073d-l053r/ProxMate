import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
  apiError: (e: unknown) => String(e),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { KeyBackupBanner } from "./key-backup-banner";
import { useAuthStore } from "@/lib/auth-store";

const admin = { id: "a1", email: "admin@example.com", role: "admin" as const, displayName: "Admin" };
const unconfirmed = { confirmed: false, confirmedAt: null, confirmedBy: null, keyChanged: false };

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  useAuthStore.getState().setUser(admin);
});
afterEach(() => {
  cleanup();
  useAuthStore.getState().clear();
});

describe("KeyBackupBanner", () => {
  it("warns an admin until the backup is confirmed, then records it and goes away", async () => {
    get.mockResolvedValue({ data: unconfirmed });
    post.mockResolvedValue({
      data: { confirmed: true, confirmedAt: "2026-10-23T12:00:00Z", confirmedBy: "admin@example.com", keyChanged: false },
    });
    render(<KeyBackupBanner />);
    await screen.findByText("Back up ENCRYPTION_KEY.");
    expect(get).toHaveBeenCalledWith("/admin/encryption-key-backup");

    const button = screen.getByRole("button", { name: "Confirm backup" });
    expect(button).toHaveProperty("disabled", true); // not until the box is ticked
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(button);
    await waitFor(() => expect(post).toHaveBeenCalledWith("/admin/encryption-key-backup/confirm", {}));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("says so when the key changed since the last confirmation", async () => {
    get.mockResolvedValue({ data: { ...unconfirmed, confirmedAt: "2026-01-01T00:00:00Z", keyChanged: true } });
    render(<KeyBackupBanner />);
    await screen.findByText(/has changed since its backup was confirmed/);
  });

  it("shows nothing once confirmed", async () => {
    get.mockResolvedValue({ data: { confirmed: true, confirmedAt: "2026-10-23T12:00:00Z", confirmedBy: "x", keyChanged: false } });
    render(<KeyBackupBanner />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("never asks the server (or shows anything) for a non-admin", async () => {
    useAuthStore.getState().setUser({ ...admin, role: "user" as const });
    render(<KeyBackupBanner />);
    expect(get).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
