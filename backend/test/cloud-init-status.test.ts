import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// cloudInitStatus() reads config + (in manual mode only) the Proxmox client.
// Keep the real proxmox exports (CLOUD_INIT_CATALOG, snippetWriteConfig) but mock
// getClient so we can assert whether it is consulted, and mock config + prisma.
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn(), setConfig: vi.fn() }));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return { ...actual, getClient: vi.fn() };
});

import { getConfig } from '../src/services/config.service.js';
import * as pve from '../src/services/proxmox.service.js';
import { cloudInitStatus } from '../src/services/template.service.js';

const getConfigMock = vi.mocked(getConfig);
const getClientMock = vi.mocked(pve.getClient);

// Catalog-agnostic picks so the test doesn't hardcode feature ids.
const CATALOG = pve.CLOUD_INIT_CATALOG;
const OFFERED = CATALOG.slice(0, 4).map((f) => f.id);
const BASE = [CATALOG[4]!.id];

const savedDir = process.env['SNIPPET_DIR'];
const savedStorage = process.env['SNIPPET_STORAGE'];

function configReturns(map: Record<string, string | null>) {
  getConfigMock.mockImplementation(async (k: string) => map[k] ?? null);
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['SNIPPET_DIR'];
  delete process.env['SNIPPET_STORAGE'];
});
afterEach(() => {
  if (savedDir === undefined) delete process.env['SNIPPET_DIR'];
  else process.env['SNIPPET_DIR'] = savedDir;
  if (savedStorage === undefined) delete process.env['SNIPPET_STORAGE'];
  else process.env['SNIPPET_STORAGE'] = savedStorage;
});

describe('cloudInitStatus — on-demand snippet writing', () => {
  it('offers every admin-selected feature without any per-node gating or Proxmox call', async () => {
    process.env['SNIPPET_DIR'] = '/snippets';
    process.env['SNIPPET_STORAGE'] = 'musebot-backups';
    configReturns({
      cloudinit_offered: JSON.stringify(OFFERED),
      cloudinit_base: JSON.stringify(BASE),
    });

    const status = await cloudInitStatus();

    expect(status.onDemand).toBe(true);
    expect(status.snippetsEnabled).toBe(true);
    // The bug was here: offered features got filtered down to whatever snippet files
    // happened to be pre-placed on a node. In on-demand mode ALL offered show.
    expect(status.features.map((f) => f.id)).toEqual(OFFERED);
    expect(status.nodes).toEqual({}); // no per-node readiness in on-demand mode
    expect(status.base.map((b) => b.id)).toEqual(BASE);
    // Short-circuit: no storage/cluster listing is performed.
    expect(getClientMock).not.toHaveBeenCalled();
  });
});

describe('cloudInitStatus — manual fallback (no on-demand config)', () => {
  it('reports onDemand:false, an empty base, and consults Proxmox for snippet storage', async () => {
    configReturns({
      cloudinit_offered: JSON.stringify(OFFERED),
      cloudinit_base: JSON.stringify(BASE),
      iso_storage: 'local',
    });
    // Storage list without the `snippets` content type → snippetsEnabled false → early return.
    getClientMock.mockResolvedValue({
      get: vi.fn().mockResolvedValue({ data: { data: [{ storage: 'local', content: 'iso,vztmpl' }] } }),
    } as never);

    const status = await cloudInitStatus();

    expect(status.onDemand).toBe(false);
    expect(status.snippetsEnabled).toBe(false);
    expect(status.base).toEqual([]); // base only applies in on-demand mode
    expect(status.features.map((f) => f.id)).toEqual(OFFERED);
    expect(getClientMock).toHaveBeenCalled();
  });
});
