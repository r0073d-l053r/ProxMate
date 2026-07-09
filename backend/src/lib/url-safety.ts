import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * Outbound URL safety for admin-configured destinations (notification webhooks,
 * cloud-image downloads, etc.). Blocks the classic SSRF targets: loopback,
 * link-local / cloud metadata, RFC1918, CGNAT, and non-http(s) schemes.
 *
 * Notes:
 * - This is host/IP-based. DNS rebinding after a first-pass check is still
 *   theoretically possible for long-lived connections; for short POSTs it's
 *   good enough and far better than scheme-only validation.
 * - Intentionally NOT used for the Proxmox API host (which is often private by
 *   design on a management network).
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
]);

/** True if an IPv4/IPv6 address is not safe as an outbound destination. */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split('.').map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local + metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    // IPv4-mapped IPv6 (:ffff:a.b.c.d)
    // IPv4-mapped forms: `::ffff:1.2.3.4` and the long `0:0:0:0:0:ffff:1.2.3.4`
    // (no leading `^` — the `::ffff:` form has a double colon).
    const mapped = lower.match(/:ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isBlockedIp(mapped[1]!);
    // fc00::/7 unique local, fe80::/10 link-local
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return true;
    }
    return false;
  }
  return true; // not a parseable IP → treat as blocked when used as a raw host
}

/**
 * Escape hatch for homelab / self-hosted deployments: a Mattermost, ntfy, or
 * image mirror on the LAN is a legitimate target there. Off by default (SSRF-safe);
 * set `ALLOW_PRIVATE_OUTBOUND_URLS=true` to permit private/loopback destinations.
 * The scheme + no-credentials checks are ALWAYS enforced regardless.
 */
function allowPrivateOutbound(): boolean {
  return process.env['ALLOW_PRIVATE_OUTBOUND_URLS'] === 'true';
}

function hostnameOf(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // Reject credentials in the URL (user:pass@host) — surprise SSRF vector.
    if (u.username || u.password) return null;
    return u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

/**
 * Synchronous host-shape check (no DNS). Use before persisting a URL so a bad
 * value never lands in config. Does NOT catch DNS that later resolves private.
 */
export function assertPublicHttpUrlShape(rawUrl: string, label = 'URL'): void {
  const host = hostnameOf(rawUrl);
  // Scheme + no-credentials are non-negotiable even for homelab deployments.
  if (!host) throw new Error(`${label} must be a plain http(s) URL with no credentials.`);
  if (allowPrivateOutbound()) return; // operator opted into private destinations
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error(`${label} must not target a private or local host.`);
  }
  // Bare IP hosts are checked immediately; names are resolved at request time.
  if (isIP(host) && isBlockedIp(host)) {
    throw new Error(`${label} must not target a private or reserved IP address.`);
  }
}

/**
 * Full SSRF guard: shape check + DNS resolution of every A/AAAA. Throws if any
 * resolved address is private/reserved. Call immediately before `fetch`/`axios`.
 */
export async function assertSafeOutboundUrl(rawUrl: string, label = 'URL'): Promise<void> {
  assertPublicHttpUrlShape(rawUrl, label);
  if (allowPrivateOutbound()) return; // operator opted into private destinations
  const host = hostnameOf(rawUrl)!;
  if (isIP(host)) return; // already validated by the shape check

  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`${label} host could not be resolved.`);
  }
  if (records.length === 0) throw new Error(`${label} host could not be resolved.`);
  for (const r of records) {
    if (isBlockedIp(r.address)) {
      throw new Error(`${label} resolves to a private or reserved address and is not allowed.`);
    }
  }
}
