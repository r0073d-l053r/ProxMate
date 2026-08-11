import type { VirtualMachine } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  getClient,
  guestAgentPing,
  guestExecOutput,
  getVmConfig,
  setGuestUserPassword,
} from './proxmox.service.js';
import { decrypt } from '../lib/crypto.js';
import { notify } from './notify.service.js';

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
 * Set the tenant's login password in-guest, via the guest agent, then destroy our
 * copy of it.
 *
 * This exists because the obvious alternative — handing the password to cloud-init
 * as `cipassword` — leaves its crypt hash in two places the tenant can read for the
 * life of the guest: the cloud-init seed drive (`/dev/sr0`, the 2026-07-18 pentest
 * finding) and the guest's own `/var/lib/cloud/instances/<id>/user-data.txt` cache.
 * Both were confirmed live on 2026-08-11, and ejecting the seed does NOT fix it
 * because the on-disk cache survives. The agent's set-user-password writes only to
 * /etc/shadow, so the credential never lands anywhere a tenant can read it back.
 *
 * Ordering matters: this runs only once cloud-init reports finished, because
 * `cc_users_groups` must have created the account first — setting a password for a
 * user that does not exist yet fails.
 *
 * Best-effort by design. A failure here must never hold the deploy lock: the guest
 * is otherwise usable, an SSH key may be the tenant's real credential anyway, and
 * the existing "reset password" flow (same agent call) is the recovery path. We keep
 * the encrypted value on a failure so a later poll can retry, and drop it once set.
 */
async function applyPendingCiPassword(vm: VirtualMachine): Promise<void> {
  if (!vm.pendingCiPassword || vm.type !== 'qemu') return;
  const username = await ciUserOf(vm);
  if (!username) {
    // Nothing to set it on. Drop the secret rather than hold it indefinitely.
    await clearPendingCiPassword(vm.id);
    logger.warn({ vmId: vm.id }, 'no cloud-init user on the guest — discarding the pending password');
    return;
  }
  try {
    const password = decrypt(vm.pendingCiPassword);
    await setGuestUserPassword(vm.proxmoxNode, vm.proxmoxVmId, username, password);
    await clearPendingCiPassword(vm.id);
    logger.info({ vmId: vm.id, username }, 'login password set in-guest via the guest agent');
  } catch (err) {
    // Left encrypted for the next poll to retry. The 8-minute timeout path calls
    // this once more, and after that the tenant uses reset-password.
    logger.warn({ vmId: vm.id, err }, 'could not set the login password in-guest — will retry');
  }
}

/** Read the cloud-init username Proxmox has on the guest (`ciuser`). */
async function ciUserOf(vm: VirtualMachine): Promise<string | null> {
  try {
    const cfg = await getVmConfig(vm.proxmoxNode, vm.proxmoxVmId, undefined, 'qemu');
    const u = cfg['ciuser'];
    return typeof u === 'string' && u.trim() ? u.trim() : null;
  } catch {
    return null;
  }
}

async function clearPendingCiPassword(id: string): Promise<void> {
  await prisma.virtualMachine.update({ where: { id }, data: { pendingCiPassword: null } });
}

/**
 * The deploy window has closed with the password still unapplied — almost always
 * because the guest agent never came up (the template does not ship it and apt could
 * not install it on first boot).
 *
 * Three things must happen, and none is optional. Drop the stored secret: it is now
 * useless and holding a reversibly-encrypted password indefinitely is exactly the
 * kind of quiet accumulation this change exists to stop. Log at ERROR. And tell an
 * ADMIN — because the tenant may have no way into their VM at all, and the only
 * other signal is that tenant failing to log in and filing a ticket. A server-side
 * log is not a signal anybody is watching; the notification is the one an operator
 * has already configured to reach them.
 *
 * The message names the template deliberately. This failure is never really about
 * one VM: it means a template does not ship `qemu-guest-agent`, so EVERY
 * password-only deploy from it is broken the same way. Fixing the template is the
 * action, so the notification has to carry enough to identify it. Recovery for the
 * guest already deployed is the existing reset-password flow (same agent call),
 * which will also fail until the agent exists.
 */
async function abandonPendingCiPassword(id: string): Promise<void> {
  const vm = await prisma.virtualMachine.findUnique({
    where: { id },
    select: { pendingCiPassword: true, name: true, description: true, os: true, proxmoxVmId: true },
  });
  if (!vm?.pendingCiPassword) return;
  await clearPendingCiPassword(id);
  logger.error(
    { vmId: id, name: vm.name },
    'could not set the login password in-guest before the deploy window closed — the guest agent never responded. ' +
      'If this VM has no SSH key the tenant cannot log in; the template needs qemu-guest-agent baked in.',
  );
  // `description` is written as "From template: <name>" by deployFromTemplate; `os`
  // carries the template's OS label. Either one points an admin at the template to
  // fix, so send whichever is present rather than nothing.
  const source = vm.description?.trim() || vm.os;
  await notify({
    event: 'deploy.agent_missing',
    title: `${vm.name} (VMID ${vm.proxmoxVmId}) — login password could not be set`,
    message:
      `The QEMU guest agent never responded during the deploy window, so the requested login ` +
      `password was never applied in-guest. If this VM was deployed without an SSH key, its owner ` +
      `cannot log in at all.\n\n` +
      `Source: ${source}\n\n` +
      `Fix the template, not the VM: ProxMate sets cloud-init passwords through the guest agent ` +
      `(never on the cloud-init seed, where any tenant could read them), so a template without ` +
      `qemu-guest-agent pre-installed breaks every password-only deploy made from it. Install and ` +
      `enable qemu-guest-agent in the template, then re-publish it.`,
  }).catch(() => undefined);
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
    // Last attempt: this is the final poll, so anything still pending after it is
    // never getting applied.
    await applyPendingCiPassword(vm);
    await abandonPendingCiPassword(vm.id);
    return markReady(vm);
  }

  const settled = await cloudInitSettled(vm);
  if (settled === true) {
    logger.info({ vmId: vm.id }, 'cloud-init deploy finished — unlocking');
    // Only now: cc_users_groups has run, so the account exists to set a password on.
    await applyPendingCiPassword(vm);
    return markReady(vm);
  }
  return 'deploying';
}
