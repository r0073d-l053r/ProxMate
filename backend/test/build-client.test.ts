import { describe, it, expect, vi } from 'vitest';

// proxmox.service → config.service → prisma constructs a client at import; stub it.
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { buildClient, getProxmoxCa } from '../src/services/proxmox.service.js';

/** axios may store create()-time headers at the top level or under `common`. */
function authHeader(client: ReturnType<typeof buildClient>): unknown {
  const h = client.defaults.headers as Record<string, unknown> & { common?: Record<string, unknown> };
  return h['Authorization'] ?? h.common?.['Authorization'];
}

describe('buildClient (Proxmox API client)', () => {
  it('builds the /api2/json base URL and the PVEAPIToken auth header', () => {
    const c = buildClient('https://pve.example:8006', 'root@pam!proxmate', 'secret-123', true);
    expect(c.defaults.baseURL).toBe('https://pve.example:8006/api2/json');
    expect(authHeader(c)).toBe('PVEAPIToken=root@pam!proxmate=secret-123');
  });

  it('verifies TLS when verifySsl is true (rejectUnauthorized = true)', () => {
    const c = buildClient('https://pve:8006', 'id', 'sec', true);
    const agent = c.defaults.httpsAgent as { options: { rejectUnauthorized?: boolean } };
    expect(agent.options.rejectUnauthorized).toBe(true);
  });

  it('skips TLS verification when verifySsl is false', () => {
    const c = buildClient('https://pve:8006', 'id', 'sec', false);
    const agent = c.defaults.httpsAgent as { options: { rejectUnauthorized?: boolean } };
    expect(agent.options.rejectUnauthorized).toBe(false);
  });

  it('trusts a custom CA while keeping verification on (private-CA path)', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----';
    const c = buildClient('https://pve:8006', 'id', 'sec', true, ca);
    const agent = c.defaults.httpsAgent as { options: { rejectUnauthorized?: boolean; ca?: string } };
    expect(agent.options.rejectUnauthorized).toBe(true);
    expect(agent.options.ca).toBe(ca);
  });
});

describe('getProxmoxCa (custom CA source)', () => {
  const PEM = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';

  it('reads an inline PEM from PROXMOX_CA_CERT', () => {
    vi.stubEnv('PROXMOX_CA_CERT', PEM);
    expect(getProxmoxCa()).toBe(PEM);
    vi.unstubAllEnvs();
  });

  it('ignores a non-PEM value and returns undefined when nothing is set', () => {
    vi.stubEnv('PROXMOX_CA_CERT', 'not-a-cert');
    expect(getProxmoxCa()).toBeUndefined();
    vi.unstubAllEnvs();
  });
});
