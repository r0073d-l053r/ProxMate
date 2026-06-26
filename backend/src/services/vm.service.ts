import type { User, VirtualMachine, Template } from '@prisma/client';
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
export async function assertWithinQuota(user: User, input: CreateVmInput): Promise<void> {
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

  // Only nodes that physically hold the install ISO can build this VM. With
  // node-local ISO storage (e.g. `local`), an ISO uploaded to one node isn't
  // visible on the others — the #1 cause of a placement that looks fine but
  // fails asynchronously in Proxmox. Constrain auto-scheduling to those nodes.
  const isoNodes = await pve.getIsoNodes(isoStorage, input.os, client);
  if (isoNodes.length === 0) {
    throw new Error(
      `Install ISO "${input.os}" isn't available on any node's "${isoStorage}" storage. ` +
        `Upload it there (or use a shared ISO storage) and try again.`,
    );
  }

  let node: string;
  if (input.node) {
    // An explicitly pinned node (admin/API) must still actually have the ISO.
    if (!isoNodes.includes(input.node)) {
      throw new Error(
        `Node "${input.node}" doesn't have ISO "${input.os}" on "${isoStorage}" ` +
          `(available on: ${isoNodes.join(', ')}).`,
      );
    }
    node = input.node;
  } else {
    node = await pve.pickBestNode(
      { cpu: input.cpu, ramMb: input.ram, storageGb: input.storage },
      storage,
      client,
      isoNodes,
    );
  }
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
    // Wait for the create task so a real Proxmox failure (e.g. unusable storage)
    // surfaces as an error here instead of a false "created" with a broken VM.
    const createUpid = await pve.createVm(
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
    await pve.waitForTask(node, createUpid, client);

    // Lock the VM's firewall down for tenant isolation before it ever boots.
    if (isolate) {
      const dnsServers = ((await getConfig('isolation_dns_servers')) ?? '').split(/[,\s]+/).filter(Boolean);
      await pve.configureVmIsolation(node, vmid, { dnsServers }, client);
    }

    await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'stopped' } });

    // Wait for the start task too, so "running" means it actually started.
    const startUpid = await pve.startVm(node, vmid, client);
    await pve.waitForTask(node, startUpid, client);
    return prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'running' } });
  } catch (err) {
    await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'error' } });
    throw err;
  }
}

export interface DeployTemplateInput {
  name: string;
  cpu: number;
  ram: number; // MB
  storage: number; // GB (clamped up to the template's base disk)
  // Cloud-init templates only: injected on first boot so the box is reachable.
  sshKey?: string;
  username?: string;
  password?: string;
  installDocker?: boolean; // attach the cloud-init "extras" vendor snippet
  installTailscale?: boolean;
}

/**
 * Deploy a new VM from a published template: quota check → linked-clone the
 * template → autoscale (cores/memory + grow disk) → isolate → start.
 */
export async function deployFromTemplate(
  user: User,
  template: Template,
  input: DeployTemplateInput,
): Promise<VirtualMachine> {
  // Can't deploy a disk smaller than the template's base image.
  const diskGb = Math.max(input.storage, template.diskGb || input.storage);
  await assertWithinQuota(user, { name: input.name, cpu: input.cpu, ram: input.ram, storage: diskGb, os: template.name });

  const client = await pve.getClient();
  const isolate = (await getConfig('isolation_enabled')) !== 'false';

  const node = template.proxmoxNode; // linked clone stays on the template's node
  const vmid = await pve.getNextVmId(client);

  const vm = await prisma.virtualMachine.create({
    data: {
      userId: user.id,
      proxmoxVmId: vmid,
      proxmoxNode: node,
      name: input.name,
      description: `From template: ${template.name}`,
      cpu: input.cpu,
      ram: input.ram,
      storage: diskGb,
      os: template.os ?? template.name,
      status: 'creating',
    },
  });

  try {
    // Cloud images are imported disks on which lvmthin doesn't support linked
    // clones, so full-clone them (small + fast). Regular templates stay linked.
    const upid = await pve.cloneVm(
      { node, templateVmid: template.proxmoxVmId, newVmid: vmid, name: input.name, full: template.cloudInit },
      client,
    );
    await pve.waitForTask(node, upid, client, 600_000);

    // Autoscale: set cores/memory, then grow the primary disk if needed.
    await pve.setVmResources(node, vmid, input.cpu, input.ram, client);
    const cfg = await pve.getVmConfig(node, vmid, client);
    const disk = pve.findPrimaryDisk(cfg);
    if (disk && diskGb > (template.diskGb || 0)) {
      await pve.resizeDisk(node, vmid, disk, diskGb, client);
    }

    // Cloud-init: inject the login user + SSH key + DHCP so the box is
    // immediately reachable on first boot (no installer). Hostname = VM name.
    if (template.cloudInit) {
      let vendorSnippet: string | undefined;
      const features: string[] = [];
      if (input.installDocker) features.push('docker');
      if (input.installTailscale) features.push('tailscale');
      if (features.length > 0) {
        // The matching snippet (combined for multiple features) must already be on
        // this node — admins place it; the API can't write snippets. Fail clearly
        // rather than letting cloud-init reference a missing file.
        const snippetStorage = (await getConfig('iso_storage')) ?? 'local';
        const file = pve.cloudInitSnippetFile(features);
        const ready = await pve.nodesWithSnippet(snippetStorage, file, client);
        if (!ready.includes(node)) {
          throw new Error(
            `The selected setup (${features.join(' + ')}) isn't installed on node "${node}" — ` +
              `an admin needs to add its snippet (Template Store → Cloud-init extras).`,
          );
        }
        vendorSnippet = `${snippetStorage}:snippets/${file}`;
      }
      await pve.setCloudInitConfig(
        node,
        vmid,
        {
          ciuser: input.username || 'debian',
          cipassword: input.password,
          sshKeys: input.sshKey,
          ipConfig: 'ip=dhcp',
          vendorSnippet,
        },
        client,
      );

      // Cloud-image templates default to a serial display (`vga=serial0`), which
      // makes ProxMate's noVNC console show the "starting serial terminal"
      // placeholder. Force a normal VGA console so the web console is usable;
      // the serial port stays available for boot logs via Proxmox.
      await client.put(`/nodes/${node}/qemu/${vmid}/config`, new URLSearchParams({ vga: 'std' }));
    }

    // Tenant isolation (cloned NICs may lack the per-NIC firewall flag).
    if (isolate) {
      await pve.ensureNicFirewall(node, vmid, client);
      const dnsServers = ((await getConfig('isolation_dns_servers')) ?? '').split(/[,\s]+/).filter(Boolean);
      await pve.configureVmIsolation(node, vmid, { dnsServers }, client);
    }

    await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'stopped' } });
    // Wait for the start task so "running" reflects reality (matches createVm).
    const startUpid = await pve.startVm(node, vmid, client);
    await pve.waitForTask(node, startUpid, client);
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

