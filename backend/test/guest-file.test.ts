import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, lstatSync, rmSync, readdirSync,
  chmodSync, chownSync, symlinkSync,
} from 'node:fs';
import path from 'node:path';

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return {
    ...actual,
    getClient: vi.fn(async () => ({})),
    guestAgentPing: vi.fn(async () => true),
    guestFileWrite: vi.fn(async () => undefined),
    guestExecOutput: vi.fn(),
  };
});
vi.mock('../src/services/vm.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/vm.service.js')>();
  return { ...actual, requireOurGuest: vi.fn(async (vm: unknown) => vm) };
});

import * as pve from '../src/services/proxmox.service.js';
import { requireOurGuest } from '../src/services/vm.service.js';
import {
  validateGuestPath,
  parseFileMode,
  guestFilePushMaxBytes,
  base64Chunks,
  PUSH_CHUNK_CHARS,
  ASSEMBLE_SCRIPT,
  assembleArgv,
  WRITE_AS_OWNER_SCRIPT,
  MKTEMP_ARGV,
  IDE_LOG_ARGV,
  IDE_LOG_SIZE_ARGV,
  IDE_LOG_TAIL_BYTES,
  IDE_LOG_MAX_LINES,
  pushGuestFile,
  readIdeInstallLog,
  stripControlChars,
  shapeIdeLog,
  GuestFileError,
} from '../src/services/guest-file.service.js';

