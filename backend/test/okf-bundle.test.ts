import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/**
 * The repo-root `okf/` directory is an Open Knowledge Format (OKF v0.2) bundle
 * describing ProxMate for agents and humans. This keeps it conformant (spec §11) and
 * stops it drifting from the code it documents: a Prisma model or router added
 * without a concept fails here rather than leaving the knowledge base silently stale.
 *
 * Beyond §11 the bundle holds itself to a stricter house style (every concept has a
 * title, description, `generated` and resolvable internal links, and every directory
 * an index listing it), because an index an agent cannot trust is worse than none.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUNDLE = path.join(REPO, 'okf');
const RESERVED = new Set(['index.md', 'log.md']);
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ACTOR = /^(human:|process:)[^\s]+$|^[^\s:/]+\/[^\s]+$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Split a markdown file into its frontmatter (parsed) and body. */
function split(file: string): { fm: Record<string, unknown> | null; body: string } {
  const text = readFileSync(file, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fm: null, body: text };
  // `yaml` would turn timestamps into strings anyway; keep them as written.
  const fm = parseYaml(m[1]!) as Record<string, unknown> | null;
  return { fm: fm ?? {}, body: text.slice(m[0].length) };
}

const rel = (f: string) => path.relative(BUNDLE, f).split(path.sep).join('/');
const files = existsSync(BUNDLE) ? walk(BUNDLE).filter((f) => f.endsWith('.md')) : [];
const concepts = files.filter((f) => !RESERVED.has(path.basename(f)));

/** Body text with fenced blocks and inline code removed, so `[^/]+` in a regex isn't a footnote. */
function prose(body: string): string {
  return body.replace(/^(```|~~~)[\s\S]*?^\1/gm, '').replace(/^(?: {4}|\t).*$/gm, '').replace(/`[^`\n]*`/g, '');
}

/** Markdown link targets in a body, minus external URLs and in-page anchors. */
function internalLinks(body: string): string[] {
  const out: string[] = [];
  for (const m of prose(body).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1]!.split('#')[0]!;
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    out.push(target);
  }
  return out;
}

function resolveLink(from: string, target: string): string {
  return target.startsWith('/') ? path.join(BUNDLE, target) : path.resolve(path.dirname(from), target);
}

describe('okf/ bundle — OKF v0.2 conformance (§11)', () => {
  it('exists with a root index declaring okf_version 0.2', () => {
    const root = path.join(BUNDLE, 'index.md');
    expect(existsSync(root)).toBe(true);
    expect(split(root).fm?.['okf_version']).toBe('0.2');
  });

  it('has concepts', () => {
    expect(concepts.length).toBeGreaterThan(50);
  });

  it.each(concepts.map(rel))('%s has parseable frontmatter with a non-empty type', (f) => {
    const { fm } = split(path.join(BUNDLE, f));
    expect(fm, 'missing frontmatter block').not.toBeNull();
    expect(typeof fm!['type']).toBe('string');
    expect(String(fm!['type']).trim()).not.toBe('');
  });

  it('carries frontmatter on no index.md but the root (§8)', () => {
    for (const f of files.filter((x) => path.basename(x) === 'index.md' && x !== path.join(BUNDLE, 'index.md'))) {
      expect(split(f).fm, rel(f)).toBeNull();
    }
  });

  it('dates log.md entries as ISO headings, newest first (§9)', () => {
    for (const f of files.filter((x) => path.basename(x) === 'log.md')) {
      const dates = [...readFileSync(f, 'utf8').matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim());
      expect(dates.length, rel(f)).toBeGreaterThan(0);
      for (const d of dates) expect(d, rel(f)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect([...dates].sort().reverse(), rel(f)).toEqual(dates);
    }
  });
});

describe('okf/ bundle — house style', () => {
  it.each(concepts.map(rel))('%s has title, description, generated and valid trust fields', (f) => {
    const { fm } = split(path.join(BUNDLE, f));
    expect(String(fm!['title'] ?? '').trim(), 'title').not.toBe('');
    const desc = String(fm!['description'] ?? '');
    expect(desc.trim(), 'description').not.toBe('');
    expect(desc, 'description must be one line').not.toMatch(/\n/);

    const gen = fm!['generated'] as { by?: unknown; at?: unknown } | undefined;
    expect(gen?.by, 'generated.by').toMatch(ACTOR);
    expect(String(gen?.at), 'generated.at').toMatch(ISO_DATETIME);

    // §5.2: a bare mapping is a one-element list.
    const verified = fm!['verified'];
    if (verified !== undefined) {
      for (const v of (Array.isArray(verified) ? verified : [verified]) as Array<{ by?: string; at?: unknown }>) {
        expect(v.by).toMatch(ACTOR);
        expect(String(v.at)).toMatch(ISO_DATETIME);
      }
    }
    if (fm!['status'] !== undefined) expect(['draft', 'stable', 'deprecated']).toContain(fm!['status']);
    if (fm!['stale_after'] !== undefined) expect(String(fm!['stale_after'])).toMatch(ISO_DATETIME);
  });

  it.each(concepts.map(rel))('%s keys every footnote to a sources[].id (§5.1)', (f) => {
    const { fm, body } = split(path.join(BUNDLE, f));
    const sources = (fm!['sources'] ?? []) as Array<{ id?: string; resource?: string }>;
    for (const s of sources) expect(String(s.resource ?? '').trim(), 'sources[].resource').not.toBe('');
    const ids = new Set(sources.map((s) => s.id).filter(Boolean));
    const labels = new Set([...prose(body).matchAll(/\[\^([^\]]+)\]/g)].map((m) => m[1]!));
    for (const l of labels) expect(ids, `footnote [^${l}] has no matching sources id`).toContain(l);
  });

  it.each(files.map(rel))('%s links only to files that exist in the bundle', (f) => {
    const full = path.join(BUNDLE, f);
    const broken = internalLinks(split(full).body).filter((t) => !existsSync(resolveLink(full, t)));
    expect(broken).toEqual([]);
  });

  it('lists every concept and subdirectory in its directory index', () => {
    const dirs = new Set(concepts.map((f) => path.dirname(f)));
    for (let d of [...dirs]) while (d.startsWith(BUNDLE) && d !== BUNDLE) dirs.add((d = path.dirname(d)));
    for (const dir of dirs) {
      const index = path.join(dir, 'index.md');
      expect(existsSync(index), `${rel(dir) || '.'} has no index.md`).toBe(true);
      const linked = new Set(internalLinks(readFileSync(index, 'utf8')).map((t) => path.normalize(resolveLink(index, t))));
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        const listable = statSync(full).isDirectory()
          ? walk(full).some((x) => x.endsWith('.md'))
          : entry.endsWith('.md') && !RESERVED.has(entry);
        if (!listable) continue;
        const ok = linked.has(path.normalize(full)) || linked.has(path.normalize(full + path.sep));
        expect(ok, `${rel(index)} does not list ${entry}`).toBe(true);
      }
    }
  });
});

