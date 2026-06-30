import type { Response } from 'express';
import { getClient } from './proxmox.service.js';

export interface LiveStat {
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
  netin: number;
  netout: number;
}

interface PveResource {
  type: string;
  vmid?: number;
  status?: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  netin?: number;
  netout?: number;
}

// Tiny in-process cache so a fast UI cadence shares one `/cluster/resources` call
// per window — Proxmox only samples guest stats every few seconds anyway.
const TTL_MS = 750;
let cache: { at: number; data: Record<number, LiveStat> } | null = null;
let inflight: Promise<Record<number, LiveStat>> | null = null;

async function fetchLiveStats(): Promise<Record<number, LiveStat>> {
  const client = await getClient();
  const r = await client.get<{ data: PveResource[] }>('/cluster/resources');
  const stats: Record<number, LiveStat> = {};
  for (const item of r.data.data) {
    if ((item.type === 'qemu' || item.type === 'lxc') && item.vmid !== undefined) {
      stats[item.vmid] = {
        status: item.status ?? 'unknown',
        cpu: item.cpu ?? 0,
        maxcpu: item.maxcpu ?? 0,
        mem: item.mem ?? 0,
        maxmem: item.maxmem ?? 0,
        disk: item.disk ?? 0,
        maxdisk: item.maxdisk ?? 0,
        uptime: item.uptime ?? 0,
        netin: item.netin ?? 0,
        netout: item.netout ?? 0,
      };
    }
  }
  return stats;
}

/** Cached + request-coalesced live stats for every guest, keyed by proxmoxVmId. */
export async function getLiveStats(): Promise<Record<number, LiveStat>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (!inflight) inflight = fetchLiveStats().finally(() => (inflight = null));
  const data = await inflight;
  cache = { at: Date.now(), data };
  return data;
}

// ─── SSE fan-out ──────────────────────────────────────────────
// One server-side poll loop pushes live stats to every subscribed admin client
// (Server-Sent Events), so the monitor no longer polls once per tab. The loop
// only runs while there's at least one subscriber.
const subscribers = new Set<Response>();
let feedTimer: ReturnType<typeof setInterval> | null = null;
const FEED_INTERVAL_MS = Math.max(250, Number(process.env['LIVE_FEED_INTERVAL_MS'] ?? 1000));

function tickFeed(): void {
  if (subscribers.size === 0) return;
  getLiveStats()
    .then((stats) => {
      const payload = `data: ${JSON.stringify(stats)}\n\n`;
      for (const res of subscribers) res.write(payload);
    })
    .catch(() => {
      for (const res of subscribers) res.write('event: stale\ndata: {}\n\n');
    });
}

/** Subscribe an SSE response to live-stats pushes; returns an unsubscribe fn. */
export function addLiveFeedSubscriber(res: Response): () => void {
  subscribers.add(res);
  if (!feedTimer) feedTimer = setInterval(tickFeed, FEED_INTERVAL_MS);
  return () => {
    subscribers.delete(res);
    if (subscribers.size === 0 && feedTimer) {
      clearInterval(feedTimer);
      feedTimer = null;
    }
  };
}
