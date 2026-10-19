import { describe, it, expect, beforeEach } from "vitest";
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";
import { api } from "./api";
import { useAuthStore } from "./auth-store";

/** An adapter that answers every request with the given status + body. */
function respondWith(status: number, data: unknown): AxiosAdapter {
  return (config: InternalAxiosRequestConfig) => {
    const response = { status, statusText: "", data, headers: {}, config };
    return Promise.reject(new AxiosError("fail", String(status), config, null, response));
  };
}

const admin = { id: "u1", email: "a@example.com", role: "admin", displayName: "A" } as const;

describe("api 401 interceptor", () => {
  beforeEach(() => {
    useAuthStore.getState().setUser({ ...admin });
  });

  it("clears the cached user when the session is rejected", async () => {
    await expect(
      api.get("/vms", { adapter: respondWith(401, { error: "Invalid or expired session" }) }),
    ).rejects.toBeInstanceOf(AxiosError);
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("keeps the cached user when a kiosk-exit PIN is wrong", async () => {
    await expect(
      api.post("/auth/kiosk-exit", { method: "pin", value: "0000" }, {
        adapter: respondWith(403, { code: "reauth_failed", error: "Incorrect — try again." }),
      }),
    ).rejects.toBeInstanceOf(AxiosError);
    expect(useAuthStore.getState().user).not.toBeNull();
  });

  it("keeps the cached user when a kiosk-exit passkey check fails", async () => {
    await expect(
      api.post("/auth/kiosk-exit/passkey-verify", {}, {
        adapter: respondWith(403, { code: "reauth_failed", error: "Passkey check failed" }),
      }),
    ).rejects.toBeInstanceOf(AxiosError);
    expect(useAuthStore.getState().user).not.toBeNull();
  });

  it("clears the cached user when a kiosk-exit call finds the session gone", async () => {
    await expect(
      api.post("/auth/kiosk-exit", { method: "pin", value: "1234" }, {
        adapter: respondWith(401, { error: "Invalid or expired session" }),
      }),
    ).rejects.toBeInstanceOf(AxiosError);
    expect(useAuthStore.getState().user).toBeNull();
  });
});
