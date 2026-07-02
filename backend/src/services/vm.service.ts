import crypto from 'node:crypto';
import type { User, VirtualMachine, Template } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { getConfig } from './config.service.js';
import { notify } from './notify.service.js';
import { isMailConfigured, sendMail } from './mail.service.js';
import { vmMaintenanceEmail } from '../lib/email-templates.js';
import * as pve from './proxmox.service.js';

/** The Proxmox guest kind for a VM row (defaults to QEMU for legacy/unset rows). */
export const kindOf = (vm: { type?: string | null }): pve.GuestKind => (vm.type === 'lxc' ? 'lxc' : 'qemu');

/** Flag a VM as failed in the DB and fire a best-effort vm.error notification. */
async function markVmError(vmId: string, name: string, err: unknown): Promise<void> {
  await prisma.virtualMachine.update({ where: { id: vmId }, data: { status: 'error' } });
  await notify({
    event: 'vm.error',
    title: name,
    message: `Provisioning of "${name}" failed: ${pve.pveMessage(err)}`,
  }).catch(() => undefined);
}

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
      // ISO installs are x86 today, so keep custom VMs on amd64 nodes (an ARM
      // node would only TCG-emulate them). An arch picker for ARM ISOs is Phase 2.
      'amd64',
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
    await markVmError(vm.id, input.name, err);
    throw err;
  }
}

export interface CreateContainerInput {
  name: string;
  cpu: number;
  ram: number; // MB
  storage: number; // GB (rootfs)
  template: string; // full LXC template volid, e.g. "local:vztmpl/debian-12-…tar.zst"
  password?: string;
  sshKey?: string;
  node?: string;
}

/** Guess a container's CPU architecture from its OS-template filename. */
function archFromTemplate(volid: string): pve.Arch | undefined {
  const s = volid.toLowerCase();
  if (/arm64|aarch64/.test(s)) return 'arm64';
  if (/amd64|x86[_-]?64/.test(s)) return 'amd64';
  return undefined; // unknown → don't constrain placement by arch
}

/**
 * Orchestrate LXC container creation — mirrors createVm: quota check → pick a node
 * that physically holds the OS template → reserve VMID → DB record (type:'lxc') →
 * create on Proxmox → lock the firewall down for tenant isolation → start.
 */
export async function createContainer(user: User, input: CreateContainerInput): Promise<VirtualMachine> {
  await assertWithinQuota(user, {
    name: input.name,
    cpu: input.cpu,
    ram: input.ram,
    storage: input.storage,
    os: input.template,
  });

  const client = await pve.getClient();
  const [storage, bridge, isolationCfg] = await Promise.all([
    getConfig('default_storage'),
    getConfig('default_bridge'),
    getConfig('isolation_enabled'),
  ]);
  if (!storage || !bridge) {
    throw new Error('Server defaults are not configured — finish setup first');
  }
  const isolate = isolationCfg !== 'false'; // tenant isolation is on by default

  // Only nodes that physically hold the OS template can build this container
  // (node-local template storage like `local` isn't shared) — same constraint as
  // ISO placement for QEMU.
  const templateName = input.template.split('/').pop() ?? input.template;
  const tmplNodes = await pve.getTemplateNodes(input.template, client);
  if (tmplNodes.length === 0) {
    throw new Error(
      `LXC template "${templateName}" isn't available on any node. ` +
        `Add it in Proxmox (pveam / Datacenter → CT Templates) and try again.`,
    );
  }

  let node: string;
  if (input.node) {
    if (!tmplNodes.includes(input.node)) {
      throw new Error(
        `Node "${input.node}" doesn't have template "${templateName}" (available on: ${tmplNodes.join(', ')}).`,
      );
    }
    node = input.node;
  } else {
    node = await pve.pickBestNode(
      { cpu: input.cpu, ramMb: input.ram, storageGb: input.storage },
      storage,
      client,
      tmplNodes,
      archFromTemplate(input.template),
    );
  }
  const vmid = await pve.getNextVmId(client);

  const vm = await prisma.virtualMachine.create({
    data: {
      userId: user.id,
      proxmoxVmId: vmid,
      proxmoxNode: node,
      type: 'lxc',
      name: input.name,
      cpu: input.cpu,
      ram: input.ram,
      storage: input.storage,
      os: templateName,
      status: 'creating',
    },
  });

  try {
    const createUpid = await pve.createLxc(
      {
        node,
        vmid,
        hostname: input.name,
        cores: input.cpu,
        memory: input.ram,
        diskGb: input.storage,
        storage,
        bridge,
        ostemplate: input.template,
        password: input.password,
        sshPublicKeys: input.sshKey,
      },
      client,
    );
    await pve.waitForTask(node, createUpid, client);

    // Lock the container's firewall down for tenant isolation before it boots.
    if (isolate) {
      const dnsServers = ((await getConfig('isolation_dns_servers')) ?? '').split(/[,\s]+/).filter(Boolean);
      await pve.configureVmIsolation(node, vmid, { dnsServers }, client, 'lxc');
    }

    await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'stopped' } });

    const startUpid = await pve.startVm(node, vmid, client, 'lxc');
    await pve.waitForTask(node, startUpid, client);
    return prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'running' } });
  } catch (err) {
    await markVmError(vm.id, input.name, err);
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
  installGuestAgent?: boolean; // installs qemu-guest-agent so the VM reports its IP
}

