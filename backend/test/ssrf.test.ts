import { describe, it, expect } from 'vitest';
import { isBlockedIp, isLoopbackOrLinkLocal, assertPublicHttpUrl, SsrfBlockedError } from '../src/lib/ssrf.js';

describe('isBlockedIp — private/loopback/link-local/reserved', () => {
  it('blocks the ranges a BYO key must never reach', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.50.40',
      '169.254.169.254', // cloud metadata
      '100.64.0.9', // CGNAT / tailnet
      '0.0.0.0',
      '224.0.0.1', // multicast
      '::1',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      '::ffff:127.0.0.1', // v4-mapped loopback
      'not-an-ip',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });
});

describe('isLoopbackOrLinkLocal — proxy target guard (private LAN allowed)', () => {
  it('blocks only loopback / link-local / metadata / unspecified', () => {
    for (const ip of ['127.0.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::abcd']) {
      expect(isLoopbackOrLinkLocal(ip), ip).toBe(true);
    }
  });
  it('ALLOWS private LAN (guests live there) and public', () => {
    for (const ip of ['192.168.50.40', '10.0.0.5', '172.16.9.9', '8.8.8.8']) {
      expect(isLoopbackOrLinkLocal(ip), ip).toBe(false);
    }
  });
});

describe('assertPublicHttpUrl', () => {
  const rejects = (url: string) => expect(assertPublicHttpUrl(url)).rejects.toBeInstanceOf(SsrfBlockedError);

  it('rejects loopback / private / link-local IP literals', async () => {
    await rejects('http://127.0.0.1:11434/v1');
    await rejects('http://169.254.169.254/latest/meta-data');
    await rejects('http://10.0.0.1/v1');
    await rejects('http://192.168.1.5:8080');
    await rejects('https://[::1]/v1');
  });

  it('rejects non-http(s) and malformed URLs', async () => {
    await rejects('ftp://example.com');
    await rejects('file:///etc/passwd');
    await rejects('not a url');
  });

  it('accepts a public IP literal', async () => {
    await expect(assertPublicHttpUrl('https://1.1.1.1/v1')).resolves.toBeUndefined();
  });
});
