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
    for (let i = 0; i < 3; i++) rl.checkUser('u1', 'mimic');
    expect(rl.checkUser('u1', 'rules')).toBe(true);
  });

  it('rules command has limit of 2/60s', () => {
    for (let i = 0; i < 2; i++) rl.checkUser('u1', 'rules');
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

  describe('per-command buckets (UR-C #3)', () => {
    it('bot_status enforces 1/5s', () => {
      expect(rl.checkUser('u1', 'bot_status')).toBe(true);
      expect(rl.checkUser('u1', 'bot_status')).toBe(false);
      vi.advanceTimersByTime(5_001);
      expect(rl.checkUser('u1', 'bot_status')).toBe(true);
    });

    it('cross_group enforces 1/5s', () => {
      expect(rl.checkUser('u1', 'cross_group')).toBe(true);
      expect(rl.checkUser('u1', 'cross_group')).toBe(false);
    });

    it('persona enforces 5/60s', () => {
      for (let i = 0; i < 5; i++) rl.checkUser('u1', 'persona');
      expect(rl.checkUser('u1', 'persona')).toBe(false);
    });

    it('admin_mod enforces 30/60s', () => {
      for (let i = 0; i < 30; i++) {
        expect(rl.checkUser('u1', 'admin_mod')).toBe(true);
      }
      expect(rl.checkUser('u1', 'admin_mod')).toBe(false);
    });

    it('unknown command keyed independently from default (regression vs shared-bucket behavior)', () => {
      // Exhaust bot_status (1/5s) — previously would have burned a slot on
      // the shared userId:default bucket used by all unknown commands.
      rl.checkUser('u1', 'bot_status');
      // persona (a different command) must still be independently available.
      for (let i = 0; i < 5; i++) {
        expect(rl.checkUser('u1', 'persona')).toBe(true);
      }
    });

    it('each command bucket is keyed per-user and per-command', () => {
      // Exhaust admin_mod for u1
      for (let i = 0; i < 30; i++) rl.checkUser('u1', 'admin_mod');
      expect(rl.checkUser('u1', 'admin_mod')).toBe(false);
      // Other commands for u1 still available.
      expect(rl.checkUser('u1', 'persona')).toBe(true);
      // admin_mod for u2 still available.
      expect(rl.checkUser('u2', 'admin_mod')).toBe(true);
    });

    it('cooldownSecondsUser respects per-command window', () => {
      rl.checkUser('u1', 'bot_status');
      expect(rl.checkUser('u1', 'bot_status')).toBe(false);
      const cd = rl.cooldownSecondsUser('u1', 'bot_status');
      expect(cd).toBeGreaterThan(0);
      expect(cd).toBeLessThanOrEqual(5);
    });
  });
});
