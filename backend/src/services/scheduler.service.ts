import cron from 'node-cron';
import { runScheduledBackups, runDueBackups } from './matestate.service.js';
import { runDuePowerActions, previousCronOccurrence, reportInvalidStoredCrons } from './power-schedule.service.js';
import { sampleResourceUsage, pruneResourceSamples } from './resource-history.service.js';
import { evaluateAlerts } from './alert.service.js';
import { refreshAllTemplates } from './template.service.js';
import { runAutoBalance } from './cluster-balancer.service.js';
import { runAppDbBackup } from './appdb-backup.service.js';
import { runAccessExpiryTick } from './access-sweep.service.js';
import { getConfig, setConfig } from './config.service.js';
import { runGuestMarkerBackfill } from './vm.service.js';
import { advanceDeployingVms } from './deploy-lock.service.js';

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
let balancerTask: ReturnType<typeof cron.schedule> | null = null;
let templateTask: ReturnType<typeof cron.schedule> | null = null;
let appDbTask: ReturnType<typeof cron.schedule> | null = null;
let accessTask: ReturnType<typeof cron.schedule> | null = null;
let accessRunning = false;
let markerTask: ReturnType<typeof cron.schedule> | null = null;
let markerRunning = false;
let running = false;
let powerRunning = false;
let deployLockRunning = false;
let backupRunning = false;
let historyRunning = false;
let balancerRunning = false;
let templateRunning = false;
let appDbRunning = false;

const DEFAULT_SCHEDULE = '0 3 * * 0'; // Sun 03:00
const DEFAULT_BALANCER_SCHEDULE = '*/15 * * * *'; // every 15 min (auto mode only)
const DEFAULT_TEMPLATE_SCHEDULE = '0 4 1 * *'; // 1st of the month, 04:00 (when enabled)
const DEFAULT_APPDB_SCHEDULE = '30 2 * * *'; // nightly 02:30 (no-op until a dir is configured)

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
  } catch (err) {
    // The cron callback can't await this, so an error escaping here (the VM query
    // or the marker write — per-VM failures are already caught) would be an
    // unhandled rejection and take the whole process down. The marker stays old,
    // so the next boot's catch-up retries the window.
    console.error('[scheduler] weekly MateState backups failed:', err);
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

/**
 * One guest-ownership-tag backfill tick (every 15 min). A no-op once a pass has
 * completed without a Proxmox error; until then each tick retries, so guests the
 * boot pass couldn't reach still get tagged. Exported for tests.
 */
export async function guestMarkerBackfillTick(): Promise<void> {
  if (markerRunning) return;
  markerRunning = true;
  try {
    const r = await runGuestMarkerBackfill();
    if (r.ran && (r.tagged || r.errors)) {
      console.log(`[scheduler] ownership tags: ${r.tagged} tagged, ${r.unmatched} unmatched, ${r.errors} Proxmox error(s)`);
    }
  } catch (err) {
    console.error('[scheduler] ownership tag backfill failed:', err);
  } finally {
    markerRunning = false;
  }
}

/** One cloud-init deploy-lock tick (every minute). Exported for tests. */
export async function deployLockTick(): Promise<void> {
  if (deployLockRunning) return; // probes are slow; never stack ticks
  deployLockRunning = true;
  try {
    const r = await advanceDeployingVms();
    if (r.ready) console.log(`[scheduler] deploy lock: ${r.ready} of ${r.checked} machine(s) finished deploying`);
  } catch (err) {
    console.error('[scheduler] deploy-lock tick failed:', err);
  } finally {
    deployLockRunning = false;
  }
}

export function startScheduler(): void {
  if (task) return; // already started
  markerTask = cron.schedule('*/15 * * * *', () => void guestMarkerBackfillTick());
  const expr = resolveSchedule();

  task = cron.schedule(expr, () => void runWeeklyBackups('scheduled'));

  console.log(`[scheduler] MateState backups scheduled (${expr})`);

  // Catch up a window we may have slept through (backend was down at 03:00).
  // Deferred slightly so the server finishes booting before any vzdump storm.
  setTimeout(() => {
    void catchUpMissedBackups().catch((err) => console.error('[scheduler] catch-up check failed:', err));
  }, 10_000);

  // Schedules stored before validation was strict may never fire; say so once at boot.
  setTimeout(() => void reportInvalidStoredCrons(), 20_000);

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

  // Per-minute tick that advances the cloud-init deploy lock (and applies the
  // pending login password) for machines nobody has opened in the UI.
  cron.schedule('* * * * *', () => void deployLockTick());

  // Per-minute tick that takes per-VM scheduled backups as their cron fires.
  // Separate lock from power actions: a slow vzdump must never block start/stop.
  backupTask = cron.schedule('* * * * *', () => void perVmBackupTick());

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
      // Evaluate per-VM tenant alerts on the same cadence (reuses the live sample).
      const { fired } = await evaluateAlerts();
      if (fired) console.log(`[scheduler] alerts: ${fired} fired`);
    } catch (err) {
      console.error('[scheduler] resource-history tick failed:', err);
    } finally {
      historyRunning = false;
    }
  });

  console.log('[scheduler] per-tenant resource history + alerts active (5-min sampling)');

  // Cluster Balancer: when auto mode is enabled, even out node memory load by
  // live-migrating guests. A no-op (and cheap) while the mode is off/recommend.
  const balancerExpr = process.env['BALANCER_CRON'] && cron.validate(process.env['BALANCER_CRON'])
    ? process.env['BALANCER_CRON']
    : DEFAULT_BALANCER_SCHEDULE;
  balancerTask = cron.schedule(balancerExpr, async () => {
    if (balancerRunning) return; // a long live-migration pass is still working — skip
    balancerRunning = true;
    try {
      const r = await runAutoBalance();
      if (r.applied > 0) console.log(`[scheduler] cluster balancer: ${r.applied} migration(s) applied — ${r.reason}`);
    } catch (err) {
      console.error('[scheduler] cluster-balancer tick failed:', err);
    } finally {
      balancerRunning = false;
    }
  });

  console.log(`[scheduler] cluster balancer active (${balancerExpr}, auto mode only)`);

  // Cloud-image freshness: monthly, rebuild every refreshable template so new
  // deploys start from a patched base. Off unless the admin enables it
  // (`template_refresh_enabled`); the tick itself is a no-op while disabled.
  const templateExpr = process.env['TEMPLATE_REFRESH_CRON'] && cron.validate(process.env['TEMPLATE_REFRESH_CRON'])
    ? process.env['TEMPLATE_REFRESH_CRON']
    : DEFAULT_TEMPLATE_SCHEDULE;
  templateTask = cron.schedule(templateExpr, async () => {
    if (templateRunning) return;
    if ((await getConfig('template_refresh_enabled')) !== 'true') return;
    templateRunning = true;
    try {
      const { refreshed, failed } = await refreshAllTemplates();
      if (refreshed || failed) console.log(`[scheduler] template refresh: ${refreshed} ok, ${failed} failed`);
    } catch (err) {
      console.error('[scheduler] template-refresh tick failed:', err);
    } finally {
      templateRunning = false;
    }
  });

  console.log(`[scheduler] cloud-image refresh scheduled (${templateExpr}, when enabled)`);

  // ProxMate's OWN database: nightly snapshot to the admin-configured directory
  // (VACUUM INTO — safe on the live DB). A cheap no-op until a dir is set.
  const appDbExpr =
    process.env['APPDB_BACKUP_CRON'] && cron.validate(process.env['APPDB_BACKUP_CRON'])
      ? process.env['APPDB_BACKUP_CRON']
      : DEFAULT_APPDB_SCHEDULE;
  appDbTask = cron.schedule(appDbExpr, async () => {
    if (appDbRunning) return;
    appDbRunning = true;
    try {
      const r = await runAppDbBackup();
      if (r.ran) console.log(`[scheduler] app-db backup: ${r.file} (pruned ${r.pruned ?? 0})`);
    } catch (err) {
      console.error('[scheduler] app-db backup tick failed:', err);
    } finally {
      appDbRunning = false;
    }
  });

  console.log(`[scheduler] app-db backups scheduled (${appDbExpr}, when a directory is configured)`);

  // Tenant compute-access windows: warn, then suspend when one closes.
  // HOURLY, not daily — refusing sign-in is instantaneous (it's a per-request
  // check), but a lapsed tenant's guests would otherwise keep burning cluster
  // resources for up to a day. Two indexed queries and an early return when
  // nothing is due. :20 keeps it clear of the 02:30 app-db snapshot and the
  // Sunday 03:00 backup window.
  const accessExpr =
    process.env['ACCESS_EXPIRY_CRON'] && cron.validate(process.env['ACCESS_EXPIRY_CRON'])
      ? process.env['ACCESS_EXPIRY_CRON']
      : '20 * * * *';
  accessTask = cron.schedule(accessExpr, () => void accessTick());

  // Catch-up: the backend may have been down across a deadline, and a tenant
  // whose window closed overnight should not get a free extra hour.
  setTimeout(() => void accessTick(), 15_000);

  console.log(`[scheduler] access-expiry sweep scheduled (${accessExpr})`);
}

