import { describe, it, expect } from 'vitest';
import { resolveIdeTargetUrl } from '../src/services/ide-proxy.service.js';

// Pure per-VM target resolution — the routing precedence that decides WHICH
// guest a tenant's IDE session lands on. A regression here is the "every IDE
// opens the same VM" incident, so it's worth pinning down explicitly.
const vmA = { ipAddress: '192.168.50.222' };
const vmB = { ipAddress: '192.168.50.40' };
const vmNone = { ipAddress: null };

describe('resolveIdeTargetUrl', () => {
  it('the rig override wins over everything (test-only escape hatch)', () => {
    expect(resolveIdeTargetUrl(vmA, { IDE_TARGET_OVERRIDE: 'http://stand-in:18080' })).toBe(
      'http://stand-in:18080',
    );
  });

  it('targets the guest LAN IP on port 8080 by default', () => {
    expect(resolveIdeTargetUrl(vmA, {})).toBe('http://192.168.50.222:8080');
  });

  it('honours IDE_GUEST_PORT', () => {
    expect(resolveIdeTargetUrl(vmA, { IDE_GUEST_PORT: '9000' })).toBe('http://192.168.50.222:9000');
  });

  it('returns null when the guest has no known IP', () => {
    expect(resolveIdeTargetUrl(vmNone, {})).toBeNull();
  });

  it('two different VMs resolve to two different targets (no global clobber)', () => {
    expect(resolveIdeTargetUrl(vmA, {})).not.toBe(resolveIdeTargetUrl(vmB, {}));
  });
});