describe('okf/ bundle — in sync with the code', () => {
  const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();

  it('documents every Prisma model under database/', () => {
    const schema = readFileSync(path.join(REPO, 'backend/prisma/schema.prisma'), 'utf8');
    const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]!);
    expect(models.length).toBeGreaterThan(0);
    const missing = models.filter((m) => !existsSync(path.join(BUNDLE, 'database', `${kebab(m)}.md`)));
    expect(missing).toEqual([]);
  });

  it('documents every API router under api/', () => {
    const routers = readdirSync(path.join(REPO, 'backend/src/routes'))
      .filter((f) => f.endsWith('.routes.ts'))
      .map((f) => f.replace(/\.routes\.ts$/, ''));
    const missing = routers.filter((r) => !existsSync(path.join(BUNDLE, 'api', `${r}.md`)));
    expect(missing).toEqual([]);
  });

  it('documents every backend service under services/', () => {
    const services = readdirSync(path.join(REPO, 'backend/src/services'))
      .filter((f) => f.endsWith('.service.ts'))
      .map((f) => f.replace(/\.service\.ts$/, ''));
    const missing = services.filter((s) => !existsSync(path.join(BUNDLE, 'services', `${s}.md`)));
    expect(missing).toEqual([]);
  });

  it('documents every SystemConfig key the backend reads or writes', () => {
    const src = walk(path.join(REPO, 'backend/src')).filter((f) => f.endsWith('.ts'));
    const keys = new Set<string>();
    for (const f of src) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\b(?:get|set)Config\(\s*'([a-z0-9_]+)'/g)) keys.add(m[1]!);
    }
    const reference = readFileSync(path.join(BUNDLE, 'config', 'system-config-keys.md'), 'utf8');
    const missing = [...keys].filter((k) => !reference.includes(`\`${k}\``)).sort();
    expect(missing).toEqual([]);
  });
});
