/**
 * An in-memory stand-in for one User row whose writes behave like the database
 * for the lockout counters: `{ increment }` applies to the CURRENT stored value,
 * and a conditional `updateMany` matches only while its `where` holds at the
 * moment it runs. Each write yields first, so concurrent callers interleave the
 * way parallel requests do.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function matches(row: Row, where: Where): boolean {
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'id') continue;
    if (k === 'OR') {
      if (!(cond as Where[]).some((c) => matches(row, c))) return false;
      continue;
    }
    const v = row[k] as number | Date | null;
    if (cond === null) {
      if (v !== null) return false;
      continue;
    }
    if (typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, number | Date | null>;
      if ('lt' in c && !(v !== null && v < c.lt!)) return false;
      if ('lte' in c && !(v !== null && v <= c.lte!)) return false;
      if ('gt' in c && !(v !== null && v > c.gt!)) return false;
      if ('gte' in c && !(v !== null && v >= c.gte!)) return false;
      if ('not' in c && c.not === null && v === null) return false;
      continue;
    }
    if (v !== cond) return false;
  }
  return true;
}

function apply(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    row[k] = v && typeof v === 'object' && 'increment' in v ? (row[k] as number) + (v as { increment: number }).increment : v;
  }
}

/** Implementations for prisma.user.update / updateMany / findUnique backed by `row`. */
export function fakeUserWrites<T extends Row>(row: T) {
  return {
    update: async (args: { data: Row }) => {
      await Promise.resolve();
      apply(row, args.data);
      return { ...row };
    },
    updateMany: async (args: { where: Where; data: Row }) => {
      await Promise.resolve();
      if (!matches(row, args.where)) return { count: 0 };
      apply(row, args.data);
      return { count: 1 };
    },
    findUnique: async () => ({ ...row }),
  };
}
