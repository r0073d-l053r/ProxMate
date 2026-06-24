import type { Template, VirtualMachine } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import * as pve from './proxmox.service.js';

/** Published templates shown in the user-facing Template Store. */
export function listPublished(): Promise<Template[]> {
  return prisma.template.findMany({ where: { published: true }, orderBy: { createdAt: 'desc' } });
}

/** All registered templates (admin view). */
export function listAll(): Promise<Template[]> {
  return prisma.template.findMany({ orderBy: { createdAt: 'desc' } });
}

/** Proxmox templates that exist on the cluster but aren't registered in the store yet. */
export async function discover(): Promise<Array<{ vmid: number; node: string; name: string; diskGb: number }>> {
  const [pveTemplates, registered] = await Promise.all([pve.getTemplates(), prisma.template.findMany()]);
  const known = new Set(registered.map((t) => t.proxmoxVmId));
  return pveTemplates
    .filter((t) => !known.has(t.vmid))
    .map((t) => ({
      vmid: t.vmid,
      node: t.node,
      name: t.name,
      diskGb: t.maxdisk ? Math.round(t.maxdisk / 1024 / 1024 / 1024) : 0,
    }));
}

export interface RegisterTemplateInput {
  proxmoxVmId: number;
  node: string;
  name: string;
  description?: string;
  os?: string;
  diskGb?: number;
  notes?: string;
}

/** Register a Proxmox template into the store (or update an existing registration). */
export async function register(input: RegisterTemplateInput): Promise<Template> {
  // Trust the disk size from Proxmox if the caller didn't supply one.
  let diskGb = input.diskGb ?? 0;
  if (!diskGb) {
    const found = (await pve.getTemplates()).find((t) => t.vmid === input.proxmoxVmId);
    if (found?.maxdisk) diskGb = Math.round(found.maxdisk / 1024 / 1024 / 1024);
  }

  return prisma.template.upsert({
    where: { proxmoxVmId: input.proxmoxVmId },
    update: {
      name: input.name,
      description: input.description ?? null,
      os: input.os ?? null,
      proxmoxNode: input.node,
      diskGb,
      published: true,
      // Only touch notes when the caller supplied them, so re-registering
      // doesn't silently wipe an admin's saved credentials.
      ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
    },
    create: {
      name: input.name,
      description: input.description ?? null,
      os: input.os ?? null,
      proxmoxVmId: input.proxmoxVmId,
      proxmoxNode: input.node,
      diskGb,
      notes: input.notes ?? null,
    },
  });
}

/** Admin: edit a template's notes (e.g. default login) and/or description. */
export async function updateTemplate(
  id: string,
  data: { notes?: string | null; description?: string | null },
): Promise<Template> {
  return prisma.template.update({
    where: { id },
    data: {
      ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
      ...(data.description !== undefined ? { description: data.description || null } : {}),
    },
  });
}

/** Remove a template from the store (does NOT delete the Proxmox template itself). */
export async function unregister(id: string): Promise<void> {
  await prisma.template.delete({ where: { id } });
}

/**
 * Convert an existing ProxMate VM into a template and register it in the store.
 * The VM is stopped, converted on Proxmox, removed from the VM list, and added
 * as a template.
 */
export async function convertVmToTemplate(
  vm: VirtualMachine,
  meta: { name: string; description?: string; os?: string },
): Promise<Template> {
  const client = await pve.getClient();

  // Templates must be stopped before conversion.
  try {
    const status = await pve.getVmStatus(vm.proxmoxNode, vm.proxmoxVmId, client);
    if (status.status !== 'stopped') {
      const upid = await pve.stopVm(vm.proxmoxNode, vm.proxmoxVmId, client);
      await pve.waitForTask(vm.proxmoxNode, upid, client);
    }
  } catch {
    /* best effort — proceed to convert */
  }

  await pve.convertToTemplate(vm.proxmoxNode, vm.proxmoxVmId, client);

  // It's no longer a usable VM — move the record into the template store.
  await prisma.virtualMachine.delete({ where: { id: vm.id } });
  return register({
    proxmoxVmId: vm.proxmoxVmId,
    node: vm.proxmoxNode,
    name: meta.name,
    description: meta.description,
    os: meta.os ?? vm.os,
    diskGb: vm.storage,
  });
}