/** Cloud-init knobs shared by template deploys and rebuilds. */
type CloudInitInput = Pick<
  DeployTemplateInput,
  'sshKey' | 'username' | 'password' | 'installDocker' | 'installTailscale' | 'installGuestAgent'
>;

/**
 * Configure a freshly-cloned VM in place: autoscale cores/memory, grow the primary
 * disk if needed, inject cloud-init (login user + SSH key + DHCP, optional first-boot
 * extras), and apply tenant firewall isolation. Shared by deployFromTemplate and
 * rebuildVm so the cloud-image setup stays identical on both paths.
 */
async function configureClonedVm(
  cfg: {
    node: string;
    vmid: number;
    template: Template;
    cpu: number;
    ram: number;
    diskGb: number;
    isolate: boolean;
    cloud: CloudInitInput;
  },
  client: Awaited<ReturnType<typeof pve.getClient>>,
): Promise<void> {
  const { node, vmid, template, cpu, ram, diskGb, isolate, cloud } = cfg;

  // Autoscale: set cores/memory, then grow the primary disk if needed.
  await pve.setVmResources(node, vmid, cpu, ram, client);
  const vmCfg = await pve.getVmConfig(node, vmid, client);
  const disk = pve.findPrimaryDisk(vmCfg);
  if (disk && diskGb > (template.diskGb || 0)) {
    await pve.resizeDisk(node, vmid, disk, diskGb, client);
  }

  // Cloud-init: inject the login user + SSH key + DHCP so the box is immediately
  // reachable on first boot (no installer). Hostname = VM name.
  if (template.cloudInit) {
    let vendorSnippet: string | undefined;
    const features: string[] = [];
    if (cloud.installDocker) features.push('docker');
    if (cloud.installTailscale) features.push('tailscale');
    if (cloud.installGuestAgent) features.push('guest-agent');
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
        ciuser: cloud.username || 'debian',
        cipassword: cloud.password,
        sshKeys: cloud.sshKey,
        ipConfig: 'ip=dhcp',
        vendorSnippet,
      },
      client,
    );

    // Cloud-image templates default to a serial display (`vga=serial0`), which makes
    // ProxMate's noVNC console show the "starting serial terminal" placeholder. Force
    // a normal VGA console; the serial port stays available for boot logs.
    await client.put(`/nodes/${node}/qemu/${vmid}/config`, new URLSearchParams({ vga: 'std' }));
  }

  // Tenant isolation (cloned NICs may lack the per-NIC firewall flag).
  if (isolate) {
    await pve.ensureNicFirewall(node, vmid, client);
    const dnsServers = ((await getConfig('isolation_dns_servers')) ?? '').split(/[,\s]+/).filter(Boolean);
    await pve.configureVmIsolation(node, vmid, { dnsServers }, client);
  }
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

    // Autoscale (cores/memory/disk) + cloud-init + tenant isolation on the clone.
    await configureClonedVm(
      { node, vmid, template, cpu: input.cpu, ram: input.ram, diskGb, isolate, cloud: input },
      client,
    );

    await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'stopped' } });
    // Wait for the start task so "running" reflects reality (matches createVm).
    const startUpid = await pve.startVm(node, vmid, client);
    await pve.waitForTask(node, startUpid, client);
    return prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'running' } });
  } catch (err) {
    await markVmError(vm.id, input.name, err);
    throw err;
  }
}

/**
 * Self-service clone of a VM the caller can operate. Full-clones the source
 * (storage-agnostic) to a new VMID on the same node, quota-checks the duplicate
 * against the owner's caps, re-applies the tenant-isolation firewall before boot
 * (the clone gets a fresh MAC, so rules must be rebuilt), and starts it. The
 * source must be stopped — a clean full clone doesn't need a snapshot and can't
 * copy a live disk out from under a running guest. QEMU-only (uses the qemu
 * clone endpoint); the new VM is owned by the same user as the source.
 */
export async function duplicateVm(source: VirtualMachine, newName: string): Promise<VirtualMachine> {
  if (kindOf(source) === 'lxc') throw new Error('Containers (LXC) can\'t be duplicated');

  const client = await pve.getClient();
  const current = await syncVmNode(source);

  const status = await pve.getVmStatus(current.proxmoxNode, current.proxmoxVmId, client).catch(() => null);
  if (status?.status === 'running') {
    throw new Error('Stop the machine first — a duplicate is made from a stopped VM');
  }

  // Quota is charged to the source's owner (the duplicate belongs to them too).
  const owner = await prisma.user.findUnique({ where: { id: current.userId } });
  if (!owner) throw new Error('VM owner not found');
  await assertWithinQuota(owner, {
    name: newName, cpu: current.cpu, ram: current.ram, storage: current.storage, os: current.os,
  });

  const node = current.proxmoxNode;
  const vmid = await pve.getNextVmId(client);
  const isolate = (await getConfig('isolation_enabled')) !== 'false';

  const vm = await prisma.virtualMachine.create({
    data: {
      userId: current.userId,
      proxmoxVmId: vmid,
      proxmoxNode: node,
      name: newName,
      description: `Copy of ${current.name}`,
      type: 'qemu',
      cpu: current.cpu,
      ram: current.ram,
      storage: current.storage,
      os: current.os,
      tags: current.tags,
      status: 'creating',
    },
  });

  try {
    // Full clone (not linked): storage-agnostic and self-contained, so the copy
    // survives the original being deleted.
    const upid = await pve.cloneVm(
      { node, templateVmid: current.proxmoxVmId, newVmid: vmid, name: newName, full: true },
      client,
    );
    await pve.waitForTask(node, upid, client, 600_000);

    if (isolate) {
      const dnsServers = ((await getConfig('isolation_dns_servers')) ?? '').split(/[,\s]+/).filter(Boolean);
      await pve.configureVmIsolation(node, vmid, { dnsServers }, client);
    }

    await prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'stopped' } });
    const startUpid = await pve.startVm(node, vmid, client);
    await pve.waitForTask(node, startUpid, client);
    return prisma.virtualMachine.update({ where: { id: vm.id }, data: { status: 'running' } });
  } catch (err) {
    await markVmError(vm.id, newName, err);
    throw err;
  }
}

