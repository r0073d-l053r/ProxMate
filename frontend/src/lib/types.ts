export type Role = "admin" | "user";

export type VmStatus = "creating" | "running" | "stopped" | "error";

/** Guest kind: a full QEMU VM or an LXC container. */
export type GuestType = "qemu" | "lxc";

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
    // CE: opted out of admin broadcast (announcement) emails. Security emails unaffected.
    broadcastOptOut?: boolean;
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

/** The caller's access to a VM: their own, admin, or a share grant. */
export type VmAccess = "owner" | "admin" | "co-owner" | "read-only";

export interface VirtualMachine {
  id: string;
  userId: string;
  proxmoxVmId: number;
  proxmoxNode: string;
  name: string;
  description: string | null;
  type: GuestType; // "qemu" (default) | "lxc"
  hasPassthrough?: boolean; // a PCI/GPU device is attached (VM can't migrate)
  cpu: number;
  ram: number;
  storage: number;
  os: string;
  status: VmStatus;
  ipAddress: string | null;
  /** The guest's Tailscale (100.x) address, when Tailscale runs inside it. */
  tailscaleIp: string | null;
  /** Non-null while booted into rescue mode (snapshot of the pre-rescue boot config). */
  rescueBoot: string | null;
  tags: string | null;
  createdAt: string;
  updatedAt: string;
  // Present on list/detail responses: how the current user may use this VM.
  access?: VmAccess;
}

export interface VmDisk {
  slot: string;
  storage: string;
  sizeGb: number;
  isRoot: boolean;
}

export interface VmShare {
  id: string;
  role: "co-owner" | "read-only";
  createdAt: string;
  user: { id: string; email: string; displayName: string };
}

export interface VmLiveStatus {
  status: string;
  /** QEMU machine state — "paused" while suspended (execution frozen, RAM resident). */
  qmpstatus?: string;
  cpu?: number;
  mem?: number;
  maxmem?: number;
  uptime?: number;
}

export interface VmDetail extends VirtualMachine {
  live: VmLiveStatus | null;
  /** Whether the admin has designated a rescue ISO (QEMU only). */
  rescueAvailable?: boolean;
}

