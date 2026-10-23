import { createHash } from 'node:crypto';
import path from 'node:path';
import type { VirtualMachine } from '@prisma/client';
import * as pve from './proxmox.service.js';
import { kindOf, requireOurGuest } from './vm.service.js';
import { envNumber } from '../lib/env-number.js';

/* eslint-disable no-control-regex -- matching control characters is the point of the path check and log cleaning */

/**
 * Guest-agent file tools for QEMU guests: push a small file into the guest, and
 * read the tail of the ProxMate IDE install log. Everything that reaches the
 * guest goes through the agent's `file-write` (content only) or `exec` with a
 * fixed argv; request-supplied values are only ever argv entries, never part
 * of a shell script's text.
 */

/** A push or log read the caller can fix (bad input, missing user, no agent). */
export class GuestFileError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'GuestFileError';
  }
}

// ─── Destination path ─────────────────────────────────────────

/** Longest destination path accepted, in bytes. */
export const GUEST_PATH_MAX_BYTES = 1024;
/**
 * Longest single path segment. Below NAME_MAX (255) so the temporary sibling
 * the guest writes first (`<name>.pmpush.<pid>`) still fits.
 */
export const GUEST_SEGMENT_MAX_BYTES = 230;
/** Kernel pseudo-filesystems: writing there changes kernel state, not files. */
const FORBIDDEN_ROOTS = ['/proc', '/sys', '/dev'];

export type GuestPathCheck = { ok: true; path: string } | { ok: false; error: string };

/**
 * Validate a destination path inside the guest: absolute, already normalized
 * (no empty, `.` or `..` segments, no trailing slash), no control characters,
 * bounded length, and not under /proc, /sys or /dev. The path is used exactly
 * as given — nothing is rewritten — so what was validated is what is written.
 */
export function validateGuestPath(input: unknown): GuestPathCheck {
  if (typeof input !== 'string' || input.length === 0) return { ok: false, error: 'Enter a destination path.' };
  if (/[\x00-\x1f\x7f]/.test(input)) return { ok: false, error: 'The path contains control characters.' };
  if (Buffer.byteLength(input, 'utf8') > GUEST_PATH_MAX_BYTES) {
    return { ok: false, error: `The path is longer than ${GUEST_PATH_MAX_BYTES} bytes.` };
  }
  if (!input.startsWith('/')) return { ok: false, error: 'Use an absolute path (starting with /).' };
  if (input.endsWith('/')) return { ok: false, error: 'The path must name a file, not end with /.' };
  const segments = input.slice(1).split('/');
  for (const s of segments) {
    if (s === '') return { ok: false, error: 'The path contains an empty segment (//).' };
    if (s === '.' || s === '..') return { ok: false, error: 'The path may not contain . or .. segments.' };
    if (Buffer.byteLength(s, 'utf8') > GUEST_SEGMENT_MAX_BYTES) {
      return { ok: false, error: `Each path segment must be at most ${GUEST_SEGMENT_MAX_BYTES} bytes.` };
    }
  }
  if (path.posix.normalize(input) !== input) return { ok: false, error: 'Use a normalized path.' };
  for (const root of FORBIDDEN_ROOTS) {
    if (input === root || input.startsWith(`${root}/`)) {
      return { ok: false, error: `Files can't be pushed into ${root}.` };
    }
  }
  return { ok: true, path: input };
}

/**
 * A plain permission mode, `644` or `0644`. Setuid, setgid and sticky bits are
 * not offered. Returns the four-digit form, or null when invalid.
 */
export function parseFileMode(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return '0644';
  if (typeof input !== 'string') return null;
  const m = /^0?([0-7]{3})$/.exec(input.trim());
  return m ? `0${m[1]}` : null;
}

/** Same shape as the guest usernames the password reset and SSH-key routes take. */
export const GUEST_USERNAME_RE = /^[a-zA-Z0-9._][a-zA-Z0-9._-]{0,63}$/;

// ─── Size and chunking ────────────────────────────────────────

export const GUEST_FILE_PUSH_DEFAULT_MAX_BYTES = 1024 * 1024;
/** Ceiling for GUEST_FILE_PUSH_MAX_BYTES: past this a push is too many agent calls. */
export const GUEST_FILE_PUSH_HARD_MAX_BYTES = 8 * 1024 * 1024;

