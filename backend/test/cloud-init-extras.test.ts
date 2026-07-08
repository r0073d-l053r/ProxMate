import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import yaml from 'js-yaml';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CLOUD_INIT_FEATURES,
  CLOUD_INIT_CATALOG,
  RECOMMENDED_BASE_IDS,
  cloudInitSnippetFile,
  cloudInitSnippetContent,
  ensureCloudInitSnippet,
  snippetWriteConfig,
} from '../src/services/proxmox.service.js';

/** Parse a generated snippet as YAML and return the cloud-config object. */
function parse(ids: string[]): { package_update?: boolean; packages?: string[]; runcmd?: unknown[] } {
  const body = cloudInitSnippetContent(ids);
  expect(body.startsWith('#cloud-config')).toBe(true);
  return yaml.load(body) as never;
}

describe('CLOUD_INIT_FEATURES — superfile', () => {
  it('is registered as a headless terminal file manager', () => {
    const sf = CLOUD_INIT_FEATURES.find((f) => f.id === 'superfile');
    expect(sf).toBeDefined();
    expect(sf!.label).toMatch(/superfile/i);
    expect(sf!.hint).toMatch(/terminal file manager/i);
  });

  it('does NOT still carry the removed warp option', () => {
    expect(CLOUD_INIT_FEATURES.some((f) => f.id === 'warp')).toBe(false);
  });
});

describe('cloudInitSnippetFile — superfile combos are sorted + namespaced', () => {
  it('names the single-feature file', () => {
    expect(cloudInitSnippetFile(['superfile'])).toBe('proxmate-superfile.yaml');
  });
  it('sorts a combo alphabetically (order-independent filename)', () => {
    expect(cloudInitSnippetFile(['superfile', 'docker'])).toBe('proxmate-docker-superfile.yaml');
    expect(cloudInitSnippetFile(['docker', 'superfile'])).toBe('proxmate-docker-superfile.yaml');
  });
});

describe('cloudInitSnippetContent — superfile', () => {
  it('produces valid cloud-config YAML that installs the spf binary from a GitHub release', () => {
    const cfg = parse(['superfile']);
    expect(cfg.package_update).toBe(true);
    expect(cfg.packages).toEqual(expect.arrayContaining(['curl', 'ca-certificates', 'tar']));

    // runcmd entries are [ sh, -c, "<command>" ] triples; flatten the commands.
    const cmds = (cfg.runcmd as string[][]).map((c) => c[2]);
    expect(cmds.some((c) => /github\.com\/yorukot\/superfile\/releases\/download/.test(c))).toBe(true);
    expect(cmds.some((c) => /dpkg --print-architecture/.test(c))).toBe(true); // arch-aware
    expect(cmds.some((c) => /install -m 0755 .* \/usr\/local\/bin\/spf/.test(c))).toBe(true);

    // every runcmd is the [ sh, -c, cmd ] shape
    for (const entry of cfg.runcmd as unknown[]) {
      expect(entry).toEqual(['sh', '-c', expect.any(String)]);
    }
  });

  it('combines with another feature: dedupes shared packages, concatenates runcmd', () => {
    const cfg = parse(['docker', 'superfile']);
    // curl is required by both docker and superfile — must appear exactly once.
    expect(cfg.packages!.filter((p) => p === 'curl')).toHaveLength(1);
    const cmds = (cfg.runcmd as string[][]).map((c) => c[2]);
    expect(cmds.some((c) => /get\.docker\.com/.test(c))).toBe(true); // docker's step
    expect(cmds.some((c) => /superfile/.test(c))).toBe(true); // superfile's step
  });
});

describe('new optional features', () => {
  it('registers cockpit, netdata, caddy, code-server as checkboxes', () => {
    for (const id of ['cockpit', 'netdata', 'caddy', 'code-server']) {
      expect(CLOUD_INIT_FEATURES.some((f) => f.id === id)).toBe(true);
    }
  });

  it('tells web-UI tools to pair with Tailscale in the hint', () => {
    for (const id of ['cockpit', 'netdata', 'code-server']) {
      const f = CLOUD_INIT_FEATURES.find((x) => x.id === id)!;
      expect(f.hint).toMatch(/tailscale|ssh tunnel/i);
    }
  });

  it('installs caddy from data-only curls + code-server from a pinned github .deb', () => {
    const caddy = (yaml.load(cloudInitSnippetContent(['caddy'])) as { runcmd: string[][] }).runcmd.map((c) => c[2]);
    expect(caddy.some((c) => /dl\.cloudsmith\.io\/public\/caddy/.test(c))).toBe(true);
    expect(caddy.some((c) => /apt-get install -y caddy/.test(c))).toBe(true);
    const cs = (yaml.load(cloudInitSnippetContent(['code-server'])) as { runcmd: string[][] }).runcmd.map((c) => c[2]);
    expect(cs.some((c) => /github\.com\/coder\/code-server\/releases\/download/.test(c))).toBe(true);
    expect(cs.some((c) => /code-server@\$\(id -nu 1000\)/.test(c))).toBe(true);
  });
});