/**
 * Ensures the VM's stored node in our database is correct by checking cluster resources.
 * If Proxmox reports the VM is on a different node, we update the DB.
 */
export async function syncVmNode(vm: VirtualMachine): Promise<VirtualMachine> {
  try {
    const client = await pve.getClient();
    const res = await client.get<{ data: Array<{ type: string; vmid?: number; node?: string }> }>('/cluster/resources');
    const match = res.data.data.find(
      (r) => (r.type === 'qemu' || r.type === 'lxc') && r.vmid === vm.proxmoxVmId
    );
    if (match && match.node && match.node !== vm.proxmoxNode) {
      const updated = await prisma.virtualMachine.update({
        where: { id: vm.id },
        data: { proxmoxNode: match.node },
      });
      return updated;
    }
  } catch (err) {
    console.error('Failed to sync VM node from Proxmox:', err);
  }
  return vm;
}

/** Merge a VM's DB record with its live Proxmox status (best-effort). */
export async function getVmWithLiveStatus(
  vm: VirtualMachine,
): Promise<VirtualMachine & { live: pve.PveVmStatus | null }> {
  let currentVm = vm;
  try {
    let live: pve.PveVmStatus;
    try {
      live = await pve.getVmStatus(currentVm.proxmoxNode, currentVm.proxmoxVmId);
    } catch (err) {
      // If VM is not found on the stored node, check if it migrated
      const syncedVm = await syncVmNode(currentVm);
      if (syncedVm.proxmoxNode !== currentVm.proxmoxNode) {
        currentVm = syncedVm;
        live = await pve.getVmStatus(currentVm.proxmoxNode, currentVm.proxmoxVmId);
      } else {
        throw err;
      }
    }

    // Keep the DB status loosely in sync with reality.
    if (live.status && live.status !== currentVm.status && currentVm.status !== 'creating') {
      await prisma.virtualMachine.update({ where: { id: currentVm.id }, data: { status: live.status } });
      currentVm.status = live.status;
    }
    return { ...currentVm, live };
  } catch {
    return { ...currentVm, live: null };
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
  const currentVm = await syncVmNode(vm);
  const client = await pve.getClient();

  // Proxmox refuses to delete a running VM, and stop is an async task — so
  // hard-stop first and wait until it's actually stopped before deleting.
  try {
    const status = await pve.getVmStatus(currentVm.proxmoxNode, currentVm.proxmoxVmId, client);
    if (status.status !== 'stopped') {
      await pve.stopVm(currentVm.proxmoxNode, currentVm.proxmoxVmId, client);
      await waitForStopped(currentVm.proxmoxNode, currentVm.proxmoxVmId, client);
    }
  } catch {
    /* status unavailable or VM already gone — fall through to delete */
  }

  try {
    await pve.deleteVm(currentVm.proxmoxNode, currentVm.proxmoxVmId, client);
  } catch (err) {
    // If the VM no longer exists on Proxmox, still clean up our record.
    const msg = pve.pveMessage(err);
    if (!/does not exist|not found/i.test(msg)) throw err;
  }
  await prisma.virtualMachine.delete({ where: { id: currentVm.id } });
}

export async function startVm(vm: VirtualMachine): Promise<void> {
  const currentVm = await syncVmNode(vm);
  await pve.startVm(currentVm.proxmoxNode, currentVm.proxmoxVmId);
  await prisma.virtualMachine.update({ where: { id: currentVm.id }, data: { status: 'running' } });
}

export async function stopVm(vm: VirtualMachine, force: boolean): Promise<void> {
  const currentVm = await syncVmNode(vm);
  if (force) await pve.stopVm(currentVm.proxmoxNode, currentVm.proxmoxVmId);
  else await pve.shutdownVm(currentVm.proxmoxNode, currentVm.proxmoxVmId);
  await prisma.virtualMachine.update({ where: { id: currentVm.id }, data: { status: 'stopped' } });
}

export async function restartVm(vm: VirtualMachine): Promise<void> {
  const currentVm = await syncVmNode(vm);
  await pve.rebootVm(currentVm.proxmoxNode, currentVm.proxmoxVmId);
  await prisma.virtualMachine.update({ where: { id: currentVm.id }, data: { status: 'running' } });
}
