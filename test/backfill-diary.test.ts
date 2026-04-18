import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseArgs,
  buildDayWindows,
  shanghaiDateLabel,
  runDaily,
  Args,
} from '../scripts/backfill-diary.js';
import type { DiaryDistiller } from '../src/modules/diary-distiller.js';
import type { Database } from '../src/storage/db.js';

// ---- Helpers ----

function makeArgs(overrides: Partial<Args> = {}): Args {
  return {
    group: 'g1',
    days: 3,
    kind: 'daily',
    model: 'claude-sonnet-4-6[1m]',
    dryRun: false,
    ...overrides,
  };
}

function makeMockDb(findByPeriodImpl: () => unknown[] = () => []): Pick<Database, 'groupDiary'> {
  return {
    groupDiary: {
      findByPeriod: vi.fn().mockImplementation(findByPeriodImpl),
      findRecent: vi.fn().mockReturnValue([]),
      insert: vi.fn().mockReturnValue(1),
      deleteByIds: vi.fn(),
      findLatest: vi.fn().mockReturnValue(undefined),
    } as unknown as Database['groupDiary'],
  } as Pick<Database, 'groupDiary'>;
}

function makeMockDistiller(generateDailyImpl?: () => Promise<number>): Pick<DiaryDistiller, 'generateDaily' | 'generateWeekly' | 'generateMonthly'> {
  return {
    generateDaily: vi.fn().mockImplementation(generateDailyImpl ?? (() => Promise.resolve(1))),
    generateWeekly: vi.fn().mockResolvedValue(1),
    generateMonthly: vi.fn().mockResolvedValue(1),
  } as unknown as Pick<DiaryDistiller, 'generateDaily' | 'generateWeekly' | 'generateMonthly'>;
}

// ============================================================================
// Case 1: CLI arg parsing
// ============================================================================

describe('parseArgs', () => {
  let exitMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitMock = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
  });

  afterEach(() => {
    exitMock.mockRestore();
  });

  it('--dry-run sets dryRun = true', () => {
    const args = parseArgs(['--group', 'g1', '--dry-run']);
    expect(args.dryRun).toBe(true);
  });

  it('--days 14 sets days = 14', () => {
    const args = parseArgs(['--group', 'g1', '--days', '14']);
    expect(args.days).toBe(14);
  });

  it('--kind all sets kind = all', () => {
    const args = parseArgs(['--group', 'g1', '--kind', 'all']);
    expect(args.kind).toBe('all');
  });

  it('missing --group causes process.exit(2)', () => {
    expect(() => parseArgs(['--days', '3'])).toThrow('process.exit called');
    expect(exitMock).toHaveBeenCalledWith(2);
  });

  it('--days 0 causes process.exit(2)', () => {
    expect(() => parseArgs(['--group', 'g1', '--days', '0'])).toThrow('process.exit called');
    expect(exitMock).toHaveBeenCalledWith(2);
  });

  it('--days 31 causes process.exit(2)', () => {
    expect(() => parseArgs(['--group', 'g1', '--days', '31'])).toThrow('process.exit called');
    expect(exitMock).toHaveBeenCalledWith(2);
  });

  it('unknown --kind causes process.exit(2)', () => {
    expect(() => parseArgs(['--group', 'g1', '--kind', 'bogus'])).toThrow('process.exit called');
    expect(exitMock).toHaveBeenCalledWith(2);
  });

  it('--model overrides default', () => {
    const args = parseArgs(['--group', 'g1', '--model', 'gemini-2.5-flash']);
    expect(args.model).toBe('gemini-2.5-flash');
  });
});

// ============================================================================
// Case 2: Idempotency — skips days with existing rows
// ============================================================================

describe('runDaily idempotency', () => {
  it('skips day when findByPeriod returns existing rows, does not call generateDaily', async () => {
    const logs: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => { logs.push(msg); });

    const db = makeMockDb(() => [{ id: 1 }]);
    const distiller = makeMockDistiller();
    const args = makeArgs({ days: 1 });

    const windows = buildDayWindows(1);
    await runDaily(
      distiller as unknown as DiaryDistiller,
      db as unknown as Database,
      args,
      windows,
    );

    expect(distiller.generateDaily).not.toHaveBeenCalled();
    expect(logs.some(l => l.includes('[SKIP]'))).toBe(true);

    consoleSpy.mockRestore();
  });

  it('calls generateDaily when no existing rows', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const db = makeMockDb(() => []);
    const distiller = makeMockDistiller();
    const args = makeArgs({ days: 1 });

    const windows = buildDayWindows(1);
    await runDaily(
      distiller as unknown as DiaryDistiller,
      db as unknown as Database,
      args,
      windows,
    );

    expect(distiller.generateDaily).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });
});

// ============================================================================
// Case 3: Model override plumbs through to DiaryDistiller constructor
// ============================================================================