/** Owner-or-admin only (owner-exclusive actions: delete, share management, convert). */
export async function getOwnedVm(
  vmId: string,
  user: { id: string; role: string },
): Promise<VirtualMachine | null> {
  const vm = await prisma.virtualMachine.findUnique({ where: { id: vmId } });
  if (!vm) return null;
  if (user.role !== 'admin' && vm.userId !== user.id) return null;
  return vm;
}

export type VmAccess = 'owner' | 'admin' | 'co-owner' | 'read-only';

/** Resolve the caller's access level to a VM, or null if they can't see it. */
export async function resolveVmAccess(
  vmId: string,
  user: { id: string; role: string },
): Promise<{ vm: VirtualMachine; access: VmAccess } | null> {
  const vm = await prisma.virtualMachine.findUnique({ where: { id: vmId } });
  if (!vm) return null;
  if (vm.userId === user.id) return { vm, access: 'owner' };
  if (user.role === 'admin') return { vm, access: 'admin' };
  const share = await prisma.vmShare.findUnique({ where: { vmId_userId: { vmId, userId: user.id } } });
  if (!share) return null;
  return { vm, access: share.role === 'co-owner' ? 'co-owner' : 'read-only' };
}

/** A VM the caller may VIEW (owner / admin / co-owner / read-only), else null. */
export async function getViewableVm(vmId: string, user: { id: string; role: string }): Promise<VirtualMachine | null> {
  return (await resolveVmAccess(vmId, user))?.vm ?? null;
}

/** A VM the caller may OPERATE (owner / admin / co-owner). A read-only share → null. */
export async function getWritableVm(vmId: string, user: { id: string; role: string }): Promise<VirtualMachine | null> {
  const r = await resolveVmAccess(vmId, user);
  return r && r.access !== 'read-only' ? r.vm : null;
}

/** List VMs the user owns OR has been shared (all VMs for admins). */
export async function listVms(user: { id: string; role: string }): Promise<VirtualMachine[]> {
  if (user.role === 'admin') return prisma.virtualMachine.findMany({ orderBy: { createdAt: 'desc' } });
  const shares = await prisma.vmShare.findMany({ where: { userId: user.id }, select: { vmId: true } });
  return prisma.virtualMachine.findMany({
    where: { OR: [{ userId: user.id }, { id: { in: shares.map((s) => s.vmId) } }] },
    orderBy: { createdAt: 'desc' },
  });
}

/** Tag each VM with the caller's access level (for list/detail responses). */
export async function annotateAccess<T extends { id: string; userId: string }>(
  vms: T[],
  user: { id: string; role: string },
): Promise<(T & { access: VmAccess })[]> {
  const sharedRoles = new Map<string, string>();
  if (user.role !== 'admin' && vms.some((v) => v.userId !== user.id)) {
    const shares = await prisma.vmShare.findMany({
      where: { userId: user.id, vmId: { in: vms.map((v) => v.id) } },
    });
    for (const s of shares) sharedRoles.set(s.vmId, s.role);
  }
  return vms.map((v) => {
    const access: VmAccess =
      v.userId === user.id ? 'owner'
        : user.role === 'admin' ? 'admin'
          : sharedRoles.get(v.id) === 'co-owner' ? 'co-owner' : 'read-only';
    return { ...v, access };
  });
}

/**
 * Migrate a VM to another cluster node (admin op). Live-migrates when it's running,
 * offline otherwise. Honors the arch-aware guardrail (never cross architectures;
 * fail-open on unknown). Waits for the task, then records the new node.
 */
/**
 * Move a VM to another node (live if running, offline if stopped). When
 * `notifyOwner` is set — i.e. an admin kicked this off by hand or via a
 * maintenance drain — the VM's owner gets a branded heads-up email as the move
 * begins (skipped if the owner is the admin who triggered it). The auto-balancer
 * leaves it unset, so routine rebalancing never emails tenants.
 */
