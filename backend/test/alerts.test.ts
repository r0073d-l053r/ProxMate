import { describe, it, expect } from 'vitest';

// Pure functions — no prisma/proxmox, so no mocking needed.
import { conditionMet, evaluateRule, describeAlert, type VmSignals } from '../src/services/alert.service.js';

const signals = (over: Partial<VmSignals> = {}): VmSignals => ({
  running: true,
  expectedRunning: true,
  cpuPct: 0,
  memPct: 0,
  diskPct: null,
  ...over,
});

const min = (n: number) => n * 60_000;
const t0 = new Date('2026-07-02T12:00:00Z');
const at = (ms: number) => new Date(t0.getTime() + ms);

describe('conditionMet', () => {
  it('cpu/memory fire at or above threshold, only while running', () => {
    expect(conditionMet({ metric: 'cpu', threshold: 85 }, signals({ cpuPct: 85 }))).toBe(true);
    expect(conditionMet({ metric: 'cpu', threshold: 85 }, signals({ cpuPct: 84 }))).toBe(false);
    expect(conditionMet({ metric: 'cpu', threshold: 85 }, signals({ cpuPct: 99, running: false }))).toBe(false);
    expect(conditionMet({ metric: 'memory', threshold: 90 }, signals({ memPct: 95 }))).toBe(true);
  });

  it('disk needs a known percentage (null → never fires)', () => {
    expect(conditionMet({ metric: 'disk', threshold: 90 }, signals({ diskPct: 92 }))).toBe(true);
    expect(conditionMet({ metric: 'disk', threshold: 90 }, signals({ diskPct: null }))).toBe(false);
  });

  it('down fires only when expected-running but not running', () => {
    expect(conditionMet({ metric: 'down', threshold: 0 }, signals({ running: false, expectedRunning: true }))).toBe(true);
    // A guest ProxMate intentionally stopped (expectedRunning false) does NOT alert.
    expect(conditionMet({ metric: 'down', threshold: 0 }, signals({ running: false, expectedRunning: false }))).toBe(false);
    expect(conditionMet({ metric: 'down', threshold: 0 }, signals({ running: true, expectedRunning: true }))).toBe(false);
  });
});

const rule = (over: Record<string, unknown> = {}) => ({
  metric: 'cpu',
  threshold: 85,
  sustainedMin: 10,
  breachingSince: null as Date | null,
  lastFiredAt: null as Date | null,
  ...over,
});

describe('evaluateRule — sustain + cooldown state machine', () => {
  it('first breach records the start but does not fire yet', () => {
    const a = evaluateRule(rule(), signals({ cpuPct: 90 }), t0);
    expect(a).toEqual({ kind: 'start-breach', breachingSince: t0 });
  });

  it('does not fire until the condition has held for sustainedMin', () => {
    const started = rule({ breachingSince: t0 });
    // 9 minutes in — not yet.
    expect(evaluateRule(started, signals({ cpuPct: 90 }), at(min(9))).kind).toBe('none');
    // 10 minutes in — fires.
    const fired = evaluateRule(started, signals({ cpuPct: 90 }), at(min(10)));
    expect(fired.kind).toBe('fire');
    if (fired.kind === 'fire') {
      expect(fired.breachingSince).toEqual(t0);
      expect(fired.lastFiredAt).toEqual(at(min(10)));
    }
  });

  it('clears the breach when the condition goes back to normal', () => {
    const started = rule({ breachingSince: t0 });
    expect(evaluateRule(started, signals({ cpuPct: 50 }), at(min(11)))).toEqual({ kind: 'clear-breach' });
  });

  it('is quiet during the cooldown after firing, then can fire again', () => {
    // Fired 30 min ago (cooldown default 60 min), still breaching since t0.
    const recentlyFired = rule({ breachingSince: t0, lastFiredAt: at(min(10)) });
    expect(evaluateRule(recentlyFired, signals({ cpuPct: 90 }), at(min(40))).kind).toBe('none');
    // 71 min after firing — cooldown elapsed, fires again.
    expect(evaluateRule(recentlyFired, signals({ cpuPct: 90 }), at(min(81))).kind).toBe('fire');
  });

  it('a down rule fires immediately once sustainedMin has elapsed', () => {
    const down = rule({ metric: 'down', threshold: 0, sustainedMin: 5, breachingSince: t0 });
    expect(evaluateRule(down, signals({ running: false }), at(min(5))).kind).toBe('fire');
  });
});

describe('describeAlert', () => {
  it('summaries name the metric and current value', () => {
    expect(describeAlert({ metric: 'cpu', threshold: 85, sustainedMin: 10 }, signals({ cpuPct: 91 }))).toMatch(/CPU.*85%.*10 min.*91%/);
    expect(describeAlert({ metric: 'down', threshold: 0, sustainedMin: 5 }, signals({ running: false }))).toMatch(/no longer running/i);
    expect(describeAlert({ metric: 'disk', threshold: 90, sustainedMin: 5 }, signals({ diskPct: 93 }))).toMatch(/93%/);
  });
});
