import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNewer, isValidTag, currentVersion } from '../src/services/update.service.js';

describe('isNewer (semver compare)', () => {
  it('detects a newer minor/major/patch', () => {
    expect(isNewer('0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
    expect(isNewer('0.1.1', '0.1.0')).toBe(true);
  });

  it('is false for equal or older', () => {
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.1.0', '0.2.0')).toBe(false);
    expect(isNewer('1.0.0', '1.0.1')).toBe(false);
  });

  it('tolerates a leading v and prerelease suffixes', () => {
    expect(isNewer('v0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('0.2.0-rc1', '0.1.0')).toBe(true);
    expect(isNewer('0.1.0-rc1', '0.1.0')).toBe(false); // prerelease dropped → equal
  });
});

describe('isValidTag', () => {
  it('accepts release tags', () => {
    expect(isValidTag('v1.2.3')).toBe(true);
    expect(isValidTag('1.2.3')).toBe(true);
    expect(isValidTag('v2.0.0-rc.1')).toBe(true);
  });

  it('rejects anything that could escape a git checkout / path', () => {
    expect(isValidTag('v1; rm -rf /')).toBe(false);
    expect(isValidTag('../../etc/passwd')).toBe(false);
    expect(isValidTag('$(whoami)')).toBe(false);
    expect(isValidTag('')).toBe(false);
  });
});

describe('currentVersion', () => {
  it('reads a semver-ish version from package.json', () => {
    expect(currentVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('requestUpdate (self-heals an unwritable status file)', () => {
  // root ignores the read-only owner bit, so this scenario can't be simulated
  // as root — skip there (CI runs unprivileged, where it's meaningful).
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  afterEach(() => {
    delete process.env['UPDATE_CONTROL_DIR'];
  });

  it.skipIf(isRoot)('overwrites a stale read-only status file and queues the request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proxmate-control-'));
    // Mimic the status file the root host-updater leaves behind: present, but
    // unwritable by us — while we still own the directory it lives in.
    const statusPath = join(dir, 'update-status.json');
    writeFileSync(statusPath, '{"state":"success","tag":"v0.0.1"}');
    chmodSync(statusPath, 0o444);

    // CONTROL_DIR is resolved at module load, so import a fresh copy pointed at
    // our temp dir.
    vi.resetModules();
    process.env['UPDATE_CONTROL_DIR'] = dir;
    const { requestUpdate } = await import('../src/services/update.service.js');

    await expect(requestUpdate('v0.2.4', 'tester')).resolves.toBeUndefined();

    expect(existsSync(join(dir, 'update-request.json'))).toBe(true);
    const status = JSON.parse(readFileSync(statusPath, 'utf8'));
    expect(status.state).toBe('queued');
    expect(status.tag).toBe('v0.2.4');
    const request = JSON.parse(readFileSync(join(dir, 'update-request.json'), 'utf8'));
    expect(request.tag).toBe('v0.2.4');
    expect(request.requestedBy).toBe('tester');
  });
});
