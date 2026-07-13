import type { VirtualMachine } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  getClient,
  guestAgentPing,
  guestFileWrite,
  guestExec,
  guestExecOutput,
  ensureIdePinhole,
  ensureHostCpu,
  getNodeAvxMap,
  migratableTargets,
  getNodesHealth,
  pickBestNode,
  shutdownVm,
  waitForTask,
} from './proxmox.service.js';
import { migrateVmToNode, startVm as startVmService, getVmWithLiveStatus } from './vm.service.js';
import { issueGatewayToken, listModelPickerEntries } from './ide-gateway.service.js';
import { getConfig } from './config.service.js';
import {
  IDE_SETTINGS_JSON,
  IDE_AUTOSTART_PACKAGE_JSON,
  IDE_AUTOSTART_EXTENSION_JS,
} from './ide-assets.generated.js';

/**
 * ProxMate IDE — lazy in-guest provisioning. On first "Open IDE", ProxMate installs
 * code-server + OpenCode NATIVELY into the tenant's VM (so the IDE truly IS the VM:
 * real users, hostname, services, opened at /) by running a self-contained bootstrap
 * script through the QEMU guest agent. The VM is LOCKED (ideState='installing') while
 * this runs so nothing can console/stop/delete it mid-install. Idempotent: re-running
 * updates config and restarts the service.
 */

export type IdeState = 'none' | 'installing' | 'ready' | 'failed';

// Generous ceiling: the code-server + OpenCode installers pull a fair bit; if the
// service still isn't up after this, mark it failed (retryable) so a stuck install
// doesn't lock the VM forever.
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Port code-server listens on inside the guest (and the isolation pinhole target). */
const IDE_GUEST_PORT = Number(process.env['IDE_GUEST_PORT'] || 8080);

/**
 * Pinned in-guest tool versions — the bootstrap installs EXACTLY these, so a new
 * upstream release can't silently break provisioning (the reverse proxy also
 * depends on code-server's relative-URL behavior, verified against this line).
 * Bump deliberately after testing a live install, or override per-deploy via env.
 */
export const IDE_CODE_SERVER_VERSION = process.env['IDE_CODE_SERVER_VERSION'] || '4.128.0';
export const IDE_OPENCODE_VERSION = process.env['IDE_OPENCODE_VERSION'] || '1.17.18';

/**
 * Minimum guest RAM (MB) to install the IDE onto. code-server + the OpenCode
 * agent spike memory during install/first-open — 4 GB OOMs and wedges the VM
 * (steady-state is light, but the transient isn't). 8 GB is the proven-safe
 * floor; admins can lower it via the `ide_min_ram_mb` SystemConfig key.
 */
const IDE_MIN_RAM_MB_DEFAULT = 8192;

export function ideStateOf(vm: { ideState: string | null }): IdeState {
  const s = vm.ideState;
  return s === 'installing' || s === 'ready' || s === 'failed' ? s : 'none';
}

/** True while an install is in progress — used to gate destructive VM actions. */
export function isIdeInstalling(vm: { ideState: string | null }): boolean {
  return vm.ideState === 'installing';
}

function renderOpencodeJson(gatewayUrl: string, models: Array<{ id: string; name: string }>, defaultModel?: string): string {
  const modelMap: Record<string, { name: string }> = {};
  for (const m of models) modelMap[m.id] = { name: m.name };
  const cfg: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    ...(defaultModel ? { model: `proxmate/${defaultModel}` } : {}),
    provider: {
      proxmate: {
        npm: '@ai-sdk/openai-compatible',
        name: 'ProxMate',
        options: { baseURL: gatewayUrl, apiKey: '{env:PROXMATE_IDE_TOKEN}' },
        models: modelMap,
      },
    },
  };
  return JSON.stringify(cfg, null, 2);
}

/**
 * The self-contained POSIX-sh bootstrap the guest agent runs as root. Each embedded
 * file uses a quoted heredoc so nothing inside is expanded. `token` is base64url
 * (no quotes) so it's safe single-quoted.
 */
