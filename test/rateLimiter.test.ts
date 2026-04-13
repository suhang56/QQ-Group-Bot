import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RateLimiter } from '../src/core/rateLimiter.js';

describe('RateLimiter', () => {
  let rl: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    rl = new RateLimiter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests within limit', () => {
    for (let i = 0; i < 10; i++) {
      expect(rl.checkUser('u1', 'any')).toBe(true);
    }
  });

  it('blocks after exceeding per-user command limit (10/60s)', () => {
    for (let i = 0; i < 10; i++) rl.checkUser('u1', 'any');
    expect(rl.checkUser('u1', 'any')).toBe(false);
  });

  it('resets after window expires', () => {
    for (let i = 0; i < 10; i++) rl.checkUser('u1', 'any');
    expect(rl.checkUser('u1', 'any')).toBe(false);
    vi.advanceTimersByTime(61_000);
    expect(rl.checkUser('u1', 'any')).toBe(true);
  });

  it('mimic command has stricter limit (3/60s)', () => {
    for (let i = 0; i < 3; i++) rl.checkUser('u1', 'mimic');
    expect(rl.checkUser('u1', 'mimic')).toBe(false);
  });

  it('mimic limit independent from general limit', () => {
    // Use up mimic limit
    for (let i = 0; i < 3; i++) rl.checkUser('u1', 'mimic');
    // General commands still allowed
    expect(rl.checkUser('u1', 'rules')).toBe(true);
  });

  it('rules command has limit of 5/60s', () => {
    for (let i = 0; i < 5; i++) rl.checkUser('u1', 'rules');
    expect(rl.checkUser('u1', 'rules')).toBe(false);
  });

  it('different users have independent limits', () => {
    for (let i = 0; i < 10; i++) rl.checkUser('u1', 'any');
    expect(rl.checkUser('u1', 'any')).toBe(false);
    expect(rl.checkUser('u2', 'any')).toBe(true);
  });

  it('checkGroup allows up to 20 bot replies per 60s', () => {
    for (let i = 0; i < 20; i++) expect(rl.checkGroup('g1', 'chat')).toBe(true);
    expect(rl.checkGroup('g1', 'chat')).toBe(false);
  });

  it('checkGroup resets after window', () => {
    for (let i = 0; i < 20; i++) rl.checkGroup('g1', 'chat');
    vi.advanceTimersByTime(61_000);
    expect(rl.checkGroup('g1', 'chat')).toBe(true);
  });

  it('returns cooldown seconds when blocked (user)', () => {
    for (let i = 0; i < 10; i++) rl.checkUser('u1', 'any');
    const cooldown = rl.cooldownSecondsUser('u1', 'any');
    expect(cooldown).toBeGreaterThan(0);
    expect(cooldown).toBeLessThanOrEqual(60);
  });

  it('returns 0 cooldown when not blocked', () => {
    expect(rl.cooldownSecondsUser('u1', 'any')).toBe(0);
  });
});
