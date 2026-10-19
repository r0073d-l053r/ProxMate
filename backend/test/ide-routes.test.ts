import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request, type Response } from 'express';

// The router under test runs for whichever user this points at.
let currentUser = { id: 'u1', role: 'user' };
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: vi.fn((req: Request, _res: Response, next: () => void) => {
    (req as unknown as { user: unknown }).user = currentUser;
    next();
  }),
}));
vi.mock('../src/services/ide.service.js', () => ({ getIdeCapability: vi.fn() }));
vi.mock('../src/services/ide-gateway.service.js', () => ({
  issueGatewayToken: vi.fn(),
  listModelPickerEntries: vi.fn().mockResolvedValue([]),
  probeModels: vi.fn(),
}));
vi.mock('../src/services/vm.service.js', () => ({ getVmWithCap: vi.fn(), getViewableVm: vi.fn() }));
vi.mock('../src/services/ide-provision.service.js', () => ({
  startIdeProvision: vi.fn(),
  refreshIdeState: vi.fn(),
  IdeProvisionError: class IdeProvisionError extends Error {},
  startIdeRelocate: vi.fn(),
  getIdeRelocateStatus: vi.fn(),
}));
vi.mock('../src/services/tenant-llm-key.service.js', () => ({
  listLlmKeys: vi.fn(),
  addLlmKey: vi.fn(),
  deleteLlmKey: vi.fn(),
  getLlmKeyEndpoint: vi.fn(),
  KNOWN_PROVIDERS: ['openai'],
  TooManyLlmKeysError: class extends Error {},
  InvalidLlmKeyError: class extends Error {},
}));
vi.mock('../src/services/ide-guest-auth.service.js', () => ({ loadIdeGuestSecret: vi.fn() }));
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: vi.fn() }));
vi.mock('../src/lib/url-safety.js', () => ({ assertSafeOutboundUrl: vi.fn() }));

import { getViewableVm } from '../src/services/vm.service.js';
import { refreshIdeState } from '../src/services/ide-provision.service.js';
import { loadIdeGuestSecret } from '../src/services/ide-guest-auth.service.js';
import ideRouter from '../src/routes/ide.routes.js';

let server: http.Server | null = null;
let base = '';

beforeEach(async () => {
  vi.clearAllMocks();
  currentUser = { id: 'u1', role: 'user' };
  const app = express();
  app.use(express.json());
  app.use('/api/ide', ideRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

describe('GET /api/ide/:id/status — out-of-date installs', () => {
  beforeEach(() => {
    vi.mocked(getViewableVm).mockResolvedValue({ id: 'vm1', userId: 'u1' } as never);
    vi.mocked(refreshIdeState).mockResolvedValue('ready');
  });

  it('flags a ready install that has no guest secret as needing a reinstall', async () => {
    vi.mocked(loadIdeGuestSecret).mockResolvedValue(null);
    const r = await fetch(`${base}/api/ide/vm1/status`);
    expect(await r.json()).toEqual({ state: 'ready', reinstallRequired: true });
  });

  it('reports a current install as plainly ready', async () => {
    vi.mocked(loadIdeGuestSecret).mockResolvedValue('secret');
    const r = await fetch(`${base}/api/ide/vm1/status`);
    expect(await r.json()).toEqual({ state: 'ready' });
  });
});