describe('catalog + base tools', () => {
  it('exposes every install recipe (apps + fail2ban/unattended/btop) in one catalog', () => {
    const ids = new Set(CLOUD_INIT_CATALOG.map((f) => f.id));
    for (const id of ['docker', 'superfile', 'cockpit', 'caddy', 'fail2ban', 'unattended-upgrades', 'btop']) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('recommends the security/base tools as the default always-on set', () => {
    expect([...RECOMMENDED_BASE_IDS].sort()).toEqual(['btop', 'fail2ban', 'unattended-upgrades']);
  });

  it('resolves base + optional ids together in the snippet content', () => {
    const cfg = parse([...RECOMMENDED_BASE_IDS, 'superfile']);
    expect(cfg.packages).toEqual(expect.arrayContaining(['fail2ban', 'unattended-upgrades', 'btop']));
    const cmds = (cfg.runcmd as string[][]).map((c) => c[2]);
    expect(cmds.some((c) => /enable --now fail2ban/.test(c))).toBe(true);
    expect(cmds.some((c) => /superfile/.test(c))).toBe(true);
  });

  it('preserves the apt.conf quotes through the YAML round-trip (tricky escaping)', () => {
    const cfg = parse(['unattended-upgrades']);
    const cmds = (cfg.runcmd as string[][]).map((c) => c[2]);
    expect(cmds.some((c) => /Unattended-Upgrade "1";/.test(c) && /20auto-upgrades/.test(c))).toBe(true);
  });
});

describe('ensureCloudInitSnippet — on-demand write (no manual placement)', () => {
  let dir: string;
  const savedDir = process.env['SNIPPET_DIR'];
  const savedStorage = process.env['SNIPPET_STORAGE'];

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'pm-snippets-'));
    process.env['SNIPPET_DIR'] = dir;
    process.env['SNIPPET_STORAGE'] = 'snip-test';
  });
  afterEach(() => {
    if (savedDir === undefined) delete process.env['SNIPPET_DIR'];
    else process.env['SNIPPET_DIR'] = savedDir;
    if (savedStorage === undefined) delete process.env['SNIPPET_STORAGE'];
    else process.env['SNIPPET_STORAGE'] = savedStorage;
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the combo file and returns the cicustom volid', async () => {
    const volid = await ensureCloudInitSnippet(['docker']);
    expect(volid).toBe('snip-test:snippets/proxmate-docker.yaml');
    const written = readFileSync(path.join(dir, 'proxmate-docker.yaml'), 'utf8');
    expect(written).toBe(cloudInitSnippetContent(['docker']));
  });

  it('is idempotent — a second call reuses the file, no error, same volid', async () => {
    const a = await ensureCloudInitSnippet(['guest-agent', 'superfile']);
    const b = await ensureCloudInitSnippet(['superfile', 'guest-agent']); // order-independent
    expect(a).toBe('snip-test:snippets/proxmate-guest-agent-superfile.yaml');
    expect(b).toBe(a);
    expect(existsSync(path.join(dir, 'proxmate-guest-agent-superfile.yaml'))).toBe(true);
  });

  it('leaves no leftover temp files after an atomic write', async () => {
    await ensureCloudInitSnippet(['tailscale']);
    const { readdirSync } = await import('node:fs');
    const leftover = readdirSync(dir).filter((f) => f.includes('.tmp'));
    expect(leftover).toHaveLength(0);
  });

  it('returns null (caller falls back to pre-placed) when not configured', async () => {
    delete process.env['SNIPPET_DIR'];
    expect(snippetWriteConfig()).toBeNull();
    expect(await ensureCloudInitSnippet(['docker'])).toBeNull();
  });
});