/** Largest file a push accepts: GUEST_FILE_PUSH_MAX_BYTES, default 1 MiB, at most 8 MiB. */
export function guestFilePushMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const v = Math.floor(envNumber('GUEST_FILE_PUSH_MAX_BYTES', GUEST_FILE_PUSH_DEFAULT_MAX_BYTES, 1, env));
  return Math.min(v, GUEST_FILE_PUSH_HARD_MAX_BYTES);
}

/**
 * Base64 characters per `file-write` call. Proxmox caps that call's `content`
 * at 60 KiB; a multiple of 4 keeps every chunk a whole base64 unit, so each
 * part decodes on its own in the guest.
 */
export const PUSH_CHUNK_CHARS = 48 * 1024;

/** Split content into base64 parts of at most PUSH_CHUNK_CHARS (none for an empty file). */
export function base64Chunks(content: Buffer): string[] {
  const b64 = content.toString('base64');
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += PUSH_CHUNK_CHARS) out.push(b64.slice(i, i + PUSH_CHUNK_CHARS));
  return out;
}

// ─── Guest commands (fixed argv) ──────────────────────────────

const STAGING_TEMPLATE = '/tmp/pmpush.XXXXXXXX';
const STAGING_RE = /^\/tmp\/pmpush\.[A-Za-z0-9]{8}$/;

/** A private (0700) staging directory for the parts. */
export const MKTEMP_ARGV: readonly string[] = ['mktemp', '-d', STAGING_TEMPLATE];

/** Create the destination's parent directories (only when asked to). */
export function mkdirArgv(dir: string): string[] {
  return ['mkdir', '-p', '--', dir];
}

/** Best-effort cleanup of a staging directory after a failed write. */
export function cleanupArgv(stagingDir: string): string[] {
  return ['rm', '-rf', '--', stagingDir];
}

/** Name of part `i` inside the staging directory; zero-padded so the glob keeps order. */
export function partPath(stagingDir: string, i: number): string {
  return `${stagingDir}/p.${String(i).padStart(5, '0')}`;
}

/**
 * The fixed script that assembles the parts into the destination. Every value
 * arrives as a positional ($1 staging dir, $2 destination, $3 mode, $4 owner
 * or empty) and is never part of the script text. It decodes into a temporary
 * sibling created under umask 077, sets mode and owner there, then renames it
 * over the destination, so the file never appears half-written or briefly with
 * looser permissions. Prints the SHA-256 of what landed.
 *
 * Exit 3: the owner user does not exist. 4: the destination is a directory.
 * 5: the parent directory does not exist. 6: a write step failed.
 */
export const ASSEMBLE_SCRIPT = [
  's="$1"; d="$2"; m="$3"; o="$4"',
  'case "$s" in /tmp/pmpush.*) ;; *) exit 9 ;; esac',
  `trap 'rm -rf -- "$s"' EXIT`,
  'if [ -n "$o" ]; then getent passwd "$o" >/dev/null || exit 3; fi',
  '[ -d "$d" ] && exit 4',
  'p="${d%/*}"; [ -n "$p" ] || p=/',
  '[ -d "$p" ] || exit 5',
  'umask 077',
  't="$d.pmpush.$$"',
  ': > "$t" || exit 6',
  'for f in "$s"/p.*; do',
  '  [ -e "$f" ] || continue',
  '  base64 -d < "$f" >> "$t" || { rm -f -- "$t"; exit 6; }',
  'done',
  'chmod "$m" "$t" || { rm -f -- "$t"; exit 6; }',
  'if [ -n "$o" ]; then chown "$o:$(id -gn "$o")" "$t" || { rm -f -- "$t"; exit 6; }; fi',
  'mv -f -- "$t" "$d" || { rm -f -- "$t"; exit 6; }',
  `sha256sum < "$d" 2>/dev/null | cut -d' ' -f1`,
].join('\n');

/** argv for the assemble step: `sh -c <fixed script> sh <staging> <dest> <mode> <owner>`. */
export function assembleArgv(stagingDir: string, dest: string, mode: string, owner: string): string[] {
  return ['/bin/sh', '-c', ASSEMBLE_SCRIPT, 'sh', stagingDir, dest, mode, owner];
}

