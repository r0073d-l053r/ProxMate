import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { buildClient, pveMessage } from '../src/services/proxmox.service.js';

/**
 * The Proxmox API token must not survive into a logged error.
 *
 * An axios error carries the request that produced it, and that request carries the
 * `Authorization: PVEAPIToken=<user>!<id>=<secret>` header. The backend has eighteen
 * places doing `console.error('...', err)`, so any Proxmox failure printed working
 * cluster-root credentials into the log — where log shipping, a support bundle or a
 * screenshot carries them straight out. Found in the wild during a local dev run: one
 * failed scheduled backup put the live token in plain text in the container log.
 *
 * These assert the SERIALISED error, because that is what actually reaches a log — not
 * a field-by-field check that could pass while some other property still held the
 * secret. Against a real HTTP server rather than a mocking library: the leak lives in
 * objects Node populates during a real request (`err.request._header` in particular),
 * which a faked transport would not produce.
 */

const TOKEN_ID = 'root@pam!proxmate';
const SECRET = 'deadbeef-0000-1111-2222-cafebabe9999';

let base: string;
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.endsWith('/version')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { version: '9.2.3' } }));
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Authentication failed!' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

/**
 * Every string anywhere in the error's object graph that contains `needle`, reported
 * as a path.
 *
 * A fixed list of fields is not good enough here, and this project has the scar to
 * prove it: the first version of this fix redacted `config.headers.Authorization` and
 * `request._header`, both tests passed, and the secret was STILL reachable through
 * `config.httpsAgent.sockets[key][0]._pendingData` — a live socket the agent happened
 * to be holding. Anything that walks only the fields you thought of will keep passing
 * while the next Node version adds a new place to hide.
 */
function pathsHolding(root: unknown, needle: string): string[] {
  const hits: string[] = [];
  const seen = new WeakSet<object>();
  const walk = (o: unknown, path: string, depth: number): void => {
    if (depth > 8 || o == null) return;
    if (typeof o === 'string') {
      if (o.includes(needle)) hits.push(path);
      return;
    }
    if (typeof o !== 'object') return;
    if (seen.has(o as object)) return;
    seen.add(o as object);
    for (const k of Object.keys(o as object)) {
      try {
        walk((o as Record<string, unknown>)[k], `${path}.${k}`, depth + 1);
      } catch {
        /* getters that throw are not a leak */
      }
    }
  };
  walk(root, 'err', 0);
  return [...new Set(hits)];
}

async function failedRequest(): Promise<unknown> {
  const client = buildClient(base, TOKEN_ID, SECRET, false);
  try {
    await client.get('/nodes');
    throw new Error('request should have failed');
  } catch (err) {
    return err;
  }
}

describe('a failed Proxmox request', () => {
  it('holds the token at NO path in the entire error graph', async () => {
    // The assertion that matters. Reports the offending paths on failure so the next
    // hiding place is named rather than guessed at.
    const paths = pathsHolding(await failedRequest(), SECRET);
    expect(paths, `secret reachable at: ${paths.join(', ')}`).toEqual([]);
  });

  it('holds the token nowhere in what console.error would actually print', async () => {
    expect(inspect(await failedRequest(), { depth: 8 })).not.toContain(SECRET);
  });

  it('redacts the Authorization header rather than deleting it, so the shape is unsurprising', async () => {
    const err = await failedRequest();
    const headers = (err as { config?: { headers?: Record<string, unknown> } }).config?.headers ?? {};
    expect(String(headers['Authorization'])).toBe('PVEAPIToken=[redacted]');
  });

  it('scrubs the raw request line too, not just the parsed header', async () => {
    // Node keeps a verbatim copy of the outgoing request in err.request._header.
    // Redacting only config.headers would leave the secret in the copy nobody checks.
    const raw = (await failedRequest() as { request?: { _header?: string } }).request?._header ?? '';
    expect(raw).not.toBe('');
    expect(raw).not.toContain(SECRET);
    expect(raw).toMatch(/Authorization: PVEAPIToken=\[redacted\]/i);
  });

  it('still yields a useful message — redaction must not cost diagnosability', async () => {
    const msg = pveMessage(await failedRequest());
    expect(msg).toBeTruthy();
    expect(msg).not.toContain(SECRET);
  });
});

describe('a successful request', () => {
  it('is untouched', async () => {
    const client = buildClient(base, TOKEN_ID, SECRET, false);
    const res = await client.get<{ data: { version: string } }>('/version');
    expect(res.data.data.version).toBe('9.2.3');
  });
});
