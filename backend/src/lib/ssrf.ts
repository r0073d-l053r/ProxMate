import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * SSRF guard for TENANT-supplied URLs (bring-your-own LLM keys). Admin-configured
 * upstreams are intentionally NOT run through this — an admin legitimately points
 * shared models at a LAN Ollama (e.g. 192.168.x). But a tenant's own key must only
 * reach the public internet, or a hostile tenant could turn the gateway's server-
 * side fetch into a probe of the ProxMate host's internal network / cloud metadata.
 *
 * Residual risk: DNS rebinding (host resolves public at save/validate time, private
 * at fetch time). We re-check at forward time to shrink the window, but a fully
 * airtight fix would pin the resolved IP for the connection. Documented in SECURITY.md.
 */

/** True if an IP is loopback, private, link-local, CGNAT/tailnet, multicast, or reserved. */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map((n) => Number(n));
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
    const a = p[0]!;
    const b = p[1]!;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10 (tailnets)
    if (a >= 224) return true; // multicast + reserved (224.0.0.0+)
    return false;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s.startsWith('::ffff:')) return isBlockedIp(s.slice('::ffff:'.length)); // v4-mapped
    if (s === '::1' || s === '::') return true; // loopback / unspecified
    if (s.startsWith('fe80')) return true; // link-local
    if (s.startsWith('fc') || s.startsWith('fd')) return true; // unique-local fc00::/7
    if (s.startsWith('ff')) return true; // multicast
    return false;
  }
  return true; // not a parseable IP → block
}

/**
 * Loopback / link-local / metadata / unspecified — never a legitimate tenant guest
 * LAN IP. Sync (no DNS). Narrower than {@link isBlockedIp}: it deliberately ALLOWS
 * RFC1918 private ranges, because tenant guests legitimately live on a private LAN —
 * it only stops a spoofed guest-reported IP from pointing the IDE proxy at the host
 * itself (127.0.0.1) or cloud metadata (169.254.169.254).
 */
export function isLoopbackOrLinkLocal(ip: string): boolean {
  const s = ip.trim().toLowerCase();
  if (s.startsWith('127.') || s === '::1') return true;
  if (s.startsWith('169.254.')) return true;
  if (s.startsWith('0.')) return true;
  if (s === '::' || s.startsWith('fe80')) return true;
  return false;
}

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * Throw {@link SsrfBlockedError} unless `raw` is an http(s) URL whose host resolves
 * ONLY to public addresses. Use for any URL a tenant controls before the server
 * fetches it.
 */
export async function assertPublicHttpUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfBlockedError('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SsrfBlockedError('Only http(s) URLs are allowed');
  }
  const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  let ips: string[];
  if (isIP(host)) {
    ips = [host];
  } else {
    try {
      ips = (await lookup(host, { all: true })).map((r) => r.address);
    } catch {
      throw new SsrfBlockedError(`Could not resolve host "${host}"`);
    }
  }
  if (ips.length === 0) throw new SsrfBlockedError(`Could not resolve host "${host}"`);
  for (const ip of ips) {
    if (isBlockedIp(ip)) {
      throw new SsrfBlockedError(
        'That URL points at a private, loopback, or link-local address, which is not allowed for a bring-your-own key.',
      );
    }
  }
}