export async function migrateVmToNode(
  vm: VirtualMachine,
  targetNode: string,
  opts: { notifyOwner?: boolean; actorId?: string } = {},
): Promise<VirtualMachine> {
  if (targetNode === vm.proxmoxNode) throw new Error('The VM is already on that node.');
  // Containers can't be live-migrated in ProxMate's API-only model (LXC has no
  // live migration; a restart-migration would mean downtime), so they're excluded
  // from manual moves, the balancer, and drains. Keep them pinned.
  if (kindOf(vm) === 'lxc') throw new Error('Live migration isn’t supported for containers (LXC).');
  // A guest with PCI/GPU passthrough is pinned to its host — can't be migrated.
  if (vm.hasPassthrough) throw new Error('A VM with PCI/GPU passthrough can’t be migrated. Detach the device first.');
  const client = await pve.getClient();

  const nodes = await pve.getNodes(client);
  if (!nodes.some((n) => n.node === targetNode)) throw new Error(`No such node "${targetNode}".`);

  // Architecture guardrail — never migrate an x86 guest onto an ARM node (or vice
  // versa). Fail-open when either node's arch is unknown (mirrors placement).
  const arch = await pve.getNodeArchMap(client);
  const src = arch.get(vm.proxmoxNode);
  const dst = arch.get(targetNode);
  if (src && dst && src !== 'unknown' && dst !== 'unknown' && src !== dst) {
    throw new Error(`Architecture mismatch: ${vm.proxmoxNode} is ${src}, ${targetNode} is ${dst}.`);
  }

  const online = (await getVmWithLiveStatus(vm)).live?.status === 'running';
  const upid = await pve.migrateVm(vm.proxmoxNode, vm.proxmoxVmId, targetNode, online, client);

  // Heads-up to the owner as the move starts (best-effort; never blocks the
  // migration). Only for admin-initiated moves, and not when the admin is moving
  // their own VM.
  if (opts.notifyOwner && opts.actorId !== vm.userId) {
    await notifyOwnerOfMigration(vm, online).catch((err) =>
      console.error(`[migrate] owner notification failed for "${vm.name}":`, err),
    );
  }

  // The migrate task runs on the source node; a live migration can take a while.
  await pve.waitForTask(vm.proxmoxNode, upid, client, 1_800_000);
  return prisma.virtualMachine.update({ where: { id: vm.id }, data: { proxmoxNode: targetNode } });
}

/** Email a VM's owner that maintenance is moving their VM. No-op without SMTP. */
async function notifyOwnerOfMigration(vm: VirtualMachine, live: boolean): Promise<void> {
  if (!(await isMailConfigured())) return;
  const owner = await prisma.user.findUnique({ where: { id: vm.userId } });
  if (!owner?.email) return;
  const mail = vmMaintenanceEmail({ vmName: vm.name, live });
  await sendMail({ to: owner.email, ...mail });
}

/**
 * Update a VM's user-editable metadata: free-text notes (`description`) and/or
 * its `name`. The notes are ProxMate-only; a name change is pushed to Proxmox by
 * the route (via `setVmName`) before this writes the new name to our DB.
 */
export async function updateVm(
  vm: VirtualMachine,
  data: { description?: string | null; name?: string; tags?: string | null },
): Promise<VirtualMachine> {
  return prisma.virtualMachine.update({ where: { id: vm.id }, data });
}

/** Normalize a list of tags to the stored CSV form: lowercase, trimmed, deduped. */
export function normalizeTags(tags: string[]): string {
  const clean = tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
  return [...new Set(clean)].join(',');
}

/** Thrown when a resize can't be applied (e.g. shrinking a disk, which Proxmox forbids). */
export class ResizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResizeError';
  }
}

/**
 * Quota check for an in-place resize: the VM's *new* totals must fit the user's
 * caps, counting every OTHER VM they own plus the requested target values — so a
 * resize is judged on the delta, not by double-counting the VM's current size.
 */
export async function assertResizeWithinQuota(
  user: User,
  vm: VirtualMachine,
  target: { cpu: number; ram: number; storage: number },
): Promise<void> {
  // Admins (cluster owners) are not quota-limited.
  if (user.role === 'admin') return;

  const others = await prisma.virtualMachine.findMany({
    where: { userId: user.id, id: { not: vm.id } },
  });
  const usedCpu = others.reduce((s, v) => s + v.cpu, 0);
  const usedRam = others.reduce((s, v) => s + v.ram, 0);
  const usedStorage = others.reduce((s, v) => s + v.storage, 0);

  const violations: Record<string, { used: number; requested: number; max: number }> = {};
  if (usedCpu + target.cpu > user.maxCpu)
    violations['cpu'] = { used: usedCpu, requested: target.cpu, max: user.maxCpu };
  if (usedRam + target.ram > user.maxRam)
    violations['ram'] = { used: usedRam, requested: target.ram, max: user.maxRam };
  if (usedStorage + target.storage > user.maxStorage)
    violations['storage'] = { used: usedStorage, requested: target.storage, max: user.maxStorage };

  if (Object.keys(violations).length > 0) throw new QuotaError(violations);
}

export interface ResizeVmInput {
  cpu?: number;
  ram?: number; // MB
  storage?: number; // GB (grow-only)
}

