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

export interface ClusterStats {
  nodes: number;
  cpu: { total: number; used: number };
  memory: { total: number; used: number };
  storage: { total: number; used: number };
  vmCount: number;
}
