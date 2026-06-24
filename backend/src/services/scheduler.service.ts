import cron from 'node-cron';
import { runScheduledBackups } from './matestate.service.js';

/**
 * Weekly MateState scheduler. Defaults to Sundays at 03:00 server time;
 * override with `MATESTATE_CRON` (5-field cron expression) in env.
 *
 * Run is idempotent enough that the only consequence of an overlapping
 * tick is wasted Proxmox effort, so a simple lock is plenty.
 */
let task: ReturnType<typeof cron.schedule> | null = null;
let running = false;

const DEFAULT_SCHEDULE = '0 3 * * 0'; // Sun 03:00

export function startScheduler(): void {
  if (task) return; // already started
  const schedule = process.env['MATESTATE_CRON'] || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    console.warn(`[scheduler] invalid MATESTATE_CRON "${schedule}", falling back to "${DEFAULT_SCHEDULE}"`);
  }
  const expr = cron.validate(schedule) ? schedule : DEFAULT_SCHEDULE;

  task = cron.schedule(expr, async () => {
    if (running) {
      console.log('[scheduler] previous backup run still in progress — skipping this tick');
      return;
    }
    running = true;
    const t0 = Date.now();
    try {
      console.log('[scheduler] starting weekly MateState backups');
      const result = await runScheduledBackups();
      console.log(`[scheduler] done: ${result.ran} ok, ${result.failed} failed in ${Math.round((Date.now() - t0) / 1000)}s`);
    } finally {
      running = false;
    }
  });

  console.log(`[scheduler] MateState backups scheduled (${expr})`);
}
