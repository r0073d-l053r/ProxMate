/**
 * Projects are a `project:<name>` tag on a VM (one per VM). These helpers mirror
 * the backend's project.service so the UI can show, validate and suggest names;
 * the server re-checks everything.
 */
export const PROJECT_PREFIX = "project:";
const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function splitTags(csv: string | null | undefined): string[] {
  return (csv ?? "").split(",").map((t) => t.trim()).filter(Boolean);
}

/** A typed project name normalized (trimmed, lowercased), or null when invalid. */
export function normalizeProjectName(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  return PROJECT_NAME_RE.test(name) ? name : null;
}

/** The VM's project from its tag CSV, or null. */
export function projectOf(csv: string | null | undefined): string | null {
  for (const t of splitTags(csv)) {
    if (!t.startsWith(PROJECT_PREFIX)) continue;
    const name = t.slice(PROJECT_PREFIX.length);
    if (PROJECT_NAME_RE.test(name)) return name;
  }
  return null;
}

/** The plain labels: every tag except the project tag. */
export function plainTags(csv: string | null | undefined): string[] {
  return splitTags(csv).filter((t) => !t.startsWith(PROJECT_PREFIX));
}

/** Distinct project names across these VMs, sorted — suggestions for the picker. */
export function projectNames(vms: ReadonlyArray<{ tags: string | null }>): string[] {
  const s = new Set<string>();
  for (const v of vms) {
    const p = projectOf(v.tags);
    if (p) s.add(p);
  }
  return [...s].sort();
}
