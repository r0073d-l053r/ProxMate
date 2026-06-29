import cron from 'node-cron';
import { runScheduledBackups, runDueBackups } from './matestate.service.js';
import { runDuePowerActions, previousCronOccurrence } from './power-schedule.service.js';
import { sampleResourceUsage, pruneResourceSamples } from './resource-history.service.js';
import { getConfig, setConfig } from './config.service.js';

/** SystemConfig key: ISO timestamp of the last successful weekly backup run. */
const LAST_RUN_KEY = 'matestate_last_run';

/**
 * Weekly MateState scheduler. Defaults to Sundays at 03:00 server time;
 * override with `MATESTATE_CRON` (5-field cron expression) in env.
 *
 * Run is idempotent enough that the only consequence of an overlapping
 * tick is wasted Proxmox effort, so a simple lock is plenty.
 */
let task: ReturnType<typeof cron.schedule> | null = null;
let powerTask: ReturnType<typeof cron.schedule> | null = null;
let backupTask: ReturnType<typeof cron.schedule> | null = null;
let historyTask: ReturnType<typeof cron.schedule> | null = null;
let running = false;
let powerRunning = false;
let backupRunning = false;
let historyRunning = false;

const DEFAULT_SCHEDULE = '0 3 * * 0'; // Sun 03:00

/** The effective weekly schedule (env override, validated, else the default). */
function resolveSchedule(): string {
  const schedule = process.env['MATESTATE_CRON'] || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    console.warn(`[scheduler] invalid MATESTATE_CRON "${schedule}", falling back to "${DEFAULT_SCHEDULE}"`);
    return DEFAULT_SCHEDULE;
  }
  return schedule;
}

/** Run the weekly backups under the lock and stamp the last-run marker. */
async function runWeeklyBackups(reason: string): Promise<void> {
  if (running) {
    console.log('[scheduler] weekly backup already in progress — skipping');
    return;
  }
  running = true;
  const t0 = Date.now();
  try {
    console.log(`[scheduler] starting weekly MateState backups (${reason})`);
    const result = await runScheduledBackups();
    await setConfig(LAST_RUN_KEY, new Date().toISOString());
    console.log(`[scheduler] done: ${result.ran} ok, ${result.failed} failed in ${Math.round((Date.now() - t0) / 1000)}s`);
  } finally {
    running = false;
  }
}

/**
 * Catch up a weekly backup that was missed because the backend was down at the
 * scheduled time. Compares the last-run marker against the most recent scheduled
 * occurrence; if we were down for it, runs the backups now. On first boot (no
 * marker) it just adopts the last window as satisfied, so a fresh install doesn't
 * immediately back up everything. Best-effort; safe to call once at startup.
 */
export async function catchUpMissedBackups(now: Date = new Date()): Promise<{ caughtUp: boolean; reason: string }> {
  const prev = previousCronOccurrence(resolveSchedule(), now);
  if (!prev) return { caughtUp: false, reason: 'no prior occurrence in window' };

  const lastRunStr = await getConfig(LAST_RUN_KEY);
  if (!lastRunStr) {
    await setConfig(LAST_RUN_KEY, prev.toISOString());
    return { caughtUp: false, reason: 'initialized marker (first boot)' };
  }

  if (new Date(lastRunStr).getTime() < prev.getTime()) {
    console.warn(
      `[scheduler] missed the weekly backup window at ${prev.toISOString()} ` +
        `(last run ${lastRunStr}) — catching up now`,
    );
    await runWeeklyBackups('catch-up');
    return { caughtUp: true, reason: 'missed window caught up' };
  }
  return { caughtUp: false, reason: 'up to date' };
}

export function startScheduler(): void {
  if (task) return; // already started
  const expr = resolveSchedule();

  task = cron.schedule(expr, () => void runWeeklyBackups('scheduled'));

  console.log(`[scheduler] MateState backups scheduled (${expr})`);

  // Catch up a window we may have slept through (backend was down at 03:00).
  // Deferred slightly so the server finishes booting before any vzdump storm.
  setTimeout(() => {
    void catchUpMissedBackups().catch((err) => console.error('[scheduler] catch-up check failed:', err));
  }, 10_000);

  // Per-minute tick that applies due per-VM power schedules (auto start/stop).
  powerTask = cron.schedule('* * * * *', async () => {
    if (powerRunning) return; // a slow tick is still working — skip
    powerRunning = true;
    try {
      const r = await runDuePowerActions(new Date());
      if (r.started || r.stopped) {
        console.log(`[scheduler] power schedule: ${r.started} started, ${r.stopped} stopped`);
      }
    } catch (err) {
      console.error('[scheduler] power-schedule tick failed:', err);
    } finally {
      powerRunning = false;
    }
  });

  console.log('[scheduler] per-VM power schedules active (1-min tick)');

  // Per-minute tick that takes per-VM scheduled backups as their cron fires.
  // Separate lock from power actions: a slow vzdump must never block start/stop.
  backupTask = cron.schedule('* * * * *', async () => {
    if (backupRunning) return; // a previous (slow) backup tick is still working — skip
    backupRunning = true;
    try {
      const r = await runDueBackups(new Date());
      if (r.ran || r.failed) {
        console.log(`[scheduler] per-VM backups: ${r.ran} ok, ${r.failed} failed`);
      }
    } catch (err) {
      console.error('[scheduler] per-VM backup tick failed:', err);
    } finally {
      backupRunning = false;
    }
  });

  console.log('[scheduler] per-VM backup schedules active (1-min tick)');

  // Per-tenant resource history: sample every running VM's live usage every 5
  // minutes (for the admin "usage" view) and prune the rolling window each tick.
  historyTask = cron.schedule('*/5 * * * *', async () => {
    if (historyRunning) return;
    historyRunning = true;
    try {
      const { sampled } = await sampleResourceUsage();
      const pruned = await pruneResourceSamples();
      if (sampled || pruned) console.log(`[scheduler] resource history: +${sampled} samples, -${pruned} pruned`);
    } catch (err) {
      console.error('[scheduler] resource-history tick failed:', err);
    } finally {
      historyRunning = false;
    }
  });

  console.log('[scheduler] per-tenant resource history active (5-min sampling)');
}
