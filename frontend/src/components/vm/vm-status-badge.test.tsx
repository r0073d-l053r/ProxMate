import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { VmStatusBadge } from "./vm-status-badge";

describe("VmStatusBadge", () => {
  it("renders a friendly label for a known status", () => {
    const { container } = render(<VmStatusBadge status="running" />);
    expect(container.textContent).toContain("Running");
  });

  it("falls back to the raw value for an unknown status", () => {
    const { container } = render(<VmStatusBadge status="paused" />);
    expect(container.textContent).toContain("paused");
  });
});
