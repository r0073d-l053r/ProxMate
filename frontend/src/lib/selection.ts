/**
 * The selected items the user can actually see, in on-screen order. Bulk actions
 * act on this, not on the raw selection: ticking a row and then switching the
 * filter must not let a delete reach a VM that is no longer on screen.
 */
export function visibleSelection<T extends { id: string }>(selected: ReadonlySet<string>, shown: readonly T[]): T[] {
  return shown.filter((item) => selected.has(item.id));
}
