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
    twoFactorEnabled?: boolean;
    require2fa?: boolean;
    mfaSetupRequired?: boolean;
  };
}

export interface AuthResponse {
  // The session is delivered as an httpOnly cookie; only the user comes back in JSON.
  user: AuthUser;
}

/**
 * Returned by register/login when the user must set up a required second factor
 * before they get a session. The token is scoped to the enrollment endpoints
 * only (no session is issued until they log in with the new factor).
 */
export interface EnrollmentResponse {
  mfaEnrollmentRequired: true;
  enrollmentToken: string;
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

/** Owner-facing per-VM activity entry — a sanitized slice of the audit log
 *  (no IP / internal user id is exposed to the VM owner). */
export interface VmActivityEntry {
  id: string;
  action: string;
  actorEmail: string | null;
  detail: string | null;
  createdAt: string;
}

export type RrdTimeframe = "hour" | "day" | "week" | "month" | "year";

/** One sample from Proxmox's per-VM RRD store. cpu is a 0..1 fraction; mem/maxmem
 *  are bytes; net/disk rates are per-second. Fields are absent for buckets where
 *  the VM wasn't running. */
export interface RrdPoint {
  time: number; // epoch seconds
  cpu?: number;
  mem?: number;
  maxmem?: number;
  netin?: number;
  netout?: number;
  diskread?: number;
  diskwrite?: number;
}

export interface VmMetrics {
  timeframe: RrdTimeframe;
  points: RrdPoint[];
}

/** A VM's optional auto start/stop schedule, as 5-field cron strings (or null = off). */
export interface PowerSchedule {
  startCron: string | null;
  stopCron: string | null;
}

/** A live Proxmox snapshot (in-place point-in-time), distinct from a MateState backup. */
export interface Snapshot {
  name: string;
  description?: string;
  snaptime?: number; // epoch seconds
  vmstate?: number; // 1 if RAM state captured
  parent?: string;
}

export interface SshKey {
  id: string;
  name: string;
  publicKey: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface Invite {
  id: string;
  token: string;
  label: string | null;
  maxCpu: number;
  maxRam: number;
  maxStorage: number;
  require2fa: boolean;
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
  require2fa: boolean;
  expiresAt: string;
}

export interface InviteValidation {
  valid: boolean;
  quotas: { maxCpu: number; maxRam: number; maxStorage: number };
  expiresAt: string;
  label: string | null;
  require2fa: boolean;
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

export interface PasswordResetRequest {
  id: string;
  userId: string;
  email: string;
  status: string;
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

export interface UpdateCheck {
  repo: string;
  current: string;
  latest: string | null;
  tag: string | null;
  updateAvailable: boolean;
  name: string | null;
  notes: string | null;
  url: string | null;
  publishedAt: string | null;
}

export interface UpdateStatus {
  enabled: boolean;
  current: string;
  state: "idle" | "queued" | "running" | "success" | "error";
  message?: string;
  tag?: string;
  updatedAt?: string;
}

export interface AdminSettings {
  proxmox: { host: string | null; tokenId: string | null; verifySsl: boolean; hasSecret: boolean };
  defaults: { storage: string | null; bridge: string | null; isoStorage: string | null };
  smtp:
    | { configured: false }
    | { configured: true; host: string; port: number; secure: boolean; user: string; from: string; hasPass: boolean };
  sso:
    | { configured: false; callbackUrl: string }
    | {
        configured: true;
        enabled: boolean;
        issuer: string;
        clientId: string;
        scopes: string;
        groupsClaim: string;
        adminGroup: string;
        allowSignup: boolean;
        buttonLabel: string;
        hasSecret: boolean;
        callbackUrl: string;
      };
}

export interface IsolationStatus {
  isolationEnabled: boolean;
  clusterFirewallEnabled: boolean;
  enforced: boolean;
  reachable: boolean;
  suggestedMgmtCidr: string | null;
  dnsServers: string;
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
  cloudInit: boolean;
  icon: string | null;
  published: boolean;
  createdAt: string;
}

export interface CuratedImage {
  id: string;
  label: string;
  url: string;
  os: string;
  defaultUser: string;
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

/** Live aggregate usage of the caller's own running VMs (dashboard sparklines). */
export interface LiveUsage {
  cpu: number; // cores in use
  mem: number; // bytes in use
  maxMem: number; // bytes allocated to running VMs
  running: number;
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

export interface AuditEntry {
  id: string;
  userId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: string | null;
  ip: string | null;
  createdAt: string;
}

export interface AuditListResponse {
  items: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
}