// ─── Push ─────────────────────────────────────────────────────

export interface GuestFilePushInput {
  path: string;
  content: Buffer;
  /** Four-digit octal, from {@link parseFileMode}. */
  mode: string;
  /** Guest user to own the file; empty keeps root. */
  owner?: string;
  createParents?: boolean;
}

export interface GuestFilePushResult {
  path: string;
  size: number;
  sha256: string;
  /** True when the guest reported the same SHA-256 back. */
  verified: boolean;
}

/**
 * Push a file into a QEMU guest through the agent: stage base64 parts in a
 * private temp directory (`file-write`), then assemble them at the destination
 * with the fixed {@link ASSEMBLE_SCRIPT}. Inputs are re-validated here so no
 * caller can skip the checks.
 */
export async function pushGuestFile(vm: VirtualMachine, input: GuestFilePushInput): Promise<GuestFilePushResult> {
  if (kindOf(vm) === 'lxc') {
    throw new GuestFileError('Pushing files needs the QEMU guest agent — containers are not supported', 409);
  }
  const checked = validateGuestPath(input.path);
  if (!checked.ok) throw new GuestFileError(checked.error);
  const dest = checked.path;
  const mode = parseFileMode(input.mode);
  if (!mode) throw new GuestFileError('Use a mode like 0644.');
  const owner = input.owner?.trim() ?? '';
  if (owner && !GUEST_USERNAME_RE.test(owner)) throw new GuestFileError('Invalid owner username.');
  const max = guestFilePushMaxBytes();
  if (input.content.length > max) {
    throw new GuestFileError(`The file is larger than the ${formatByteLimit(max)} push limit.`, 413);
  }
  const sha256 = createHash('sha256').update(input.content).digest('hex');

  const client = await pve.getClient();
  const current = await requireOurGuest(vm, { client });
  const { proxmoxNode: node, proxmoxVmId: vmid } = current;
  if (!(await pve.guestAgentPing(node, vmid, client))) {
    throw new GuestFileError(
      'The QEMU guest agent is not responding. Start the VM and make sure qemu-guest-agent is running in it.',
      409,
    );
  }

  if (input.createParents) {
    const parent = path.posix.dirname(dest);
    if (parent !== '/') {
      const r = await pve.guestExecOutput(node, vmid, mkdirArgv(parent), client, 15_000);
      if (r.exitcode !== 0) {
        throw new GuestFileError(`Couldn't create ${parent} in the guest${r.stderr ? `: ${r.stderr}` : ''}`, 502);
      }
    }
  }

  const tmp = await pve.guestExecOutput(node, vmid, [...MKTEMP_ARGV], client, 15_000);
  const staging = tmp.stdout.trim();
  if (tmp.exitcode !== 0 || !STAGING_RE.test(staging)) {
    throw new GuestFileError(`Couldn't create a staging directory in the guest${tmp.stderr ? `: ${tmp.stderr}` : ''}`, 502);
  }

  let assembled = false;
  try {
    const parts = base64Chunks(input.content);
    for (let i = 0; i < parts.length; i++) {
      await pve.guestFileWrite(node, vmid, partPath(staging, i), parts[i]!, client);
    }
    const r = await pve.guestExecOutput(node, vmid, assembleArgv(staging, dest, mode, owner), client, 60_000);
    assembled = true; // the script removes the staging directory itself
    if (r.exitcode === 3) throw new GuestFileError(`User "${owner}" does not exist in the guest`);
    if (r.exitcode === 4) throw new GuestFileError(`${dest} is a directory in the guest`);
    if (r.exitcode === 5) {
      throw new GuestFileError(`The folder ${path.posix.dirname(dest)} doesn't exist in the guest — choose "Create parent folders".`);
    }
    if (r.exitcode !== 0) {
      throw new GuestFileError(
        `Writing the file failed inside the guest${r.stderr ? `: ${r.stderr}` : ` (exit ${r.exitcode})`}`,
        502,
      );
    }
    const reported = r.stdout.trim().split('\n').pop() ?? '';
    const verified = reported === sha256;
    if (/^[0-9a-f]{64}$/.test(reported) && !verified) {
      throw new GuestFileError('The file arrived in the guest with a different checksum — try again.', 502);
    }
    return { path: dest, size: input.content.length, sha256, verified };
  } finally {
    if (!assembled) {
      await pve.guestExecOutput(node, vmid, cleanupArgv(staging), client, 10_000).catch(() => undefined);
    }
  }
}

