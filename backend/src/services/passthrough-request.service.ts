import type { VirtualMachine } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import * as pve from './proxmox.service.js';
import { syncVmNode } from './vm.service.js';

/** A passthrough-request error carrying an HTTP status the route can surface. */
export class PassthroughRequestError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

// v1 attaches a single device at hostpci0. Detach takes an explicit index so a
// future multi-device flow needs no signature change.
const HOSTPCI_INDEX = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll a VM until it reports stopped (or the timeout elapses). */
async function waitStopped(
  node: string,
  vmid: number,
  client: Awaited<ReturnType<typeof pve.getClient>>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      if ((await pve.getVmStatus(node, vmid, client, 'qemu')).status === 'stopped') return;
    } catch {
      return; // gone / unreadable — nothing to wait for
    }
  }
}

/**
 * Create a pending passthrough request for a VM. QEMU-only, one pending per VM,
 * and not if a device is already attached. The route has already authorized the
 * caller's write access to `vm`.
 */
export async function createPassthroughRequest(
  userId: string,
  vm: VirtualMachine,
  reason?: string,
): Promise<void> {
  if (vm.type === 'lxc') {
    throw new PassthroughRequestError('PCI passthrough is only available for VMs, not containers.', 400);
  }
  if (vm.hasPassthrough) {
    throw new PassthroughRequestError('This VM already has a PCI device attached.', 409);
  }
  const existing = await prisma.passthroughRequest.findFirst({ where: { vmId: vm.id, status: 'pending' } });
  if (existing) {
    throw new PassthroughRequestError('There is already a pending passthrough request for this VM.', 409);
  }
  await prisma.passthroughRequest.create({
    data: { userId, vmId: vm.id, reason: reason?.trim() || null },
  });
}

/** The caller's own passthrough requests, newest first (with VM name). */
export function listMyPassthroughRequests(userId: string) {
  return prisma.passthroughRequest.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: { vm: { select: { id: true, name: true } } },
  });
}

export interface PendingPassthroughRequest {
  id: string;
  reason: string | null;
  createdAt: string;
  user: { id: string; email: string; displayName: string };
  vm: { id: string; name: string; node: string; vmid: number };
}

/** Pending requests + VM + requester (admin review queue). */
export async function listPendingPassthroughRequests(): Promise<PendingPassthroughRequest[]> {
  const rows = await prisma.passthroughRequest.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' },
    include: {
      user: { select: { id: true, email: true, displayName: true } },
      vm: { select: { id: true, name: true, proxmoxNode: true, proxmoxVmId: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    user: { id: r.user.id, email: r.user.email, displayName: r.user.displayName },
    vm: { id: r.vm.id, name: r.vm.name, node: r.vm.proxmoxNode, vmid: r.vm.proxmoxVmId },
  }));
}

/**
 * Approve: validate the chosen mapping exists, stop the VM if running (Proxmox
 * rejects `hostpci` on a running guest), attach `hostpci0=mapping=<name>`, flag
 * the VM `hasPassthrough` (so the balancer/drain skip it), and resolve the
 * request. Returns info for the audit log / caller.
 */
export async function approvePassthroughRequest(
  id: string,
  adminId: string,
  mapping: string,
): Promise<{ email: string; vmName: string; mapping: string; wasRunning: boolean }> {
  const row = await prisma.passthroughRequest.findUnique({ where: { id }, include: { user: true, vm: true } });
  if (!row) throw new PassthroughRequestError('Request not found', 404);
  if (row.status !== 'pending') throw new PassthroughRequestError('This request was already resolved.', 409);
  if (row.vm.type !== 'qemu') throw new PassthroughRequestError('PCI passthrough is only available for VMs.', 400);

  const client = await pve.getClient();
  const mappings = await pve.listPciMappings(client);
  if (!mappings.some((m) => m.id === mapping)) {
    throw new PassthroughRequestError(`No PCI mapping named "${mapping}" exists on the cluster.`, 400);
  }

  const vm = await syncVmNode(row.vm);

  // hostpci can only be set on a stopped VM — stop it first if needed.
  let wasRunning = false;
  try {
    const st = await pve.getVmStatus(vm.proxmoxNode, vm.proxmoxVmId, client, 'qemu');
    if (st.status !== 'stopped') {
      wasRunning = true;
      await pve.stopVm(vm.proxmoxNode, vm.proxmoxVmId, client, 'qemu');
      await waitStopped(vm.proxmoxNode, vm.proxmoxVmId, client);
    }
  } catch {
    /* status unknown — the attach below will surface any real problem */
  }

  await pve.attachPci(vm.proxmoxNode, vm.proxmoxVmId, HOSTPCI_INDEX, mapping, client);

  await prisma.$transaction([
    prisma.virtualMachine.update({
      where: { id: vm.id },
      // If we stopped it to attach, reflect that; otherwise leave status alone.
      data: { hasPassthrough: true, ...(wasRunning ? { status: 'stopped' } : {}) },
    }),
    prisma.passthroughRequest.update({
      where: { id },
      data: { status: 'approved', mapping, resolvedAt: new Date(), resolvedById: adminId },
    }),
  ]);
  return { email: row.user.email, vmName: vm.name, mapping, wasRunning };
}

/** Deny: mark resolved without touching the VM. */
export async function denyPassthroughRequest(
  id: string,
  adminId: string,
): Promise<{ email: string; vmName: string }> {
  const row = await prisma.passthroughRequest.findUnique({ where: { id }, include: { user: true, vm: true } });
  if (!row) throw new PassthroughRequestError('Request not found', 404);
  if (row.status !== 'pending') throw new PassthroughRequestError('This request was already resolved.', 409);
  await prisma.passthroughRequest.update({
    where: { id },
    data: { status: 'denied', resolvedAt: new Date(), resolvedById: adminId },
  });
  return { email: row.user.email, vmName: row.vm.name };
}

/**
 * Admin: detach a PCI device (`hostpci{index}`) from a VM. Stops it first if
 * running (Proxmox needs the guest stopped), then recomputes `hasPassthrough`
 * from the live config so the balancer/drain skip only while a device remains.
 */
export async function detachPassthrough(vm: VirtualMachine, index: number): Promise<void> {
  if (vm.type !== 'qemu') throw new PassthroughRequestError('PCI passthrough is only available for VMs.', 400);
  const client = await pve.getClient();
  const current = await syncVmNode(vm);

  try {
    const st = await pve.getVmStatus(current.proxmoxNode, current.proxmoxVmId, client, 'qemu');
    if (st.status !== 'stopped') {
      await pve.stopVm(current.proxmoxNode, current.proxmoxVmId, client, 'qemu');
      await waitStopped(current.proxmoxNode, current.proxmoxVmId, client);
      await prisma.virtualMachine.update({ where: { id: current.id }, data: { status: 'stopped' } });
    }
  } catch {
    /* status unknown — proceed to detach */
  }

  await pve.detachPci(current.proxmoxNode, current.proxmoxVmId, index, client);

  const cfg = await pve.getVmConfig(current.proxmoxNode, current.proxmoxVmId, client, 'qemu');
  const remaining = pve.getPassthroughDevices(cfg).length;
  await prisma.virtualMachine.update({ where: { id: current.id }, data: { hasPassthrough: remaining > 0 } });
}
