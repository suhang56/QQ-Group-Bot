import { describe, it, expect } from 'vitest';
import { parseIntOr, parseFloatOr } from '../src/utils/config-parse.js';

describe('parseIntOr', () => {
  it('returns fallback on undefined', () => {
    expect(parseIntOr(undefined, 7)).toBe(7);
  });

  it('returns fallback on empty string', () => {
    expect(parseIntOr('', 7)).toBe(7);
  });

  it('returns fallback on whitespace-only', () => {
    expect(parseIntOr('   ', 7)).toBe(7);
  });

  it('parses valid integer', () => {
    expect(parseIntOr('42', 7)).toBe(42);
  });

  it('parses "0" as 0 (not fallback)', () => {
    expect(parseIntOr('0', 7)).toBe(0);
  });

  it('returns fallback on NaN-producing "7d" (regression: parseInt would return 7)', () => {
    expect(parseIntOr('7d', 99)).toBe(99);
  });

  it('returns fallback on negative', () => {
    expect(parseIntOr('-5', 10)).toBe(10);
  });

  it('returns fallback on mixed alpha', () => {
    expect(parseIntOr('abc', 10)).toBe(10);
  });

  it('returns fallback on float-like string', () => {
    expect(parseIntOr('3.14', 10)).toBe(10);
  });

  it('accepts leading plus', () => {
    expect(parseIntOr('+3', 10)).toBe(3);
  });

  it('rejects "0x10" hex', () => {
    expect(parseIntOr('0x10', 42)).toBe(42);
  });

  it('trims leading/trailing whitespace around digits', () => {
    expect(parseIntOr(' 42 ', 7)).toBe(42);
  });

  it('rejects thousands-separator variants', () => {
    expect(parseIntOr('1_000', 99)).toBe(99);
    expect(parseIntOr('1,000', 99)).toBe(99);
  });

  it('accepts large integers within JS safe range', () => {
    expect(parseIntOr('86400000', 0)).toBe(86_400_000);
  });
});

describe('parseFloatOr', () => {
  it('returns fallback on undefined', () => {
    expect(parseFloatOr(undefined, 0.5)).toBe(0.5);
  });

  it('returns fallback on empty', () => {
    expect(parseFloatOr('', 0.5)).toBe(0.5);
  });

  it('parses decimal', () => {
    expect(parseFloatOr('0.78', 0)).toBeCloseTo(0.78);
  });

  it('parses negative float', () => {
    expect(parseFloatOr('-0.3', 0)).toBeCloseTo(-0.3);
  });

  it('returns fallback on non-numeric', () => {
    expect(parseFloatOr('abc', 0.5)).toBe(0.5);
  });

  it('accepts scientific notation', () => {
    expect(parseFloatOr('1e3', 0)).toBe(1000);
  });
});
