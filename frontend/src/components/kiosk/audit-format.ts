import type { AuditEntry } from "@/lib/types";

/** Severity heuristic for an activity dot — green → amber → red. */
export function severityDot(action: string): string {
  const a = action.toLowerCase();
  if (/(delete|destroy|force|fail|lock|error)/.test(a)) return "bg-destructive";
  if (/(stop|restart|reset|update|rollback)/.test(a)) return "bg-amber-500";
  return "bg-emerald-500";
}

export function humanizeAction(action: string): string {
  return action.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Best-effort VM name for a `vm`-targeted entry. Audit rows store the VM's DB id
 * in `targetId`; the human name conventionally leads `detail` (VM names are
 * restricted to [A-Za-z0-9-], so the leading token is the name). Cosmetic only —
 * filtering keys on the stable `targetId`.
 */
export function vmLabel(e: AuditEntry): string | null {
  if (e.targetType !== "vm" || !e.targetId) return null;
  const m = e.detail?.match(/^[A-Za-z0-9-]+/);
  return m ? m[0] : "VM";
}
