import type { VirtualMachine } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { getClient, guestAgentPing, guestFileWrite, guestExec } from './proxmox.service.js';
import { issueGatewayToken, listModelPickerEntries } from './ide-gateway.service.js';
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
export DEBIAN_FRONTEND=noninteractive
echo "[proxmate-ide] installing code-server..."
curl -fsSL https://code-server.dev/install.sh | sh
echo "[proxmate-ide] installing OpenCode..."
HOME=/root sh -c 'curl -fsSL https://opencode.ai/install | bash'
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

export class IdeProvisionError extends Error {
  constructor(message: string) {
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
  const port = process.env['IDE_GUEST_PORT'] || '8080';
  const target = override || (vm.ipAddress ? `http://${vm.ipAddress}:${port}` : null);
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
