import { describe, it, expect } from "vitest";
import { missingVmMessage } from "./vm-missing";

describe("missingVmMessage", () => {
  it("shows why a create failed, whether or not the page saw it creating", () => {
    const body = { error: "storage 'local-lvm' does not exist", code: "create_failed" };
    expect(missingVmMessage(body, null)).toBe("This machine couldn't be created: storage 'local-lvm' does not exist");
    expect(missingVmMessage(body, "creating")).toBe("This machine couldn't be created: storage 'local-lvm' does not exist");
  });

  it("stays neutral when a creating machine is gone without a recorded failure", () => {
    expect(missingVmMessage({ error: "VM not found" }, "creating")).toBe("This machine no longer exists.");
  });

  it("leaves an ordinary 404 to the default message", () => {
    expect(missingVmMessage({ error: "VM not found" }, "running")).toBeNull();
    expect(missingVmMessage(undefined, null)).toBeNull();
  });
});
