/** Most copies a tenant may deploy at once (mirrors the backend's BULK_DEPLOY_MAX). */
export const MAX_COPIES = 20;
/** Most copies (or users) an admin may deploy at once (BULK_DEPLOY_MAX_ADMIN). */
export const MAX_COPIES_ADMIN = 50;

const NAME_RE = /^[a-zA-Z0-9-]+$/;

/** `{n}` → the copy's 1-based number (same rule as the backend). */
export function expandNamePattern(pattern: string, n: number): string {
  return pattern.replaceAll("{n}", String(n));
}

/**
 * Why a name pattern can't be used for `count` copies, or null when it can. One
 * copy per user (`perUser`) may reuse one name, since each lands in its own account.
 */
export function namePatternError(pattern: string, count: number, perUser = false): string | null {
  if (!pattern) return "Enter a name";
  if (!perUser && count > 1 && !pattern.includes("{n}")) return "Add {n} for the copy number, e.g. web-{n}";
  const sample = expandNamePattern(pattern, Math.max(count, 1));
  if (!NAME_RE.test(expandNamePattern(pattern, 1)) || !NAME_RE.test(sample)) {
    return "Use letters, numbers and hyphens only (plus {n})";
  }
  if (sample.length > 63) return "Names can be at most 63 characters";
  return null;
}

export type BatchItemStatus = "queued" | "deploying" | "done" | "failed";

export interface DeployBatch {
  id: string;
  templateName: string;
  finishedAt: string | null;
  items: Array<{
    index: number;
    name: string;
    userId: string;
    vmId: string;
    proxmoxVmId: number;
    node: string;
    status: BatchItemStatus;
    error?: string;
  }>;
}
