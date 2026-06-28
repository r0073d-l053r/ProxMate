import { describe, it, expect } from 'vitest';
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
