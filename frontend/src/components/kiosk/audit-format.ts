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
 * The display name for a `vm`-targeted entry, resolved from the REAL inventory
 * (VM id -> name) the kiosk already polls.
 *
 * This used to parse the leading token out of the free-text `detail`, which was
 * wrong in a way that mattered: `vm.share` records its detail as
 * "person@example.com as manager", so the regex happily printed a tenant's
 * email local-part on the wall as if it were a machine name — the exact actor
 * identity this panel is built never to show. (It also mislabelled node names
 * from balancer moves.) Resolving against known ids can only ever produce a
 * real VM name, and shows nothing when the target isn't a VM we know.
 */
export function vmLabel(e: AuditEntry, names?: Map<string, string>): string | null {
  if (e.targetType !== 'vm' || !e.targetId) return null;
  return names?.get(e.targetId) ?? null;
}
