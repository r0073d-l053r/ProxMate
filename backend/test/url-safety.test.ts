import { describe, it, expect, afterEach } from 'vitest';
import {
  isBlockedIp,
  isLoopbackOrLinkLocal,
  assertPublicHttpUrlShape,
  assertSafeOutboundUrl,
} from '../src/lib/url-safety.js';

describe('isBlockedIp', () => {
  it('blocks IPv4 loopback / private / link-local / CGNAT / multicast / reserved', () => {
    for (const ip of [
      '0.0.0.0', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '255.255.255.255',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows public IPv4 (incl. the boundaries just outside private ranges)', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '93.184.216.34']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it('blocks IPv6 loopback / ULA / link-local and IPv4-mapped private forms', () => {
    for (const ip of [
      '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1',
      '::ffff:169.254.169.254', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:10.0.0.1', // the ::ffff: regex-fix cases
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows a public IPv6', () => {
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
  });
});

describe('isLoopbackOrLinkLocal — IDE proxy target guard (private LAN allowed)', () => {
  it('blocks only loopback / link-local / metadata / unspecified', () => {
    for (const ip of ['127.0.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::abcd']) {
      expect(isLoopbackOrLinkLocal(ip), ip).toBe(true);
    }
  });
  it('ALLOWS private LAN (where tenant guests live) and public', () => {
    for (const ip of ['192.168.50.40', '10.0.0.5', '172.16.9.9', '8.8.8.8']) {
      expect(isLoopbackOrLinkLocal(ip), ip).toBe(false);
    }
  });
});

describe('assertPublicHttpUrlShape', () => {
  it('rejects non-http(s) schemes, embedded credentials, and private/local hosts', () => {
    expect(() => assertPublicHttpUrlShape('ftp://example.com')).toThrow();
    expect(() => assertPublicHttpUrlShape('http://user:pass@example.com')).toThrow(/credentials|plain http/i);
    expect(() => assertPublicHttpUrlShape('http://localhost')).toThrow(/private or local/i);
    expect(() => assertPublicHttpUrlShape('http://foo.local')).toThrow(/private or local/i);
    expect(() => assertPublicHttpUrlShape('http://169.254.169.254/latest/meta-data')).toThrow(/private or reserved/i);
    expect(() => assertPublicHttpUrlShape('http://192.168.1.10:9000')).toThrow(/private or reserved/i);
  });

  it('accepts a plain public https URL', () => {
    expect(() => assertPublicHttpUrlShape('https://hooks.slack.com/services/x')).not.toThrow();
  });
});

describe('ALLOW_PRIVATE_OUTBOUND_URLS opt-out (homelab escape hatch)', () => {
  const saved = process.env['ALLOW_PRIVATE_OUTBOUND_URLS'];
  afterEach(() => {
    if (saved === undefined) delete process.env['ALLOW_PRIVATE_OUTBOUND_URLS'];
    else process.env['ALLOW_PRIVATE_OUTBOUND_URLS'] = saved;
  });

  it('permits private destinations when enabled — but still enforces scheme + no-credentials', async () => {
    process.env['ALLOW_PRIVATE_OUTBOUND_URLS'] = 'true';
    expect(() => assertPublicHttpUrlShape('http://192.168.1.10:9000')).not.toThrow();
    await expect(assertSafeOutboundUrl('http://192.168.1.10:9000')).resolves.toBeUndefined();
    // The non-negotiable checks remain even with the opt-out on:
    expect(() => assertPublicHttpUrlShape('http://user:pass@192.168.1.10')).toThrow();
    expect(() => assertPublicHttpUrlShape('gopher://192.168.1.10')).toThrow();
  });
});
