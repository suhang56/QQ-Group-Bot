import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initLogger } from '../src/utils/logger.js';
import { AffinityModule, _computeAggregated } from '../src/modules/affinity.js';

initLogger({ level: 'silent' });

// Matches M9.3 spec: DB must have user_affinity, group_config,
// interaction_stats, and cross_group_audit. Use the minimal column sets
// the AffinityModule actually reads — keeps tests hermetic.
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
    );
    CREATE TABLE IF NOT EXISTS group_config (
      group_id            TEXT PRIMARY KEY,
      link_across_groups  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS interaction_stats (
      group_id       TEXT    NOT NULL,
      from_user      TEXT    NOT NULL,
      to_user        TEXT    NOT NULL,
      reply_count    INTEGER NOT NULL DEFAULT 0,
      mention_count  INTEGER NOT NULL DEFAULT 0,
      name_ref_count INTEGER NOT NULL DEFAULT 0,
      last_updated   INTEGER NOT NULL,
      PRIMARY KEY (group_id, from_user, to_user)
    );
    CREATE TABLE IF NOT EXISTS cross_group_audit (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      requester_gid TEXT    NOT NULL,
      target_uid    TEXT    NOT NULL,
      source_gids   TEXT    NOT NULL,
      aggregated    REAL    NOT NULL,
      ts            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cross_group_audit_ts ON cross_group_audit(ts DESC);
  `);
  return db;
}

function setGroupFlag(db: DatabaseSync, groupId: string, flag: boolean): void {
  db.prepare(
    'INSERT INTO group_config (group_id, link_across_groups) VALUES (?, ?) ON CONFLICT(group_id) DO UPDATE SET link_across_groups = excluded.link_across_groups',
  ).run(groupId, flag ? 1 : 0);
}

function seed(
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

function seedInteractions(
  db: DatabaseSync,
  groupId: string,
  userId: string,
  total: number,
): void {
  // Use from_user — the sum reads both sides.
  db.prepare(
    'INSERT INTO interaction_stats (group_id, from_user, to_user, reply_count, last_updated) VALUES (?, ?, ?, ?, ?)',
  ).run(groupId, userId, 'other', total, Date.now());
}

describe('AffinityModule — M9.3 cross-group recognition', () => {
  let db: DatabaseSync;
  let mod: AffinityModule;

  beforeEach(() => {
    db = createTestDb();
    mod = new AffinityModule(db);
  });

  describe('privacy hard-stop', () => {
    it('returns null WITHOUT querying DB when requester flag is off', () => {
      // Seed data in other groups that would otherwise match — shouldn't matter.
      setGroupFlag(db, 'g-other', true);
      seed(db, 'g-other', 'u1', 90, Date.now());
      seedInteractions(db, 'g-other', 'u1', 50);

      // Requester flag is false by default.
      const result = mod.getCrossGroupScore('g-requester', 'u1');
      expect(result).toBeNull();

      // Audit table remains empty — proof of non-access.
      const auditCount = db.prepare('SELECT COUNT(*) as c FROM cross_group_audit').get() as { c: number };
      expect(auditCount.c).toBe(0);
    });

    it('returns null when ALL source groups have flag off (unilateral)', () => {
      setGroupFlag(db, 'g-requester', true);
      // Two other groups exist, neither opted in.
      seed(db, 'g-a', 'u1', 85, Date.now());
      seed(db, 'g-b', 'u1', 80, Date.now());

      const result = mod.getCrossGroupScore('g-requester', 'u1');
      expect(result).toBeNull();
    });

    it('filters out only the non-bilateral source groups', () => {
      setGroupFlag(db, 'g-requester', true);
      setGroupFlag(db, 'g-a', true);   // bilateral
      setGroupFlag(db, 'g-b', false);  // NOT opted in
      seed(db, 'g-a', 'u1', 90, Date.now());
      seedInteractions(db, 'g-a', 'u1', 20);
      seed(db, 'g-b', 'u1', 90, Date.now());
      seedInteractions(db, 'g-b', 'u1', 20);

      const result = mod.getCrossGroupScore('g-requester', 'u1');
      expect(result).not.toBeNull();
      expect(result!.sourceGroups).toEqual(['g-a']);
      expect(result!.groupCount).toBe(1);
    });

    it('excludes the requester group itself from the aggregate', () => {
      setGroupFlag(db, 'g-requester', true);
      setGroupFlag(db, 'g-a', true);
      seed(db, 'g-requester', 'u1', 100, Date.now()); // should be IGNORED
      seed(db, 'g-a', 'u1', 80, Date.now());
      seedInteractions(db, 'g-a', 'u1', 10);

      const result = mod.getCrossGroupScore('g-requester', 'u1');
      expect(result!.sourceGroups).toEqual(['g-a']);
    });
  });

  describe('aggregation math', () => {
    it('picks active group (recent, modest count) over stale group (old, huge count)', () => {
      const now = Date.now();
      const activeRow = {
        groupId: 'g-active',
        score: 90,
        lastInteraction: now - 1 * 24 * 60 * 60 * 1000,  // 1 day ago
        interactionCount: 5,
      };
      const staleRow = {
        groupId: 'g-stale',
        score: 30,
        lastInteraction: now - 30 * 24 * 60 * 60 * 1000, // 30 days ago
        interactionCount: 500,
      };
      const agg = _computeAggregated([activeRow, staleRow], now);
      // Decaying weight favors the active row. Plain-max would be 90, naive
      // count-weighted would be ~30 (dominated by 500 interactions). The
      // decay keeps active ahead of the stale bulk.
      expect(agg).toBeGreaterThan(60);
    });

    it('recency decay ~14d half-life: 1-day row outweighs 60-day row by >3x on equal counts', () => {
      const now = Date.now();
      const recent = {
        groupId: 'g1', score: 80, interactionCount: 10,
        lastInteraction: now - 1 * 24 * 60 * 60 * 1000,
      };
      const old = {
        groupId: 'g2', score: 30, interactionCount: 10,
        lastInteraction: now - 60 * 24 * 60 * 60 * 1000,
      };
      const agg = _computeAggregated([recent, old], now);
      // recency_recent ≈ exp(-1/14) ≈ 0.931
      // recency_old    ≈ exp(-60/14) ≈ 0.013
      // ratio ≈ 72. So agg is dominated by the recent row (80).
      expect(agg).toBeGreaterThan(75);
    });

    it('cold fallback: when total weight < 0.5, returns max(score_g)', () => {
      const now = Date.now();
      // Very cold data — 1 interaction, long ago on both.
      const cold1 = {
        groupId: 'g1', score: 50, interactionCount: 0,
        lastInteraction: now - 90 * 24 * 60 * 60 * 1000,
      };
      const cold2 = {
        groupId: 'g2', score: 85, interactionCount: 0,
        lastInteraction: now - 90 * 24 * 60 * 60 * 1000,
      };
      const agg = _computeAggregated([cold1, cold2], now);
      // log(1+0)=0 → weight=0 → falls back to max(85).
      expect(agg).toBe(85);
    });

    it('all-default scores (30) aggregate near 30', () => {
      const now = Date.now();
      const agg = _computeAggregated(
        [
          { groupId: 'g1', score: 30, interactionCount: 5, lastInteraction: now - 3 * 86400000 },
          { groupId: 'g2', score: 30, interactionCount: 10, lastInteraction: now - 1 * 86400000 },
        ],
        now,
      );
      expect(agg).toBeCloseTo(30, 5);
    });

    it('empty rows return 0', () => {
      expect(_computeAggregated([], Date.now())).toBe(0);
    });
  });

  describe('formatCrossGroupHint thresholds + audit', () => {
    it('emits hint with >2 groups and high aggregate + writes audit row', () => {
      setGroupFlag(db, 'g-req', true);
      setGroupFlag(db, 'g-a', true);
      setGroupFlag(db, 'g-b', true);
      const recent = Date.now() - 1 * 86400000;
      seed(db, 'g-a', 'u1', 90, recent);
      seedInteractions(db, 'g-a', 'u1', 20);
      seed(db, 'g-b', 'u1', 85, recent);
      seedInteractions(db, 'g-b', 'u1', 30);

      const hint = mod.formatCrossGroupHint('g-req', 'u1', '西瓜', 40);
      expect(hint).toBe('（西瓜 和你在其它 2 个群也有互动）');

      const audit = db.prepare('SELECT requester_gid, target_uid, source_gids, aggregated FROM cross_group_audit').all() as Array<{
        requester_gid: string; target_uid: string; source_gids: string; aggregated: number;
      }>;
      expect(audit.length).toBe(1);
      expect(audit[0]!.requester_gid).toBe('g-req');
      expect(audit[0]!.target_uid).toBe('u1');
      expect(JSON.parse(audit[0]!.source_gids)).toEqual(['g-a', 'g-b']);
    });

    it('returns null when only 1 qualifying source group', () => {
      setGroupFlag(db, 'g-req', true);
      setGroupFlag(db, 'g-a', true);
      seed(db, 'g-a', 'u1', 90, Date.now());
      seedInteractions(db, 'g-a', 'u1', 20);

      const hint = mod.formatCrossGroupHint('g-req', 'u1', '小明', 30);
      expect(hint).toBeNull();
      // No audit row written when the gate fails.
      const auditCount = db.prepare('SELECT COUNT(*) as c FROM cross_group_audit').get() as { c: number };
      expect(auditCount.c).toBe(0);
    });

    it('returns null when aggregate <= 70 (all-default scores)', () => {
      setGroupFlag(db, 'g-req', true);
      setGroupFlag(db, 'g-a', true);
      setGroupFlag(db, 'g-b', true);
      seed(db, 'g-a', 'u1', 30, Date.now());
      seedInteractions(db, 'g-a', 'u1', 5);
      seed(db, 'g-b', 'u1', 30, Date.now());
      seedInteractions(db, 'g-b', 'u1', 5);

      expect(mod.formatCrossGroupHint('g-req', 'u1', 'x', 30)).toBeNull();
    });

    it('suppresses hint when user is already well-known locally (currentScore > 70)', () => {
      setGroupFlag(db, 'g-req', true);
      setGroupFlag(db, 'g-a', true);
      setGroupFlag(db, 'g-b', true);
      seed(db, 'g-a', 'u1', 90, Date.now());
      seedInteractions(db, 'g-a', 'u1', 20);
      seed(db, 'g-b', 'u1', 85, Date.now());
      seedInteractions(db, 'g-b', 'u1', 20);

      // Local currentScore 80 — already above ceiling, so skip.
      expect(mod.formatCrossGroupHint('g-req', 'u1', 'x', 80)).toBeNull();
      // And no audit row either.
      const auditCount = db.prepare('SELECT COUNT(*) as c FROM cross_group_audit').get() as { c: number };
      expect(auditCount.c).toBe(0);
    });

    it('emits hint at the boundary currentGroupScore === 70 (ceiling is inclusive)', () => {
      setGroupFlag(db, 'g-req', true);
      setGroupFlag(db, 'g-a', true);
      setGroupFlag(db, 'g-b', true);
      seed(db, 'g-a', 'u1', 90, Date.now());
      seedInteractions(db, 'g-a', 'u1', 20);
      seed(db, 'g-b', 'u1', 85, Date.now());
      seedInteractions(db, 'g-b', 'u1', 20);

      // 70 is the well-known ceiling. Suppression is strict-> (score > 70),
      // so exactly 70 still emits.
      const hint = mod.formatCrossGroupHint('g-req', 'u1', 'x', 70);
      expect(hint).not.toBeNull();
      expect(hint).toContain('其它 2 个群');

      // Audit row is written.
      const auditCount = db.prepare('SELECT COUNT(*) as c FROM cross_group_audit').get() as { c: number };
      expect(auditCount.c).toBe(1);
    });

    it('renders SQL-unsafe nickname safely (no injection, no template break)', () => {
      setGroupFlag(db, 'g-req', true);
      setGroupFlag(db, 'g-a', true);
      setGroupFlag(db, 'g-b', true);
      seed(db, 'g-a', 'u1', 90, Date.now());
      seedInteractions(db, 'g-a', 'u1', 20);
      seed(db, 'g-b', 'u1', 85, Date.now());
      seedInteractions(db, 'g-b', 'u1', 20);

      const nickname = `$injection{} ';DROP TABLE--`;
      const hint = mod.formatCrossGroupHint('g-req', 'u1', nickname, 30);
      expect(hint).toBe(`（${nickname} 和你在其它 2 个群也有互动）`);
      // Audit insert didn't throw and nickname is NOT in audit payload.
      const audit = db.prepare('SELECT source_gids FROM cross_group_audit').all() as Array<{ source_gids: string }>;
      expect(audit.length).toBe(1);
      expect(audit[0]!.source_gids).not.toContain(nickname);
    });
  });

  describe('getScore regression (signature unchanged)', () => {
    it('returns stored score and 30-default', () => {
      seed(db, 'g1', 'u1', 75, Date.now());
      expect(mod.getScore('g1', 'u1')).toBe(75);
      expect(mod.getScore('g1', 'u-unknown')).toBe(30);
    });
  });

  describe('dailyDecay purges audit rows >90d', () => {
    it('purges rows older than 90 days at the boundary', () => {
      const now = Date.now();
      // 91 days old — must be deleted.
      db.prepare(
        'INSERT INTO cross_group_audit (requester_gid, target_uid, source_gids, aggregated, ts) VALUES (?, ?, ?, ?, ?)',
      ).run('g1', 'u1', '["g2"]', 80, now - 91 * 86400000);
      // 89 days old — must be kept.
      db.prepare(
        'INSERT INTO cross_group_audit (requester_gid, target_uid, source_gids, aggregated, ts) VALUES (?, ?, ?, ?, ?)',
      ).run('g1', 'u2', '["g2"]', 80, now - 89 * 86400000);

      mod.dailyDecay();

      const rows = db.prepare('SELECT target_uid FROM cross_group_audit').all() as Array<{ target_uid: string }>;
      expect(rows.map(r => r.target_uid)).toEqual(['u2']);
    });
  });

  describe('forgetUserCrossGroup', () => {
    it('clears rows in OTHER groups only, preserves current group', () => {
      const now = Date.now();
      seed(db, 'g-cur', 'u1', 60, now);
      seed(db, 'g-a', 'u1', 70, now);
      seed(db, 'g-b', 'u1', 80, now);
      seed(db, 'g-a', 'u2', 50, now); // different user, must survive

      const removed = mod.forgetUserCrossGroup('g-cur', 'u1');
      expect(removed).toBe(2);

      const remaining = db.prepare('SELECT group_id, user_id FROM user_affinity ORDER BY group_id, user_id').all() as Array<{
        group_id: string; user_id: string;
      }>;
      expect(remaining).toEqual([
        { group_id: 'g-a', user_id: 'u2' },
        { group_id: 'g-cur', user_id: 'u1' },
      ]);
    });
  });

  describe('listCrossGroupAudit', () => {
    it('returns recent rows in DESC ts order with correct typing', () => {
      const now = Date.now();
      db.prepare(
        'INSERT INTO cross_group_audit (requester_gid, target_uid, source_gids, aggregated, ts) VALUES (?, ?, ?, ?, ?)',
      ).run('g1', 'u1', '["g2","g3"]', 82, now - 1 * 86400000);
      db.prepare(
        'INSERT INTO cross_group_audit (requester_gid, target_uid, source_gids, aggregated, ts) VALUES (?, ?, ?, ?, ?)',
      ).run('g1', 'u2', '["g3"]', 71, now - 2 * 86400000);
      // 40 days ago — filtered out by sinceMs=30d.
      db.prepare(
        'INSERT INTO cross_group_audit (requester_gid, target_uid, source_gids, aggregated, ts) VALUES (?, ?, ?, ?, ?)',
      ).run('g1', 'u3', '["g4"]', 75, now - 40 * 86400000);

      const rows = mod.listCrossGroupAudit({ sinceMs: now - 30 * 86400000, limit: 30 });
      expect(rows.length).toBe(2);
      expect(rows[0]!.targetUid).toBe('u1');
      expect(rows[0]!.sourceGids).toEqual(['g2', 'g3']);
      expect(rows[1]!.targetUid).toBe('u2');
    });

    it('filters by targetUid when provided', () => {
      const now = Date.now();
      db.prepare(
        'INSERT INTO cross_group_audit (requester_gid, target_uid, source_gids, aggregated, ts) VALUES (?, ?, ?, ?, ?)',
      ).run('g1', 'u1', '["g2"]', 80, now - 1 * 86400000);
      db.prepare(
        'INSERT INTO cross_group_audit (requester_gid, target_uid, source_gids, aggregated, ts) VALUES (?, ?, ?, ?, ?)',
      ).run('g1', 'u2', '["g2"]', 80, now - 1 * 86400000);

      const rows = mod.listCrossGroupAudit({ sinceMs: now - 30 * 86400000, targetUid: 'u1', limit: 30 });
      expect(rows.length).toBe(1);
      expect(rows[0]!.targetUid).toBe('u1');
    });
  });

  describe('concurrency + idempotency', () => {
    it('concurrent reads during decay do not throw or return stale values', () => {
      setGroupFlag(db, 'g-req', true);
      setGroupFlag(db, 'g-a', true);
      setGroupFlag(db, 'g-b', true);
      seed(db, 'g-a', 'u1', 90, Date.now());
      seedInteractions(db, 'g-a', 'u1', 20);
      seed(db, 'g-b', 'u1', 85, Date.now());
      seedInteractions(db, 'g-b', 'u1', 20);

      // Interleave reads with decay sweeps (synchronous SQLite — serial).
      expect(() => {
        for (let i = 0; i < 5; i++) {
          mod.getCrossGroupScore('g-req', 'u1');
          mod.dailyDecay();
        }
      }).not.toThrow();

      const final = mod.getCrossGroupScore('g-req', 'u1');
      expect(final).not.toBeNull();
      expect(final!.groupCount).toBe(2);
    });
  });
});
