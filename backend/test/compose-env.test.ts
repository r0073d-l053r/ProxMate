import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

// The Docker backend gets an explicit `environment:` map (no env_file), so a
// variable set in .env reaches the container only if the compose file forwards
// it. These are the settings the docs tell Docker operators to put in .env.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const compose = parseYaml(readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')) as {
  services: { backend: { environment: Record<string, string> } };
};
const env = compose.services.backend.environment;

const FORWARDED = [
  'APPDB_BACKUP_CRON',
  'BALANCER_CRON',
  'TEMPLATE_REFRESH_CRON',
  'MATESTATE_CRON',
  'ACCESS_EXPIRY_CRON',
  'USAGE_DIGEST_CRON',
  'PROXMATE_MODULES',
  'LOG_LEVEL',
  'GITHUB_TOKEN',
  'IDE_GUEST_PORT',
];

describe('docker-compose.yml backend environment', () => {
  it.each(FORWARDED)('forwards %s from .env', (name) => {
    expect(env, `${name} missing from the backend environment map`).toHaveProperty(name);
    expect(String(env[name])).toMatch(new RegExp(`^\\$\\{${name}(:?-[^}]*)?\\}$`));
  });

  it('LOG_LEVEL never reaches the logger as an empty string', () => {
    // logger.ts falls back with `??`, so an empty value would not take the default.
    expect(String(env['LOG_LEVEL'])).toMatch(/^\$\{LOG_LEVEL:-\w+\}$/);
  });
});