/**
 * Change a VM's allocated CPU/RAM/disk in place. Disk is grow-only (Proxmox can't
 * shrink). Each Proxmox change is written to our DB right after it lands —
 * Proxmox-first, mirroring the rename flow — so a mid-way failure never leaves the
 * DB claiming resources the cluster didn't apply. CPU/RAM changes the guest can't
 * hot-plug take effect on the VM's next start. Returns the updated VM (unchanged
 * if the request is a no-op).
 */
export async function resizeVm(
  user: User,
  vm: VirtualMachine,
  input: ResizeVmInput,
): Promise<VirtualMachine> {
  const targetCpu = input.cpu ?? vm.cpu;
  const targetRam = input.ram ?? vm.ram;
  const targetStorage = input.storage ?? vm.storage;

  // Proxmox can only grow a disk, never shrink it.
  if (targetStorage < vm.storage) {
    throw new ResizeError(
      `Disks can only grow — ${targetStorage}GB is smaller than the current ${vm.storage}GB.`,
    );
  }

  const resourcesChanged = targetCpu !== vm.cpu || targetRam !== vm.ram;
  const growDisk = targetStorage > vm.storage;
  if (!resourcesChanged && !growDisk) return vm; // nothing to do

  await assertResizeWithinQuota(user, vm, { cpu: targetCpu, ram: targetRam, storage: targetStorage });

  let current = await syncVmNode(vm);
  const client = await pve.getClient();
  const kind = kindOf(current);

  // Resolve the disk up-front so a missing/unresizable disk fails before we
  // change anything else. LXC's root volume is always `rootfs`; a QEMU VM's
  // primary disk is a bus slot (scsi0, …) we read from its config.
  let diskKey: string | undefined;
  if (growDisk) {
    if (kind === 'lxc') {
      diskKey = 'rootfs';
    } else {
      const cfg = await pve.getVmConfig(current.proxmoxNode, current.proxmoxVmId, client);
      diskKey = pve.findPrimaryDisk(cfg);
      if (!diskKey) throw new ResizeError('Could not find a resizable disk on this VM.');
    }
  }

  if (resourcesChanged) {
    await pve.setVmResources(current.proxmoxNode, current.proxmoxVmId, targetCpu, targetRam, client, kind);
    current = await prisma.virtualMachine.update({
      where: { id: current.id },
      data: { cpu: targetCpu, ram: targetRam },
    });
  }

  if (growDisk && diskKey) {
    await pve.resizeDisk(current.proxmoxNode, current.proxmoxVmId, diskKey, targetStorage, client, kind);
    current = await prisma.virtualMachine.update({
      where: { id: current.id },
      data: { storage: targetStorage },
    });
  }

  return current;
}

/** Set (or clear, with nulls) a VM's auto start/stop cron schedule. */
export async function setPowerSchedule(
  vm: VirtualMachine,
  data: { startCron: string | null; stopCron: string | null },
): Promise<VirtualMachine> {
  return prisma.virtualMachine.update({ where: { id: vm.id }, data });
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
  const kind = kindOf(vm);
  try {
    let live: pve.PveVmStatus;
    try {
      live = await pve.getVmStatus(currentVm.proxmoxNode, currentVm.proxmoxVmId, undefined, kind);
    } catch (err) {
      // If VM is not found on the stored node, check if it migrated
      const syncedVm = await syncVmNode(currentVm);
      if (syncedVm.proxmoxNode !== currentVm.proxmoxNode) {
        currentVm = syncedVm;
        live = await pve.getVmStatus(currentVm.proxmoxNode, currentVm.proxmoxVmId, undefined, kind);
      } else {
        throw err;
      }
    }

    // Keep the DB status loosely in sync with reality.
    if (live.status && live.status !== currentVm.status && currentVm.status !== 'creating') {
      await prisma.virtualMachine.update({ where: { id: currentVm.id }, data: { status: live.status } });
      currentVm.status = live.status;
    }
    // Refresh the guest IP (best-effort, needs qemu-guest-agent in the guest).
    if (currentVm.status === 'running') await refreshVmIps([currentVm]);
    return { ...currentVm, live };
  } catch {
    return { ...currentVm, live: null };
  }
}

/**
 * Best-effort refresh of guest IPs via the QEMU guest agent, caching the results
 * on `VirtualMachine.ipAddress` / `.tailscaleIp`. Only running VMs are queried
 * (the agent is unreachable otherwise) and failures are swallowed — a missing
 * agent never breaks the list, it just leaves the IP blank. The LAN IP is sticky
 * (never cleared, so a brief agent hiccup keeps the last known address); the
 * Tailscale IP is cleared when it stops being advertised, since a stale tailnet
 * address is misleading. Mutates + returns the same array.
 */
