import type { VirtualMachine } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { getClient, guestAgentPing, guestExecOutput, scrubCloudInitPassword } from './proxmox.service.js';

/**
 * Cloud-init deploy lock. A VM cloned from a cloud-init template is reported
 * 'running' by Proxmox the instant it boots, but cloud-init keeps working inside
 * the guest for another minute or several — growing the disk, installing the
 * guest agent, docker/tailscale/the tenant's extras, applying the always-on base.
 * Stopping / restarting / deleting the VM in that window leaves a half-built box.
 *
 * So `deployFromTemplate` / `rebuildVm` flag the guest `deployState='deploying'`
 * (mirrors the IDE install lock — {@link ../services/ide-provision.service.ts}),
 * which the VM routes turn into a 409 on destructive actions. The lock clears the
 * moment a guest-agent `cloud-init status` probe reports the run finished, or —
 * as a fail-safe so a guest with no agent (nothing to probe) never stays locked
 * forever — after {@link DEPLOY_TIMEOUT_MS}. This module is side-effect-light and
 * unit-tested against a mocked agent.
 */

export type DeployState = 'none' | 'deploying' | 'ready';

// Upper bound on how long we keep the lock without confirmation. cloud-init that
// installs a heavy extras combo (apt update + docker + tailscale) can run a few
// minutes; past this it's either done, stuck, or there's no agent to ask — either
// way stop locking. The agent probe unlocks earlier in the common case.
const DEPLOY_TIMEOUT_MS = 8 * 60 * 1000;

export function deployStateOf(vm: { deployState: string | null }): DeployState {
  const s = vm.deployState;
  return s === 'deploying' || s === 'ready' ? s : 'none';
}

/** True while cloud-init is still provisioning — used to gate destructive VM actions. */
export function isDeploying(vm: { deployState: string | null }): boolean {
  return vm.deployState === 'deploying';
}

async function markReady(vm: VirtualMachine): Promise<DeployState> {
  await prisma.virtualMachine.update({ where: { id: vm.id }, data: { deployState: 'ready', deployStateAt: new Date() } });
  return 'ready';
}

/**
 * Ask the guest, via the QEMU agent, whether cloud-init has finished. Returns
 * true when the run reached a terminal state (done / error / disabled / degraded)
 * OR when there's no cloud-init to wait on (command missing), false while it's
 * still running, and null when we couldn't reach the agent to find out.
 */
async function cloudInitSettled(vm: VirtualMachine): Promise<boolean | null> {
  const client = await getClient();
  if (!(await guestAgentPing(vm.proxmoxNode, vm.proxmoxVmId, client))) return null;
  try {
    // `cloud-init status` prints e.g. "status: done". Exit codes vary by version
    // (0 done, 1 error, 2 degraded/disabled), so trust the printed status, and
    // treat a missing binary (127) as "nothing to wait for".
    const r = await guestExecOutput(
      vm.proxmoxNode,
      vm.proxmoxVmId,
      ['/bin/sh', '-c', 'cloud-init status 2>/dev/null || true'],
      client,
      8000,
    );
    const out = r.stdout.toLowerCase();
    const m = out.match(/status:\s*(\w+)/);
    if (m) {
      const status = m[1];
      // Anything other than an in-progress run means the deploy window is over.
      return status !== 'running' && status !== 'not' /* "not run" / "not started" */;
    }
    // No parseable status line — cloud-init isn't present (or not initialised).
    // There's nothing to keep waiting for, so consider the deploy settled.
    return true;
  } catch {
    // Agent glitch / probe timeout — unknown, try again on the next poll.
    return null;
  }
}

/**
 * Resolve the current deploy state, advancing 'deploying' → 'ready' once cloud-init
 * settles (or the timeout elapses). Called from the VM-detail fetch so the lock
 * clears on its own as the tenant watches the VM come up. No-op for guests that
 * aren't mid-deploy.
 */
export async function refreshDeployState(vm: VirtualMachine): Promise<DeployState> {
  const state = deployStateOf(vm);
  if (state !== 'deploying') return state;

  if (vm.deployStateAt && Date.now() - vm.deployStateAt.getTime() > DEPLOY_TIMEOUT_MS) {
    logger.info({ vmId: vm.id }, 'cloud-init deploy lock timed out — unlocking');
    return markReady(vm);
  }

  const settled = await cloudInitSettled(vm);
  if (settled === true) {
    // Cloud-init has applied the login password, so the copy Proxmox keeps in the
    // config and on the attached seed drive is now pure liability — a root shell in
    // the guest can read the hash off it (2026-07-18 pentest finding). Scrub it here
    // and ONLY here: this is the one branch that has confirmed the run finished. The
    // timeout branch above has not, and removing a password cloud-init never applied
    // would leave a password-only tenant with no way in.
    //
    // Unlock only once the scrub has succeeded, so a transient Proxmox error is
    // retried on the next poll instead of silently leaving the hash behind. This
    // cannot wedge the guest: the timeout branch above force-unlocks regardless.
    if (!(await scrubDeployCredential(vm))) return 'deploying';
    logger.info({ vmId: vm.id }, 'cloud-init deploy finished — unlocking');
    return markReady(vm);
  }
  return 'deploying';
}

/**
 * Remove the cloud-init password now that it has been applied. Returns false when
 * the attempt failed and is worth retrying; true when there is nothing left to do
 * (scrubbed, or never had one, or not a guest kind that carries a seed).
 */
async function scrubDeployCredential(vm: VirtualMachine): Promise<boolean> {
  if (vm.type !== 'qemu') return true; // cloud-init seeds are a QEMU concern
  try {
    const scrubbed = await scrubCloudInitPassword(vm.proxmoxNode, vm.proxmoxVmId);
    if (scrubbed) logger.info({ vmId: vm.id }, 'cloud-init password scrubbed from config + seed');
    return true;
  } catch (err) {
    logger.warn({ vmId: vm.id, err }, 'could not scrub the cloud-init password — retrying on the next refresh');
    return false;
  }
}