const vm = { id: 'vm1', userId: 'u1', name: 'web', type: 'qemu', proxmoxNode: 'pve1', proxmoxVmId: 101 } as never;
const exec = vi.mocked(pve.guestExecOutput);
const ok = (stdout = '') => ({ exitcode: 0, stdout, stderr: '' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pve.guestAgentPing).mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe('validateGuestPath', () => {
  const good = [
    '/etc/motd',
    '/home/ubuntu/.bashrc',
    '/opt/app/config.yaml',
    '/srv/a b/c.txt',
    '/root/x',
    '/tmp/weird;$(id)`name`.txt', // shell metacharacters are just bytes in a path
    '/home/ünïcødé/file',
    '/devices/notes', // only /dev itself is refused, not names starting with it
    '/system/file',
    '/process.txt',
    `/${'a'.repeat(230)}`,
  ];
  it.each(good)('accepts %s', (p) => {
    expect(validateGuestPath(p)).toEqual({ ok: true, path: p });
  });

  const bad: Array<[string, unknown]> = [
    ['empty', ''],
    ['not a string', 42],
    ['relative', 'etc/motd'],
    ['dot relative', './etc/motd'],
    ['root itself', '/'],
    ['trailing slash', '/etc/'],
    ['double slash', '/etc//motd'],
    ['dot segment', '/etc/./motd'],
    ['dotdot segment', '/etc/../root/.ssh/authorized_keys'],
    ['dotdot at end', '/etc/..'],
    ['NUL byte', '/etc/motd\0.txt'],
    ['newline', '/etc/mo\ntd'],
    ['carriage return', '/etc/motd\r'],
    ['tab', '/etc/mo\ttd'],
    ['DEL', '/etc/mo\x7ftd'],
    ['/proc', '/proc'],
    ['under /proc', '/proc/sys/kernel/hostname'],
    ['/sys', '/sys/kernel/x'],
    ['/dev', '/dev/sda'],
    ['/dev itself', '/dev'],
    ['segment too long', `/${'a'.repeat(231)}`],
    ['path too long', `/${'abcdefghi/'.repeat(110)}x`],
  ];
  it.each(bad)('rejects %s', (_label, p) => {
    const r = validateGuestPath(p);
    expect(r.ok).toBe(false);
  });
});

describe('parseFileMode', () => {
  it.each([
    [undefined, '0644'],
    ['', '0644'],
    ['644', '0644'],
    ['0600', '0600'],
    ['0755', '0755'],
    ['000', '0000'],
  ])('%s → %s', (input, want) => {
    expect(parseFileMode(input)).toBe(want);
  });

  it.each(['4755', '1777', '0o644', '888', '64', '06444', 'rwxr-xr-x', '0644; id', 7])('rejects %s', (input) => {
    expect(parseFileMode(input)).toBeNull();
  });
});

describe('push size cap', () => {
  it('defaults to 1 MiB', () => {
    expect(guestFilePushMaxBytes({})).toBe(1024 * 1024);
  });
  it('can be raised up to 8 MiB but no further', () => {
    expect(guestFilePushMaxBytes({ GUEST_FILE_PUSH_MAX_BYTES: String(4 * 1024 * 1024) })).toBe(4 * 1024 * 1024);
    expect(guestFilePushMaxBytes({ GUEST_FILE_PUSH_MAX_BYTES: String(64 * 1024 * 1024) })).toBe(8 * 1024 * 1024);
  });
  it('keeps the default for a non-numeric value', () => {
    expect(guestFilePushMaxBytes({ GUEST_FILE_PUSH_MAX_BYTES: 'lots' })).toBe(1024 * 1024);
  });
  it('refuses a file over the cap before touching the guest', async () => {
    const big = Buffer.alloc(1024 * 1024 + 1);
    await expect(pushGuestFile(vm, { path: '/tmp/big', content: big, mode: '0644' })).rejects.toMatchObject({
      status: 413,
    });
    expect(requireOurGuest).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
  it('accepts a file exactly at the cap', async () => {
    exec.mockResolvedValueOnce(ok('/tmp/pmpush.AbCd1234'));
    const content = Buffer.alloc(1024 * 1024, 7);
    exec.mockResolvedValueOnce(ok(createHash('sha256').update(content).digest('hex')));
    const r = await pushGuestFile(vm, { path: '/tmp/big', content, mode: '0644' });
    expect(r.size).toBe(1024 * 1024);
    expect(r.verified).toBe(true);
  });
});

describe('base64Chunks', () => {
  it('splits into whole base64 units under the 60 KiB file-write cap', () => {
    const content = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251));
    const parts = base64Chunks(content);
    expect(parts.length).toBe(Math.ceil(content.toString('base64').length / PUSH_CHUNK_CHARS));
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(60 * 1024);
      expect(p.length % 4 === 0 || p === parts[parts.length - 1]).toBe(true);
    }
    // Each part decodes on its own, which is how the guest decodes them.
    expect(Buffer.concat(parts.map((p) => Buffer.from(p, 'base64')))).toEqual(content);
  });
  it('has no parts for an empty file', () => {
    expect(base64Chunks(Buffer.alloc(0))).toEqual([]);
  });
});

describe('argv construction', () => {
  const hostile = "/srv/x'; rm -rf / #$(reboot)`id`|&>.txt";

  it('passes every value only as a positional after the fixed scripts', () => {
    const argv = assembleArgv('/tmp/pmpush.AbCd1234', hostile, '0644', 'ubuntu', 3, true);
    expect(argv).toEqual([
      '/bin/sh', '-c', ASSEMBLE_SCRIPT, 'sh', WRITE_AS_OWNER_SCRIPT,
      '/tmp/pmpush.AbCd1234', hostile, '0644', 'ubuntu', '3', '1',
    ]);
    expect(ASSEMBLE_SCRIPT).not.toContain(hostile);
    expect(WRITE_AS_OWNER_SCRIPT).not.toContain(hostile);
  });

  it('reads the IDE log with fixed argvs', () => {
    expect(IDE_LOG_SIZE_ARGV).toEqual(['stat', '-c', '%s', '/var/log/pmide-provision.log']);
    expect(IDE_LOG_ARGV).toEqual(['tail', '-c', String(IDE_LOG_TAIL_BYTES), '/var/log/pmide-provision.log']);
  });

  it('every guest command a push runs is one of the fixed shapes', async () => {
    exec.mockImplementation(async (_n, _v, argv) =>
      argv[0] === 'mktemp' ? ok('/tmp/pmpush.AbCd1234') : ok(''),
    );
    await pushGuestFile(vm, {
      path: hostile,
      content: Buffer.from('hello'),
      mode: '0600',
      owner: 'ubuntu',
      createParents: true,
    });
    const argvs = exec.mock.calls.map((c) => c[2]);
    expect(argvs).toEqual([
      [...MKTEMP_ARGV],
      ['/bin/sh', '-c', ASSEMBLE_SCRIPT, 'sh', WRITE_AS_OWNER_SCRIPT, '/tmp/pmpush.AbCd1234', hostile, '0600', 'ubuntu', '1', '1'],
    ]);
    // No argv runs a shell over request text: the only shell gets the constant script.
    for (const a of argvs) if (a[0] === '/bin/sh') expect(a[2]).toBe(ASSEMBLE_SCRIPT);
  });
});

