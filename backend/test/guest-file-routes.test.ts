import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

// Route-level checks for the guest-agent file tools: who may push a file
// (the `configure` capability: owner, admin, manager share) and who may read
// the IDE install log (owner or admin), what is audited, and the rate limit.
// Capabilities are resolved by the real vm.service against a stubbed prisma.

vi.hoisted(() => {
  process.env['GUEST_FILE_RATE_LIMIT_MAX'] = '6';
});

let currentUser = { id: 'owner', role: 'user' };
const vmRow = {
  id: 'vm1', userId: 'owner', name: 'web', type: 'qemu', proxmoxNode: 'pve1', proxmoxVmId: 101,
  status: 'running', ideState: 'failed',
};
const shares: Record<string, string> = { viewer: 'viewer', operator: 'operator', manager: 'manager' };

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { findUnique: vi.fn(async () => vmRow) },
    vmShare: {
      findUnique: vi.fn(async ({ where }: { where: { vmId_userId: { userId: string } } }) => {
        const role = shares[where.vmId_userId.userId];
        return role ? { role } : null;
      }),
    },
  },
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: Request, _res: Response, next: () => void) => {
    (req as unknown as { user: unknown }).user = currentUser;
    next();
  },
  allowExpiredAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../src/middleware/mfa.js', () => ({
  enforceMfaSetup: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../src/services/audit.service.js', () => ({
  recordAudit: vi.fn(async () => undefined),
  listAuditForTarget: vi.fn(async () => []),
}));
vi.mock('../src/services/guest-file.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/guest-file.service.js')>();
  return {
    ...actual,
    pushGuestFile: vi.fn(async (_vm: unknown, input: { path: string; content: Buffer }) => ({
      path: input.path,
      size: input.content.length,
      sha256: createHash('sha256').update(input.content).digest('hex'),
      verified: true,
    })),
    readIdeInstallLog: vi.fn(async () => ({ path: actual.IDE_LOG_PATH, log: 'done', truncated: false, missing: false })),
  };
});

import vmRouter from '../src/routes/vm.routes.js';
import ideRouter from '../src/routes/ide.routes.js';
import { recordAudit } from '../src/services/audit.service.js';
import { pushGuestFile, readIdeInstallLog, GuestFileError } from '../src/services/guest-file.service.js';

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/vms', vmRouter);
  app.use('/ide', ideRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  vi.clearAllMocks();
  vmRow.type = 'qemu';
});

function push(fields: Record<string, string>, content: string | Uint8Array = 'hello world\n') {
  const form = new FormData();
  form.append('file', new Blob([content]), 'notes.txt');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return fetch(`${base}/vms/vm1/files`, { method: 'POST', body: form });
}
const as = (id: string, role = 'user') => {
  currentUser = { id, role };
};

describe('POST /vms/:id/files — capability', () => {
  it.each([
    ['viewer', 404],
    ['operator', 404],
    ['stranger', 404],
  ])('%s is refused', async (who, status) => {
    as(who);
    expect((await push({ path: '/etc/motd' })).status).toBe(status);
    expect(pushGuestFile).not.toHaveBeenCalled();
  });

  it.each([
    ['owner', 'user'],
    ['manager', 'user'],
    ['someadmin', 'admin'],
  ])('%s may push', async (who, role) => {
    as(who, role);
    const r = await push({ path: '/etc/motd', mode: '0600', owner: 'ubuntu', createParents: 'true' });
    expect(r.status).toBe(200);
    expect(pushGuestFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'vm1' }),
      expect.objectContaining({ path: '/etc/motd', mode: '0600', owner: 'ubuntu', createParents: true }),
    );
  });

  it('refuses containers', async () => {
    as('owner');
    vmRow.type = 'lxc';
    expect((await push({ path: '/etc/motd' })).status).toBe(409);
    expect(pushGuestFile).not.toHaveBeenCalled();
  });
});

