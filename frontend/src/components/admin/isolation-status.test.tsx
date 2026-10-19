import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { IsolationStatusNote, isolationView } from "./isolation-status";
import type { IsolationStatus } from "@/lib/types";

afterEach(cleanup);

const iso = (over: Partial<IsolationStatus> = {}): IsolationStatus => ({
  isolationEnabled: true,
  clusterFirewallEnabled: false,
  enforced: false,
  reachable: true,
  suggestedMgmtCidr: null,
  dnsServers: "",
  ...over,
});

describe("isolation status", () => {
  it("says the state is unknown and offers no enforcement controls when Proxmox is unreachable", () => {
    const status = iso({ reachable: false });
    render(<IsolationStatusNote isolation={status} />);
    expect(screen.getByText(/Proxmox is unreachable, so the cluster firewall state is unknown/)).toBeTruthy();
    expect(screen.queryByText(/Not enforced yet/)).toBeNull();
    expect(isolationView(status)).toEqual({ state: "unreachable", showEnable: false, showDisable: false });
  });

  it("offers enabling when reachable and the cluster firewall is off", () => {
    render(<IsolationStatusNote isolation={iso()} />);
    expect(screen.getByText(/Not enforced yet/)).toBeTruthy();
    expect(isolationView(iso()).showEnable).toBe(true);
  });

  it("offers disabling when enforced", () => {
    const status = iso({ clusterFirewallEnabled: true, enforced: true });
    render(<IsolationStatusNote isolation={status} />);
    expect(screen.getByText(/Isolation is enforced/)).toBeTruthy();
    expect(isolationView(status)).toEqual({ state: "enforced", showEnable: false, showDisable: true });
  });
});