function buildBootstrap(token: string, opencodeJson: string): string {
  return `#!/bin/sh
set -e
# Detached via the guest agent — the environment is minimal, so set HOME (the
# code-server installer runs 'set -u' and references $HOME) and a sane PATH.
export HOME=/root
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export DEBIAN_FRONTEND=noninteractive
echo "[proxmate-ide] installing code-server ${IDE_CODE_SERVER_VERSION}..."
curl -fsSL https://code-server.dev/install.sh | sh -s -- --version ${IDE_CODE_SERVER_VERSION}
echo "[proxmate-ide] installing OpenCode ${IDE_OPENCODE_VERSION}..."
HOME=/root sh -c 'curl -fsSL https://opencode.ai/install | bash -s -- --version ${IDE_OPENCODE_VERSION}'
install -m 0755 /root/.opencode/bin/opencode /usr/local/bin/opencode
mkdir -p /root/.local/share/code-server/User /root/.local/share/code-server/extensions/proxmate-ide-autostart /root/.config/opencode
cat > /root/.local/share/code-server/User/settings.json <<'PMEOF_SETTINGS'
${IDE_SETTINGS_JSON}
PMEOF_SETTINGS
cat > /root/.local/share/code-server/extensions/proxmate-ide-autostart/package.json <<'PMEOF_PKG'
${IDE_AUTOSTART_PACKAGE_JSON}
PMEOF_PKG
cat > /root/.local/share/code-server/extensions/proxmate-ide-autostart/extension.js <<'PMEOF_EXT'
${IDE_AUTOSTART_EXTENSION_JS}
PMEOF_EXT
code-server --install-extension sst-dev.opencode || echo "[proxmate-ide] warn: opencode ext install failed (offline?)"
cat > /root/.config/opencode/opencode.json <<'PMEOF_OC'
${opencodeJson}
PMEOF_OC
umask 077
printf 'PROXMATE_IDE_TOKEN=%s\\n' '${token}' > /etc/proxmate-ide.env
cat > /etc/systemd/system/proxmate-ide.service <<'PMEOF_SVC'
[Unit]
Description=ProxMate IDE (code-server, opened at /)
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=root
EnvironmentFile=/etc/proxmate-ide.env
ExecStart=/usr/bin/code-server --app-name "ProxMate IDE" --auth none --disable-telemetry --bind-addr 0.0.0.0:8080 /
Restart=on-failure
RestartSec=3
[Install]
WantedBy=multi-user.target
PMEOF_SVC
systemctl daemon-reload
systemctl enable --now proxmate-ide.service
echo "[proxmate-ide] done"
`;
}

/**
 * Machine-readable reason for a provision refusal, so the UI can offer the right
 * next step: 'reboot_required' → a cpu-model change needs one reboot to land;
 * 'node_no_avx' → the NODE's physical CPU lacks AVX, so no reboot will ever help —
 * offer the one-click relocate to a capable node instead.
 */
export type IdeProvisionErrorCode = 'reboot_required' | 'node_no_avx';

export class IdeProvisionError extends Error {
  constructor(
    message: string,
    public code?: IdeProvisionErrorCode,
  ) {
    super(message);
    this.name = 'IdeProvisionError';
  }
}

/**
 * Kick off (or re-run) the in-guest install. Fire-and-forget: writes the bootstrap
 * into the guest and starts it detached, then flips the VM to 'installing' and
 * returns immediately — the caller polls {@link refreshIdeState}.
 */
