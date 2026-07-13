import { describe, it, expect, beforeEach, vi } from 'vitest';

// The relocate flow orchestrates proxmox + vm.service calls — mock both modules
// and drive the pure decision logic (error codes, target intersection).
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { virtualMachine: { update: vi.fn().mockResolvedValue({}) } },
}));
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/services/proxmox.service.js', () => ({
  getClient: vi.fn().mockResolvedValue({}),
  guestAgentPing: vi.fn(),
  guestFileWrite: vi.fn(),
  guestExec: vi.fn(),
  guestExecOutput: vi.fn(),
  ensureIdePinhole: vi.fn(),
  ensureHostCpu: vi.fn(),
  getNodeAvxMap: vi.fn(),
  migratableTargets: vi.fn(),
  getNodesHealth: vi.fn(),
  pickBestNode: vi.fn(),
  shutdownVm: vi.fn(),
  waitForTask: vi.fn(),
}));
vi.mock('../src/services/vm.service.js', () => ({
  migrateVmToNode: vi.fn(),
  startVm: vi.fn(),
  getVmWithLiveStatus: vi.fn(),
}));
vi.mock('../src/services/ide-gateway.service.js', () => ({
  issueGatewayToken: vi.fn(),
  listModelPickerEntries: vi.fn().mockResolvedValue([]),
}));
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn() }));
vi.mock('../src/services/ide-assets.generated.js', () => ({
  IDE_SETTINGS_JSON: '{}',
  IDE_AUTOSTART_PACKAGE_JSON: '{}',
  IDE_AUTOSTART_EXTENSION_JS: '',
}));

import type { VirtualMachine } from '@prisma/client';
import {
  guestAgentPing,
  guestExecOutput,
  guestFileWrite,
  ensureHostCpu,
  getNodeAvxMap,
  migratableTargets,
  getNodesHealth,
  pickBestNode,
} from '../src/services/proxmox.service.js';
import { getConfig } from '../src/services/config.service.js';
import { issueGatewayToken, listModelPickerEntries } from '../src/services/ide-gateway.service.js';
import {
  startIdeProvision,
  planIdeRelocate,
  IdeProvisionError,
  IDE_CODE_SERVER_VERSION,
  IDE_OPENCODE_VERSION,
} from '../src/services/ide-provision.service.js';

const ping = vi.mocked(guestAgentPing);
const execOut = vi.mocked(guestExecOutput);
const hostCpu = vi.mocked(ensureHostCpu);
const avxMap = vi.mocked(getNodeAvxMap);
const targets = vi.mocked(migratableTargets);
const health = vi.mocked(getNodesHealth);
const pick = vi.mocked(pickBestNode);
const config = vi.mocked(getConfig);

let vmSeq = 0;
function vm(overrides: Partial<VirtualMachine> = {}): VirtualMachine {
  return {
    id: `vm-${++vmSeq}`,
    type: 'qemu',
    status: 'running',
    cpu: 2,
    ram: 8192,
    storage: 40,
    proxmoxNode: 'n-old',
    proxmoxVmId: 100 + vmSeq,
    ideState: null,
    deployState: null,
    hasPassthrough: false,
    ...overrides,
  } as VirtualMachine;
}

beforeEach(() => {
  vi.clearAllMocks();
  config.mockResolvedValue(null as never);
  ping.mockResolvedValue(true as never);
  hostCpu.mockResolvedValue(false as never); // cpu already 'host'
});

async function provisionErr(v: VirtualMachine): Promise<IdeProvisionError> {
  try {
    await startIdeProvision(v, { id: 'u1', role: 'user' }, 'https://x/api');
    throw new Error('expected startIdeProvision to throw');
  } catch (e) {
    expect(e).toBeInstanceOf(IdeProvisionError);
    return e as IdeProvisionError;
  }
}

describe('startIdeProvision — AVX guardrail codes', () => {
  it("codes 'node_no_avx' when the guest lacks AVX and the node's silicon confirmed lacks it", async () => {
    execOut.mockResolvedValue({ exitcode: 0, stdout: 'no', stderr: '' } as never);
    avxMap.mockResolvedValue(new Map([['n-old', false]]) as never);
    const err = await provisionErr(vm());
    expect(err.code).toBe('node_no_avx');
    expect(err.message).toMatch(/moved to a capable node/i);
  });

  it("codes 'reboot_required' when the node HAS AVX (the cpu-model change just needs a reboot)", async () => {
    execOut.mockResolvedValue({ exitcode: 0, stdout: 'no', stderr: '' } as never);
    avxMap.mockResolvedValue(new Map([['n-old', true]]) as never);
    const err = await provisionErr(vm());
    expect(err.code).toBe('reboot_required');
  });

  it("fails toward the cheap fix: unknown node capability → 'reboot_required', not a move", async () => {
    execOut.mockResolvedValue({ exitcode: 0, stdout: 'no', stderr: '' } as never);
    avxMap.mockResolvedValue(new Map([['n-old', 'unknown']]) as never);
    const err = await provisionErr(vm());
    expect(err.code).toBe('reboot_required');
  });
});

