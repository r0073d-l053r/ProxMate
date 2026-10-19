import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from "axios";

const replace = vi.fn();
// Next's router object is stable across renders; the guard's effect depends on it.
const router = { replace, push: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/",
}));

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
  apiError: (e: unknown) => (e instanceof Error ? e.message : "error"),
  apiBaseUrl: "http://localhost:4000/api",
}));

import { AuthGuard } from "./auth-guard";
import LoginPage from "@/app/(auth)/login/page";
import { useAuthStore } from "@/lib/auth-store";

afterEach(cleanup);

const cfg = { headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
const networkError = () => new AxiosError("Network Error", "ERR_NETWORK", cfg);
const httpError = (status: number) =>
  new AxiosError("fail", String(status), cfg, null, {
    status,
    statusText: "",
    data: { error: "x" },
    headers: {},
    config: cfg,
  });

const cachedUser = { id: "u1", email: "a@example.com", role: "user" as const, displayName: "A" };

beforeEach(() => {
  replace.mockReset();
  get.mockReset();
  post.mockReset();
  useAuthStore.getState().setUser({ ...cachedUser });
});

describe("AuthGuard", () => {
  it("shows a retry state instead of bouncing to /login when the API is unreachable", async () => {
    get.mockRejectedValue(networkError());
    render(<AuthGuard>secret</AuthGuard>);
    expect(await screen.findByRole("button", { name: /retry/i })).toBeTruthy();
    expect(replace).not.toHaveBeenCalledWith("/login");
  });

  it("shows a retry state when /auth/me fails with a server error", async () => {
    get.mockImplementation((url: string) =>
      url === "/setup/status" ? Promise.resolve({ data: { setupComplete: true } }) : Promise.reject(httpError(502)),
    );
    render(<AuthGuard>secret</AuthGuard>);
    expect(await screen.findByRole("button", { name: /retry/i })).toBeTruthy();
    expect(replace).not.toHaveBeenCalledWith("/login");
  });

  it("retries and renders once the API is back", async () => {
    get.mockRejectedValue(networkError());
    render(<AuthGuard>secret</AuthGuard>);
    const retry = await screen.findByRole("button", { name: /retry/i });
    get.mockImplementation((url: string) =>
      url === "/setup/status"
        ? Promise.resolve({ data: { setupComplete: true } })
        : Promise.resolve({ data: { user: { ...cachedUser } } }),
    );
    fireEvent.click(retry);
    expect(await screen.findByText("secret")).toBeTruthy();
  });

  it("says the API is unavailable and retries on its own with backoff", async () => {
    vi.useFakeTimers();
    try {
      get.mockRejectedValue(networkError());
      render(<AuthGuard>secret</AuthGuard>);
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByText(/The ProxMate API is unavailable/)).toBeTruthy();
      expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
      expect(get).toHaveBeenCalledTimes(1);

      // First automatic retry after 5s.
      await act(() => vi.advanceTimersByTimeAsync(4999));
      expect(get).toHaveBeenCalledTimes(1);
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(get).toHaveBeenCalledTimes(2);

      // Second failure waits 10s; the API is back by then.
      get.mockImplementation((url: string) =>
        url === "/setup/status"
          ? Promise.resolve({ data: { setupComplete: true } })
          : Promise.resolve({ data: { user: { ...cachedUser } } }),
      );
      await act(() => vi.advanceTimersByTimeAsync(9999));
      expect(screen.queryByText("secret")).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(screen.getByText("secret")).toBeTruthy();
      expect(replace).not.toHaveBeenCalledWith("/login");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a signed-out session to /login", async () => {
    get.mockImplementation((url: string) =>
      url === "/setup/status" ? Promise.resolve({ data: { setupComplete: true } }) : Promise.reject(httpError(401)),
    );
    render(<AuthGuard>secret</AuthGuard>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  });

  it("clears a cached user whose account no longer exists before going to /login", async () => {
    get.mockImplementation((url: string) =>
      url === "/setup/status" ? Promise.resolve({ data: { setupComplete: true } }) : Promise.reject(httpError(404)),
    );
    render(<AuthGuard>secret</AuthGuard>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(useAuthStore.getState().user).toBeNull();
  });
});

describe("LoginPage with a cached user", () => {
  it("does not bounce back to / when the setup status can't be loaded", async () => {
    get.mockRejectedValue(networkError());
    render(<LoginPage />);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/setup/status"));
    // Give the rejected request a chance to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(replace).not.toHaveBeenCalledWith("/");
  });

  it("still goes to the dashboard when the setup status loads", async () => {
    get.mockImplementation((url: string) =>
      url === "/setup/status" ? Promise.resolve({ data: { setupComplete: true, adminExists: true } }) : Promise.reject(networkError()),
    );
    render(<LoginPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });
});