/** SystemConfig key: ISO timestamp of the minute the last per-VM backup tick covered. */
const VM_BACKUP_TICK_KEY = 'matestate_vm_tick_last';

/** The minute the last per-VM backup tick covered (null until the first one runs). */
let lastBackupTickAt: Date | null = null;

/**
 * One per-VM backup tick. Backups run one after another and each can take many
 * minutes, so ticks that fire meanwhile return at once — and the next tick that
 * does run covers every minute since the last one that ran, so a schedule that
 * fired during someone else's vzdump is still backed up. Exported for tests.
 */
export async function perVmBackupTick(now: Date = new Date()): Promise<void> {
  if (backupRunning) return; // a previous (slow) backup tick is still working — the next one catches up
  backupRunning = true;
  try {
    // The marker is also kept in SystemConfig, so schedules that fired while the
    // backend was down (up to the 24 h catch-up cap) are backed up after a restart.
    let since = lastBackupTickAt ?? undefined;
    if (!since) {
      const stored = await Promise.resolve(getConfig(VM_BACKUP_TICK_KEY)).catch(() => null);
      const parsed = stored ? new Date(stored) : null;
      since = parsed && !Number.isNaN(parsed.getTime()) && parsed < now ? parsed : undefined;
    }
    lastBackupTickAt = now;
    await Promise.resolve(setConfig(VM_BACKUP_TICK_KEY, now.toISOString())).catch(() => undefined);
    const r = await runDueBackups(now, since);
    if (r.ran || r.failed) {
      console.log(`[scheduler] per-VM backups: ${r.ran} ok, ${r.failed} failed`);
    }
  } catch (err) {
    console.error('[scheduler] per-VM backup tick failed:', err);
  } finally {
    backupRunning = false;
  }
}

async function accessTick(): Promise<void> {
  if (accessRunning) return;
  accessRunning = true;
  try {
    const r = await runAccessExpiryTick(new Date());
    if (r.suspended || r.warned) {
      console.log(
        `[scheduler] access expiry: ${r.suspended} suspended (${r.stopped} guest(s) stopped), ${r.warned} warned`,
      );
    }
  } catch (err) {
    console.error('[scheduler] access-expiry tick failed:', err);
  } finally {
    accessRunning = false;
  }
}
