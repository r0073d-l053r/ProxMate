import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import axios from 'axios';

/**
 * Self-update support. Two clearly-separated halves:
 *
 *  1. CHECK (always available) — read the deployed version and ask the GitHub
 *     Releases API what the latest published release is. Pure read, admin-only.
 *
 *  2. APPLY (opt-in, host-mediated) — a container can't rebuild and restart
 *     itself, so the app never runs Docker/git. Instead, when self-update is
 *     enabled it drops a *request flag* into a bind-mounted control directory
 *     that a privileged host-side updater (deploy/update.sh via a systemd path
 *     unit) watches; that updater does `git checkout <tag> && docker compose
 *     build && up -d` and writes a *status* file back, which the UI polls.
 *
 * The app's only "power" here is writing a file in one directory — no Docker
 * socket, no host shell. See deploy/update.sh and DEPLOYMENT.md.
 */

/** owner/repo to check releases against (a fork can override via env). */
export function updateRepo(): string {
  return process.env['UPDATE_REPO'] || 'r0073d-l053r/ProxMate';
}

/** The running app version. `APP_VERSION` (baked at build) wins; else read it
 *  out of package.json (present at the image WORKDIR and in dev). */
export function currentVersion(): string {
  if (process.env['APP_VERSION']) return process.env['APP_VERSION'] as string;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Parse `v1.2.3` / `1.2.3-rc1` → [1,2,3] (prerelease suffix dropped). */
function parseSemver(v: string): number[] {
  return (v.replace(/^v/, '').split('-')[0] ?? '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
}

/** Strict "is a newer than b" by numeric semver (equal → false). */
export function isNewer(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export interface UpdateCheck {
  repo: string;
  current: string;
  latest: string | null; // version without a leading "v" (for display/compare)
  tag: string | null; // the exact release tag_name (for the host updater to checkout)
  updateAvailable: boolean;
  name: string | null;
  notes: string | null;
  url: string | null;
  publishedAt: string | null;
}

// Tiny TTL cache so repeated clicks don't burn the unauthenticated GitHub
// rate-limit (60/hr/IP).
let cache: { at: number; value: UpdateCheck } | null = null;
const CACHE_TTL_MS = 60_000;

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
}

/** Compare the deployed version against the latest GitHub Release. */
export async function checkForUpdate(force = false): Promise<UpdateCheck> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const repo = updateRepo();
  const current = currentVersion();
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ProxMate-updater',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env['GITHUB_TOKEN'];
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let value: UpdateCheck;
  try {
    const res = await axios.get<GitHubRelease>(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers,
      timeout: 10_000,
    });
    const tag = String(res.data.tag_name ?? '');
    const latest = tag ? tag.replace(/^v/, '') : null;
    value = {
      repo,
      current,
      latest,
      tag: tag || null,
      updateAvailable: latest ? isNewer(latest, current) : false,
      name: res.data.name ?? null,
      notes: res.data.body ?? null,
      url: res.data.html_url ?? null,
      publishedAt: res.data.published_at ?? null,
    };
  } catch (err) {
    // 404 = the repo has no published releases yet — that's "up to date", not an error.
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      value = { repo, current, latest: null, tag: null, updateAvailable: false, name: null, notes: null, url: null, publishedAt: null };
    } else {
      throw err;
    }
  }

  cache = { at: Date.now(), value };
  return value;
}

// ─── Apply (opt-in, host-mediated) ────────────────────────────

/** Self-update is only wired up when the admin has set up the host updater. */
export function selfUpdateEnabled(): boolean {
  return process.env['SELF_UPDATE_ENABLED'] === 'true';
}

const CONTROL_DIR = process.env['UPDATE_CONTROL_DIR'] || '/control';
const REQUEST_FILE = 'update-request.json';
const STATUS_FILE = 'update-status.json';

// Tags are written to a file and later `git checkout`'d by the host script —
// keep them to a safe charset (defense in depth; the script validates too).
const TAG_RE = /^v?[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;

export function isValidTag(tag: string): boolean {
  return TAG_RE.test(tag);
}

export interface UpdateStatus {
  state: 'idle' | 'queued' | 'running' | 'success' | 'error';
  message?: string;
  tag?: string;
  updatedAt?: string;
}

/** Drop a request flag for the host updater to pick up. */
export async function requestUpdate(tag: string, requestedBy: string): Promise<void> {
  await mkdir(CONTROL_DIR, { recursive: true });
  const payload = JSON.stringify({ tag, requestedBy, requestedAt: new Date().toISOString() }, null, 2);
  // Write a queued status immediately so the UI reflects it before the host runs.
  await writeFile(
    join(CONTROL_DIR, STATUS_FILE),
    JSON.stringify({ state: 'queued', tag, updatedAt: new Date().toISOString() }, null, 2),
  );
  await writeFile(join(CONTROL_DIR, REQUEST_FILE), payload);
}

/** The host updater's last-written status (idle when none / not set up). */
export async function getUpdateStatus(): Promise<UpdateStatus> {
  try {
    const raw = await readFile(join(CONTROL_DIR, STATUS_FILE), 'utf8');
    const parsed = JSON.parse(raw) as UpdateStatus;
    if (parsed && typeof parsed.state === 'string') return parsed;
    return { state: 'idle' };
  } catch {
    return { state: 'idle' };
  }
}
