import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, screen, cleanup, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

const post = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { post: (...args: unknown[]) => post(...args) },
  apiError: (e: unknown) => String(e),
}));

import ResetPasswordPage from "./page";

afterEach(cleanup);

async function resetWith(remainingPasskeys: string[]) {
  post.mockResolvedValue({ data: { success: true, remainingPasskeys } });
  window.history.replaceState(null, "", "/reset-password?token=abc");
  render(<ResetPasswordPage />);
  fireEvent.change(await screen.findByLabelText("New password"), { target: { value: "longenough1" } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "longenough1" } });
  fireEvent.submit(screen.getByLabelText("New password").closest("form")!);
  await screen.findByText("Password updated");
}

describe("reset password confirmation", () => {
  it("names the passkeys that can still sign in and says where to remove them", async () => {
    await resetWith(["MacBook", "YubiKey"]);
    await waitFor(() => expect(screen.getByText(/MacBook, YubiKey/)).toBeTruthy());
    expect(screen.getByText(/remove it under Security/)).toBeTruthy();
  });

  it("says nothing about passkeys when there are none", async () => {
    await resetWith([]);
    expect(screen.queryByText(/passkeys can still sign in/)).toBeNull();
  });
});
