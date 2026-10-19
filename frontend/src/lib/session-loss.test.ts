import { describe, it, expect } from "vitest";
import { isSessionLoss } from "./session-loss";

describe("isSessionLoss", () => {
  it("treats a 401 from an ordinary endpoint as a lost session", () => {
    expect(isSessionLoss(401, "/vms", { error: "Invalid or expired session" })).toBe(true);
    expect(isSessionLoss(401, "/auth/me", undefined)).toBe(true);
  });

  it("ignores non-401 responses", () => {
    expect(isSessionLoss(403, "/vms", { error: "Forbidden" })).toBe(false);
    expect(isSessionLoss(undefined, "/vms", undefined)).toBe(false);
  });

  it("keeps the session when a kiosk-exit re-auth is rejected", () => {
    expect(isSessionLoss(401, "/auth/kiosk-exit", { error: "Incorrect — try again." })).toBe(false);
    expect(isSessionLoss(401, "/auth/kiosk-exit/passkey-verify", { error: "Passkey check failed" })).toBe(false);
    expect(isSessionLoss(401, "auth/kiosk-exit?x=1", { error: "Incorrect — try again." })).toBe(false);
  });

  it("still clears when the kiosk-exit call failed because the session itself is gone", () => {
    expect(isSessionLoss(401, "/auth/kiosk-exit", { error: "Invalid or expired session" })).toBe(true);
    expect(isSessionLoss(401, "/auth/kiosk-exit", { error: "Unauthorized — missing session" })).toBe(true);
  });
});