describe('startIdeProvision — the bootstrap installs PINNED tool versions', () => {
  it('ships a bootstrap that pins code-server and OpenCode (never "latest")', async () => {
    execOut.mockResolvedValue({ exitcode: 0, stdout: 'yes', stderr: '' } as never); // AVX ok
    vi.mocked(issueGatewayToken).mockResolvedValue({
      token: 'tok_abc123',
      baseUrl: 'https://x/api/ide/vm-1/llm/v1',
    } as never);
    vi.mocked(listModelPickerEntries).mockResolvedValue([] as never);

    const state = await startIdeProvision(vm(), { id: 'u1', role: 'user' }, 'https://x/api');
    expect(state).toBe('installing');

    // The script is shipped base64 via the guest agent — decode what really lands.
    const write = vi.mocked(guestFileWrite).mock.calls[0];
    expect(write?.[2]).toBe('/tmp/pmide-bootstrap.b64');
    const script = Buffer.from(String(write?.[3]), 'base64').toString('utf8');

    expect(script).toContain(`install.sh | sh -s -- --version ${IDE_CODE_SERVER_VERSION}`);
    expect(script).toContain(`--version ${IDE_OPENCODE_VERSION}`);
    // No unpinned fallbacks left behind.
    expect(script).not.toMatch(/install\.sh \| sh\s*$/m);
    expect(script).not.toMatch(/opencode\.ai\/install \| bash\s*'?\s*$/m);
    // Sanity: the pins are real versions, not empty env fallbacks.
    expect(IDE_CODE_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(IDE_OPENCODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('planIdeRelocate — target selection', () => {
  it('refuses when the current node is not confirmed AVX-less (no pointless move)', async () => {
    avxMap.mockResolvedValue(new Map([['n-old', true]]) as never);
    await expect(planIdeRelocate(vm())).rejects.toThrow(/no move is needed/i);
    avxMap.mockResolvedValue(new Map([['n-old', 'unknown']]) as never);
    await expect(planIdeRelocate(vm())).rejects.toThrow(/no move is needed/i);
  });

  it('refuses containers, passthrough-pinned guests, and locked VMs', async () => {
    await expect(planIdeRelocate(vm({ type: 'lxc' }))).rejects.toThrow(/containers/i);
    await expect(planIdeRelocate(vm({ hasPassthrough: true }))).rejects.toThrow(/pinned/i);
    await expect(planIdeRelocate(vm({ ideState: 'installing' }))).rejects.toThrow(/busy/i);
    await expect(planIdeRelocate(vm({ deployState: 'deploying' }))).rejects.toThrow(/busy/i);
  });

  it('targets = Proxmox-allowed ∩ online ∩ CONFIRMED AVX (unknown is not good enough to move to)', async () => {
    avxMap.mockResolvedValue(
      new Map<string, boolean | 'unknown'>([
        ['n-old', false],
        ['n-a', true],
        ['n-b', true],
        ['n-c', 'unknown'],
      ]) as never,
    );
    targets.mockResolvedValue(['n-a', 'n-c'] as never); // Proxmox says only a + c can take the disks
    health.mockResolvedValue({
      nodes: [
        { name: 'n-old', online: true },
        { name: 'n-a', online: true },
        { name: 'n-b', online: true },
        { name: 'n-c', online: true },
      ],
    } as never);
    pick.mockResolvedValue('n-a' as never);

    const chosen = await planIdeRelocate(vm());
    expect(chosen).toBe('n-a');
    // n-b was excluded by the Proxmox preflight; n-c by unconfirmed AVX.
    expect(pick).toHaveBeenCalledWith(
      { cpu: 2, ramMb: 8192, storageGb: 0 },
      undefined,
      expect.anything(),
      ['n-a'],
      'amd64',
    );
  });

  it('fails open on an unreadable preflight: falls back to online nodes, still AVX-filtered', async () => {
    avxMap.mockResolvedValue(
      new Map<string, boolean | 'unknown'>([
        ['n-old', false],
        ['n-a', true],
        ['n-b', true],
      ]) as never,
    );
    targets.mockResolvedValue(null as never);
    health.mockResolvedValue({
      nodes: [
        { name: 'n-old', online: true },
        { name: 'n-a', online: true },
        { name: 'n-b', online: false },
      ],
    } as never);
    pick.mockResolvedValue('n-a' as never);

    await planIdeRelocate(vm());
    expect(pick).toHaveBeenCalledWith(expect.anything(), undefined, expect.anything(), ['n-a'], 'amd64');
  });

  it('409s (throws) when no reachable node is confirmed AVX-capable', async () => {
    avxMap.mockResolvedValue(
      new Map<string, boolean | 'unknown'>([
        ['n-old', false],
        ['n-a', 'unknown'],
      ]) as never,
    );
    targets.mockResolvedValue(['n-a'] as never);
    health.mockResolvedValue({ nodes: [{ name: 'n-a', online: true }] } as never);
    await expect(planIdeRelocate(vm())).rejects.toThrow(/No reachable node/i);
    expect(pick).not.toHaveBeenCalled();
  });
});
