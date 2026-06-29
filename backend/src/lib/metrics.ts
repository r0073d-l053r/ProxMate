import { Registry, collectDefaultMetrics, Histogram, Counter, Gauge } from 'prom-client';
import { prisma } from './prisma.js';

/**
 * Prometheus metrics. A single registry exposed at GET /metrics so an operator can
 * scrape request latency, Proxmox API error counts, and the live VM count without
 * polling the app's own UI.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new Histogram({
  name: 'proxmate_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const proxmoxApiErrors = new Counter({
  name: 'proxmate_proxmox_api_errors_total',
  help: 'Count of failed Proxmox API calls, by kind',
  labelNames: ['kind'] as const, // 'timeout' | 'network' | 'http' | 'other'
  registers: [registry],
});

// vm_count is read straight from the DB at scrape time (cheap; one COUNT).
new Gauge({
  name: 'proxmate_vm_count',
  help: 'Number of VMs ProxMate is tracking',
  registers: [registry],
  async collect() {
    try {
      this.set(await prisma.virtualMachine.count());
    } catch {
      /* DB unavailable at scrape time — leave the last value */
    }
  },
});
