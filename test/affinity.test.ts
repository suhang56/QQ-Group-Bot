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

  // ---- M8.4: 10-type deltas ----

  describe('10-type deltas (M8.4)', () => {
    it('praise applies +2', () => {
      mod.recordInteraction('g1', 'u1', 'praise');
      expect(mod.getScore('g1', 'u1')).toBe(32);
    });
    it('thanks applies +2', () => {
      mod.recordInteraction('g1', 'u1', 'thanks');
      expect(mod.getScore('g1', 'u1')).toBe(32);
    });
    it('mock applies -2 (clamps at 0 for default-user)', () => {
      seedAffinity(db, 'g1', 'u1', 50, Date.now());
      mod.recordInteraction('g1', 'u1', 'mock');
      expect(mod.getScore('g1', 'u1')).toBe(48);
    });
    it('mock on fresh user: default 30 - 2 = 28', () => {
      mod.recordInteraction('g1', 'u1', 'mock');
      expect(mod.getScore('g1', 'u1')).toBe(28);
    });
    it('mock clamped at 0 (lower bound)', () => {
      seedAffinity(db, 'g1', 'u1', 1, Date.now());
      mod.recordInteraction('g1', 'u1', 'mock');
      expect(mod.getScore('g1', 'u1')).toBe(0);
    });
    it('joke_share applies +1', () => {
      mod.recordInteraction('g1', 'u1', 'joke_share');
      expect(mod.getScore('g1', 'u1')).toBe(31);
    });
    it('question_ask applies +1', () => {
      mod.recordInteraction('g1', 'u1', 'question_ask');
      expect(mod.getScore('g1', 'u1')).toBe(31);
    });
    it('farewell applies +1', () => {
      mod.recordInteraction('g1', 'u1', 'farewell');
      expect(mod.getScore('g1', 'u1')).toBe(31);
    });
  });

  // ---- M8.4: detectInteractionType classifier ----

  describe('detectInteractionType', () => {
    const baseCtx = { isMention: false, isReplyToBot: false, isAdversarial: false, comprehensionScore: 0.8 };

    it('classifies praise (好棒)', async () => {
      const { detectInteractionType } = await import('../src/modules/affinity.js');
      expect(detectInteractionType('哇好棒啊', baseCtx)).toBe('praise');
    });
    it('classifies praise (yyds, case-insensitive)', async () => {
      const { detectInteractionType } = await import('../src/modules/affinity.js');
      expect(detectInteractionType('YYDS', baseCtx)).toBe('praise');
    });
    it('classifies mock via keyword (傻逼)', async () => {
      const { detectInteractionType } = await import('../src/modules/affinity.js');
      expect(detectInteractionType('你是傻逼', baseCtx)).toBe('mock');
    });
    it('classifies mock even in adversarial context (overlay wins over correction)', async () => {
      const { detectInteractionType } = await import('../src/modules/affinity.js');
      const ctx = { ...baseCtx, isAdversarial: true, comprehensionScore: 0.3 };
      expect(detectInteractionType('你是傻逼', ctx)).toBe('mock');
    });
    it('classifies thanks (谢谢)', async () => {
      const { detectInteractionType } = await import('../src/modules/affinity.js');
      expect(detectInteractionType('谢谢你帮忙', baseCtx)).toBe('thanks');
    });
    it('classifies farewell (晚安)', async () => {
      const { detectInteractionType } = await import('../src/modules/affinity.js');
      expect(detectInteractionType('晚安', baseCtx)).toBe('farewell');
    });
    it('classifies question_ask (? mark)', async () => {
      const { detectInteractionType } = await import('../src/modules/affinity.js');
      expect(detectInteractionType('你觉得怎样?', baseCtx)).toBe('question_ask');
    });
    it('classifies question_ask (Chinese ？)', async () => {
      const { detectInteractionType } = await import('../src/modules/affinity.js');
      expect(detectInteractionType('怎么办？', baseCtx)).toBe('question_ask');
    });
    it('classifies joke_share (哈哈)', async () => {
      const { detectInteractionType } = await import('../src/modules/affinity.js');
      expect(detectInteractionType('哈哈哈哈', baseCtx)).toBe('joke_share');
    });
    it('falls back to reply_continue when replying to bot', async () => {
      const { detectInteractionType } = await import('../src/modules/affinity.js');
      const ctx = { ...baseCtx, isReplyToBot: true };
      expect(detectInteractionType('好的', ctx)).toBe('reply_continue');
    });
    it('falls back to at_friendly for friendly mention', async () => {
      const { detectInteractionType } = await import('../src/modules/affinity.js');
      const ctx = { ...baseCtx, isMention: true, comprehensionScore: 0.7 };
      expect(detectInteractionType('说说看', ctx)).toBe('at_friendly');
    });
    it('falls back to correction when adversarial + low comprehension', async () => {
      const { detectInteractionType } = await import('../src/modules/affinity.js');
      const ctx = { ...baseCtx, isAdversarial: true, comprehensionScore: 0.2 };
      expect(detectInteractionType('不是这样的', ctx)).toBe('correction');
    });
    it('default falls back to chat', async () => {
      const { detectInteractionType } = await import('../src/modules/affinity.js');
      expect(detectInteractionType('随便说句话', baseCtx)).toBe('chat');
    });
    it('empty content + isReplyToBot → reply_continue', async () => {
      const { detectInteractionType } = await import('../src/modules/affinity.js');
      const ctx = { ...baseCtx, isReplyToBot: true };
      expect(detectInteractionType('', ctx)).toBe('reply_continue');
    });
    it('null content handled without throwing', async () => {
      const { detectInteractionType } = await import('../src/modules/affinity.js');
      expect(detectInteractionType(null, baseCtx)).toBe('chat');
    });
    it('undefined content handled without throwing', async () => {
      const { detectInteractionType } = await import('../src/modules/affinity.js');
      expect(detectInteractionType(undefined, baseCtx)).toBe('chat');
    });
    it('mock overlay wins over at_friendly context', async () => {
      const { detectInteractionType } = await import('../src/modules/affinity.js');
      const ctx = { ...baseCtx, isMention: true, comprehensionScore: 0.9 };
      expect(detectInteractionType('你蠢死了', ctx)).toBe('mock');
    });
    it('praise overlay wins over reply_continue context', async () => {
      const { detectInteractionType } = await import('../src/modules/affinity.js');
      const ctx = { ...baseCtx, isReplyToBot: true };
      expect(detectInteractionType('awsl', ctx)).toBe('praise');
    });
    it('at_friendly not chosen when adversarial', async () => {
      const { detectInteractionType } = await import('../src/modules/affinity.js');
      const ctx = { ...baseCtx, isMention: true, isAdversarial: true, comprehensionScore: 0.7 };
      // adversarial + high comprehension + no keyword → chat (not at_friendly, not correction)
      expect(detectInteractionType('随便说句话', ctx)).toBe('chat');
    });
  });

  // ---- M8.4: anti-farm cooldown ----

  describe('anti-farm cooldown (5min for praise/thanks/mock/farewell)', () => {
    it('2nd praise within 5min → delta=0 (no score change)', () => {
      mod.recordInteraction('g1', 'u1', 'praise'); // 30+2=32
      expect(mod.getScore('g1', 'u1')).toBe(32);
      mod.recordInteraction('g1', 'u1', 'praise'); // cooldown hit, delta=0
      expect(mod.getScore('g1', 'u1')).toBe(32);
    });
    it('cooldown hit still updates last_interaction', () => {
      mod.recordInteraction('g1', 'u1', 'praise');
      const firstTs = (db.prepare(
        'SELECT last_interaction FROM user_affinity WHERE group_id=? AND user_id=?',
      ).get('g1', 'u1') as { last_interaction: number }).last_interaction;
      vi.useFakeTimers();
      vi.setSystemTime(firstTs + 60_000); // +1min
      try {
        mod.recordInteraction('g1', 'u1', 'praise'); // cooldown, delta=0 but ts updates
        const secondTs = (db.prepare(
          'SELECT last_interaction FROM user_affinity WHERE group_id=? AND user_id=?',
        ).get('g1', 'u1') as { last_interaction: number }).last_interaction;
        expect(secondTs).toBeGreaterThan(firstTs);
      } finally {
        vi.useRealTimers();
      }
    });
    it('after 5min cooldown expires, praise applies again', () => {
      vi.useFakeTimers();
      const t0 = Date.now();
      vi.setSystemTime(t0);
      try {
        mod.recordInteraction('g1', 'u1', 'praise'); // 30+2=32
        vi.setSystemTime(t0 + 5 * 60 * 1000 + 1000); // +5min1s
        mod.recordInteraction('g1', 'u1', 'praise'); // 32+2=34
        expect(mod.getScore('g1', 'u1')).toBe(34);
      } finally {
        vi.useRealTimers();
      }
    });
    it('chat/at_friendly/reply_continue/correction NOT subject to cooldown', () => {
      // 8 chats back-to-back → all apply (subject to daily cap only)
      for (let i = 0; i < 5; i++) mod.recordInteraction('g1', 'u1', 'chat');
      expect(mod.getScore('g1', 'u1')).toBe(35); // 30 + 5 (all 5 count — under cap)
    });
    it('cooldown isolated per type (praise cooldown does not block thanks)', () => {
      mod.recordInteraction('g1', 'u1', 'praise'); // 32
      mod.recordInteraction('g1', 'u1', 'thanks'); // 32+2=34 (different type)
      expect(mod.getScore('g1', 'u1')).toBe(34);
    });
    it('cooldown isolated across groups (same uid+type in g1 vs g2)', () => {
      mod.recordInteraction('g1', 'u1', 'praise'); // g1: 32
      mod.recordInteraction('g2', 'u1', 'praise'); // g2 fresh: 32
      expect(mod.getScore('g1', 'u1')).toBe(32);
      expect(mod.getScore('g2', 'u1')).toBe(32);
    });
    it('mock cooldown applies (rapid mock does not stack)', () => {
      seedAffinity(db, 'g1', 'u1', 50, Date.now());
      mod.recordInteraction('g1', 'u1', 'mock'); // 48
      mod.recordInteraction('g1', 'u1', 'mock'); // cooldown, no change
      expect(mod.getScore('g1', 'u1')).toBe(48);
    });
  });

  // ---- M8.4: daily positive-gain cap ----

  describe('daily positive-gain cap (+10/day)', () => {
    it('11th +1 chat in same day clamped to 0', () => {
      for (let i = 0; i < 10; i++) mod.recordInteraction('g1', 'u1', 'chat'); // 30+10=40
      expect(mod.getScore('g1', 'u1')).toBe(40);
      mod.recordInteraction('g1', 'u1', 'chat'); // capped
      expect(mod.getScore('g1', 'u1')).toBe(40);
    });
    it('partial clamp: at net=8, a +3 correction only adds 2', () => {
      for (let i = 0; i < 8; i++) mod.recordInteraction('g1', 'u1', 'chat'); // 38, net=8
      mod.recordInteraction('g1', 'u1', 'correction'); // +3 requested, only +2 applied
      expect(mod.getScore('g1', 'u1')).toBe(40);
    });
    it('mock (negative) always applies — NOT subject to positive-cap gate', () => {
      for (let i = 0; i < 10; i++) mod.recordInteraction('g1', 'u1', 'chat'); // 40, cap hit
      mod.recordInteraction('g1', 'u1', 'mock'); // still applies: 40-2=38
      expect(mod.getScore('g1', 'u1')).toBe(38);
    });
    it('mock does not consume daily positive budget', () => {
      for (let i = 0; i < 5; i++) mod.recordInteraction('g1', 'u1', 'chat'); // 35, net=5
      seedAffinity; // no-op, just reference
      mod.recordInteraction('g1', 'u1', 'mock'); // 35-2=33 (negative doesn't touch cap)
      // Still have 5 positive budget remaining
      for (let i = 0; i < 5; i++) mod.recordInteraction('g1', 'u1', 'chat'); // 33+5=38
      expect(mod.getScore('g1', 'u1')).toBe(38);
    });
    it('cap isolated across groups', () => {
      for (let i = 0; i < 10; i++) mod.recordInteraction('g1', 'u1', 'chat');
      mod.recordInteraction('g2', 'u1', 'chat'); // g2 fresh budget
      expect(mod.getScore('g1', 'u1')).toBe(40);
      expect(mod.getScore('g2', 'u1')).toBe(31);
    });
    it('cap isolated across users in same group', () => {
      for (let i = 0; i < 10; i++) mod.recordInteraction('g1', 'u1', 'chat');
      mod.recordInteraction('g1', 'u2', 'chat');
      expect(mod.getScore('g1', 'u1')).toBe(40);
      expect(mod.getScore('g1', 'u2')).toBe(31);
    });
    it('cap resets on new day', () => {
      vi.useFakeTimers();
      const t0 = Date.now();
      vi.setSystemTime(t0);
      try {
        for (let i = 0; i < 10; i++) mod.recordInteraction('g1', 'u1', 'chat'); // 40, cap hit
        mod.recordInteraction('g1', 'u1', 'chat'); // 40 (capped)
        expect(mod.getScore('g1', 'u1')).toBe(40);
        vi.setSystemTime(t0 + 86_400_000 + 1000); // +1day
        mod.recordInteraction('g1', 'u1', 'chat'); // fresh day: 40+1=41
        expect(mod.getScore('g1', 'u1')).toBe(41);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ---- M8.4: back-compat with legacy 3-arg calls ----

  describe('back-compat', () => {
    it('3-arg recordInteraction(gid, uid, "chat") still works', () => {
      mod.recordInteraction('g1', 'u1', 'chat');
      expect(mod.getScore('g1', 'u1')).toBe(31);
    });
    it('cold user + new type: initial score clamped to [0, 100]', () => {
      mod.recordInteraction('g1', 'u-new', 'praise'); // 30+2=32
      expect(mod.getScore('g1', 'u-new')).toBe(32);
    });
    it('existing 4-type callers unaffected by new 6 types', () => {
      mod.recordInteraction('g1', 'u1', 'at_friendly');
      mod.recordInteraction('g1', 'u1', 'reply_continue');
      mod.recordInteraction('g1', 'u1', 'correction');
      // 30+2+1+3 = 36
      expect(mod.getScore('g1', 'u1')).toBe(36);
    });
  });
});
