import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startRssGuard, parseRssLimit } from '../../src/utils/rss-guard.js';

function mockLogger(): { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  return { error: vi.fn(), warn: vi.fn() };
}

function mockMemoryUsage(rssMb: number): void {
  vi.spyOn(process, 'memoryUsage').mockReturnValue({
    rss: rssMb * 1024 * 1024,
    heapTotal: 0,
    heapUsed: 0,
    external: 0,
    arrayBuffers: 0,
  });
}

describe('startRssGuard (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('T1: under threshold — no exit, no error log', () => {
    const logger = mockLogger();
    const exitFn = vi.fn();
    mockMemoryUsage(500);

    startRssGuard({ maxRssMb: 1500, intervalMs: 30_000 }, logger, exitFn);
    vi.advanceTimersByTime(30_000);

    expect(exitFn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('T2: over threshold — exits with 1 and logs structured error', () => {
    const logger = mockLogger();
    const exitFn = vi.fn();
    mockMemoryUsage(2000);

    startRssGuard({ maxRssMb: 1500, intervalMs: 30_000 }, logger, exitFn);
    vi.advanceTimersByTime(30_000);

    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      { rssMb: 2000, limit: 1500 },
      'memory limit exceeded — exiting for service auto-restart',
    );
  });

  it('T3: stop() prevents firing even when over threshold', () => {
    const logger = mockLogger();
    const exitFn = vi.fn();
    mockMemoryUsage(2000);

    const guard = startRssGuard({ maxRssMb: 1500, intervalMs: 30_000 }, logger, exitFn);
    guard.stop();
    vi.advanceTimersByTime(30_000);

    expect(exitFn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('T4: triggered flag — exitFn fires only once across multiple ticks', () => {
    const logger = mockLogger();
    const exitFn = vi.fn();
    mockMemoryUsage(2000);

    startRssGuard({ maxRssMb: 1500, intervalMs: 30_000 }, logger, exitFn);
    vi.advanceTimersByTime(90_000);

    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('T6: exact-threshold boundary — no exit (strict greater-than)', () => {
    const logger = mockLogger();
    const exitFn = vi.fn();
    mockMemoryUsage(1500);

    startRssGuard({ maxRssMb: 1500, intervalMs: 30_000 }, logger, exitFn);
    vi.advanceTimersByTime(30_000);

    expect(exitFn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('startRssGuard — unref (real timers)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T5: timer.unref() is invoked exactly once', () => {
    const logger = mockLogger();
    const exitFn = vi.fn();
    const unref = vi.fn();
    const fakeHandle = {
      unref,
      [Symbol.toPrimitive]: () => 0,
    } as unknown as NodeJS.Timeout;

    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue(fakeHandle);

    const guard = startRssGuard({ maxRssMb: 1500, intervalMs: 30_000 }, logger, exitFn);
    guard.stop();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
  });
});

describe('parseRssLimit', () => {
  it('T7a: undefined returns default 1500', () => {
    expect(parseRssLimit(undefined)).toBe(1500);
  });

  it("T7b: '1500' returns 1500", () => {
    expect(parseRssLimit('1500')).toBe(1500);
  });

  it("T7c: '0' returns null (disabled)", () => {
    expect(parseRssLimit('0')).toBeNull();
  });

  it("T7d: '-100' returns null (negative invalid)", () => {
    expect(parseRssLimit('-100')).toBeNull();
  });

  it("T7e: 'abc' returns null (NaN)", () => {
    expect(parseRssLimit('abc')).toBeNull();
  });

  it("T7f: '1500.7' returns 1500 (parseInt truncates)", () => {
    expect(parseRssLimit('1500.7')).toBe(1500);
  });

  it("T7g: 'Infinity' returns null (not finite)", () => {
    expect(parseRssLimit('Infinity')).toBeNull();
  });
});