/** One 1 s sample from GET /vms/:id/live-stats (cached cluster/resources). */
export interface VmLiveSample {
  status: string;
  cpu: number; // 0..1 fraction of allocated cores
  maxcpu: number;
  mem: number; // bytes
  maxmem: number; // bytes
  uptime?: number;
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

/** Per-VM backup policy. backupCron null = cluster-wide weekly default;
 *  backupKeep null = default rolling retention. */
export interface BackupPolicy {
  backupCron: string | null;
  backupKeep: number | null;
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

/** A personal API token's non-secret metadata (for listing). */
export interface ApiTokenInfo {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/** Returned once when a token is created — `token` is the raw secret, shown one time. */
export interface CreatedApiToken {
  id: string;
  name: string;
  token: string;
  createdAt: string;
}

export interface Invite {
  id: string;
  token: string;
  label: string | null;
  email: string | null;
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
  email: string | null;
  maxCpu: number;
  maxRam: number;
  maxStorage: number;
  require2fa: boolean;
  expiresAt: string;
  emailed: boolean;
  emailError?: string;
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

/** A GPU/PCI passthrough request the current user has made (for the pending badge). */
export interface MyPassthroughRequest {
  id: string;
  vmId: string;
  vmName: string;
  reason: string | null;
  status: string; // pending | approved | denied
  mapping: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** A pending passthrough request in the admin review queue. */
export interface PendingPassthroughRequest {
  id: string;
  reason: string | null;
  createdAt: string;
  user: { id: string; email: string; displayName: string };
  vm: { id: string; name: string; node: string; vmid: number };
  // Background-apply progress: approving may stop + migrate the VM to the
  // device's node before attaching. null until an approval is started.
  applyState: "queued" | "stopping" | "migrating" | "attaching" | "failed" | null;
  applyError: string | null;
  targetNode: string | null;
  mapping: string | null;
  /** q35 / OVMF / EFI-disk readiness warnings for the VM (may be empty). */
  bootWarnings: string[];
}

/** An admin-defined Proxmox PCI resource mapping (what a passthrough attaches). */
export interface PciMapping {
  id: string;
  description?: string;
  nodes: string[];
}

/** An attached PCI device on a VM (parsed `hostpciN`). */
export interface PassthroughDevice {
  index: number;
  slot: string;
  mapping?: string;
  raw: string;
}

export interface PendingQuotaRequest {
  id: string;
  cpu: number;
  ram: number;
  storage: number;
  reason: string | null;
  createdAt: string;
  user: { id: string; email: string; displayName: string; quota: { cpu: number; ram: number; storage: number } };
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

export type AlertMetric = "cpu" | "memory" | "disk" | "down";

export interface AlertRule {
  id: string;
  metric: AlertMetric;
  threshold: number;
  sustainedMin: number;
  enabled: boolean;
  lastFiredAt: string | null;
}

/** An LXC OS template (vztmpl) available on the cluster. */
export interface LxcTemplate {
  volid: string;
  name: string;
  storage: string;
  size?: number;
}

export interface UserUsage {
  userId: string;
  email: string;
  displayName: string;
  samples: number;
  avgCpuPct: number;
  avgMemBytes: number;
  peakMemBytes: number;
}

export interface ResourceHistory {
  days: number;
  usage: UserUsage[];
}

export interface ProxmoxResources {
  storages: Array<{ name: string; type: string }>;
  bridges: Array<{ name: string }>;
  isoStorages: Array<{ name: string; type: string }>;
  backupStorages: Array<{ name: string; type: string }>;
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
  defaults: { storage: string | null; bridge: string | null; isoStorage: string | null; backupStorage: string | null };
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
  notify: NotifyConfig;
}

export type NotifyEvent = "backup.failed" | "vm.error" | "auth.lockout";

export interface NotifyConfig {
  webhookUrl: string;
  emailEnabled: boolean;
  emailTo: string;
  events: NotifyEvent[];
}

export const NOTIFY_EVENT_LABELS: Record<NotifyEvent, string> = {
  "backup.failed": "Backup failed",
  "vm.error": "VM provisioning error",
  "auth.lockout": "Account locked (brute-force)",
};

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

export type Arch = "amd64" | "arm64";

export interface Template {
  id: string;
  name: string;
  description: string | null;
  os: string | null;
  arch: Arch | null;
  proxmoxVmId: number;
  proxmoxNode: string;
  diskGb: number;
  notes: string | null;
  cloudInit: boolean;
  icon: string | null;
  published: boolean;
  /** Cloud image URL it was built from (set for importer-built templates). */
  sourceUrl: string | null;
  /** Last successful refresh, or null if never refreshed. */
  refreshedAt: string | null;
  createdAt: string;
}

export interface CuratedImage {
  id: string;
  label: string;
  url: string;
  os: string;
  defaultUser: string;
  arch: Arch;
}

export interface DiscoveredTemplate {
  vmid: number;
  node: string;
  name: string;
  diskGb: number;
  arch: Arch;
}

export interface ClusterStats {
  nodes: number;
  cpu: { total: number; used: number };
  memory: { total: number; used: number };
  storage: { total: number; used: number };
  vmCount: number;
}

/** Per-node health + cluster quorum (kiosk command center). */
export interface NodeHealth {
  name: string;
  online: boolean;
  cpu: number; // 0..1 load fraction
  mem: { used: number; total: number };
  uptime: number; // seconds
}

export interface ClusterHealth {
  quorate: boolean;
  expected: number;
  online: number;
  nodes: NodeHealth[];
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

// ─── Cluster Balancer ─────────────────────────────────────────

export type BalancerMode = "off" | "recommend" | "auto";

export interface BalancerSettings {
  mode: BalancerMode;
  thresholdPct: number;
  maxMoves: number;
  exclude: number[];
}

export interface BalancerMove {
  vmId: string;
  proxmoxVmId: number;
  name: string;
  fromNode: string;
  toNode: string;
  memBytes: number;
  reason: string;
}

export interface BalancerNodeView {
  name: string;
  online: boolean;
  arch: "amd64" | "arm64" | "unknown";
  cpuPct: number;
  memUsed: number;
  memTotal: number;
  loadPct: number;
  vmCount: number;
}

export interface BalancePlan {
  balanced: boolean;
  reason: string;
  thresholdPct: number;
  currentSpreadPct: number;
  projectedSpreadPct: number;
  nodes: BalancerNodeView[];
  projectedNodes: BalancerNodeView[];
  moves: BalancerMove[];
}

export interface BalancerResponse {
  settings: BalancerSettings;
  plan: BalancePlan | null;
  error?: string;
}

export interface DrainMove {
  vmId: string;
  proxmoxVmId: number;
  name: string;
  fromNode: string;
  toNode: string;
  memBytes: number;
  running: boolean;
  reason: string;
}

export interface DrainBlocker {
  proxmoxVmId: number;
  name: string;
  reason: string;
}

export interface DrainPlan {
  node: string;
  targetNode: string | null;
  ok: boolean;
  reason: string;
  moves: DrainMove[];
  blockers: DrainBlocker[];
  targets: BalancerNodeView[];
}