export async function startIdeProvision(
  vm: VirtualMachine,
  user: { id: string; role: string },
  publicApiBaseUrl: string,
): Promise<IdeState> {
  if (vm.type === 'lxc') throw new IdeProvisionError('The IDE needs a QEMU VM — containers are not supported.');
  if (vm.status !== 'running') throw new IdeProvisionError('Start the VM before installing the IDE.');

  const client = await getClient();
  if (!(await guestAgentPing(vm.proxmoxNode, vm.proxmoxVmId, client))) {
    throw new IdeProvisionError(
      'The QEMU guest agent is not responding. The IDE installs through it — make sure qemu-guest-agent is installed and running in the VM.',
    );
  }

  // Minimum-spec guardrail — refuse to install onto a box that can't run the IDE.
  // (a) RAM floor: the install/first-open transient OOMs a small VM (4 GB wedges).
  const minRamMb = Number(await getConfig('ide_min_ram_mb')) || IDE_MIN_RAM_MB_DEFAULT;
  if (vm.ram < minRamMb) {
    throw new IdeProvisionError(
      `The ProxMate IDE needs at least ${Math.round(minRamMb / 1024)} GB of RAM — this VM has ${Math.round(
        vm.ram / 1024,
      )} GB. Resize it, then open the IDE again.`,
    );
  }
  // (b) AVX: the OpenCode agent's Bun runtime needs it. Set the host CPU model
  // (idempotent), then require the guest to actually expose AVX. If it's missing,
  // the NODE's own capability decides the remedy: a node whose silicon has AVX
  // (or unknown — fail toward the cheap fix) just needs the guest rebooted so the
  // cpu-model change lands; a node that demonstrably LACKS AVX can never provide
  // it, so the answer is relocating the VM to a capable node.
  await ensureHostCpu(vm.proxmoxNode, vm.proxmoxVmId, client);
  const avx = await guestExecOutput(
    vm.proxmoxNode,
    vm.proxmoxVmId,
    ['/bin/sh', '-c', 'grep -qw avx /proc/cpuinfo && echo yes || echo no'],
    client,
    8000,
  );
  if (avx.stdout.trim() !== 'yes') {
    const nodeAvx = (await getNodeAvxMap(client)).get(vm.proxmoxNode);
    if (nodeAvx === false) {
      throw new IdeProvisionError(
        "This node's CPU hardware doesn't support AVX, which the OpenCode AI agent needs — no reboot will add it. The VM can be moved to a capable node instead.",
        'node_no_avx',
      );
    }
    throw new IdeProvisionError(
      "This VM's CPU doesn't expose AVX, which the OpenCode AI agent needs. I set its CPU type to 'host' — reboot the VM, then open the IDE again.",
      'reboot_required',
    );
  }

  // Reuse the tenant-isolation firewall instead of fighting it: add a single
  // managed, infra-scoped :8080 pinhole so the reverse proxy can reach code-server
  // while the guest stays isolated from every other tenant. `ide_ingress_cidr` is
  // the ProxMate infrastructure source (node / subnet-router / backend host). If
  // it's unset, an isolated guest stays unreachable — warn, but don't block (a
  // flat network with isolation off doesn't need it).
  const ingress = (await getConfig('ide_ingress_cidr'))?.trim();
  if (ingress) {
    await ensureIdePinhole(vm.proxmoxNode, vm.proxmoxVmId, { port: IDE_GUEST_PORT, source: ingress }, client);
  } else {
    logger.warn(
      { vmId: vm.id },
      'ide: ide_ingress_cidr is not set — the tenant-isolation firewall may block the reverse proxy from reaching code-server',
    );
  }

  const issued = await issueGatewayToken(user, vm.id, publicApiBaseUrl);
  if (!issued) throw new IdeProvisionError('ProxMate IDE is not available for this VM.');

  const models = await listModelPickerEntries(user);
  const opencodeJson = renderOpencodeJson(issued.baseUrl, models, models[0]?.id);
  const script = buildBootstrap(issued.token, opencodeJson);

  // Ship the bootstrap as base64 (pure ASCII — the raw script has non-ASCII/newlines
  // that break Proxmox's agent/file-write content param) and decode it in the guest.
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  await guestFileWrite(vm.proxmoxNode, vm.proxmoxVmId, '/tmp/pmide-bootstrap.b64', b64, client);
  // Detach fully so the install survives past this request/agent session.
  await guestExec(
    vm.proxmoxNode,
    vm.proxmoxVmId,
    [
      '/bin/sh',
      '-c',
      'base64 -d /tmp/pmide-bootstrap.b64 > /tmp/pmide-bootstrap.sh && setsid sh /tmp/pmide-bootstrap.sh >/var/log/pmide-provision.log 2>&1 </dev/null & echo started',
    ],
    client,
  );

  await prisma.virtualMachine.update({ where: { id: vm.id }, data: { ideState: 'installing', ideStateAt: new Date() } });
  logger.info({ vmId: vm.id, vmid: vm.proxmoxVmId }, 'ide install started');
  return 'installing';
}