/** A byte limit for messages: `1 MiB`, `512 KiB`. */
export function formatByteLimit(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} bytes`;
}

// ─── IDE install log ──────────────────────────────────────────

/** Where the IDE bootstrap's output goes (see ide-provision.service). */
export const IDE_LOG_PATH = '/var/log/pmide-provision.log';
export const IDE_LOG_TAIL_BYTES = 64 * 1024;
export const IDE_LOG_MAX_LINES = 500;
/** Fixed argv: nothing from the request reaches it. */
export const IDE_LOG_ARGV: readonly string[] = ['tail', '-c', String(IDE_LOG_TAIL_BYTES), IDE_LOG_PATH];

/**
 * Make guest output safe to show as plain text: drop ANSI escape sequences
 * (CSI, OSC and two-character escapes), resolve carriage-return progress lines
 * to their final state, and remove every remaining control character except
 * newline and tab, plus the Unicode bidirectional overrides.
 */
export function stripControlChars(text: string): string {
  const noEscapes = text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI: colours, cursor moves
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '') // OSC: titles, hyperlinks
    .replace(/\x1b[ -/]+[0-~]/g, '') // character-set and other nF escapes
    .replace(/\x1b[@-Z\\-_]/g, '') // other two-character escapes
    .replace(/\x9b[0-?]*[ -/]*[@-~]/g, ''); // 8-bit CSI
  const lines = noEscapes
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const parts = line.split('\r');
      // A progress bar rewrites its line with \r; keep what the terminal would show last.
      for (let i = parts.length - 1; i >= 0; i--) if (parts[i] !== '') return parts[i]!;
      return '';
    });
  return lines
    .join('\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(/[‪-‮⁦-⁩]/g, '');
}

export interface IdeInstallLog {
  path: string;
  log: string;
  /** True when older output was cut off (only the tail is returned). */
  truncated: boolean;
  /** True when the guest has no install log (no install has run, or it was removed). */
  missing: boolean;
}

/** Turn raw `tail -c` output into the response body: cleaned, at most IDE_LOG_MAX_LINES lines. */
export function shapeIdeLog(raw: string): { log: string; truncated: boolean } {
  let truncated = Buffer.byteLength(raw, 'utf8') >= IDE_LOG_TAIL_BYTES;
  let lines = stripControlChars(raw).trimEnd().split('\n');
  // tail -c usually starts mid-line; drop the fragment.
  if (truncated && lines.length > 1) lines = lines.slice(1);
  if (lines.length > IDE_LOG_MAX_LINES) {
    lines = lines.slice(-IDE_LOG_MAX_LINES);
    truncated = true;
  }
  return { log: lines.join('\n'), truncated };
}

/** Read the tail of the IDE install log from a running QEMU guest through the agent. */
export async function readIdeInstallLog(vm: VirtualMachine): Promise<IdeInstallLog> {
  if (kindOf(vm) === 'lxc') throw new GuestFileError('The IDE needs a QEMU VM — containers are not supported.', 409);
  const client = await pve.getClient();
  const current = await requireOurGuest(vm, { client });
  const { proxmoxNode: node, proxmoxVmId: vmid } = current;
  if (!(await pve.guestAgentPing(node, vmid, client))) {
    throw new GuestFileError(
      'The QEMU guest agent is not responding, so the log cannot be read. Start the VM and try again.',
      409,
    );
  }
  const r = await pve.guestExecOutput(node, vmid, [...IDE_LOG_ARGV], client, 15_000, false);
  if (r.exitcode !== 0) {
    if (/no such file/i.test(r.stderr)) return { path: IDE_LOG_PATH, log: '', truncated: false, missing: true };
    throw new GuestFileError(`Couldn't read the install log${r.stderr ? `: ${stripControlChars(r.stderr)}` : ''}`, 502);
  }
  return { path: IDE_LOG_PATH, missing: false, ...shapeIdeLog(r.stdout) };
}
