import crypto from 'node:crypto';
import type { Template, User } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { recordAudit, type AuditActor } from './audit.service.js';
import * as pve from './proxmox.service.js';
import {
  reserveTemplateBatch,
  provisionReservedDeploy,
  CreateOptionError,
  type DeployTemplateInput,
  type TemplateBatchItem,
} from './vm.service.js';

/**
 * Bulk template deploys: N copies of one template for one owner (`web-{n}`), or —
 * admin only — one copy into each of several users' accounts. The batch is
 * reserved all at once (see reserveTemplateBatch: quota for the whole batch, every
 * row written together, or nothing), then cloned a few at a time; each copy goes
 * through exactly the single-deploy path (placement, cloud-init, isolation, deploy
 * lock). A batch takes minutes, so the request returns once it is reserved and
 * the per-copy results are polled from here.
 *
 * Batches live in memory: the API is a single process (see acquireQuotaLock), and
 * a batch's machines are ordinary rows, so a restart loses only the progress view.
 */

/** Most copies a tenant may deploy in one batch. */
export const BULK_DEPLOY_MAX = 20;
/** Most copies (or users) an admin may deploy in one batch. */
export const BULK_DEPLOY_MAX_ADMIN = 50;
/** Copies cloned at the same time. */
export const BULK_DEPLOY_CONCURRENCY = 3;
/** How long a finished batch's results stay readable. */
const FINISHED_BATCH_TTL_MS = 60 * 60 * 1000;

const NAME_RE = /^[a-zA-Z0-9-]+$/;

/** A bulk-deploy request the routes surface directly (status included). */
export class BulkDeployError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'BulkDeployError';
  }
}

export type BatchItemStatus = 'queued' | 'deploying' | 'done' | 'failed';

export interface BatchItem {
  index: number;
  name: string;
  userId: string;
  vmId: string;
  proxmoxVmId: number;
  node: string;
  status: BatchItemStatus;
  error?: string;
}

export interface DeployBatch {
  id: string;
  actorId: string;
  templateId: string;
  templateName: string;
  createdAt: string;
  finishedAt: string | null;
  items: BatchItem[];
}

const batches = new Map<string, { batch: DeployBatch; done: Promise<void> }>();

/** `{n}` → the copy's 1-based number. */
export function expandNamePattern(pattern: string, n: number): string {
  return pattern.replaceAll('{n}', String(n));
}

/**
 * The copies a request asks for: `count` copies for the actor (or the admin's
 * `forUserId`), or one per user in `forUserIds` (admin only). Enforces the caps,
 * the admin-only options and the name rules; returns one entry per copy.
 */
export async function planBatch(
  actor: { id: string; role: string },
  opts: { namePattern: string; count?: number; forUserId?: string; forUserIds?: string[]; quotaExempt?: boolean },
): Promise<Array<{ owner: User; name: string }>> {
  const isAdmin = actor.role === 'admin';
  if (!isAdmin && (opts.forUserId !== undefined || opts.forUserIds !== undefined || opts.quotaExempt !== undefined)) {
    throw new CreateOptionError('Deploying for other users, or quota exemption, is admin-only.');
  }
  if (opts.forUserIds !== undefined && (opts.forUserId !== undefined || (opts.count ?? 1) !== 1)) {
    throw new BulkDeployError('Choose either a number of copies or a list of users, not both.');
  }
  const cap = isAdmin ? BULK_DEPLOY_MAX_ADMIN : BULK_DEPLOY_MAX;

  let owners: User[];
  if (opts.forUserIds !== undefined) {
    const ids = [...new Set(opts.forUserIds)];
    if (ids.length === 0) throw new BulkDeployError('Choose at least one user.');
    if (ids.length > cap) throw new BulkDeployError(`At most ${cap} users per batch.`);
    const found = await prisma.user.findMany({ where: { id: { in: ids } } });
    if (found.length !== ids.length) throw new CreateOptionError('No such user to deploy for.', 404);
    const byId = new Map(found.map((u) => [u.id, u]));
    owners = ids.map((id) => byId.get(id)!);
  } else {
    const count = opts.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > cap) {
      throw new BulkDeployError(`Deploy between 1 and ${cap} copies at a time.`);
    }
    if (count > 1 && !opts.namePattern.includes('{n}')) {
      throw new BulkDeployError('The name pattern needs {n} (the copy number), e.g. web-{n}.');
    }
    const owner = await prisma.user.findUnique({ where: { id: opts.forUserId ?? actor.id } });
    if (!owner) throw new CreateOptionError(opts.forUserId ? 'No such user to deploy for.' : 'User not found', 404);
    owners = Array.from({ length: count }, () => owner);
  }

  const plan = owners.map((owner, i) => ({ owner, name: expandNamePattern(opts.namePattern, i + 1) }));
  for (const { name } of plan) {
    if (!NAME_RE.test(name) || name.length > 63) {
      throw new BulkDeployError(`"${name}" is not a valid name — use letters, numbers and hyphens (at most 63).`);
    }
  }
  const seen = new Set<string>();
  for (const { owner, name } of plan) {
    const key = `${owner.id}/${name}`;
    if (seen.has(key)) throw new BulkDeployError(`The pattern gives two machines the name "${name}".`);
    seen.add(key);
  }
  return plan;
}

