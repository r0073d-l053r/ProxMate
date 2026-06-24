export type Role = "admin" | "user";

export type VmStatus = "creating" | "running" | "stopped" | "error";

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  displayName: string;
}

export interface QuotaTriple {
  used: number;
  max: number;
}

export interface Quota {
  cpu: QuotaTriple;
  ram: QuotaTriple;
  storage: QuotaTriple;
}

export interface MeResponse {
  user: AuthUser & {
    createdAt: string;
    quota: Quota;
  };
}

export interface AuthResponse {
  user: AuthUser;
  token: string;
  expiresAt: string;
}

export interface VirtualMachine {
  id: string;
  userId: string;
  proxmoxVmId: number;
  proxmoxNode: string;
  name: string;
  description: string | null;
  cpu: number;
  ram: number;
  storage: number;
  os: string;
  status: VmStatus;
  ipAddress: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VmLiveStatus {
  status: string;
  cpu?: number;
  mem?: number;
  maxmem?: number;
  uptime?: number;
}

export interface VmDetail extends VirtualMachine {
  live: VmLiveStatus | null;
}

export interface Invite {
  id: string;
  token: string;
  label: string | null;
  maxCpu: number;
  maxRam: number;
  maxStorage: number;
  used: boolean;
  usedBy: { email: string; displayName: string } | null;
  expired: boolean;
  expiresAt: string;
  createdAt: string;
}

export interface CreatedInvite {
  id: string;
  token: string;
  inviteUrl: string;
  label: string | null;
  maxCpu: number;
  maxRam: number;
  maxStorage: number;
  expiresAt: string;
}

export interface InviteValidation {
  valid: boolean;
  quotas: { maxCpu: number; maxRam: number; maxStorage: number };
  expiresAt: string;
  label: string | null;
}

export interface ManagedUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  vmCount: number;
  quota: Quota;
  createdAt: string;
}

export interface ProxmoxNode {
  node: string;
  status: string;
  maxcpu?: number;
  maxmem?: number;
  cpu?: number;
  mem?: number;
}

export interface ProxmoxIso {
  volid: string;
  name: string;
  size?: number;
}

export interface ProxmoxResources {
  storages: Array<{ name: string; type: string }>;
  bridges: Array<{ name: string }>;
  isoStorages: Array<{ name: string; type: string }>;
}

export interface AdminSettings {
  proxmox: { host: string | null; tokenId: string | null; verifySsl: boolean; hasSecret: boolean };
  defaults: { storage: string | null; bridge: string | null; isoStorage: string | null };
}

export interface IsolationStatus {
  isolationEnabled: boolean;
  clusterFirewallEnabled: boolean;
  enforced: boolean;
  reachable: boolean;
  suggestedMgmtCidr: string | null;
}

export type MateStateStatus = "creating" | "ready" | "restoring" | "error";

export interface MateState {
  id: string;
  vmId: string;
  proxmoxVmId: number;
  proxmoxNode: string;
  storage: string;
  volid: string;
  size: number;
  status: MateStateStatus;
  kind: "scheduled" | "manual";
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Template {
  id: string;
  name: string;
  description: string | null;
  os: string | null;
  proxmoxVmId: number;
  proxmoxNode: string;
  diskGb: number;
  notes: string | null;
  published: boolean;
  createdAt: string;
}

export interface DiscoveredTemplate {
  vmid: number;
  node: string;
  name: string;
  diskGb: number;
}

export interface ClusterStats {
  nodes: number;
  cpu: { total: number; used: number };
  memory: { total: number; used: number };
  storage: { total: number; used: number };
  vmCount: number;
}

export interface UserGroup {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  quota: { cpu: number; ram: number; storage: number };
  vms: VirtualMachine[];
}

export interface LiveVmStats {
  status: string;
  cpu: number;       // 0..1, fraction of allocated cores
  maxcpu: number;
  mem: number;       // bytes
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;    // seconds
  netin: number;     // cumulative bytes
  netout: number;
}

export type LiveStats = Record<number, LiveVmStats>;