describe('pushGuestFile', () => {
  const content = Buffer.from('a'.repeat(100_000));
  const sha = createHash('sha256').update(content).digest('hex');

  it('stages parts in the private directory and verifies the checksum', async () => {
    exec.mockResolvedValueOnce(ok('/tmp/pmpush.AbCd1234')).mockResolvedValueOnce(ok(sha));
    const r = await pushGuestFile(vm, { path: '/opt/app/data.bin', content, mode: '0644' });
    expect(r).toEqual({ path: '/opt/app/data.bin', size: content.length, sha256: sha, verified: true });
    const writes = vi.mocked(pve.guestFileWrite).mock.calls;
    expect(writes.map((c) => c[2])).toEqual(['/tmp/pmpush.AbCd1234/p.00000', '/tmp/pmpush.AbCd1234/p.00001', '/tmp/pmpush.AbCd1234/p.00002']);
    expect(writes.map((c) => c[3]).join('')).toBe(content.toString('base64'));
    expect(requireOurGuest).toHaveBeenCalledTimes(1);
    // The part count and create-parents flag ride along as positionals.
    expect(exec.mock.calls[1]![2].slice(-2)).toEqual(['3', '0']);
  });

  it('refuses containers', async () => {
    await expect(
      pushGuestFile({ ...(vm as object), type: 'lxc' } as never, { path: '/etc/x', content, mode: '0644' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('re-validates the path, mode and owner', async () => {
    await expect(pushGuestFile(vm, { path: '/etc/../x', content, mode: '0644' })).rejects.toBeInstanceOf(GuestFileError);
    await expect(pushGuestFile(vm, { path: '/etc/x', content, mode: '4755' })).rejects.toBeInstanceOf(GuestFileError);
    await expect(pushGuestFile(vm, { path: '/etc/x', content, mode: '0644', owner: '-rf' })).rejects.toBeInstanceOf(GuestFileError);
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses when the agent does not answer', async () => {
    vi.mocked(pve.guestAgentPing).mockResolvedValue(false);
    await expect(pushGuestFile(vm, { path: '/etc/x', content, mode: '0644' })).rejects.toMatchObject({ status: 409 });
    expect(pve.guestFileWrite).not.toHaveBeenCalled();
  });

  it('refuses a staging directory that is not the expected shape', async () => {
    exec.mockResolvedValueOnce(ok('/etc'));
    await expect(pushGuestFile(vm, { path: '/etc/x', content, mode: '0644' })).rejects.toMatchObject({ status: 502 });
    expect(pve.guestFileWrite).not.toHaveBeenCalled();
  });

  it.each([
    [3, /does not exist/],
    [4, /is a directory/],
    [5, /Create parent folders/],
    [6, /failed inside the guest/],
    [7, /went missing/],
    [8, /Choose the owner/],
    [10, /setpriv, runuser or su/],
  ])('maps assemble exit %i to a clear error', async (code, msg) => {
    exec.mockResolvedValueOnce(ok('/tmp/pmpush.AbCd1234')).mockResolvedValueOnce({ exitcode: code, stdout: '', stderr: '' });
    await expect(pushGuestFile(vm, { path: '/etc/x', content, mode: '0644', owner: 'nobody2' })).rejects.toThrow(msg);
  });

  it('cleans and caps guest stderr in error messages', async () => {
    const noisy = `\x1b[31mmv: cannot move\x1b[0m\r\n‮${'x'.repeat(2000)}`;
    exec.mockResolvedValueOnce(ok('/tmp/pmpush.AbCd1234')).mockResolvedValueOnce({ exitcode: 6, stdout: '', stderr: noisy });
    const err = await pushGuestFile(vm, { path: '/etc/x', content, mode: '0644' }).catch((e: Error) => e);
    expect(err.message).toContain('mv: cannot move');
    expect([...err.message].some((ch) => ch.charCodeAt(0) < 0x20 || ch === '\u202e')).toBe(false);
    expect(err.message.length).toBeLessThan(450);
  });

  it('fails on a checksum mismatch', async () => {
    exec.mockResolvedValueOnce(ok('/tmp/pmpush.AbCd1234')).mockResolvedValueOnce(ok('0'.repeat(64)));
    await expect(pushGuestFile(vm, { path: '/etc/x', content, mode: '0644' })).rejects.toThrow(/checksum/);
  });

  it('cleans up the staging directory when a part fails to write', async () => {
    exec.mockResolvedValueOnce(ok('/tmp/pmpush.AbCd1234')).mockResolvedValue(ok(''));
    vi.mocked(pve.guestFileWrite).mockRejectedValueOnce(new Error('agent gone'));
    await expect(pushGuestFile(vm, { path: '/etc/x', content, mode: '0644' })).rejects.toThrow('agent gone');
    expect(exec.mock.calls.at(-1)![2]).toEqual(['rm', '-rf', '--', '/tmp/pmpush.AbCd1234']);
  });
});

// Run the real assemble script with a local POSIX shell, so the positional
// handling and the symlink rules are proven rather than assumed.
const canSh = process.platform === 'linux' && existsSync('/bin/sh') && existsSync('/tmp');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const hasNobody = spawnSync('getent', ['passwd', 'nobody']).status === 0;

describe.runIf(canSh)('ASSEMBLE_SCRIPT under sh', () => {
  let work: string;
  let staging: string;
  beforeEach(() => {
    work = mkdtempSync(path.join('/tmp', 'pmtest-'));
    chmodSync(work, 0o755);
    staging = mkdtempSync('/tmp/pmpush.');
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  });
  const stage = (content: Buffer) => {
    const parts = base64Chunks(content);
    parts.forEach((p, i) => writeFileSync(path.join(staging, `p.${String(i).padStart(5, '0')}`), p));
    return parts.length;
  };
  const run = (dest: string, opts: { mode?: string; owner?: string; parts?: number; mkdir?: boolean } = {}) =>
    spawnSync(
      '/bin/sh',
      [
        '-c', ASSEMBLE_SCRIPT, 'sh', WRITE_AS_OWNER_SCRIPT, staging, dest, opts.mode ?? '0640', opts.owner ?? '',
        String(opts.parts ?? 0), opts.mkdir ? '1' : '0',
      ],
      { encoding: 'utf8', cwd: work },
    );

  it.runIf(!isRoot)('as a non-root user, refuses to write without an owner (exit 8)', () => {
    expect(run(path.join(work, 'f')).status).toBe(8);
  });

  describe.runIf(isRoot)('as root', () => {
    it('writes the decoded file with the mode, prints its hash and treats metacharacters as text', () => {
      const content = Buffer.from(Array.from({ length: 150_000 }, (_, i) => (i * 7) % 256));
      const parts = stage(content);
      const dest = path.join(work, "we ird;$(touch pwned)'`touch pwned2`.bin");
      const r = run(dest, { parts });
      expect(r.status).toBe(0);
      expect(readFileSync(dest)).toEqual(content);
      expect(statSync(dest).mode & 0o777).toBe(0o640);
      expect(r.stdout.trim()).toBe(createHash('sha256').update(content).digest('hex'));
      expect(readdirSync(work).filter((f) => f.startsWith('pwned') || f.startsWith('.pmpush'))).toEqual([]);
      expect(existsSync(staging)).toBe(false);
    });

    it('writes an empty file from no parts', () => {
      const dest = path.join(work, 'empty');
      expect(run(dest).status).toBe(0);
      expect(readFileSync(dest).length).toBe(0);
    });

    it('exits 7 when parts are missing, so no short file lands', () => {
      stage(Buffer.from('hello'));
      expect(run(path.join(work, 'f'), { parts: 2 }).status).toBe(7);
      expect(existsSync(path.join(work, 'f'))).toBe(false);
    });

    it('exits 5 when the parent folder is missing and 4 for a directory', () => {
      expect(run(path.join(work, 'nope', 'file')).status).toBe(5);
      mkdirSync(path.join(work, 'adir'));
      expect(run(path.join(work, 'adir')).status).toBe(4);
    });

    it('creates parent folders when asked', () => {
      expect(run(path.join(work, 'a', 'b', 'file'), { mkdir: true }).status).toBe(0);
      expect(existsSync(path.join(work, 'a', 'b', 'file'))).toBe(true);
    });

    it('exits 3 for an owner that does not exist', () => {
      expect(run(path.join(work, 'f'), { mode: '0644', owner: 'no-such-user-pm' }).status).toBe(3);
    });

    it('replaces a symlink at the destination instead of writing through it', () => {
      const victim = path.join(work, 'victim');
      writeFileSync(victim, 'secret');
      chmodSync(victim, 0o600);
      symlinkSync(victim, path.join(work, 'dest'));
      // The old fixed temp names: a pre-planted link there must not be followed either.
      for (let pid = 1; pid < 64; pid++) symlinkSync(victim, path.join(work, `dest.pmpush.${pid}`));
      const parts = stage(Buffer.from('new content'));
      expect(run(path.join(work, 'dest'), { mode: '0644', parts }).status).toBe(0);
      expect(readFileSync(victim, 'utf8')).toBe('secret');
      expect(statSync(victim).mode & 0o777).toBe(0o600);
      expect(lstatSync(path.join(work, 'dest')).isSymbolicLink()).toBe(false);
      expect(readFileSync(path.join(work, 'dest'), 'utf8')).toBe('new content');
    });

    it('refuses to write as root into a folder reached through a symlink (exit 8)', () => {
      mkdirSync(path.join(work, 'real'));
      symlinkSync(path.join(work, 'real'), path.join(work, 'link'));
      expect(run(path.join(work, 'link', 'f')).status).toBe(8);
      expect(readdirSync(path.join(work, 'real'))).toEqual([]);
    });

    it('refuses to write as root into a folder other users can write to (exit 8)', () => {
      const shared = path.join(work, 'shared');
      mkdirSync(shared);
      chmodSync(shared, 0o777);
      expect(run(path.join(shared, 'f')).status).toBe(8);
    });

    it('chowns the file (not a link) in a root-only folder', () => {
      if (!hasNobody) return;
      const parts = stage(Buffer.from('x'));
      expect(run(path.join(work, 'owned'), { owner: 'nobody', parts }).status).toBe(0);
      expect(statSync(path.join(work, 'owned')).uid).toBe(65534);
    });

    describe.runIf(hasNobody)('in a folder the owner controls', () => {
      let home: string;
      beforeEach(() => {
        home = path.join(work, 'home');
        mkdirSync(home);
        chownSync(home, 65534, 65534);
      });

      it('writes as the owner', () => {
        const parts = stage(Buffer.from('dotfile'));
        const r = run(path.join(home, '.bashrc'), { owner: 'nobody', mode: '0644', parts });
        expect(r.status).toBe(0);
        const st = statSync(path.join(home, '.bashrc'));
        expect(st.uid).toBe(65534);
        expect(readFileSync(path.join(home, '.bashrc'), 'utf8')).toBe('dotfile');
        expect(r.stdout.trim()).toBe(createHash('sha256').update('dotfile').digest('hex'));
      });

      it('a planted symlink only reaches what the owner could write', () => {
        const victim = path.join(work, 'shadow');
        writeFileSync(victim, 'root only');
        chmodSync(victim, 0o600);
        symlinkSync(victim, path.join(home, '.bashrc'));
        for (let pid = 1; pid < 64; pid++) symlinkSync(victim, path.join(home, `.bashrc.pmpush.${pid}`));
        const parts = stage(Buffer.from('dotfile'));
        expect(run(path.join(home, '.bashrc'), { owner: 'nobody', parts }).status).toBe(0);
        expect(readFileSync(victim, 'utf8')).toBe('root only');
        expect(statSync(victim).uid).toBe(0);
        expect(lstatSync(path.join(home, '.bashrc')).isSymbolicLink()).toBe(false);
      });

      it('a parent folder swapped for a symlink to a root-only folder is not written', () => {
        const rootOnly = path.join(work, 'rootssh');
        mkdirSync(rootOnly);
        chmodSync(rootOnly, 0o700);
        symlinkSync(rootOnly, path.join(home, 'link'));
        const parts = stage(Buffer.from('ssh-ed25519 AAAA'));
        const r = run(path.join(home, 'link', 'authorized_keys'), { owner: 'nobody', parts });
        expect(r.status).not.toBe(0);
        expect(readdirSync(rootOnly)).toEqual([]);
      });

      // Guests differ in which tool switches users; hide the earlier ones from PATH.
      it.each([
        ['runuser', ['setpriv']],
        ['su', ['setpriv', 'runuser']],
      ])('falls back to %s', (_tool, hidden) => {
        const bin = mkdtempSync(path.join('/tmp', 'pmbin-'));
        chmodSync(bin, 0o755);
        try {
          const tools = ['sh', 'getent', 'id', 'find', 'mktemp', 'base64', 'chmod', 'chown', 'mv', 'rm', 'cat', 'cut',
            'sha256sum', 'mkdir', 'setpriv', 'runuser', 'su'];
          for (const t of tools) {
            if (hidden.includes(t)) continue;
            const where = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', t], { encoding: 'utf8' }).stdout.trim();
            if (where) symlinkSync(where, path.join(bin, t));
          }
          if (!existsSync(path.join(bin, _tool))) return;
          const parts = stage(Buffer.from('fallback'));
          const r = spawnSync(
            '/bin/sh',
            ['-c', ASSEMBLE_SCRIPT, 'sh', WRITE_AS_OWNER_SCRIPT, staging, path.join(home, 'f'), '0644', 'nobody', String(parts), '0'],
            { encoding: 'utf8', cwd: work, env: { PATH: bin } },
          );
          expect(r.stderr).toBe('');
          expect(r.status).toBe(0);
          expect(statSync(path.join(home, 'f')).uid).toBe(65534);
          expect(readFileSync(path.join(home, 'f'), 'utf8')).toBe('fallback');
        } finally {
          rmSync(bin, { recursive: true, force: true });
        }
      });

      it('creates parent folders as the owner', () => {
        const parts = stage(Buffer.from('x'));
        expect(run(path.join(home, 'a', 'b', 'f'), { owner: 'nobody', parts, mkdir: true }).status).toBe(0);
        expect(statSync(path.join(home, 'a')).uid).toBe(65534);
        expect(statSync(path.join(home, 'a', 'b', 'f')).uid).toBe(65534);
      });
    });
  });
});

describe('stripControlChars', () => {
  it.each([
    ['colour codes', '\x1b[1;32mok\x1b[0m done', 'ok done'],
    ['cursor moves', 'a\x1b[2Kb\x1b[1Ac', 'abc'],
    ['OSC title and hyperlink', '\x1b]0;title\x07x \x1b]8;;http://e\x1b\\link\x1b]8;;\x1b\\', 'x link'],
    ['two-char escapes', 'a\x1bMb\x1b(B', 'ab'],
    ['8-bit CSI', 'a\x9b31mb', 'ab'],
    ['progress bars keep their last state', '  0%\r 50%\r100%\nnext', '100%\nnext'],
    ['CRLF', 'one\r\ntwo\r\n', 'one\ntwo\n'],
    ['other control chars', 'a\x00b\x07c\x08d\x7fe\tf', 'abcde\tf'],
    ['bidi overrides and marks', 'safe\u202etxt\u200e\u200f\u061c.exe', 'safetxt.exe'],
    ['html stays as text', '<script>alert(1)</script>', '<script>alert(1)</script>'],
  ])('%s', (_label, input, want) => {
    expect(stripControlChars(input)).toBe(want);
  });
});

describe('shapeIdeLog', () => {
  it('keeps a short log whole', () => {
    expect(shapeIdeLog('[proxmate-ide] installing\n[proxmate-ide] done\n')).toEqual({
      log: '[proxmate-ide] installing\n[proxmate-ide] done',
      truncated: false,
    });
  });
  it('drops the partial first line of a full tail', () => {
    const raw = 'tial line\n' + 'x'.repeat(IDE_LOG_TAIL_BYTES - 16) + '\nlast\n';
    const r = shapeIdeLog(raw);
    expect(r.truncated).toBe(true);
    expect(r.log.startsWith('tial')).toBe(false);
    expect(r.log.endsWith('last')).toBe(true);
  });
  it(`keeps at most ${IDE_LOG_MAX_LINES} lines`, () => {
    const raw = Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n');
    const r = shapeIdeLog(raw);
    expect(r.truncated).toBe(true);
    const lines = r.log.split('\n');
    expect(lines.length).toBe(IDE_LOG_MAX_LINES);
    expect(lines.at(-1)).toBe('line 899');
  });
});

describe('readIdeInstallLog', () => {
  it('runs the fixed stat and tail commands and cleans the output', async () => {
    exec.mockResolvedValueOnce(ok('28')).mockResolvedValueOnce(ok('\x1b[31merror\x1b[0m: curl failed\n'));
    const r = await readIdeInstallLog(vm);
    expect(exec.mock.calls.map((c) => c[2])).toEqual([[...IDE_LOG_SIZE_ARGV], [...IDE_LOG_ARGV]]);
    expect(r).toEqual({ path: '/var/log/pmide-provision.log', log: 'error: curl failed', truncated: false, missing: false });
  });
  it('reports a missing log rather than failing', async () => {
    exec.mockResolvedValueOnce({ exitcode: 1, stdout: '', stderr: "stat: cannot statx '/var/log/pmide-provision.log': No such file or directory" });
    expect(await readIdeInstallLog(vm)).toMatchObject({ missing: true, log: '' });
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it('flags truncation from the file size on the guest', async () => {
    exec.mockResolvedValueOnce(ok('900000')).mockResolvedValueOnce(ok('partial\nwhole line\n'));
    expect(await readIdeInstallLog(vm)).toMatchObject({ truncated: true, log: 'whole line' });
  });
  it('checks guest identity before reading', async () => {
    vi.mocked(requireOurGuest).mockRejectedValueOnce(new Error('not ours'));
    await expect(readIdeInstallLog(vm)).rejects.toThrow('not ours');
    expect(exec).not.toHaveBeenCalled();
  });
  it('refuses containers', async () => {
    await expect(readIdeInstallLog({ ...(vm as object), type: 'lxc' } as never)).rejects.toMatchObject({ status: 409 });
  });
});
