import type { User, VirtualMachine } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { getConfig } from './config.service.js';
import * as pve from './proxmox.service.js';

/** Thrown when a VM request would push a user over one of their quota caps. */
export class QuotaError extends Error {
  constructor(
    public readonly details: Record<string, { used: number; requested: number; max: number }>,
  ) {
    super('Quota exceeded');
    this.name = 'QuotaError';
  }
}

export interface CreateVmInput {
  name: string;
  cpu: number;
  ram: number; // MB
  storage: number; // GB
  os: string; // ISO filename
  node?: string;
}

/** Check the requested resources against the user's remaining quota. */
async function assertWithinQuota(user: User, input: CreateVmInput): Promise<void> {
  // Admins (cluster owners) are not quota-limited.
  if (user.role === 'admin') return;

  const existing = await prisma.virtualMachine.findMany({ where: { userId: user.id } });
  const usedCpu = existing.reduce((s, v) => s + v.cpu, 0);
  const usedRam = existing.reduce((s, v) => s + v.ram, 0);
  const usedStorage = existing.reduce((s, v) => s + v.storage, 0);

  const violations: Record<string, { used: number; requested: number; max: number }> = {};
  if (usedCpu + input.cpu > user.maxCpu)
    violations['cpu'] = { used: usedCpu, requested: input.cpu, max: user.maxCpu };
  if (usedRam + input.ram > user.maxRam)
    violations['ram'] = { used: usedRam, requested: input.ram, max: user.maxRam };
  if (usedStorage + input.storage > user.maxStorage)
    violations['storage'] = { used: usedStorage, requested: input.storage, max: user.maxStorage };

  if (Object.keys(violations).length > 0) throw new QuotaError(violations);
}

/**
 * Orchestrate VM creation: quota check → reserve VMID → DB record →
 * create on Proxmox → start → reflect final status.
 */
export async function createVm(user: User, input: CreateVmInput): Promise<VirtualMachine> {
  await assertWithinQuota(user, input);

  const client = await pve.getClient();
  const [storage, bridge, isoStorage, isolationCfg] = await Promise.all([
    getConfig('default_storage'),
    getConfig('default_bridge'),
    getConfig('iso_storage'),
    getConfig('isolation_enabled'),
  ]);
  if (!storage || !bridge || !isoStorage) {
    throw new Error('Server defaults are not configured — finish setup first');
  }
  const isolate = isolationCfg !== 'false'; // tenant isolation is on by default

  const node = input.node ?? (await pve.getDefaultNode(client));
  const vmid = await pve.getNextVmId(client);

  const vm = await prisma.virtualMachine.create({
    data: {
      userId: user.id,
      proxmoxVmId: vmid,
      proxmoxNode: node,
      name: input.name,
      cpu: input.cpu,
      ram: input.ram,
      storage: input.storage,
      os: input.os,
      status: 'creating',
    },
  });

  try {
    await pve.createVm(
      {
        node,
        vmid,
        name: input.name,
        cores: input.cpu,
        memory: input.ram,
        diskGb: input.storage,
        storage,
        bridge,
        isoStorage,
        iso: input.os,
      },
      client,
    );

    // Lock the VM's firewall down for tenant isolation before it ever boots.
    if (isolate) {
      const gateway = await pve.getBridgeGateway(bridge, node, client);
      await pve.configureVmIsolation(node, vmid, { gateway }, client);
    }

    await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'stopped' } });

    await pve.startVm(node, vmid, client);
    return prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'running' } });
  } catch (err) {
    await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'error' } });
    throw err;
  }
}

/** Fetch a VM the caller is allowed to see (owner, or any VM for admins). */
export async function getOwnedVm(
  vmId: string,
  user: { id: string; role: string },
): Promise<VirtualMachine | null> {
  const vm = await prisma.virtualMachine.findUnique({ where: { id: vmId } });
  if (!vm) return null;
  if (user.role !== 'admin' && vm.userId !== user.id) return null;
  return vm;
}

/** List VMs for a user (all VMs for admins). */
export async function listVms(user: { id: string; role: string }): Promise<VirtualMachine[]> {
  return prisma.virtualMachine.findMany({
    where: user.role === 'admin' ? {} : { userId: user.id },
    orderBy: { createdAt: 'desc' },
  });
}

/** Merge a VM's DB record with its live Proxmox status (best-effort). */
export async function getVmWithLiveStatus(
  vm: VirtualMachine,
): Promise<VirtualMachine & { live: pve.PveVmStatus | null }> {
  try {
    const live = await pve.getVmStatus(vm.proxmoxNode, vm.proxmoxVmId);
    // Keep the DB status loosely in sync with reality.
    if (live.status && live.status !== vm.status && vm.status !== 'creating') {
      await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: live.status } });
      vm.status = live.status;
    }
    return { ...vm, live };
  } catch {
    return { ...vm, live: null };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll a VM's status until it reports "stopped" or the timeout elapses. */
async function waitForStopped(
  node: string,
  vmid: number,
  client: Awaited<ReturnType<typeof pve.getClient>>,
  timeoutMs = 25_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      const s = await pve.getVmStatus(node, vmid, client);
      if (s.status === 'stopped') return;
    } catch {
      return; // VM is gone — nothing left to wait for
    }
  }
}

export async function destroyVm(vm: VirtualMachine): Promise<void> {
  const client = await pve.getClient();

  // Proxmox refuses to delete a running VM, and stop is an async task — so
  // hard-stop first and wait until it's actually stopped before deleting.
  try {
    const status = await pve.getVmStatus(vm.proxmoxNode, vm.proxmoxVmId, client);
    if (status.status !== 'stopped') {
      await pve.stopVm(vm.proxmoxNode, vm.proxmoxVmId, client);
      await waitForStopped(vm.proxmoxNode, vm.proxmoxVmId, client);
    }
  } catch {
    /* status unavailable or VM already gone — fall through to delete */
  }

  try {
    await pve.deleteVm(vm.proxmoxNode, vm.proxmoxVmId, client);
  } catch (err) {
    // If the VM no longer exists on Proxmox, still clean up our record.
    const msg = pve.pveMessage(err);
    if (!/does not exist|not found/i.test(msg)) throw err;
  }
  await prisma.virtualMachine.delete({ where: { id: vm.id } });
}

export async function startVm(vm: VirtualMachine): Promise<void> {
  await pve.startVm(vm.proxmoxNode, vm.proxmoxVmId);
  await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'running' } });
}

export async function stopVm(vm: VirtualMachine, force: boolean): Promise<void> {
  if (force) await pve.stopVm(vm.proxmoxNode, vm.proxmoxVmId);
  else await pve.shutdownVm(vm.proxmoxNode, vm.proxmoxVmId);
  await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'stopped' } });
}

export async function restartVm(vm: VirtualMachine): Promise<void> {
  await pve.rebootVm(vm.proxmoxNode, vm.proxmoxVmId);
  await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'running' } });
}
