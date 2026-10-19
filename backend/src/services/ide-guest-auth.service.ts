import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { isLoopbackOrLinkLocal } from '../lib/url-safety.js';
import { getClient, getVmIps } from './proxmox.service.js';
import { envNumber } from '../lib/env-number.js';

/**
 * Per-VM guest credential for the ProxMate IDE.
 *
 * The reverse proxy dials the guest at the IP its own guest agent reports, and a
 * guest's root user controls that report. So reaching *some* code-server at that
 * address proves nothing about WHICH VM it belongs to. Each install therefore gets
 * its own random secret, held encrypted here and handed only to that guest, and
 * code-server runs with password auth keyed to it:
 *
 *   - The guest's systemd env sets `HASHED_PASSWORD=<sha256 hex of the secret>`
 *     and code-server runs `--auth password`. A non-argon2 hash selects
 *     code-server's SHA256 mode, where a request is authenticated iff its
 *     `code-server-session` cookie equals that hash string exactly, and a login
 *     POST with the secret as password answers with that same cookie (code-server
 *     4.128.0: src/node/util.ts isCookieValid / handlePasswordValidation).
 *   - Before proxying, the backend proves the guest: it POSTs the secret to the
 *     guest's `/login` and requires the `code-server-session` cookie it gets back
 *     to equal the expected hash. Anything that is not this VM's install (another
 *     VM's code-server, an unrelated LAN service, an old `--auth none` install)
 *     cannot produce it, so the proxy refuses to relay.
 *   - Every proxied request then carries the cookie, injected server-side; the
 *     browser never holds it. Another VM's code-server rejects it.
 *
 * Scope of the guarantee: the proof shows the answering code-server holds this
 * VM's secret. It relies on the address being the one this VM's guest agent
 * reports now (read live before each proof, for running VMs only) and on the
 * backend→guest network path being trusted, as the isolation pinhole already
 * assumes. It does not by itself authenticate the network.
 *
 * Successful logins do not consume code-server's login rate limit, so the proof
 * costs nothing on a healthy install; a positive result is cached briefly per VM
 * and dropped as soon as the VM's recorded address changes or it stops running.
 */

/** code-server's session cookie name (no `--cookie-suffix` is configured). */
export const IDE_GUEST_COOKIE = 'code-server-session';

/** A fresh guest secret (URL-safe, no shell-special characters). */
export function newIdeGuestSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The value code-server holds as `HASHED_PASSWORD` and expects as its session
 * cookie. Lowercase hex, so it never contains `$argon` (which would switch
 * code-server to argon2 mode) and is safe in a systemd EnvironmentFile.
 */
