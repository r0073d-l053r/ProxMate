import { describe, it, expect, vi } from 'vitest';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { buildClient } from '../src/services/proxmox.service.js';

// Mock the metrics module so importing proxmox.service doesn't pull in the real
// Prisma client just to register a gauge — the retry logic is what we're testing.
vi.mock('../src/lib/metrics.js', () => ({ proxmoxApiErrors: { inc: vi.fn() } }));

/**
 * An axios adapter that fails the first `failTimes` calls with an error built from
 * the live request config (so `error.config` is populated, as real axios does),
 * then succeeds.
 */
function flakyAdapter(failTimes: number, makeErr: (config: InternalAxiosRequestConfig) => AxiosError) {
  let calls = 0;
  const adapter: AxiosAdapter = async (config) => {
    calls++;
    if (calls <= failTimes) throw makeErr(config);
    return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
  };
  return { adapter, calls: () => calls };
}

const timeoutErr = (config: InternalAxiosRequestConfig) =>
  new AxiosError('timeout of 15000ms exceeded', 'ECONNABORTED', config);
const networkErr = (config: InternalAxiosRequestConfig) => new AxiosError('socket hang up', 'ECONNRESET', config);
const httpErr = (status: number) => (config: InternalAxiosRequestConfig) =>
  new AxiosError('Request failed', 'ERR', config, undefined, {
    status,
    data: {},
    statusText: '',
    headers: {},
    config,
  });

function client() {
  return buildClient('https://pve.local:8006', 'root@pam!t', 'secret', false);
}

describe('Proxmox client retry/backoff', () => {
  it('retries an idempotent GET through a transient timeout and then succeeds', async () => {
    const c = client();
    const { adapter, calls } = flakyAdapter(2, timeoutErr);
    c.defaults.adapter = adapter;

    const res = await c.get('/version');
    expect(res.data).toEqual({ ok: true });
    expect(calls()).toBe(3); // 2 failures + 1 success (default 2 retries)
  });

  it('does NOT retry a POST (could double-provision a VM)', async () => {
    const c = client();
    const { adapter, calls } = flakyAdapter(99, networkErr);
    c.defaults.adapter = adapter;

    await expect(c.post('/nodes/pve/qemu', {})).rejects.toBeInstanceOf(AxiosError);
    expect(calls()).toBe(1);
  });

  it('does NOT retry a non-transient 4xx', async () => {
    const c = client();
    const { adapter, calls } = flakyAdapter(99, httpErr(400));
    c.defaults.adapter = adapter;

    await expect(c.get('/version')).rejects.toBeInstanceOf(AxiosError);
    expect(calls()).toBe(1);
  });

  it('gives up after the retry budget on a persistent 5xx', async () => {
    const c = client();
    const { adapter, calls } = flakyAdapter(99, httpErr(503));
    c.defaults.adapter = adapter;

    await expect(c.get('/version')).rejects.toBeInstanceOf(AxiosError);
    expect(calls()).toBe(3); // initial try + 2 retries
  });
});