export async function refreshVmIps<T extends VirtualMachine>(vms: T[]): Promise<T[]> {
  const running = vms.filter((v) => v.status === 'running');
  if (running.length === 0) return vms;
  const client = await pve.getClient();
  await Promise.all(
    running.map(async (vm) => {
      // LXC has no guest agent — Proxmox reads the container's IPs directly.
      const { ip, tailscaleIp } =
        kindOf(vm) === 'lxc'
          ? await pve.getLxcIps(vm.proxmoxNode, vm.proxmoxVmId, client)
          : await pve.getVmIps(vm.proxmoxNode, vm.proxmoxVmId, client);
      const data: { ipAddress?: string; tailscaleIp?: string | null } = {};
      if (ip && ip !== vm.ipAddress) {
        vm.ipAddress = ip;
        data.ipAddress = ip;
      }
      // Only meaningful when the interface listing was readable at all — a null
      // ip AND null tailscaleIp usually means the agent was unreachable, so we
      // leave the cached tailnet address alone rather than flap it.
      if ((ip || tailscaleIp) && tailscaleIp !== vm.tailscaleIp) {
        vm.tailscaleIp = tailscaleIp;
        data.tailscaleIp = tailscaleIp;
      }
      if (Object.keys(data).length > 0) {
        await prisma.virtualMachine
          .update({ where: { id: vm.id }, data })
          .catch(() => undefined);
      }
    }),
  );
  return vms;
}

export interface LiveUsage {
  cpu: number; // cores currently in use (sum of cpu-fraction × cores over running VMs)
  mem: number; // bytes of RAM currently in use
  maxMem: number; // bytes of RAM allocated to the running VMs
  running: number; // count of running VMs
}

/**
 * Live aggregate resource usage of the requesting user's OWN VMs, from a single
 * `/cluster/resources` call. Drives the dashboard's live-usage sparklines.
 */
export async function getLiveUsage(user: { id: string }): Promise<LiveUsage> {
  const vms = await prisma.virtualMachine.findMany({
    where: { userId: user.id },
    select: { proxmoxVmId: true },
  });
  const ids = new Set(vms.map((v) => v.proxmoxVmId));
  const empty: LiveUsage = { cpu: 0, mem: 0, maxMem: 0, running: 0 };
  if (ids.size === 0) return empty;

  const client = await pve.getClient();
  const res = await client.get<{
    data: Array<{ type: string; vmid?: number; status?: string; cpu?: number; maxcpu?: number; mem?: number; maxmem?: number }>;
  }>('/cluster/resources');

  const usage = { ...empty };
  for (const r of res.data.data) {
    if ((r.type === 'qemu' || r.type === 'lxc') && r.vmid !== undefined && ids.has(r.vmid) && r.status === 'running') {
      usage.cpu += (r.cpu ?? 0) * (r.maxcpu ?? 0);
      usage.mem += r.mem ?? 0;
      usage.maxMem += r.maxmem ?? 0;
      usage.running += 1;
    }
  }
  usage.cpu = Math.round(usage.cpu * 100) / 100;
  return usage;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll a VM's status until it reports "stopped" or the timeout elapses. */
async function waitForStopped(
  node: string,
  vmid: number,
  client: Awaited<ReturnType<typeof pve.getClient>>,
  timeoutMs = 25_000,
  kind: pve.GuestKind = 'qemu',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      const s = await pve.getVmStatus(node, vmid, client, kind);
      if (s.status === 'stopped') return;
    } catch {
      return; // VM is gone — nothing left to wait for
    }
  }
}

/**
 * Hard-stop (if needed) and delete a VM on Proxmox, leaving our DB row untouched.
 * A VM that no longer exists on Proxmox is treated as already gone (not an error),
 * so callers can clean up / re-provide regardless. Shared by destroyVm and rebuildVm.
 */
async function stopAndDeleteProxmoxVm(
  node: string,
  vmid: number,
  client: Awaited<ReturnType<typeof pve.getClient>>,
  kind: pve.GuestKind = 'qemu',
): Promise<void> {
  // Proxmox refuses to delete a running VM, and stop is an async task — so
  // hard-stop first and wait until it's actually stopped before deleting.
  try {
    const status = await pve.getVmStatus(node, vmid, client, kind);
    if (status.status !== 'stopped') {
      await pve.stopVm(node, vmid, client, kind);
      await waitForStopped(node, vmid, client, 25_000, kind);
    }
  } catch {
    /* status unavailable or VM already gone — fall through to delete */
  }

  try {
    await pve.deleteVm(node, vmid, client, kind);
  } catch (err) {
    // If the VM no longer exists on Proxmox, treat it as already deleted.
    const msg = pve.pveMessage(err);
    if (!/does not exist|not found/i.test(msg)) throw err;
  }
}

export async function destroyVm(vm: VirtualMachine): Promise<void> {
  const currentVm = await syncVmNode(vm);
  const client = await pve.getClient();
  await stopAndDeleteProxmoxVm(currentVm.proxmoxNode, currentVm.proxmoxVmId, client, kindOf(currentVm));
  await prisma.virtualMachine.delete({ where: { id: currentVm.id } });
}

/**
 * Source for a rebuild: either a fresh ISO install or a redeploy from a published
 * template / cloud image (with the cloud-init login details re-supplied).
 */
export type RebuildSource =
  | { kind: 'iso'; os: string }
  | { kind: 'template'; template: Template; cloud: CloudInitInput };

/**
 * Re-image an existing VM in place: destroy its current Proxmox VM (keeping our DB
 * row and its VMID/name/owner), then re-provision into the SAME VMID from the chosen
 * source and start it. Resources (cpu/ram) are preserved; a template whose base disk
 * is larger than the VM's current disk grows it (quota-checked). This is destructive
 * — the old disk and all its data are gone. On a mid-way failure the DB row is left
 * in `error`, matching createVm/deployFromTemplate.
 */