/**
 * Reserve a batch (a BatchQuotaError when it doesn't fit, and nothing is written)
 * and start cloning it in the background. Returns the batch once reserved.
 */
export async function startTemplateBatch(
  actor: AuditActor & { role: string },
  template: Template,
  copies: Array<{ owner: User; name: string }>,
  input: Omit<DeployTemplateInput, 'name' | 'adminManaged'>,
): Promise<DeployBatch> {
  const items: TemplateBatchItem[] = copies.map(({ owner, name }) => ({
    owner,
    // Same rule as a single deploy: a machine an admin puts into someone else's
    // account is admin-managed, and quota exemption only ever applies there.
    input: {
      ...input,
      name,
      adminManaged: owner.id !== actor.id,
      quotaExempt: owner.id !== actor.id ? input.quotaExempt : undefined,
    },
  }));
  const reservation = await reserveTemplateBatch(template, items);

  pruneFinishedBatches();
  const batch: DeployBatch = {
    id: crypto.randomUUID(),
    actorId: actor.id,
    templateId: template.id,
    templateName: template.name,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    items: reservation.items.map(({ vm }, index) => ({
      index,
      name: vm.name,
      userId: vm.userId,
      vmId: vm.id,
      proxmoxVmId: vm.proxmoxVmId,
      node: vm.proxmoxNode,
      status: 'queued',
    })),
  };
  await recordAudit({
    action: 'template.deploy_bulk',
    actor,
    targetType: 'template',
    targetId: template.id,
    detail: `${batch.items.length} × ${template.name} (batch ${batch.id})`,
  });

  const done = runPool(reservation.items, BULK_DEPLOY_CONCURRENCY, async (item, i) => {
    const entry = batch.items[i]!;
    entry.status = 'deploying';
    try {
      const vm = await provisionReservedDeploy(reservation, item);
      entry.status = 'done';
      entry.proxmoxVmId = vm.proxmoxVmId;
    } catch (err) {
      entry.status = 'failed';
      entry.error = pve.pveMessage(err);
    }
  }).then(async () => {
    batch.finishedAt = new Date().toISOString();
    const ok = batch.items.filter((x) => x.status === 'done').length;
    await recordAudit({
      action: 'template.deploy_bulk_done',
      actor,
      targetType: 'template',
      targetId: template.id,
      detail: `${ok}/${batch.items.length} × ${template.name} deployed (batch ${batch.id})`,
    });
  });
  batches.set(batch.id, { batch, done });
  return batch;
}

/** A batch the caller may see (the admin, or whoever started it), or null. */
export function getBatch(id: string, user: { id: string; role: string }): DeployBatch | null {
  const entry = batches.get(id);
  if (!entry) return null;
  if (user.role !== 'admin' && entry.batch.actorId !== user.id) return null;
  return entry.batch;
}

/** Resolves once every copy in the batch is settled (tests and shutdown). */
export async function waitForBatch(id: string): Promise<void> {
  await batches.get(id)?.done;
}

function pruneFinishedBatches(): void {
  const cutoff = Date.now() - FINISHED_BATCH_TTL_MS;
  for (const [id, { batch }] of batches) {
    if (batch.finishedAt && Date.parse(batch.finishedAt) < cutoff) batches.delete(id);
  }
}

/** Run `fn` over `items` with at most `limit` running at once. */
async function runPool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
