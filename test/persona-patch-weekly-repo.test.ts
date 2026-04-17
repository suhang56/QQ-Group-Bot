/**
 * M8.1 — PersonaPatchRepository weekly-kind coverage.
 * Covers: insert(kind), countProposalsSince(kind), hasRecentDuplicate(kind),
 * findLastWeekly, rejectStaleDailiesBefore, weekly-first sort in listPending /
 * listHistory, schema migration idempotency with existing DBs, and back-compat
 * (legacy rows written before the kind column default to 'daily').
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../src/storage/db.js';
import { defaultGroupConfig } from '../src/config.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const GROUP = 'g-ppw-repo';
const DAY = 86400;
const OLD = '你是一个邦多利 bot，说话轻快活泼。';
const NEW_D = '你是一个邦多利 bot，日级调优版本，说话稍温柔一点。';
const NEW_W = '你是一个邦多利 bot，周级整体调优版本，更温柔并且跟着群友话题走。';

function makeDb(): Database {
  return new Database(':memory:');
}

function seedConfig(db: Database, groupId = GROUP, persona: string | null = OLD): void {
  db.groupConfig.upsert({ ...defaultGroupConfig(groupId), chatPersonaText: persona });
}

function insert(
  db: Database,
  kind: 'daily' | 'weekly',
  overrides: Partial<{ createdAt: number; newPersonaText: string; groupId: string; oldPersonaText: string | null }> = {},
): number {
  const now = Math.floor(Date.now() / 1000);
  return db.personaPatches.insert({
    groupId: overrides.groupId ?? GROUP,
    oldPersonaText: 'oldPersonaText' in overrides ? overrides.oldPersonaText! : OLD,
    newPersonaText: overrides.newPersonaText ?? (kind === 'weekly' ? NEW_W : NEW_D),
    reasoning: '测试 reasoning',
    diffSummary: '-a\n+b',
    kind,
    createdAt: overrides.createdAt ?? now,
  });
}

describe('PersonaPatchRepository — M8.1 weekly kind', () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
    seedConfig(db);
  });

  describe('insert with kind', () => {
    it('stores kind and round-trips via getById', () => {
      const weeklyId = insert(db, 'weekly');
      const dailyId = insert(db, 'daily');
      expect(db.personaPatches.getById(weeklyId)!.kind).toBe('weekly');
      expect(db.personaPatches.getById(dailyId)!.kind).toBe('daily');
    });

    it('defaults kind to daily when caller omits it (back-compat)', () => {
      // Cast to the old signature — the insert type tolerates missing kind.
      const id = db.personaPatches.insert({
        groupId: GROUP,
        oldPersonaText: OLD,
        newPersonaText: NEW_D,
        reasoning: 'r',
        diffSummary: '-a\n+b',
        createdAt: Math.floor(Date.now() / 1000),
      });
      expect(db.personaPatches.getById(id)!.kind).toBe('daily');
    });
  });

  describe('countProposalsSince — kind filter', () => {
    it('filters by kind when provided', () => {
      const now = Math.floor(Date.now() / 1000);
      insert(db, 'daily', { createdAt: now - 100 });
      insert(db, 'daily', { createdAt: now - 50, newPersonaText: NEW_D + ' v2' });
      insert(db, 'weekly', { createdAt: now - 10 });
      expect(db.personaPatches.countProposalsSince(GROUP, now - 3600, 'daily')).toBe(2);
      expect(db.personaPatches.countProposalsSince(GROUP, now - 3600, 'weekly')).toBe(1);
      expect(db.personaPatches.countProposalsSince(GROUP, now - 3600)).toBe(3);
    });
  });

  describe('hasRecentDuplicate — kind filter', () => {
    it('daily and weekly have independent dedup spaces', () => {
      const now = Math.floor(Date.now() / 1000);
      insert(db, 'daily', { newPersonaText: NEW_D, createdAt: now - 60 });
      expect(db.personaPatches.hasRecentDuplicate(GROUP, NEW_D, 3600, now, 'daily')).toBe(true);
      // Not a dup against weekly, even though text identical — different kind.
      expect(db.personaPatches.hasRecentDuplicate(GROUP, NEW_D, 3600, now, 'weekly')).toBe(false);
    });

    it('no-kind call still matches any kind (legacy callers keep working)', () => {
      const now = Math.floor(Date.now() / 1000);
      insert(db, 'weekly', { newPersonaText: NEW_W, createdAt: now - 60 });
      expect(db.personaPatches.hasRecentDuplicate(GROUP, NEW_W, 3600, now)).toBe(true);
    });
  });

  describe('findLastWeekly', () => {
    it('returns the newest weekly for the group, or null', () => {
      expect(db.personaPatches.findLastWeekly(GROUP)).toBeNull();
      const now = Math.floor(Date.now() / 1000);
      insert(db, 'weekly', { createdAt: now - 2 * DAY });
      const newest = insert(db, 'weekly', { createdAt: now - DAY, newPersonaText: NEW_W + ' v2' });
      insert(db, 'daily', { createdAt: now }); // ignored
      const found = db.personaPatches.findLastWeekly(GROUP);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(newest);
      expect(found!.kind).toBe('weekly');
    });

    it('does not leak across groups', () => {
      seedConfig(db, 'other', 'other persona');
      insert(db, 'weekly', { groupId: 'other' });
      expect(db.personaPatches.findLastWeekly(GROUP)).toBeNull();
    });
  });

  describe('rejectStaleDailiesBefore', () => {
    it('rejects pending dailies older than beforeTs, leaves newer + non-daily untouched', () => {
      const now = Math.floor(Date.now() / 1000);
      const staleDaily = insert(db, 'daily', { createdAt: now - 3 * DAY });
      const freshDaily = insert(db, 'daily', { createdAt: now - 60, newPersonaText: NEW_D + ' v2' });
      const weekly = insert(db, 'weekly', { createdAt: now - 2 * DAY, newPersonaText: NEW_W });
      const count = db.personaPatches.rejectStaleDailiesBefore(GROUP, now - DAY, 'admin-x', now);
      expect(count).toBe(1);
      expect(db.personaPatches.getById(staleDaily)!.status).toBe('rejected');
      expect(db.personaPatches.getById(staleDaily)!.decidedBy).toBe('admin-x');
      expect(db.personaPatches.getById(freshDaily)!.status).toBe('pending');
      expect(db.personaPatches.getById(weekly)!.status).toBe('pending');
    });

    it('does not touch already-decided dailies', () => {
      const now = Math.floor(Date.now() / 1000);
      const approved = insert(db, 'daily', { createdAt: now - 3 * DAY });
      // Reject it first — not pending anymore
      db.personaPatches.reject(approved, 'admin', now);
      const count = db.personaPatches.rejectStaleDailiesBefore(GROUP, now - DAY, 'admin-x', now);
      expect(count).toBe(0);
      // decidedBy preserved from original reject
      expect(db.personaPatches.getById(approved)!.decidedBy).toBe('admin');
    });
  });

  describe('weekly-first sort', () => {
    it('listPending returns weekly rows before daily rows, even when daily is newer', () => {
      const now = Math.floor(Date.now() / 1000);
      insert(db, 'daily', { createdAt: now - 60 });
      const weeklyId = insert(db, 'weekly', { createdAt: now - 3600, newPersonaText: NEW_W });
      const pending = db.personaPatches.listPending(GROUP, now, 14 * DAY);
      expect(pending[0]!.id).toBe(weeklyId);
      expect(pending[0]!.kind).toBe('weekly');
    });

    it('listHistory returns weekly rows before daily rows', () => {
      const now = Math.floor(Date.now() / 1000);
      insert(db, 'daily', { createdAt: now - 60 });
      const weeklyId = insert(db, 'weekly', { createdAt: now - 3600, newPersonaText: NEW_W });
      const rows = db.personaPatches.listHistory(GROUP, now - 30 * DAY);
      expect(rows[0]!.id).toBe(weeklyId);
    });
  });

  describe('back-compat: pre-M8.1 rows (kind column absent at insert time)', () => {
    it('rows inserted without kind (via the no-kind column list) default to daily', () => {
      // Simulate a pre-M8.1 INSERT statement that doesn't name the kind column.
      // The ALTER TABLE default ('daily') fills it for new inserts; _row()
      // surfaces it as a typed 'daily' on read.
      const raw = db.rawDb;
      raw.prepare(`
        INSERT INTO persona_patch_proposals (group_id, old_persona_text, new_persona_text, reasoning, diff_summary, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(GROUP, OLD, NEW_D, 'r', '-a\n+b', Math.floor(Date.now() / 1000));
      const rows = db.personaPatches.listHistory(GROUP, 0);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.kind).toBe('daily');
    });

    it('_row maps any unexpected kind string back to daily (defensive)', () => {
      // Shove a bogus value in via raw SQL — _row should not propagate it as-is.
      const raw = db.rawDb;
      raw.prepare(`
        INSERT INTO persona_patch_proposals (group_id, old_persona_text, new_persona_text, reasoning, diff_summary, kind, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(GROUP, OLD, NEW_D, 'r', '-a\n+b', 'mystery', Math.floor(Date.now() / 1000));
      const rows = db.personaPatches.listHistory(GROUP, 0);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.kind).toBe('daily');
    });
  });

  describe('schema migration idempotency (M8.1 ALTER)', () => {
    it('opening the DB twice against the same file does not error (duplicate column swallowed)', () => {
      const p = path.join(os.tmpdir(), `ppw-mig-${Date.now()}.sqlite`);
      try {
        const d1 = new Database(p);
        seedConfig(d1, GROUP);
        const id1 = d1.personaPatches.insert({
          groupId: GROUP, oldPersonaText: OLD, newPersonaText: NEW_W,
          reasoning: 'r', diffSummary: '-a\n+b', kind: 'weekly',
          createdAt: Math.floor(Date.now() / 1000),
        });
        d1.close();
        // Second open — ALTER TABLE should be a no-op and not throw.
        const d2 = new Database(p);
        const found = d2.personaPatches.getById(id1);
        expect(found).not.toBeNull();
        expect(found!.kind).toBe('weekly');
        d2.close();
      } finally {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
    });
  });
});
