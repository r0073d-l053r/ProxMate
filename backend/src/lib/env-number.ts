/**
 * Read a numeric tunable from the environment. Unset, empty or non-numeric
 * values fall back to `fallback`; a number below `min` is raised to `min`.
 *
 * `Math.max(min, Number(value))` alone is not enough: a typo such as `abc`
 * yields NaN, NaN survives Math.max, and every comparison with NaN is false —
 * so a threshold or interval would quietly stop working instead of using its
 * default. (A NaN rate limit, for instance, switches the limiter off.)
 */
export function envNumber(
  name: string,
  fallback: number,
  min = -Infinity,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return Math.max(min, fallback);
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(min, value) : Math.max(min, fallback);
}
