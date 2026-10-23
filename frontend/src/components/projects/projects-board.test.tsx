import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within, fireEvent, cleanup } from "@testing-library/react";
import type { ProjectGroup, ProjectVm, ProjectsView } from "@/lib/types";
import { ProjectsBoard, rollupSummary } from "./projects-board";

afterEach(cleanup);

const vm = (id: string, over: Partial<ProjectVm> = {}): ProjectVm => ({
  id, name: id, type: "qemu", status: "running", cpu: 2, ram: 2048, storage: 20, access: "owner", usage: null, ...over,
});
const group = (name: string | null, vms: ProjectVm[], over: Partial<ProjectGroup> = {}): ProjectGroup => ({
  name,
  vmCount: vms.length,
  running: vms.filter((v) => v.status === "running").length,
  cpu: vms.reduce((n, v) => n + v.cpu, 0),
  ram: vms.reduce((n, v) => n + v.ram, 0),
  storage: vms.reduce((n, v) => n + v.storage, 0),
  usage: { samples: 0, avgCpuPct: 0, avgMemBytes: 0 },
  vms,
  ...over,
});

const me = { id: "u1", email: "me@example.com", displayName: "Me", role: "user" as const };

function sectionOf(heading: string): HTMLElement {
  return screen.getByRole("heading", { name: heading }).closest("section")!;
}

describe("ProjectsBoard", () => {
  const view: ProjectsView = {
    days: 7,
    owners: [
      {
        owner: me,
        projects: [
          group("shop", [vm("web-1"), vm("web-2", { status: "stopped" })], {
            usage: { samples: 4, avgCpuPct: 12.5, avgMemBytes: 2 * 1024 ** 3 },
          }),
          group(null, [vm("scratch")]),
        ],
      },
    ],
    shared: group(null, [vm("their-db", { access: "operator" })]),
  };

  it("groups VMs under each project, then No project, then Shared with me", () => {
    render(<ProjectsBoard view={view} isAdmin={false} busyKey={null} onBulk={() => {}} />);
    const headings = screen.getAllByRole("heading").map((h) => h.textContent?.trim());
    expect(headings).toEqual(["shop", "No project", "Shared with me"]);
    expect(within(sectionOf("shop")).getByText("web-1")).toBeTruthy();
    expect(within(sectionOf("shop")).getByText("web-2")).toBeTruthy();
    expect(within(sectionOf("No project")).getByText("scratch")).toBeTruthy();
    expect(within(sectionOf("Shared with me")).getByText("their-db")).toBeTruthy();
    expect(within(sectionOf("Shared with me")).getByText("Shared · operator")).toBeTruthy();
  });

  it("shows the rollup line", () => {
    render(<ProjectsBoard view={view} isAdmin={false} busyKey={null} onBulk={() => {}} />);
    expect(within(sectionOf("shop")).getByText(/2 VMs · 1 running · 4 vCPU · 4 GB · 40 GB · avg CPU 12\.5% · avg RAM 2\.0 GB/)).toBeTruthy();
    expect(rollupSummary(view.owners[0]!.projects[1]!)).toMatch(/no usage samples yet/);
  });

  it("runs bulk power on exactly the project's VMs, and offers none on shared VMs", () => {
    const onBulk = vi.fn();
    render(<ProjectsBoard view={view} isAdmin={false} busyKey={null} onBulk={onBulk} />);
    fireEvent.click(within(sectionOf("shop")).getByRole("button", { name: /Stop all/ }));
    expect(onBulk).toHaveBeenCalledWith("u1:shop", "stop", ["web-1", "web-2"]);
    expect(within(sectionOf("Shared with me")).queryByRole("button")).toBeNull();
  });

  it("heads each owner's projects with the owner for admins", () => {
    const admin: ProjectsView = {
      days: 7,
      owners: [
        { owner: { id: "a", email: "a@example.com", displayName: "Alice", role: "user" }, projects: [group("x", [vm("a-vm")])] },
        { owner: { id: "b", email: "b@example.com", displayName: "Bob", role: "user" }, projects: [group("x", [vm("b-vm")])] },
      ],
      shared: null,
    };
    render(<ProjectsBoard view={admin} isAdmin busyKey={null} onBulk={() => {}} />);
    expect(screen.getAllByRole("heading").map((h) => h.textContent?.trim())).toEqual(["Alice", "x", "Bob", "x"]);
  });
});
