import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

// Helper: create in-memory DB with the user_affinity table
function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_affinity (
      group_id         TEXT    NOT NULL,
      user_id          TEXT    NOT NULL,
      score            INTEGER NOT NULL DEFAULT 30,
      last_interaction INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      PRIMARY KEY (group_id, user_id)
    )
  `);
  return db;
}

// Seed a row directly for test setup
function seedAffinity(
  db: DatabaseSync,
  groupId: string,
  userId: string,
  score: number,
  lastInteraction: number,
): void {
  db.prepare(
    'INSERT INTO user_affinity (group_id, user_id, score, last_interaction, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(groupId, userId, score, lastInteraction, Date.now());
}

describe('AffinityModule', () => {
  let db: DatabaseSync;
  let mod: InstanceType<typeof import('../src/modules/affinity.js').AffinityModule>;

  beforeEach(async () => {
    db = createTestDb();
    const { AffinityModule } = await import('../src/modules/affinity.js');
    mod = new AffinityModule(db);
  });

  // ---- getScore ----

  describe('getScore', () => {
    it('returns default 30 for unknown user', () => {
      expect(mod.getScore('g1', 'u-unknown')).toBe(30);
    });

    it('returns stored score for known user', () => {
      seedAffinity(db, 'g1', 'u1', 75, Date.now());
      expect(mod.getScore('g1', 'u1')).toBe(75);
    });

    it('isolates scores across groups', () => {
      seedAffinity(db, 'g1', 'u1', 80, Date.now());
      seedAffinity(db, 'g2', 'u1', 10, Date.now());
      expect(mod.getScore('g1', 'u1')).toBe(80);
      expect(mod.getScore('g2', 'u1')).toBe(10);
    });
  });

  // ---- recordInteraction ----

  describe('recordInteraction', () => {
    it('inserts new row with default + delta for chat (+1)', () => {
      mod.recordInteraction('g1', 'u1', 'chat');
      expect(mod.getScore('g1', 'u1')).toBe(31);
    });

    it('inserts new row with default + delta for at_friendly (+2)', () => {
      mod.recordInteraction('g1', 'u1', 'at_friendly');
      expect(mod.getScore('g1', 'u1')).toBe(32);
    });

    it('inserts new row with default + delta for reply_continue (+1)', () => {
      mod.recordInteraction('g1', 'u1', 'reply_continue');
      expect(mod.getScore('g1', 'u1')).toBe(31);
    });

    it('inserts new row with default + delta for correction (+3)', () => {
      mod.recordInteraction('g1', 'u1', 'correction');
      expect(mod.getScore('g1', 'u1')).toBe(33);
    });

    it('increments existing score', () => {
      seedAffinity(db, 'g1', 'u1', 50, Date.now());
      mod.recordInteraction('g1', 'u1', 'correction');
      expect(mod.getScore('g1', 'u1')).toBe(53);
    });

    it('clamps score at 100 (upper bound)', () => {
      seedAffinity(db, 'g1', 'u1', 99, Date.now());
      mod.recordInteraction('g1', 'u1', 'correction'); // +3 → 102 → clamped to 100
      expect(mod.getScore('g1', 'u1')).toBe(100);
    });

    it('clamps score at 0 (lower bound) — score cannot go negative via interaction', () => {
      seedAffinity(db, 'g1', 'u1', 0, Date.now());
      mod.recordInteraction('g1', 'u1', 'chat'); // +1
      expect(mod.getScore('g1', 'u1')).toBe(1);
    });

    it('does not affect other groups', () => {
      seedAffinity(db, 'g1', 'u1', 50, Date.now());
      seedAffinity(db, 'g2', 'u1', 50, Date.now());
      mod.recordInteraction('g1', 'u1', 'correction');
      expect(mod.getScore('g1', 'u1')).toBe(53);
      expect(mod.getScore('g2', 'u1')).toBe(50); // unchanged
    });

    it('handles multiple sequential interactions', () => {
      mod.recordInteraction('g1', 'u1', 'chat');       // 30+1=31
      mod.recordInteraction('g1', 'u1', 'at_friendly'); // 31+2=33
      mod.recordInteraction('g1', 'u1', 'correction');  // 33+3=36
      expect(mod.getScore('g1', 'u1')).toBe(36);
    });

    it('updates last_interaction timestamp', () => {
      const before = Date.now();
      mod.recordInteraction('g1', 'u1', 'chat');
      const row = db.prepare(
        'SELECT last_interaction FROM user_affinity WHERE group_id = ? AND user_id = ?',
      ).get('g1', 'u1') as { last_interaction: number };
      expect(row.last_interaction).toBeGreaterThanOrEqual(before);
    });
  });

  // ---- dailyDecay ----

  describe('dailyDecay', () => {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

    it('decays score by 5 for users inactive > 7 days', () => {
      const eightDaysAgo = Date.now() - SEVEN_DAYS_MS - 1000;
      seedAffinity(db, 'g1', 'u1', 50, eightDaysAgo);
      mod.dailyDecay();
      expect(mod.getScore('g1', 'u1')).toBe(45);
    });

    it('does NOT decay users active within 7 days', () => {
      const sixDaysAgo = Date.now() - SEVEN_DAYS_MS + 60_000;
      seedAffinity(db, 'g1', 'u1', 50, sixDaysAgo);
      mod.dailyDecay();
      expect(mod.getScore('g1', 'u1')).toBe(50);
    });

    it('floors decayed score at 0', () => {
      const eightDaysAgo = Date.now() - SEVEN_DAYS_MS - 1000;
      seedAffinity(db, 'g1', 'u1', 3, eightDaysAgo);
      mod.dailyDecay();
      expect(mod.getScore('g1', 'u1')).toBe(0);
    });

    it('deletes rows with score <= 0 and inactive > 30 days', () => {
      const thirtyOneDaysAgo = Date.now() - THIRTY_DAYS_MS - 1000;
      seedAffinity(db, 'g1', 'u-old', 0, thirtyOneDaysAgo);
      mod.dailyDecay();
      // Row should be deleted — getScore returns default 30
      expect(mod.getScore('g1', 'u-old')).toBe(30);
    });

    it('does NOT delete rows with score > 0 even if inactive > 30 days', () => {
      const thirtyOneDaysAgo = Date.now() - THIRTY_DAYS_MS - 1000;
      seedAffinity(db, 'g1', 'u1', 10, thirtyOneDaysAgo);
      mod.dailyDecay();
      // Score should be decayed (10-5=5) but row still exists
      expect(mod.getScore('g1', 'u1')).toBe(5);
    });

    it('does NOT delete rows with score <= 0 if inactive < 30 days', () => {
      const twentyDaysAgo = Date.now() - 20 * 24 * 60 * 60 * 1000;
      seedAffinity(db, 'g1', 'u1', 0, twentyDaysAgo);
      mod.dailyDecay();
      // Row still exists (decayed to 0, but not cleaned up yet)
      const row = db.prepare(
        'SELECT score FROM user_affinity WHERE group_id = ? AND user_id = ?',
      ).get('g1', 'u1') as { score: number } | undefined;
      expect(row).toBeDefined();
      expect(row!.score).toBe(0);
    });

    it('handles empty table without error', () => {
      expect(() => mod.dailyDecay()).not.toThrow();
    });

    it('decays multiple users across groups', () => {
      const eightDaysAgo = Date.now() - SEVEN_DAYS_MS - 1000;
      seedAffinity(db, 'g1', 'u1', 60, eightDaysAgo);
      seedAffinity(db, 'g2', 'u2', 40, eightDaysAgo);
      seedAffinity(db, 'g1', 'u3', 80, Date.now()); // active — no decay
      mod.dailyDecay();
      expect(mod.getScore('g1', 'u1')).toBe(55);
      expect(mod.getScore('g2', 'u2')).toBe(35);
      expect(mod.getScore('g1', 'u3')).toBe(80);
    });
  });

  // ---- getAffinityFactor ----

  describe('getAffinityFactor', () => {
    it('returns +0.15 when score > 70', () => {
      seedAffinity(db, 'g1', 'u1', 71, Date.now());
      expect(mod.getAffinityFactor('g1', 'u1')).toBe(0.15);
    });

    it('returns +0.15 when score is 100', () => {
      seedAffinity(db, 'g1', 'u1', 100, Date.now());
      expect(mod.getAffinityFactor('g1', 'u1')).toBe(0.15);
    });

    it('returns -0.10 when score < 30', () => {
      seedAffinity(db, 'g1', 'u1', 29, Date.now());
      expect(mod.getAffinityFactor('g1', 'u1')).toBe(-0.10);
    });

    it('returns -0.10 when score is 0', () => {
      seedAffinity(db, 'g1', 'u1', 0, Date.now());
      expect(mod.getAffinityFactor('g1', 'u1')).toBe(-0.10);
    });

    it('returns 0 when score is exactly 30', () => {
      seedAffinity(db, 'g1', 'u1', 30, Date.now());
      expect(mod.getAffinityFactor('g1', 'u1')).toBe(0);
    });

    it('returns 0 when score is exactly 70', () => {
      seedAffinity(db, 'g1', 'u1', 70, Date.now());
      expect(mod.getAffinityFactor('g1', 'u1')).toBe(0);
    });

    it('returns 0 for unknown user (default 30)', () => {
      expect(mod.getAffinityFactor('g1', 'u-unknown')).toBe(0);
    });

    it('returns 0 for score in middle range (50)', () => {
      seedAffinity(db, 'g1', 'u1', 50, Date.now());
      expect(mod.getAffinityFactor('g1', 'u1')).toBe(0);
    });
  });

  // ---- formatAffinityHint ----

  describe('formatAffinityHint', () => {
    it('returns friendly hint when score > 70', () => {
      seedAffinity(db, 'g1', 'u1', 71, Date.now());
      expect(mod.formatAffinityHint('g1', 'u1', '西瓜')).toBe(
        '（西瓜 是你比较熟的群友）',
      );
    });

    it('returns cold hint when score < 30', () => {
      seedAffinity(db, 'g1', 'u1', 29, Date.now());
      expect(mod.formatAffinityHint('g1', 'u1', 'kisa')).toBe(
        '（kisa 你不太熟）',
      );
    });

    it('returns cold hint for score 20 (< 30 threshold)', () => {
      seedAffinity(db, 'g1', 'u1', 20, Date.now());
      expect(mod.formatAffinityHint('g1', 'u1', 'test')).toBe(
        '（test 你不太熟）',
      );
    });

    it('returns null when score is between 30 and 70 inclusive', () => {
      seedAffinity(db, 'g1', 'u1', 50, Date.now());
      expect(mod.formatAffinityHint('g1', 'u1', '美游')).toBeNull();
    });

    it('returns null for exactly score 30', () => {
      seedAffinity(db, 'g1', 'u1', 30, Date.now());
      expect(mod.formatAffinityHint('g1', 'u1', 'test')).toBeNull();
    });

    it('returns null for exactly score 70', () => {
      seedAffinity(db, 'g1', 'u1', 70, Date.now());
      expect(mod.formatAffinityHint('g1', 'u1', 'test')).toBeNull();
    });

    it('returns cold hint for score 0', () => {
      seedAffinity(db, 'g1', 'u1', 0, Date.now());
      expect(mod.formatAffinityHint('g1', 'u1', 'test')).toBe(
        '（test 你不太熟）',
      );
    });

    it('returns null for unknown user (default 30)', () => {
      expect(mod.formatAffinityHint('g1', 'u-unknown', 'nobody')).toBeNull();
    });

    it('handles nickname with special characters', () => {
      seedAffinity(db, 'g1', 'u1', 80, Date.now());
      expect(mod.formatAffinityHint('g1', 'u1', '❤️飞鸟❤️')).toBe(
        '（❤️飞鸟❤️ 是你比较熟的群友）',
      );
    });

    it('handles empty nickname string', () => {
      seedAffinity(db, 'g1', 'u1', 80, Date.now());
      expect(mod.formatAffinityHint('g1', 'u1', '')).toBe(
        '（ 是你比较熟的群友）',
      );
    });
  });

  // ---- Edge cases: concurrent upserts ----

  describe('upsert edge cases', () => {
    it('first interaction creates row, second updates it', () => {
      mod.recordInteraction('g1', 'u1', 'chat');       // insert 30+1=31
      mod.recordInteraction('g1', 'u1', 'at_friendly'); // update 31+2=33
      expect(mod.getScore('g1', 'u1')).toBe(33);
    });

    it('different users in same group are independent', () => {
      mod.recordInteraction('g1', 'u1', 'correction'); // 30+3=33
      mod.recordInteraction('g1', 'u2', 'chat');       // 30+1=31
      expect(mod.getScore('g1', 'u1')).toBe(33);
      expect(mod.getScore('g1', 'u2')).toBe(31);
    });
  });

  // ---- Boundary: score at max undergoing decay ----

  describe('decay + interaction interplay', () => {
    it('decay then interaction resumes correctly', () => {
      const eightDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000 - 1000;
      seedAffinity(db, 'g1', 'u1', 50, eightDaysAgo);
      mod.dailyDecay(); // 50-5=45
      mod.recordInteraction('g1', 'u1', 'correction'); // 45+3=48
      expect(mod.getScore('g1', 'u1')).toBe(48);
    });
  });
});
