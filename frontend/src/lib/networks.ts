import type { GuestNetwork } from "./types";

/** Mirrors the backend's NETWORK_NAME_RE: what a guest NIC's `bridge=` may name. */
export const NETWORK_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/;

/** "Linux bridge", "OVS bridge" or "SDN VNet · zone evpn1". */
export function networkKindLabel(n: Pick<GuestNetwork, "kind" | "zone">): string {
  if (n.kind === "vnet") return n.zone ? `SDN VNet · zone ${n.zone}` : "SDN VNet";
  return n.kind === "ovs" ? "OVS bridge" : "Linux bridge";
}

/**
 * A warning when a network is missing from some online nodes, or null when it is on
 * all of them. A guest placed on a node without its network fails to start.
 */
export function networkCoverageWarning(n: Pick<GuestNetwork, "nodes">, nodeCount?: number): string | null {
  if (!nodeCount || n.nodes.length >= nodeCount) return null;
  return `only on ${n.nodes.join(", ") || "no online node"} (${n.nodes.length} of ${nodeCount} nodes)`;
}

/** Validation message for a hand-typed network name, or null when it is acceptable. */
export function networkNameError(name: string): string | null {
  const v = name.trim();
  if (!v) return "Enter a bridge or VNet name.";
  if (!NETWORK_NAME_RE.test(v)) {
    return "Must start with a letter and use only letters, digits, '.', '_' or '-' (max 32).";
  }
  return null;
}
