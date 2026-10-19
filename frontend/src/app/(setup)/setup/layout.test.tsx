import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, screen, cleanup, waitFor } from "@testing-library/react";

const push = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/setup/proxmox",
  useRouter: () => ({ push, replace }),
}));

const post = vi.fn(() => Promise.resolve({ data: { success: true } }));
vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(() => Promise.resolve({ data: { setupComplete: false, adminExists: true } })),
    post: (...args: unknown[]) => post(...(args as [])),
  },
}));

vi.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => null }));

vi.mock("@/lib/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-store")>()),
  useHydrated: () => true,
}));

import SetupLayout from "./layout";
import { useAuthStore } from "@/lib/auth-store";

afterEach(cleanup);

describe("setup wizard Sign Out", () => {
  it("ends the server session, not just the local profile", async () => {
    useAuthStore.getState().setUser({ id: "a1", email: "admin@x.y", role: "admin", displayName: "Admin" } as never);
    render(<SetupLayout>step</SetupLayout>);

    fireEvent.click(await screen.findByText("Sign Out"));

    await waitFor(() => expect(post).toHaveBeenCalledWith("/auth/logout"));
    expect(useAuthStore.getState().user).toBeNull();
    expect(push).toHaveBeenCalledWith("/login");
  });
});
