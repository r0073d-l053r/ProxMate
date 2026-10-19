import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The production images must run the Node major that CI tests on — and so a
// supported release line, not one that no longer receives security fixes.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

const ciMajors = [
  ...new Set([...read('.github/workflows/ci.yml').matchAll(/node-version:\s*['"]?(\d+)/g)].map((m) => m[1])),
];

describe('Dockerfile base images', () => {
  it('CI pins a single Node major', () => {
    expect(ciMajors).toHaveLength(1);
  });

  it.each(['backend/Dockerfile', 'frontend/Dockerfile'])('%s uses the CI Node major in every stage', (file) => {
    const froms = [...read(file).matchAll(/^FROM\s+node:(\d+)-alpine\b/gm)].map((m) => m[1]);
    expect(froms.length).toBeGreaterThanOrEqual(2);
    for (const major of froms) expect(major).toBe(ciMajors[0]);
  });
});
