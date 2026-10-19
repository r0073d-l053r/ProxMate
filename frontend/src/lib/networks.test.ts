import { describe, it, expect } from "vitest";
import { networkKindLabel, networkCoverageWarning, networkNameError } from "./networks";

describe("networkKindLabel", () => {
  it("names each kind the way Proxmox does", () => {
    expect(networkKindLabel({ kind: "bridge" })).toBe("Linux bridge");
    expect(networkKindLabel({ kind: "ovs" })).toBe("OVS bridge");
    expect(networkKindLabel({ kind: "vnet", zone: "evpn1" })).toBe("SDN VNet · zone evpn1");
    expect(networkKindLabel({ kind: "vnet" })).toBe("SDN VNet");
  });
});

describe("networkCoverageWarning", () => {
  it("is silent when the network is on every online node", () => {
    expect(networkCoverageWarning({ nodes: ["pve1", "pve2"] }, 2)).toBeNull();
  });

  it("flags a bridge that only some nodes have", () => {
    expect(networkCoverageWarning({ nodes: ["pve1"] }, 8)).toBe("only on pve1 (1 of 8 nodes)");
  });

  it("is silent when the node count is unknown (older backend)", () => {
    expect(networkCoverageWarning({ nodes: ["pve1"] })).toBeNull();
  });
});

describe("networkNameError", () => {
  it("accepts bridge and VNet names", () => {
    for (const ok of ["vmbr0", "tenants", " vnet1 "]) expect(networkNameError(ok)).toBeNull();
  });

  it("rejects empty names and anything that would corrupt a NIC line", () => {
    for (const bad of ["", "  ", "vmbr0,tag=5", "0abc", "a b"]) expect(networkNameError(bad)).not.toBeNull();
  });
});
