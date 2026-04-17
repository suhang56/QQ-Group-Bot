import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FatigueModule, FATIGUE_THRESHOLD } from '../src/modules/fatigue.js';

describe('FatigueModule', () => {
  let fatigue: FatigueModule;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T00:00:00Z'));
    fatigue = new FatigueModule();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('onReply accumulation', () => {
    it('adds 1.0 per onReply at same timestamp', () => {
      fatigue.onReply('g1');
      expect(fatigue.getRawScore('g1')).toBeCloseTo(1, 5);

      fatigue.onReply('g1');
      fatigue.onReply('g1');
      fatigue.onReply('g1');
      expect(fatigue.getRawScore('g1')).toBeCloseTo(4, 5);

      fatigue.onReply('g1');
      expect(fatigue.getRawScore('g1')).toBeCloseTo(5, 5);
    });
  });

  describe('getRawScore', () => {
    it('returns 0 for brand-new groupId', () => {
      expect(fatigue.getRawScore('brand-new')).toBe(0);
    });

    it('returns non-zero decayed score below threshold', () => {
      for (let i = 0; i < 3; i++) fatigue.onReply('g1'); // score=3 (below 4)
      const raw = fatigue.getRawScore('g1');
      expect(raw).toBeCloseTo(3, 5);
      expect(raw).toBeLessThan(FATIGUE_THRESHOLD);
    });

    it('returns score * 0.5 after 30 minutes (half-life)', () => {
      for (let i = 0; i < 10; i++) fatigue.onReply('g1');
      expect(fatigue.getRawScore('g1')).toBeCloseTo(10, 5);
      vi.advanceTimersByTime(30 * 60_000);
      expect(fatigue.getRawScore('g1')).toBeCloseTo(5, 2);
    });

    it('returns score * 0.25 after 60 minutes (two half-lives)', () => {
      for (let i = 0; i < 8; i++) fatigue.onReply('g1');
      vi.advanceTimersByTime(60 * 60_000);
      expect(fatigue.getRawScore('g1')).toBeCloseTo(2, 2);
    });

    it('getRawScore triggers decay write-back — two reads with dt=0 return identical values', () => {
      for (let i = 0; i < 6; i++) fatigue.onReply('g1');
      const r1 = fatigue.getRawScore('g1');
      const r2 = fatigue.getRawScore('g1');
      expect(r2).toBeCloseTo(r1, 10);
    });

    it('isolates score per groupId', () => {
      for (let i = 0; i < 10; i++) fatigue.onReply('g1');
      expect(fatigue.getRawScore('g1')).toBeCloseTo(10, 5);
      expect(fatigue.getRawScore('g2')).toBe(0);
    });
  });

  describe('getPenalty legacy formula (threshold=4)', () => {
    it('returns 0 below threshold', () => {
      for (let i = 0; i < 3; i++) fatigue.onReply('g1'); // score=3
      expect(fatigue.getPenalty('g1')).toBe(0);
    });

    it('returns 0 exactly at threshold (score=4)', () => {
      for (let i = 0; i < 4; i++) fatigue.onReply('g1');
      expect(fatigue.getPenalty('g1')).toBe(0);
    });

    it('linear ramp 0 at 4 → -0.3 at 6', () => {
      for (let i = 0; i < 5; i++) fatigue.onReply('g1');
      // score=5 → -0.3 * (1/2) = -0.15
      expect(fatigue.getPenalty('g1')).toBeCloseTo(-0.15, 5);
    });

    it('caps at -0.3 for score >= 6', () => {
      for (let i = 0; i < 6; i++) fatigue.onReply('g1');
      expect(fatigue.getPenalty('g1')).toBeCloseTo(-0.3, 5);
      for (let i = 0; i < 20; i++) fatigue.onReply('g1');
      expect(fatigue.getPenalty('g1')).toBeCloseTo(-0.3, 5);
    });

    it('getPenalty and getRawScore both trigger decay write-back — second read consistent', () => {
      for (let i = 0; i < 6; i++) fatigue.onReply('g1');
      const p1 = fatigue.getPenalty('g1');
      const r1 = fatigue.getRawScore('g1');
      const p2 = fatigue.getPenalty('g1');
      const r2 = fatigue.getRawScore('g1');
      expect(p2).toBeCloseTo(p1, 10);
      expect(r2).toBeCloseTo(r1, 10);
    });
  });

  describe('decay + onReply interaction', () => {
    it('onReply after decay accumulates on top of decayed score', () => {
      for (let i = 0; i < 10; i++) fatigue.onReply('g1');
      vi.advanceTimersByTime(30 * 60_000); // → ~5
      fatigue.onReply('g1'); // → ~6
      expect(fatigue.getRawScore('g1')).toBeCloseTo(6, 2);
    });

    it('10x rapid onReply saturates penalty at cap', () => {
      for (let i = 0; i < 10; i++) fatigue.onReply('g1');
      expect(fatigue.getPenalty('g1')).toBeCloseTo(-0.3, 5);
    });
  });
});