export async function rebuildVm(
  user: User,
  vm: VirtualMachine,
  source: RebuildSource,
): Promise<VirtualMachine> {
  const client = await pve.getClient();
  const current = await syncVmNode(vm);
  const vmid = current.proxmoxVmId;
  const isolate = (await getConfig('isolation_enabled')) !== 'false';

  // Decide the target node + final disk size + the OS label we'll store, and run a
  // quota check if a template's base disk would grow this VM's allocation.
  let targetNode = current.proxmoxNode;
  let diskGb = current.storage;
  let osLabel: string;
  let storage: string | undefined;
  let bridge: string | undefined;
  let isoStorage: string | undefined;

  if (source.kind === 'iso') {
    const cfg = await Promise.all([
      getConfig('default_storage'),
      getConfig('default_bridge'),
      getConfig('iso_storage'),
    ]);
    [storage, bridge, isoStorage] = cfg as [string, string, string];
    if (!storage || !bridge || !isoStorage) {
      throw new Error('Server defaults are not configured — finish setup first');
    }
    // The VM must be rebuilt on a node that actually holds the ISO. Prefer the
    // current node; otherwise place it where the ISO lives with the most capacity.
    const isoNodes = await pve.getIsoNodes(isoStorage, source.os, client);
    if (isoNodes.length === 0) {
      throw new Error(
        `Install ISO "${source.os}" isn't available on any node's "${isoStorage}" storage.`,
      );
    }
    targetNode = isoNodes.includes(current.proxmoxNode)
      ? current.proxmoxNode
      : await pve.pickBestNode(
          { cpu: current.cpu, ramMb: current.ram, storageGb: current.storage },
          storage,
          client,
          isoNodes,
          'amd64',
        );
    osLabel = source.os;
  } else {
    const { template } = source;
    targetNode = template.proxmoxNode; // a clone stays on the template's node
    diskGb = Math.max(current.storage, template.diskGb || current.storage);
    osLabel = template.os ?? template.name;
    if (diskGb !== current.storage) {
      await assertResizeWithinQuota(user, current, { cpu: current.cpu, ram: current.ram, storage: diskGb });
    }
  }

  // Point of no return: tear down the existing VM, then mark the row rebuilding.
  await stopAndDeleteProxmoxVm(current.proxmoxNode, vmid, client);
  await prisma.virtualMachine.update({
    where: { id: current.id },
    data: { status: 'creating', ipAddress: null, proxmoxNode: targetNode, os: osLabel, storage: diskGb },
  });

  try {
    if (source.kind === 'iso') {
      const createUpid = await pve.createVm(
        {
          node: targetNode,
          vmid,
          name: current.name,
          cores: current.cpu,
          memory: current.ram,
          diskGb: current.storage,
          storage: storage!,
          bridge: bridge!,
          isoStorage: isoStorage!,
          iso: source.os,
        },
        client,
      );
      await pve.waitForTask(targetNode, createUpid, client);
      if (isolate) {
        const dnsServers = ((await getConfig('isolation_dns_servers')) ?? '').split(/[,\s]+/).filter(Boolean);
        await pve.configureVmIsolation(targetNode, vmid, { dnsServers }, client);
      }
    } else {
      const { template } = source;
      const upid = await pve.cloneVm(
        { node: targetNode, templateVmid: template.proxmoxVmId, newVmid: vmid, name: current.name, full: template.cloudInit },
        client,
      );
      await pve.waitForTask(targetNode, upid, client, 600_000);
      await configureClonedVm(
        { node: targetNode, vmid, template, cpu: current.cpu, ram: current.ram, diskGb, isolate, cloud: source.cloud },
        client,
      );
    }

    await prisma.virtualMachine.update({ where: { id: current.id }, data: { status: 'stopped' } });
    const startUpid = await pve.startVm(targetNode, vmid, client);
    await pve.waitForTask(targetNode, startUpid, client);
    return prisma.virtualMachine.update({ where: { id: current.id }, data: { status: 'running' } });
  } catch (err) {
    await markVmError(current.id, current.name, err);
    throw err;
  }
}

export async function startVm(vm: VirtualMachine): Promise<void> {
  const currentVm = await syncVmNode(vm);
  await pve.startVm(currentVm.proxmoxNode, currentVm.proxmoxVmId, undefined, kindOf(currentVm));
  await prisma.virtualMachine.update({ where: { id: currentVm.id }, data: { status: 'running' } });
}

export async function stopVm(vm: VirtualMachine, force: boolean): Promise<void> {
  const currentVm = await syncVmNode(vm);
  const kind = kindOf(currentVm);
  if (force) await pve.stopVm(currentVm.proxmoxNode, currentVm.proxmoxVmId, undefined, kind);
  else await pve.shutdownVm(currentVm.proxmoxNode, currentVm.proxmoxVmId, undefined, kind);
  await prisma.virtualMachine.update({ where: { id: currentVm.id }, data: { status: 'stopped' } });
}

export async function restartVm(vm: VirtualMachine): Promise<void> {
  const currentVm = await syncVmNode(vm);
  await pve.rebootVm(currentVm.proxmoxNode, currentVm.proxmoxVmId, undefined, kindOf(currentVm));
  await prisma.virtualMachine.update({ where: { id: currentVm.id }, data: { status: 'running' } });
}

