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

/** Best-effort cleanup of a staging directory after a failed write. */
export function cleanupArgv(stagingDir: string): string[] {
  return ['rm', '-rf', '--', stagingDir];
}

/** Name of part `i` inside the staging directory; zero-padded so the glob keeps order. */
export function partPath(stagingDir: string, i: number): string {
  return `${stagingDir}/p.${String(i).padStart(5, '0')}`;
}

/**
 * Writes the file as the chosen owner, reading its content from stdin:
 * $1 parent directory, $2 `./<file name>`, $3 mode. Run by {@link ASSEMBLE_SCRIPT}
 * when the parent directory is one other users can change, so any symlink in
 * the way only reaches what that user could write anyway.
 */
export const WRITE_AS_OWNER_SCRIPT = [
  'p="$1"; b="$2"; m="$3"',
  'cd -P -- "$p" || exit 5',
  '[ -d "$b" ] && exit 4',
  'umask 077',
  't=$(mktemp ./.pmpush.XXXXXXXX) || exit 6',
  'cat > "$t" || { rm -f -- "$t"; exit 6; }',
  'chmod "$m" "$t" || { rm -f -- "$t"; exit 6; }',
  `h=$(sha256sum < "$t" 2>/dev/null | cut -d' ' -f1)`,
  'mv -f -- "$t" "$b" || { rm -f -- "$t"; exit 6; }',
  'echo "$h"',
].join('\n');

/**
 * The fixed script that assembles the parts into the destination, run as
 * root. Every value arrives as a positional and is never part of the script
 * text: $1 {@link WRITE_AS_OWNER_SCRIPT}, $2 staging dir, $3 destination,
 * $4 mode, $5 owner or empty, $6 expected part count, $7 create parents (1/0).
 *
 * Root writes only into a parent directory it reaches without symlinks and
 * that nobody else can change (owned by root, not group- or other-writable),
 * working from inside it after `cd -P`. The temporary file is made with
 * `mktemp` (exclusive create, random name), given its mode and, if asked, its
 * owner (`chown -h`), then renamed over the destination, so the file never
 * appears half-written. Any other parent directory is written as the owner
 * (setpriv, runuser or su, whichever the guest has); without an owner such a
 * push is refused. Parent folders are created as the owner when one is given.
 * Prints the SHA-256 of the written file.
 *
 * Exit 3: owner does not exist. 4: destination is a directory. 5: parent
 * missing (or could not be created). 6: a write step failed. 7: parts missing.
 * 8: unsafe parent and no owner. 10: no way to run as the owner.
 */
export const ASSEMBLE_SCRIPT = [
  'i="$1"; s="$2"; d="$3"; m="$4"; o="$5"; n="$6"; mk="$7"',
  'case "$s" in /tmp/pmpush.*) ;; *) exit 9 ;; esac',
  `trap 'rm -rf -- "$s"' EXIT`,
  'c=0; for f in "$s"/p.*; do [ -e "$f" ] && c=$((c + 1)); done',
  '[ "$c" = "$n" ] || exit 7',
  'if [ -n "$o" ]; then getent passwd "$o" >/dev/null || exit 3; fi',
  // asuser <user> <fixed script> <$0> <args...>. Some su builds parse options
  // anywhere in argv, so no argument after the script may start with "-".
  'asuser() {',
  '  u="$1"; c="$2"; shift 2',
  '  if command -v setpriv >/dev/null 2>&1; then setpriv --reuid="$u" --regid="$(id -g "$u")" --init-groups -- /bin/sh -c "$c" "$@"',
  '  elif command -v runuser >/dev/null 2>&1; then runuser -u "$u" -- /bin/sh -c "$c" "$@"',
  '  elif command -v su >/dev/null 2>&1; then su -s /bin/sh "$u" -c "$c" "$@"',
  '  else return 10; fi',
  '}',
  'decode() { for f in "$s"/p.*; do [ -e "$f" ] || continue; base64 -d < "$f" || return 6; done; }',
  'p="${d%/*}"; [ -n "$p" ] || p=/; b="${d##*/}"',
  'if [ "$mk" = 1 ]; then',
  `  if [ -n "$o" ]; then asuser "$o" 'mkdir -p -- "$1"' pmpush "$p"; r=$?; else mkdir -p -- "$p"; r=$?; fi`,
  '  [ "$r" = 10 ] && exit 10',
  '  [ "$r" = 0 ] || exit 5',
  'fi',
  '[ -d "$p" ] || exit 5',
  'if cd -P -- "$p" 2>/dev/null && [ "$(pwd -P)" = "$p" ] && [ -n "$(find . -maxdepth 0 -user 0 ! -perm -020 ! -perm -002)" ]; then',
  '  [ -d "./$b" ] && exit 4',
  '  umask 077',
  '  t=$(mktemp ./.pmpush.XXXXXXXX) || exit 6',
  '  decode > "$t" || { rm -f -- "$t"; exit 6; }',
  '  chmod "$m" "$t" || { rm -f -- "$t"; exit 6; }',
  '  if [ -n "$o" ]; then chown -h "$o:$(id -gn "$o")" "$t" || { rm -f -- "$t"; exit 6; }; fi',
  `  h=$(sha256sum < "$t" 2>/dev/null | cut -d' ' -f1)`,
  '  mv -f -- "$t" "./$b" || { rm -f -- "$t"; exit 6; }',
  '  echo "$h"',
  'elif [ -n "$o" ]; then',
  '  cd /',
  '  decode | asuser "$o" "$i" pmpush "$p" "./$b" "$m"',
  'else',
  '  exit 8',
  'fi',
].join('\n');