/** Is the guest's code-server serving yet? (probe the IDE target, fail-fast). */
async function probeIdeUp(vm: VirtualMachine): Promise<boolean> {
  const override = process.env['IDE_TARGET_OVERRIDE'];
  const target = override || (vm.ipAddress ? `http://${vm.ipAddress}:${IDE_GUEST_PORT}` : null);
  if (!target) return false;
  try {
    const r = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    return r.status > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the current install state, advancing 'installing' → 'ready' once the
 * guest is serving, or → 'failed' after the timeout so a stuck install can't lock
 * the VM forever.
 */
export async function refreshIdeState(vm: VirtualMachine): Promise<IdeState> {
  const state = ideStateOf(vm);
  if (state !== 'installing') return state;

  if (vm.ideStateAt && Date.now() - vm.ideStateAt.getTime() > INSTALL_TIMEOUT_MS) {
    await prisma.virtualMachine.update({ where: { id: vm.id }, data: { ideState: 'failed', ideStateAt: new Date() } });
    return 'failed';
  }
  if (await probeIdeUp(vm)) {
    await prisma.virtualMachine.update({ where: { id: vm.id }, data: { ideState: 'ready', ideStateAt: new Date() } });
    logger.info({ vmId: vm.id }, 'ide install ready');
    return 'ready';
  }
  return 'installing';
}

// ─── Relocate to an AVX-capable node (the 'node_no_avx' escape hatch) ─────────
//
// When the guardrail above hits 'node_no_avx', no reboot can ever fix the VM in
// place — the node's silicon lacks the instructions. This moves the guest to a
// node whose CPU is CONFIRMED AVX-capable, picked by the server (tenants never
// choose nodes — a recorded design decision). The move is deliberately OFFLINE:
// the guest runs `cpu: host`, and live-migrating a host-CPU guest between
// heterogeneous CPUs is exactly the unsafe case (recorded caveat), so we shut
// down → migrate → start. Long disk copies outlast any HTTP request (and the
// tunnel), so the route returns 202 and the UI polls the in-memory tracker
// below (single-process backend — same pattern as the gateway rate window).

export interface IdeRelocateStatus {
  state: 'running' | 'done' | 'failed';
  startedAt: number;
  target?: string;
  error?: string;
}

const relocations = new Map<string, IdeRelocateStatus>();
const RELOCATE_RESULT_TTL_MS = 10 * 60 * 1000;

export function getIdeRelocateStatus(vmId: string): IdeRelocateStatus | null {
  const r = relocations.get(vmId);
  if (!r) return null;
  // Expire finished entries so the map can't grow unbounded.
  if (r.state !== 'running' && Date.now() - r.startedAt > RELOCATE_RESULT_TTL_MS) {
    relocations.delete(vmId);
    return null;
  }
  return r;
}

/**
 * Validate that a relocate makes sense for this VM and pick the target node.
 * Throws {@link IdeProvisionError} with a human-readable reason otherwise.
 */
export async function planIdeRelocate(vm: VirtualMachine): Promise<string> {
  if (vm.type === 'lxc') throw new IdeProvisionError('The IDE needs a QEMU VM — containers are not supported.');
  if (vm.hasPassthrough) {
    throw new IdeProvisionError('This VM has a PCI/GPU device attached and is pinned to its node — it can’t be moved.');
  }
  if (vm.ideState === 'installing' || vm.deployState === 'deploying') {
    throw new IdeProvisionError('This VM is busy finishing another operation — try again in a minute.');
  }
  if (relocations.get(vm.id)?.state === 'running') {
    throw new IdeProvisionError('A move is already in progress for this VM.');
  }

  const client = await getClient();
  const avxMap = await getNodeAvxMap(client);
  if (avxMap.get(vm.proxmoxNode) !== false) {
    throw new IdeProvisionError('This VM’s node supports the IDE — no move is needed. Reboot the VM and open the IDE again.');
  }

  // Where CAN it go (Proxmox preflight, fail-open to online nodes) ∩ online ∩
  // CONFIRMED AVX-capable. Requiring confirmed AVX is deliberately fail-CLOSED:
  // moving a guest to another incapable (or unknowable) node helps nobody.
  const [allowed, health] = await Promise.all([
    migratableTargets(vm.proxmoxNode, vm.proxmoxVmId, client),
    getNodesHealth(client),
  ]);
  const onlineOthers = health.nodes.filter((n) => n.online && n.name !== vm.proxmoxNode).map((n) => n.name);
  const base = allowed ?? onlineOthers;
  const onlineSet = new Set(onlineOthers);
  const eligible = base.filter((n) => onlineSet.has(n) && avxMap.get(n) === true);
  if (eligible.length === 0) {
    throw new IdeProvisionError(
      'No reachable node with an AVX-capable CPU can take this VM right now — ask your admin about moving it.',
    );
  }
  return pickBestNode({ cpu: vm.cpu, ramMb: vm.ram, storageGb: 0 }, undefined, client, eligible, 'amd64');
}

/**
 * Kick off the background stop → offline-migrate → start. Returns the chosen
 * target immediately; progress is polled via {@link getIdeRelocateStatus}.
 */
export async function startIdeRelocate(vm: VirtualMachine, actorId: string): Promise<string> {
  const target = await planIdeRelocate(vm);
  relocations.set(vm.id, { state: 'running', startedAt: Date.now(), target });

  void (async () => {
    try {
      const client = await getClient();
      // Graceful shutdown first (skip if already off). cpu:host forbids a live move.
      const { live } = await getVmWithLiveStatus(vm);
      if (live?.status === 'running') {
        const upid = await shutdownVm(vm.proxmoxNode, vm.proxmoxVmId, client);
        await waitForTask(vm.proxmoxNode, upid, client, 5 * 60_000);
        await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'stopped' } });
      }
      const moved = await migrateVmToNode(vm, target, { offline: true, actorId });
      await startVmService(moved);
      relocations.set(vm.id, { state: 'done', startedAt: Date.now(), target });
      logger.info({ vmId: vm.id, target }, 'ide relocate done');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'move failed';
      relocations.set(vm.id, { state: 'failed', startedAt: Date.now(), target, error: msg });
      logger.error({ vmId: vm.id, target, err: msg }, 'ide relocate failed');
    }
  })();

  return target;
}