export function ideGuestCookieValue(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Store (or rotate) the encrypted guest secret for a VM. */
export async function saveIdeGuestSecret(vmId: string, secret: string): Promise<void> {
  const secretEnc = encrypt(secret);
  await prisma.ideGuestSecret.upsert({
    where: { vmId },
    update: { secretEnc },
    create: { vmId, secretEnc },
  });
}

/**
 * The VM's guest secret, or null when none is stored (an install made before
 * guest authentication existed) or it can't be decrypted. Callers fail closed.
 */
export async function loadIdeGuestSecret(vmId: string): Promise<string | null> {
  const row = await prisma.ideGuestSecret.findUnique({ where: { vmId } });
  if (!row) return null;
  try {
    return decrypt(row.secretEnc);
  } catch (err) {
    logger.warn({ vmId, err: (err as Error)?.message }, 'ide: guest secret could not be decrypted');
    return null;
  }
}

function sameString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Pull one cookie's value out of a list of Set-Cookie header lines. */
function setCookieValue(lines: string[], name: string): string | undefined {
  for (const line of lines) {
    const first = line.split(';', 1)[0] ?? '';
    const i = first.indexOf('=');
    if (i === -1 || first.slice(0, i).trim() !== name) continue;
    const raw = first.slice(i + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/**
 * Ask the code-server at `target` to prove it holds this VM's secret (see the
 * file header). True only when it answers the login with the expected session
 * cookie; any other answer, or no answer, is false.
 */
export async function proveIdeGuest(target: string, secret: string, timeoutMs = 4000): Promise<boolean> {
  const expected = ideGuestCookieValue(secret);
  try {
    const r = await fetch(new URL('login', target.endsWith('/') ? target : `${target}/`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: secret }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    void r.body?.cancel().catch(() => {});
    const got = setCookieValue(r.headers.getSetCookie(), IDE_GUEST_COOKIE);
    return got !== undefined && sameString(got, expected);
  } catch {
    return false;
  }
}

/**
 * The upstream code-server URL for a guest address. Pure (env-injected) so the
 * per-VM routing precedence is unit-testable:
 *   1. `IDE_TARGET_OVERRIDE` — a single fixed URL for the rig. TEST-ONLY: it
 *      clobbers per-VM routing, so it must NOT be set in a multi-VM deployment.
 *   2. `http://<ipAddress>:<IDE_GUEST_PORT or 8080>`, never a loopback /
 *      link-local / metadata address.
 */
export function resolveIdeTargetUrl(
  vm: { ipAddress: string | null },
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const override = env['IDE_TARGET_OVERRIDE'];
  if (override) return override;
  if (!vm.ipAddress || isLoopbackOrLinkLocal(vm.ipAddress)) return null;
  // Parsed exactly as ide-provision parses it, so the proxy and the guest agree.
  const port = envNumber('IDE_GUEST_PORT', 8080, 1, env);
  return `http://${vm.ipAddress}:${port}`;
}

/** What {@link proveIdeGuestTarget} needs to know about a VM. */
export interface IdeGuestVm {
  id: string;
  type: string;
  status: string;
  ipAddress: string | null;
  proxmoxNode: string;
  proxmoxVmId: number;
}

/**
 * The target for the address this VM's guest agent reports right now (recorded
 * on the VM row if it moved), or null when it can't be read. A stale recorded
 * address is never dialled with the secret.
 */
async function freshIdeTarget(vm: IdeGuestVm, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (env['IDE_TARGET_OVERRIDE']) return resolveIdeTargetUrl(vm, env);
  if (vm.type === 'lxc') return null; // the IDE is QEMU-only (no guest agent on LXC)
  let ip: string | null = null;
  try {
    ip = (await getVmIps(vm.proxmoxNode, vm.proxmoxVmId, await getClient())).ip;
  } catch {
    return null;
  }
  if (!ip) return null;
  if (ip !== vm.ipAddress) {
    await prisma.virtualMachine.update({ where: { id: vm.id }, data: { ipAddress: ip } }).catch(() => undefined);
  }
  return resolveIdeTargetUrl({ ipAddress: ip }, env);
}

// Positive proofs only, one per VM: the target it was proven at and the
// credential used. A different recorded address, a new secret, a stopped VM or
// age all drop it. Single-process backend, so an in-memory map is enough.
const PROOF_TTL_MS = 5 * 60 * 1000;
const PROOF_REFRESH_MS = 60 * 1000;
const proofs = new Map<string, { target: string; cred: string; until: number }>();

// Single-flight: one agent read + one /login proof per VM and credential at a
// time. Opening the IDE fires many parallel requests; without this, each cache
// miss would dial the guest agent and the guest on its own.
const inflight = new Map<string, Promise<string | null>>();

function singleFlight(key: string, run: () => Promise<string | null>): Promise<string | null> {
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * The proven code-server target for a running VM, or null. Uses a recent proof
 * while the VM's recorded address still matches it; otherwise reads the address
 * live from the guest agent and proves the guest there with {@link proveIdeGuest}.
 */
export async function proveIdeGuestTarget(
  vm: IdeGuestVm,
  secret: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (vm.status !== 'running') {
    proofs.delete(vm.id);
    return null;
  }
  const cred = ideGuestCookieValue(secret);
  const hit = proofs.get(vm.id);
  if (hit && hit.cred === cred && hit.until > Date.now() && hit.target === resolveIdeTargetUrl(vm, env)) {
    // Near expiry, re-prove at the same target in the background so an open IDE
    // doesn't stall on a fresh proof; the entry stays valid meanwhile and is
    // extended only on success (a failed re-proof just lets it expire).
    if (hit.until - Date.now() < PROOF_REFRESH_MS) {
      void singleFlight(`${vm.id}|${cred}`, async () => {
        if (!(await proveIdeGuest(hit.target, secret))) return null;
        const cur = proofs.get(vm.id);
        if (cur && cur.target === hit.target && cur.cred === cred) cur.until = Date.now() + PROOF_TTL_MS;
        return hit.target;
      });
    }
    return hit.target;
  }
  proofs.delete(vm.id);
  return singleFlight(`${vm.id}|${cred}`, async () => {
    const target = await freshIdeTarget(vm, env);
    if (!target || !(await proveIdeGuest(target, secret))) return null;
    if (proofs.size > 1000) proofs.clear();
    proofs.set(vm.id, { target, cred, until: Date.now() + PROOF_TTL_MS });
    return target;
  });
}

/** Test hook: forget cached proofs. */
export function clearIdeGuestProofs(): void {
  proofs.clear();
  inflight.clear();
}