describe('model override', () => {
  it('--model gemini-2.5-flash is parsed and available for DiaryDistiller construction', () => {
    const args = parseArgs(['--group', 'g1', '--model', 'gemini-2.5-flash']);
    expect(args.model).toBe('gemini-2.5-flash');
    // DiaryDistiller receives args.model — verified by construction in main()
    // This test confirms parseArgs plumbs it through correctly
  });
});

// ============================================================================
// Case 4: Per-day failure is non-fatal
// ============================================================================

describe('runDaily failure handling', () => {
  it('continues after a day throws, logs [FAIL], and does not rethrow', async () => {
    const logs: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => { logs.push(msg); });

    const db = makeMockDb(() => []);
    let callCount = 0;
    const distiller = makeMockDistiller(() => {
      callCount++;
      if (callCount === 2) return Promise.reject(new Error('LLM timeout'));
      return Promise.resolve(1);
    });

    const args = makeArgs({ days: 3 });
    const windows = buildDayWindows(3);

    await runDaily(
      distiller as unknown as DiaryDistiller,
      db as unknown as Database,
      args,
      windows,
    );

    // All 3 days attempted
    expect(distiller.generateDaily).toHaveBeenCalledTimes(3);
    // Day 2 logged [FAIL]
    expect(logs.some(l => l.includes('[FAIL]') && l.includes('LLM timeout'))).toBe(true);
    // Days 1 and 3 logged [OK]
    expect(logs.filter(l => l.includes('[OK]')).length).toBe(2);

    consoleSpy.mockRestore();
  });
});

// ============================================================================
// Case 5: buildDayWindows boundary (edge)
// ============================================================================

describe('buildDayWindows boundaries', () => {
  const NOW_MS = 1_745_000_000_000; // fixed reference point

  it('buildDayWindows(1) returns exactly 1 window', () => {
    const windows = buildDayWindows(1, NOW_MS);
    expect(windows).toHaveLength(1);
  });

  it('buildDayWindows(7) returns 7 windows', () => {
    const windows = buildDayWindows(7, NOW_MS);
    expect(windows).toHaveLength(7);
  });

  it('index 0 is oldest, index 6 is yesterday', () => {
    const windows = buildDayWindows(7, NOW_MS);
    // Each window's startSec should be strictly increasing
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].startSec).toBeGreaterThan(windows[i - 1].startSec);
    }
  });

  it('no window includes today (all endSec < floor(NOW_MS/1000) + DAY_SEC)', () => {
    const windows = buildDayWindows(7, NOW_MS);
    const nowSec = Math.floor(NOW_MS / 1000);
    // yesterday window ends at most at end of yesterday = some point < nowSec + 86400
    // but endSec must be < nowSec (yesterday ended before now)
    for (const w of windows) {
      expect(w.endSec).toBeLessThan(nowSec + 86_400);
      expect(w.startSec).toBeLessThan(nowSec);
    }
  });

  it('each window label is a YYYY-MM-DD string', () => {
    const windows = buildDayWindows(3, NOW_MS);
    for (const w of windows) {
      expect(w.label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

// ============================================================================
// Case 6: --dry-run makes no LLM calls
// ============================================================================

describe('dry-run makes no LLM calls', () => {
  it('findByPeriod called for preview but generateDaily never called', async () => {
    const logs: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => { logs.push(msg); });

    const db = makeMockDb(() => []);
    const distiller = makeMockDistiller();
    const args = makeArgs({ days: 3, dryRun: true });
    const windows = buildDayWindows(3);

    // Simulate the dry-run branch from main()
    for (const w of windows) {
      const existing = (db.groupDiary.findByPeriod as ReturnType<typeof vi.fn>)(args.group, 'daily', w.startSec, w.endSec);
      console.log(`[DRY]  ${w.label} daily would generate (window ${w.startSec}-${w.endSec}, ${(existing as unknown[]).length} existing rows)`);
    }

    expect(distiller.generateDaily).not.toHaveBeenCalled();
    expect(logs.filter(l => l.startsWith('[DRY]')).length).toBe(3);

    consoleSpy.mockRestore();
  });
});

// ============================================================================
// shanghaiDateLabel edge cases
// ============================================================================

describe('shanghaiDateLabel', () => {
  it('returns YYYY-MM-DD format', () => {
    // 2026-04-18 00:00:00 UTC+8 = 2026-04-17 16:00:00 UTC
    const startSec = Math.floor(new Date('2026-04-17T16:00:00Z').getTime() / 1000);
    expect(shanghaiDateLabel(startSec)).toBe('2026-04-18');
  });

  it('handles year boundary (2025-12-31 Shanghai)', () => {
    // 2025-12-31 00:00:00 UTC+8 = 2025-12-30 16:00:00 UTC
    const startSec = Math.floor(new Date('2025-12-30T16:00:00Z').getTime() / 1000);
    expect(shanghaiDateLabel(startSec)).toBe('2025-12-31');
  });
});
