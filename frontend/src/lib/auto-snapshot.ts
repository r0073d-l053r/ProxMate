/**
 * What the backend did about the automatic snapshot it takes before a resize,
 * data-disk grow or rescue boot (VMs only; containers are skipped).
 */
export type AutoSnapshotResult =
  | { taken: string }
  | { taken: null; skipped: "disabled" | "container" | "unsupported" };

/** Name prefix of snapshots ProxMate takes on its own (reserved for user snapshots). */
export const AUTO_SNAPSHOT_PREFIX = "pm-auto-";

export function isAutoSnapshotName(name: string): boolean {
  return name.toLowerCase().startsWith(AUTO_SNAPSHOT_PREFIX);
}

/**
 * A line for the success toast saying how to undo the change, or why there is
 * no snapshot to undo it with. Null when there is nothing worth saying (the
 * feature is off, or it's a container).
 */
export function autoSnapshotNote(r: AutoSnapshotResult | null | undefined): string | null {
  if (!r) return null;
  if (r.taken !== null) {
    return `Snapshot "${r.taken}" was taken first — roll back to it from Backups & Snapshots if needed.`;
  }
  if (r.skipped === "unsupported") {
    return "No automatic snapshot was taken: this machine's storage doesn't support snapshots.";
  }
  return null;
}
