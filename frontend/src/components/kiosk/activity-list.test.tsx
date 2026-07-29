import { describe, it, expect, afterEach } from "vitest";
import { render, fireEvent, screen, cleanup } from "@testing-library/react";
import { KioskActivityList } from "./activity-list";
import type { AuditEntry } from "@/lib/types";

// Vitest runs without `globals`, so RTL's auto-cleanup doesn't hook in — without
// this, each render stays mounted and `screen` queries hit stale trees.
afterEach(cleanup);

function entry(over: Partial<AuditEntry>): AuditEntry {
  return {
    id: Math.random().toString(36).slice(2),
    userId: "u1",
    actorEmail: "admin@example.com",
    action: "vm.start",
    targetType: "vm",
    targetId: "vm-a",
    detail: "web-server-01 started",
    ip: "203.0.113.7",
    createdAt: new Date().toISOString(),
    ...over,
  };
}

/** id -> name, exactly what the kiosk page derives from its VM inventory. */
const NAMES = new Map([
  ["vm-a", "web-server-01"],
  ["vm-b", "db-box"],
]);

const AUDIT: AuditEntry[] = [
  entry({ id: "1", action: "vm.start", targetId: "vm-a", detail: "web-server-01 started", ip: "203.0.113.7" }),
  entry({ id: "2", action: "vm.stop", targetId: "vm-b", detail: "db-box stopped", ip: "198.51.100.9" }),
  entry({ id: "3", action: "auth.login", targetType: null, targetId: null, detail: null, ip: "203.0.113.7" }),
];

describe("KioskActivityList", () => {
  it("renders action, VM name, and IP — but never the actor email or raw detail", () => {
    const { container } = render(<KioskActivityList audit={AUDIT} total={42} vmNames={NAMES} />);
    expect(container.textContent).toContain("Vm Start");
    expect(container.textContent).toContain("web-server-01");
    expect(container.textContent).toContain("db-box");
    expect(container.textContent).toContain("198.51.100.9");
    expect(container.textContent).toContain("latest 3 of 42");
    // Privacy: the wall panel must not show who did it, only what/where/when.
    expect(container.textContent).not.toContain("admin@example.com");
    // The free-text detail (which can itself carry emails) stays hidden too —
    // only the leading VM name is surfaced, not the rest of the sentence.
    expect(container.textContent).not.toContain("started");
  });

  it("filters by IP on tap and clears again", () => {
    const { container } = render(<KioskActivityList audit={AUDIT} total={42} vmNames={NAMES} />);
    fireEvent.click(screen.getAllByLabelText("Filter by IP 203.0.113.7")[0]!);
    expect(container.textContent).toContain("web-server-01");
    expect(container.textContent).not.toContain("db-box");
    expect(container.textContent).toContain("2 matching");
    // The header chip clears the filter.
    fireEvent.click(screen.getByLabelText("Clear filter"));
    expect(container.textContent).toContain("db-box");
  });

  it("filters by VM (stable targetId) via the VM chip", () => {
    const { container } = render(<KioskActivityList audit={AUDIT} total={42} vmNames={NAMES} />);
    fireEvent.click(screen.getByLabelText("Filter by VM db-box"));
    expect(container.textContent).toContain("db-box");
    expect(container.textContent).not.toContain("web-server-01");
    expect(container.textContent).toContain("1 matching");
  });

  it("NEVER prints a tenant's email from a vm.share detail line", () => {
    // vm.share records detail as "<email> as <role>". The old label parser took
    // the leading token and printed "sarah-chen" on the wall as if it were a
    // machine name — actor identity, which this panel must never show.
    const share = entry({
      id: "s1",
      action: "vm.share",
      targetType: "vm",
      targetId: "vm-a",
      detail: "sarah-chen@university.edu as manager",
      ip: "203.0.113.7",
    });
    const { container } = render(<KioskActivityList audit={[share]} total={1} vmNames={NAMES} />);
    expect(container.textContent).not.toContain("sarah-chen");
    expect(container.textContent).not.toContain("university.edu");
    // The resolved machine name is fine — that's what the chip is for.
    expect(container.textContent).toContain("web-server-01");
  });

  it("shows no VM chip for a target it can't resolve, rather than guessing", () => {
    const stray = entry({ id: "x1", action: "balancer.migrate", targetId: "vm-unknown", detail: "pve-2 → pve-0" });
    const { container } = render(<KioskActivityList audit={[stray]} total={1} vmNames={NAMES} />);
    expect(container.textContent).not.toContain("pve-2");
    expect(container.textContent).toContain("Balancer Migrate");
  });

  it("shows the empty state when nothing is recorded", () => {
    const { container } = render(<KioskActivityList audit={[]} total={0} vmNames={NAMES} />);
    expect(container.textContent).toContain("No activity recorded yet.");
  });
});