describe('POST /vms/:id/files — validation and size', () => {
  beforeEach(() => as('owner2-validation'));
  beforeEach(() => {
    vmRow.userId = 'owner2-validation';
  });
  afterAll(() => {
    vmRow.userId = 'owner';
  });

  it.each(['relative/path', '/etc/../shadow', '/proc/1/mem', '/dev/sda'])('rejects path %s', async (p) => {
    const r = await push({ path: p });
    expect(r.status).toBe(400);
    expect(pushGuestFile).not.toHaveBeenCalled();
  });

  it('rejects a bad mode', async () => {
    expect((await push({ path: '/etc/x', mode: '4755' })).status).toBe(400);
  });
});

describe('POST /vms/:id/files — size cap and audit', () => {
  beforeEach(() => {
    vmRow.userId = 'owner3';
    as('owner3');
  });
  afterAll(() => {
    vmRow.userId = 'owner';
  });

  it('answers 413 above 1 MiB without calling the guest', async () => {
    const r = await push({ path: '/srv/big.bin' }, new Uint8Array(1024 * 1024 + 1));
    expect(r.status).toBe(413);
    expect(pushGuestFile).not.toHaveBeenCalled();
  });

  it('audits path, size and checksum, never the contents', async () => {
    const content = 'top-secret-contents-123';
    const r = await push({ path: '/opt/app/.env' }, content);
    expect(r.status).toBe(200);
    const entry = vi.mocked(recordAudit).mock.calls[0]![0];
    expect(entry.action).toBe('vm.file_push');
    expect(entry.targetId).toBe('vm1');
    expect(entry.detail).toContain('/opt/app/.env');
    expect(entry.detail).toContain(`${content.length} bytes`);
    expect(entry.detail).toContain(createHash('sha256').update(content).digest('hex'));
    expect(entry.detail).toContain('mode 0644');
    expect(entry.detail).not.toContain(content);
  });

  it('a push that landed still answers 200 if auditing fails', async () => {
    vi.mocked(recordAudit).mockRejectedValueOnce(new Error('db locked'));
    const r = await push({ path: '/opt/app/.env' });
    expect(r.status).toBe(200);
    expect(vi.mocked(recordAudit).mock.calls.map((c) => c[0].action)).toEqual(['vm.file_push']);
  });

  it('audits a failed push too', async () => {
    vi.mocked(pushGuestFile).mockRejectedValueOnce(new GuestFileError('User "x" does not exist in the guest'));
    const r = await push({ path: '/opt/app/.env', owner: 'x' });
    expect(r.status).toBe(400);
    expect(vi.mocked(recordAudit).mock.calls[0]![0].action).toBe('vm.file_push_failed');
  });
});

describe('POST /vms/:id/files — rate limit', () => {
  it('limits pushes per user', async () => {
    vmRow.userId = 'busy';
    as('busy');
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await push({ path: '/tmp/x' })).status);
    expect(codes.slice(0, 6).every((c) => c === 200)).toBe(true);
    expect(codes[6]).toBe(429);
    vmRow.userId = 'owner';
  });
});

describe('GET /ide/:id/install-log — owner or admin', () => {
  const get = () => fetch(`${base}/ide/vm1/install-log`);

  it('the owner reads it', async () => {
    as('owner');
    const r = await get();
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ log: 'done', missing: false });
  });

  it('an admin reads it', async () => {
    as('someadmin', 'admin');
    expect((await get()).status).toBe(200);
  });

  it('a manager share is refused with the owner-only reason', async () => {
    as('manager');
    const r = await get();
    expect(r.status).toBe(403);
    expect(readIdeInstallLog).not.toHaveBeenCalled();
  });

  it.each(['viewer', 'operator', 'stranger'])('%s gets 404', async (who) => {
    as(who);
    expect((await get()).status).toBe(404);
    expect(readIdeInstallLog).not.toHaveBeenCalled();
  });

  it('passes a guest-side error through with its status', async () => {
    as('owner');
    vi.mocked(readIdeInstallLog).mockRejectedValueOnce(new GuestFileError('agent not responding', 409));
    expect((await get()).status).toBe(409);
  });
});
