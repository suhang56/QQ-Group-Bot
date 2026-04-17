import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GroupActivityTracker } from '../src/modules/group-activity-tracker.js';

describe('GroupActivityTracker', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-04-16T00:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('record + countIn: wider window sees more; narrower prunes older', () => {
    // Insert in real chronological order (oldest first) so prune can front-drop.
    const t = new GroupActivityTracker();
    const now = Date.now();
    t.record('g', now - 110_000);
    t.record('g', now - 80_000);
    t.record('g', now - 55_000);
    t.record('g', now - 30_000);
    t.record('g', now - 5_000);
    // Wide first — nothing pruned yet.
    expect(t.countIn('g', 120_000, now)).toBe(5);
    // Now narrow: prunes oldest two, leaves 3 inside 60s.
    expect(t.countIn('g', 60_000, now)).toBe(3);
  });

  it('per-group 60-item cap evicts oldest on overflow', () => {
    const t = new GroupActivityTracker();
    const now = Date.now();
    // 70 timestamps in chronological order, covering the last ~7s
    for (let i = 69; i >= 0; i--) t.record('g', now - i * 100);
    // Only 60 most recent survive; window covers all of them
    expect(t.countIn('g', 300_000, now)).toBe(60);
  });

  it('level busy boundary: exactly 8 in last 60s → busy; 7 → normal', () => {
    const tracker = new GroupActivityTracker();
    const now = Date.now();
    // 8 fresh peer messages 0..7s old → in60s = 8 → busy
    for (let i = 7; i >= 0; i--) tracker.record('g8', now - i * 1_000);
    expect(tracker.level('g8', now)).toBe('busy');

    // 7 fresh + padding outside 60s window so level is not idle
    const tracker7 = new GroupActivityTracker();
    // Padding: 10 msgs between 70s and 200s ago (outside 60s, inside 300s)
    for (let i = 9; i >= 0; i--) tracker7.record('g7', now - (70_000 + i * 10_000));
    // Fresh 7 in last 7s
    for (let i = 6; i >= 0; i--) tracker7.record('g7', now - i * 1_000);
    expect(tracker7.level('g7', now)).toBe('normal');
  });

  it('level idle boundary: 2 in 5min → idle; 3 → normal', () => {
    const tIdle = new GroupActivityTracker();
    const now = Date.now();
    tIdle.record('gi', now - 60_000);
    tIdle.record('gi', now - 10_000);
    expect(tIdle.level('gi', now)).toBe('idle');

    const tNormal = new GroupActivityTracker();
    tNormal.record('gn', now - 200_000);
    tNormal.record('gn', now - 60_000);
    tNormal.record('gn', now - 10_000);
    expect(tNormal.level('gn', now)).toBe('normal');
  });

  it('level transitions busy → normal → idle as time advances', () => {
    const t = new GroupActivityTracker();
    const t0 = Date.now();
    // 10 msgs over the last 25s → busy at t0
    for (let i = 9; i >= 0; i--) t.record('g', t0 - i * 2_500);
    expect(t.level('g', t0)).toBe('busy');

    // Advance 80s. All 10 msgs now 80..105s old → 0 in 60s, 10 in 300s → normal.
    vi.advanceTimersByTime(80_000);
    expect(t.level('g', Date.now())).toBe('normal');

    // Advance another 230s (total 310s since initial burst). Everything is
    // now >300s old → 0 in 300s window → idle.
    vi.advanceTimersByTime(230_000);
    expect(t.level('g', Date.now())).toBe('idle');
  });

  it('countIn prunes stale timestamps as a side effect', () => {
    const t = new GroupActivityTracker();
    const now = Date.now();
    t.record('g', now - 400_000);
    t.record('g', now - 350_000);
    t.record('g', now - 10_000);
    // Read with 60s window → should only count the fresh one, and prune stale
    expect(t.countIn('g', 60_000, now)).toBe(1);
    // A subsequent wider read confirms stale entries were dropped
    expect(t.countIn('g', 600_000, now)).toBe(1);
  });

  it('unknown group defaults to normal (insufficient data, no multiplier change)', () => {
    const t = new GroupActivityTracker();
    expect(t.level('nobody', Date.now())).toBe('normal');
    expect(t.countIn('nobody', 60_000, Date.now())).toBe(0);
  });

  it('group that had messages but all expired drops to idle (observed sparse)', () => {
    const t = new GroupActivityTracker();
    const now = Date.now();
    // One message 10 minutes ago: observed but fully outside the 5-min window.
    t.record('stale', now - 600_000);
    expect(t.level('stale', now)).toBe('idle');
  });

  it('cross-group isolation: one group busy does not leak into another', () => {
    const t = new GroupActivityTracker();
    const now = Date.now();
    for (let i = 9; i >= 0; i--) t.record('loud', now - i * 1_000);
    expect(t.level('loud', now)).toBe('busy');
    // 'quiet' never observed → normal (not idle) by new default
    expect(t.level('quiet', now)).toBe('normal');
  });
});
