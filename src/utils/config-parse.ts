import { createLogger } from './logger.js';

const logger = createLogger('config-parse');

/**
 * Parse an env-var value as a non-negative integer. Returns fallback on
 * missing/empty/NaN/negative values. Emits a warn log (with the env-var label
 * when provided) on any rejected non-empty value so misconfiguration shows
 * up in startup logs instead of failing silently.
 *
 * Accepts only pure integer strings (optionally with leading "+" / whitespace).
 * Values like "7d", "1_000", "0x10" all fall back.
 */
export function parseIntOr(envValue: string | undefined, fallback: number, label?: string): number {
  if (envValue === undefined || envValue.trim().length === 0) return fallback;
  const trimmed = envValue.trim();
  if (!/^[+]?\d+$/.test(trimmed)) {
    logger.warn({ label, value: envValue, fallback }, 'env var not a non-negative integer — using fallback');
    return fallback;
  }
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 0) {
    logger.warn({ label, value: envValue, fallback }, 'env var parsed outside valid range — using fallback');
    return fallback;
  }
  return n;
}

/**
 * Parse an env-var value as a finite float (any sign). Returns fallback on
 * missing/empty/NaN values. Emits warn log on reject so miskeys are visible.
 */
export function parseFloatOr(envValue: string | undefined, fallback: number, label?: string): number {
  if (envValue === undefined || envValue.trim().length === 0) return fallback;
  const n = parseFloat(envValue);
  if (!Number.isFinite(n)) {
    logger.warn({ label, value: envValue, fallback }, 'env var not a finite number — using fallback');
    return fallback;
  }
  return n;
}
