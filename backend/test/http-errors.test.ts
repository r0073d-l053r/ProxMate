import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { notFound } from '../src/middleware/notFound.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { monitoringAuthorized } from '../src/lib/monitoring-auth.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  app.post('/api/echo', (req, res) => {
    res.json(req.body);
  });
  app.get('/api/upstream', () => {
    // Shaped like an axios error from a failed Proxmox call: has a status, no `expose`.
    throw Object.assign(new Error('Request failed with status code 401'), { status: 401 });
  });
  app.use(notFound);
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe('unknown paths', () => {
  it('answer a JSON 404 that does not echo the path', async () => {
    const res = await fetch(`${base}/api/does-not-exist-xyz`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'Not found' });
    expect(text).not.toContain('does-not-exist-xyz');
    expect(text).not.toContain('Cannot GET');
  });
});

describe('the error handler', () => {
  it('answers a malformed JSON body with 400, not 500', async () => {
    const res = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Bad request' });
  });

  it('answers an oversized body with 413', async () => {
    const res = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: 'a'.repeat(4096) }),
    });
    expect(res.status).toBe(413);
  });

  it('never passes an upstream status through to the browser', async () => {
    const res = await fetch(`${base}/api/upstream`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});

describe('monitoringAuthorized', () => {
  const saved = { token: process.env['METRICS_TOKEN'], env: process.env.NODE_ENV };
  afterEach(() => {
    if (saved.token === undefined) delete process.env['METRICS_TOKEN'];
    else process.env['METRICS_TOKEN'] = saved.token;
    process.env.NODE_ENV = saved.env;
  });

  it('is closed in production with no token set', () => {
    delete process.env['METRICS_TOKEN'];
    process.env.NODE_ENV = 'production';
    expect(monitoringAuthorized({ headers: {} })).toBe(false);
  });

  it('is open outside production with no token set', () => {
    delete process.env['METRICS_TOKEN'];
    process.env.NODE_ENV = 'development';
    expect(monitoringAuthorized({ headers: {} })).toBe(true);
  });

  it('needs the exact Bearer token once one is set', () => {
    process.env['METRICS_TOKEN'] = 'secret-token';
    process.env.NODE_ENV = 'development';
    expect(monitoringAuthorized({ headers: {} })).toBe(false);
    expect(monitoringAuthorized({ headers: { authorization: 'Bearer wrong' } })).toBe(false);
    expect(monitoringAuthorized({ headers: { authorization: 'Bearer secret-token' } })).toBe(true);
  });
});
