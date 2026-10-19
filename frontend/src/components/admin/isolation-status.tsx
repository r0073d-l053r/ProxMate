import { cn } from "@/lib/utils";
import type { IsolationStatus } from "@/lib/types";

export type IsolationState = "unreachable" | "enforced" | "firewall-off" | "disabled";

/**
 * What the isolation card shows. When Proxmox could not be asked, the cluster
 * firewall state is unknown — so neither "not enforced" nor the enable/disable
 * enforcement controls apply (acting on a guess could lock the admin out).
 */
export function isolationView(iso: IsolationStatus): {
  state: IsolationState;
  showEnable: boolean;
  showDisable: boolean;
} {
  if (!iso.reachable) return { state: "unreachable", showEnable: false, showDisable: false };
  if (iso.enforced) return { state: "enforced", showEnable: false, showDisable: true };
  return {
    state: iso.clusterFirewallEnabled ? "disabled" : "firewall-off",
    showEnable: iso.isolationEnabled,
    showDisable: false,
  };
}

/** The coloured status note under the isolation toggle. */
export function IsolationStatusNote({ isolation }: { isolation: IsolationStatus }) {
  const { state } = isolationView(isolation);
  return (
    <div
      className={cn(
        "rounded-lg border p-3 text-sm",
        state === "enforced" ? "border-emerald-500/30 bg-emerald-500/10" : "border-amber-500/30 bg-amber-500/10",
      )}
    >
      {state === "unreachable" ? (
        <p>
          <span className="font-medium">Proxmox is unreachable, so the cluster firewall state is unknown.</span>{" "}
          Check the connection on this page, then reload.
        </p>
      ) : state === "enforced" ? (
        <p>
          <span className="font-medium">Isolation is enforced.</span> New VMs are firewalled off from the rest of
          your infrastructure.
        </p>
      ) : state === "firewall-off" ? (
        <p>
          <span className="font-medium">Not enforced yet.</span> ProxMate is configuring each VM&apos;s firewall,
          but rules only take effect once the <span className="font-medium">Proxmox cluster firewall</span> is
          enabled. Until then, VMs share your LAN. See <code>SECURITY.md</code> for the safe steps to enable it
          (and the recommended dedicated-VLAN setup).
        </p>
      ) : (
        <p>
          <span className="font-medium">Isolation is disabled.</span> New VMs will be placed on your network
          without isolation rules.
        </p>
      )}
    </div>
  );
}