/**
 * Pause (QEMU suspend) a running VM — execution freezes with RAM resident, so
 * resuming is instant. DB status stays "running" (the guest is still resident on
 * the node and holding its resources); the live qmpstatus reports "paused".
 * QEMU-only: Proxmox's LXC suspend is experimental, so containers are rejected.
 */
export async function pauseVm(vm: VirtualMachine): Promise<void> {
  if (kindOf(vm) === 'lxc') throw new Error('Containers (LXC) cannot be paused');
  const client = await pve.getClient();
  const currentVm = await syncVmNode(vm);
  await pve.suspendVm(currentVm.proxmoxNode, currentVm.proxmoxVmId, client);
}

/** Resume a paused VM. QEMU-only, the counterpart of {@link pauseVm}. */
export async function resumeVm(vm: VirtualMachine): Promise<void> {
  if (kindOf(vm) === 'lxc') throw new Error('Containers (LXC) cannot be paused');
  const client = await pve.getClient();
  const currentVm = await syncVmNode(vm);
  await pve.resumeVm(currentVm.proxmoxNode, currentVm.proxmoxVmId, client);
}

// ─── Guest password reset ─────────────────────────────────────

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/**
 * A CSPRNG-generated, unambiguous (no 0/O/1/l/I) 20-char guest password.
 * Uses `crypto.randomInt` for an *unbiased* index into the alphabet — plain
 * `randomBytes % length` skews toward the first (256 % length) characters.
 */
export function generateGuestPassword(): string {
  let out = '';
  for (let i = 0; i < 20; i++) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

/**
 * Reset a user's password inside the guest via the QEMU guest agent (its
 * dedicated set-user-password call — no shell involved). For tenants locked
 * out of key-only cloud images. Returns the new password exactly once; it is
 * never stored or logged. QEMU + running agent required.
 */
export async function resetGuestPassword(vm: VirtualMachine, username: string): Promise<string> {
  if (kindOf(vm) === 'lxc') throw new Error('Password reset needs the QEMU guest agent — containers are not supported');
  const client = await pve.getClient();
  const currentVm = await syncVmNode(vm);
  const password = generateGuestPassword();
  await pve.setGuestUserPassword(currentVm.proxmoxNode, currentVm.proxmoxVmId, username, password, client);
  return password;
}

// ─── Rescue mode ──────────────────────────────────────────────

/**
 * Boot a VM from the admin-designated rescue ISO. The current { boot, ide3 }
 * config is snapshotted on `rescueBoot` first so {@link exitRescue} can put
 * everything back. The VM is force-stopped if running (rescue exists for
 * machines that won't boot or can't shut down cleanly), reconfigured, then
 * started into the ISO.
 */
export async function enterRescue(vm: VirtualMachine): Promise<VirtualMachine> {
  if (kindOf(vm) === 'lxc') throw new Error('Rescue mode is for VMs — containers share the host kernel');
  if (vm.rescueBoot) throw new Error('Already in rescue mode');
  const iso = await getConfig('rescue_iso');
  if (!iso) throw new Error('No rescue ISO is configured — an admin can set one under Admin → Settings');

  const client = await pve.getClient();
  const current = await syncVmNode(vm);
  const cfg = await pve.getVmConfig(current.proxmoxNode, current.proxmoxVmId, client);
  const snap: pve.RescueSnapshot = { boot: cfg['boot'] ?? null, ide3: cfg['ide3'] ?? null };

  const status = await pve.getVmStatus(current.proxmoxNode, current.proxmoxVmId, client).catch(() => null);
  if (status?.status === 'running') {
    const upid = await pve.stopVm(current.proxmoxNode, current.proxmoxVmId, client);
    await pve.waitForTask(current.proxmoxNode, upid, client);
  }

  await pve.applyRescueConfig(current.proxmoxNode, current.proxmoxVmId, iso, client);
  const updated = await prisma.virtualMachine.update({
    where: { id: current.id },
    data: { rescueBoot: JSON.stringify(snap), status: 'running' },
  });
  await pve.startVm(current.proxmoxNode, current.proxmoxVmId, client);
  return updated;
}

/** Leave rescue mode: stop, restore the snapshotted boot config, boot from disk. */
export async function exitRescue(vm: VirtualMachine): Promise<VirtualMachine> {
  if (!vm.rescueBoot) throw new Error('Not in rescue mode');
  const snap = JSON.parse(vm.rescueBoot) as pve.RescueSnapshot;

  const client = await pve.getClient();
  const current = await syncVmNode(vm);
  const status = await pve.getVmStatus(current.proxmoxNode, current.proxmoxVmId, client).catch(() => null);
  if (status?.status === 'running') {
    const upid = await pve.stopVm(current.proxmoxNode, current.proxmoxVmId, client);
    await pve.waitForTask(current.proxmoxNode, upid, client);
  }

  await pve.restoreBootConfig(current.proxmoxNode, current.proxmoxVmId, snap, client);
  const updated = await prisma.virtualMachine.update({
    where: { id: current.id },
    data: { rescueBoot: null, status: 'running' },
  });
  await pve.startVm(current.proxmoxNode, current.proxmoxVmId, client);
  return updated;
}
