/**
 * Client-side checks for the guest-agent file tools. They mirror the server's
 * rules (backend guest-file.service) so the dialog can explain a problem
 * before uploading; the server checks everything again.
 */

const FORBIDDEN_ROOTS = ["/proc", "/sys", "/dev"];
const PATH_MAX_BYTES = 1024;
const SEGMENT_MAX_BYTES = 230;
const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** Why a destination path would be refused, or null when it is fine. */
export function guestPathError(input: string): string | null {
  if (!input) return "Enter a destination path.";
  if (/[\x00-\x1f\x7f]/.test(input)) return "The path contains control characters.";
  if (byteLength(input) > PATH_MAX_BYTES) return `The path is longer than ${PATH_MAX_BYTES} bytes.`;
  if (!input.startsWith("/")) return "Use an absolute path (starting with /).";
  if (input.endsWith("/")) return "The path must name a file, not end with /.";
  for (const s of input.slice(1).split("/")) {
    if (s === "") return "The path contains an empty segment (//).";
    if (s === "." || s === "..") return "The path may not contain . or .. segments.";
    if (byteLength(s) > SEGMENT_MAX_BYTES) return `Each path segment must be at most ${SEGMENT_MAX_BYTES} bytes.`;
  }
  for (const root of FORBIDDEN_ROOTS) {
    if (input === root || input.startsWith(`${root}/`)) return `Files can't be pushed into ${root}.`;
  }
  return null;
}

/** A plain permission mode (`644` / `0644`, no setuid/setgid/sticky). */
export function isValidFileMode(input: string): boolean {
  return input.trim() === "" || /^0?[0-7]{3}$/.test(input.trim());
}

/**
 * A sensible destination for a dropped file: its name in /root, with anything
 * that isn't a plain filename character replaced.
 */
export function suggestedPath(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+$/, "");
  return `/root/${clean || "file"}`;
}

/**
 * Plain text for display: the server already strips terminal control codes,
 * this repeats it so nothing but text ever reaches the page.
 */
export function cleanLogText(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/\x1b[ -/]+[0-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const parts = line.split("\r");
      for (let i = parts.length - 1; i >= 0; i--) if (parts[i] !== "") return parts[i];
      return "";
    })
    .join("\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}
