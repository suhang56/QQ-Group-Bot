import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  safeSetTimeout,
  SAFE_MAX_TIMEOUT_MS,
} from '../../src/utils/safe-set-timeout.js';

describe('safeSetTimeout', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    warnSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  function expectNoOverflowWarning(): void {
    for (const call of warnSpy.mock.calls) {
      const arg = call[0];
      const text = typeof arg === 'string' ? arg : (arg as Error)?.message ?? '';
      expect(text).not.toMatch(/TimeoutOverflowWarning/);
    }
  }

  it('short delay fires once after target ms (no chunking)', () => {
    const fn = vi.fn();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    safeSetTimeout(5_000, fn);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(4_999);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expectNoOverflowWarning();
  });

  it('30-day delay fires exactly once at the correct elapsed time', () => {
    const fn = vi.fn();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const THIRTY_DAYS = 30 * 86_400_000;

    safeSetTimeout(THIRTY_DAYS, fn);

    vi.advanceTimersByTime(THIRTY_DAYS - 1);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);

    // 30 days = 2,592,000,000 ms; SAFE_MAX_TIMEOUT_MS = 2,000,000,000 ms.
    // Expect exactly 2 chunks: first SAFE_MAX, then remaining ~592M.
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    expectNoOverflowWarning();
  });

  it('cancel() before fire prevents callback', () => {
    const fn = vi.fn();
    const timer = safeSetTimeout(5_000, fn);

    vi.advanceTimersByTime(1_000);
    timer.cancel();

    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
    expectNoOverflowWarning();
  });

  it('cancel() during intermediate chunk prevents callback', () => {
    const fn = vi.fn();
    const THIRTY_DAYS = 30 * 86_400_000;
    const timer = safeSetTimeout(THIRTY_DAYS, fn);

    // advance past first SAFE_MAX chunk so we are mid-chain awaiting the 2nd chunk
    vi.advanceTimersByTime(SAFE_MAX_TIMEOUT_MS + 1);
    timer.cancel();

    vi.advanceTimersByTime(THIRTY_DAYS);
    expect(fn).not.toHaveBeenCalled();
    expectNoOverflowWarning();
  });

  it('exact SAFE_MAX_TIMEOUT_MS boundary fires once with no chaining', () => {
    const fn = vi.fn();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    safeSetTimeout(SAFE_MAX_TIMEOUT_MS, fn);

    vi.advanceTimersByTime(SAFE_MAX_TIMEOUT_MS);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expectNoOverflowWarning();
  });

  it('SAFE_MAX_TIMEOUT_MS + 1 chains exactly twice', () => {
    const fn = vi.fn();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    safeSetTimeout(SAFE_MAX_TIMEOUT_MS + 1, fn);

    vi.advanceTimersByTime(SAFE_MAX_TIMEOUT_MS);
    expect(fn).not.toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    expectNoOverflowWarning();
  });

  it('zero delay fires on next tick', () => {
    const fn = vi.fn();
    safeSetTimeout(0, fn);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledTimes(1);
    expectNoOverflowWarning();
  });

  it('negative delay treated as zero (no overflow warning)', () => {
    const fn = vi.fn();
    safeSetTimeout(-500, fn);
    vi.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledTimes(1);
    expectNoOverflowWarning();
  });
});
