/**
 * safeSetTimeout — schedule a callback safely beyond Node's 32-bit signed
 * setTimeout limit (~24.85 days = 2^31 - 1 ms).
 *
 * Passing a delay > 2,147,483,647 ms makes Node clamp it to 1 ms and emit
 * `TimeoutOverflowWarning`. In production the diary-distiller monthly cron
 * (delay up to ~30.5 days) hit this and saturated the event loop with an
 * infinite reschedule loop, taking the bot offline.
 *
 * This helper splits long delays into chunks of at most SAFE_MAX_TIMEOUT_MS
 * (~23.1 days, comfortably under the 32-bit limit), recomputing remaining
 * time from wall clock at each wake to absorb minor drift.
 */

export const SAFE_MAX_TIMEOUT_MS = 2_000_000_000;

export interface SafeTimer {
  cancel(): void;
  unref?(): void;
}

export function safeSetTimeout(delayMs: number, callback: () => void): SafeTimer {
  const clampedMs = Math.max(0, delayMs);
  const targetTime = Date.now() + clampedMs;

  let activeHandle: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  function schedule(remaining: number): void {
    const chunk = Math.min(remaining, SAFE_MAX_TIMEOUT_MS);
    activeHandle = setTimeout(() => {
      if (cancelled) return;
      const stillRemaining = targetTime - Date.now();
      if (stillRemaining > 0) {
        schedule(stillRemaining);
      } else {
        callback();
      }
    }, chunk);
    activeHandle.unref?.();
  }

  schedule(clampedMs);

  return {
    cancel(): void {
      cancelled = true;
      if (activeHandle !== null) {
        clearTimeout(activeHandle);
        activeHandle = null;
      }
    },
    unref(): void {
      activeHandle?.unref?.();
    },
  };
}
