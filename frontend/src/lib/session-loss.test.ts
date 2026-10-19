import { describe, it, expect } from "vitest";
import { isSessionLoss } from "./session-loss";

describe("isSessionLoss", () => {
  it("treats a 401 as a lost session, from any endpoint", () => {
    expect(isSessionLoss(401)).toBe(true);
  });

  it("keeps the session for a rejected kiosk-exit re-auth (403 reauth_failed)", () => {
    expect(isSessionLoss(403)).toBe(false);
  });

  it("ignores other failures and network errors", () => {
    expect(isSessionLoss(400)).toBe(false);
    expect(isSessionLoss(500)).toBe(false);
    expect(isSessionLoss(undefined)).toBe(false);
  });
});