/**
 * argv for the assemble step:
 * `sh -c <fixed script> sh <owner script> <staging> <dest> <mode> <owner> <parts> <mkdir>`.
 */
export function assembleArgv(
  stagingDir: string,
  dest: string,
  mode: string,
  owner: string,
  parts: number,
  createParents: boolean,
): string[] {
  return [
    '/bin/sh', '-c', ASSEMBLE_SCRIPT, 'sh', WRITE_AS_OWNER_SCRIPT,
    stagingDir, dest, mode, owner, String(parts), createParents ? '1' : '0',
  ];
}

/** Guest stderr for an error message: control characters stripped, length capped. */
export function guestDetail(stderr: string, max = 300): string {
  const clean = stripControlChars(stderr).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
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

  const tmp = await pve.guestExecOutput(node, vmid, [...MKTEMP_ARGV], client, 15_000);
  const staging = tmp.stdout.trim();
  if (tmp.exitcode !== 0 || !STAGING_RE.test(staging)) {
    const why = guestDetail(tmp.stderr);
    throw new GuestFileError(`Couldn't create a staging directory in the guest${why ? `: ${why}` : ''}`, 502);
  }

  let assembled = false;
  try {
    const parts = base64Chunks(input.content);
    for (let i = 0; i < parts.length; i++) {
      await pve.guestFileWrite(node, vmid, partPath(staging, i), parts[i]!, client);
    }
    const r = await pve.guestExecOutput(
      node, vmid, assembleArgv(staging, dest, mode, owner, parts.length, !!input.createParents), client, 60_000,
    );
    assembled = true; // the script removes the staging directory itself
    if (r.exitcode === 3) throw new GuestFileError(`User "${owner}" does not exist in the guest`);
    if (r.exitcode === 4) throw new GuestFileError(`${dest} is a directory in the guest`);
    const parent = path.posix.dirname(dest);
    const why = guestDetail(r.stderr);
    if (r.exitcode === 5) {
      throw new GuestFileError(
        input.createParents
          ? `Couldn't create the folder ${parent} in the guest${owner ? ` as ${owner}` : ''}${why ? `: ${why}` : ''}`
          : `The folder ${parent} doesn't exist in the guest — choose "Create parent folders".`,
      );
    }
    if (r.exitcode === 7) throw new GuestFileError('Some parts of the file went missing in the guest — try again.', 502);
    if (r.exitcode === 8) {
      throw new GuestFileError(
        `Other users can change ${parent}, or its path goes through a symlink, so it isn't written as root. ` +
          'Choose the owner the file should belong to, or give the real path.',
      );
    }
    if (r.exitcode === 10) {
      throw new GuestFileError(`The guest has no setpriv, runuser or su to write the file as ${owner}.`, 502);
    }
    if (r.exitcode !== 0) {
      throw new GuestFileError(
        `Writing the file failed inside the guest${owner ? ` (as ${owner} where needed)` : ''}${why ? `: ${why}` : ` (exit ${r.exitcode})`}`,
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
/** Fixed argv for the log's size, so `truncated` reflects the file and not a re-encoding. */
export const IDE_LOG_SIZE_ARGV: readonly string[] = ['stat', '-c', '%s', IDE_LOG_PATH];

/**
 * Make guest output safe to show as plain text: drop ANSI escape sequences
 * (CSI, OSC and two-character escapes), resolve carriage-return progress lines
 * to their final state, and remove every remaining control character except
 * newline and tab, plus the Unicode bidirectional overrides and marks.
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
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}

export interface IdeInstallLog {
  path: string;
  log: string;
  /** True when older output was cut off (only the tail is returned). */
  truncated: boolean;
  /** True when the guest has no install log (no install has run, or it was removed). */
  missing: boolean;
}

/**
 * Turn raw `tail -c` output into the response body: cleaned, at most
 * IDE_LOG_MAX_LINES lines. `fileBytes` is the log's size on the guest.
 */
export function shapeIdeLog(raw: string, fileBytes?: number): { log: string; truncated: boolean } {
  let truncated = fileBytes !== undefined ? fileBytes > IDE_LOG_TAIL_BYTES : Buffer.byteLength(raw, 'utf8') >= IDE_LOG_TAIL_BYTES;
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
  const size = await pve.guestExecOutput(node, vmid, [...IDE_LOG_SIZE_ARGV], client, 15_000);
  if (size.exitcode !== 0) {
    if (/no such file/i.test(size.stderr)) return { path: IDE_LOG_PATH, log: '', truncated: false, missing: true };
    const why = guestDetail(size.stderr);
    throw new GuestFileError(`Couldn't read the install log${why ? `: ${why}` : ''}`, 502);
  }
  const r = await pve.guestExecOutput(node, vmid, [...IDE_LOG_ARGV], client, 15_000, false);
  if (r.exitcode !== 0) {
    if (/no such file/i.test(r.stderr)) return { path: IDE_LOG_PATH, log: '', truncated: false, missing: true };
    const why = guestDetail(r.stderr);
    throw new GuestFileError(`Couldn't read the install log${why ? `: ${why}` : ''}`, 502);
  }
  const bytes = Number(size.stdout.trim());
  return { path: IDE_LOG_PATH, missing: false, ...shapeIdeLog(r.stdout, Number.isFinite(bytes) ? bytes : undefined) };
}
