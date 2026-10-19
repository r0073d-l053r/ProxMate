import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { HoldBanner, isVmHeld } from "./hold-banner";

afterEach(cleanup);

describe("HoldBanner", () => {
  it("shows the hold reason for a held machine", () => {
    const { getByRole } = render(
      <HoldBanner vm={{ status: "stopped", holdReason: "This machine's provisioning didn't finish." }} />,
    );
    expect(getByRole("alert").textContent).toContain("This machine's provisioning didn't finish.");
    expect(getByRole("alert").textContent).toContain("Start, the console and the IDE stay unavailable");
  });

  it("explains an error row that has no reason recorded (a 1.0.x row)", () => {
    const { getByRole } = render(<HoldBanner vm={{ status: "error", holdReason: null }} />);
    expect(getByRole("alert").textContent).toMatch(/can.t be started/);
  });

  it("renders nothing for a machine that isn't held", () => {
    const { container } = render(<HoldBanner vm={{ status: "stopped", holdReason: null }} />);
    expect(container.textContent).toBe("");
  });
});

describe("isVmHeld", () => {
  it("is true for a hold reason or the error status, false otherwise", () => {
    expect(isVmHeld({ status: "stopped", holdReason: "over quota" })).toBe(true);
    expect(isVmHeld({ status: "error", holdReason: null })).toBe(true);
    expect(isVmHeld({ status: "running", holdReason: null })).toBe(false);
    expect(isVmHeld({ status: "stopped" })).toBe(false);
  });
});
