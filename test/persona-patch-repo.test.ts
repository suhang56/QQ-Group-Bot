import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../src/storage/db.js';
import { defaultGroupConfig } from '../src/config.js';

function makeDb(): Database {
  return new Database(':memory:');
}

const GROUP = 'g-persona';
const DAY = 86400;
const TTL_SEC = 7 * DAY;
const OLD_PERSONA = '你是一个邦多利群的 bot，说话轻快活泼，常用颜文字。';
const NEW_PERSONA = '你是一个邦多利群的 bot，说话偏温柔克制，保留少量颜文字。';

function insert(db: Database, overrides: Partial<{
  oldPersonaText: string | null;
  newPersonaText: string;
  reasoning: string;
  diffSummary: string;
  createdAt: number;
  groupId: string;
}> = {}): number {
  const now = Math.floor(Date.now() / 1000);
  return db.personaPatches.insert({
    groupId: overrides.groupId ?? GROUP,
    oldPersonaText: 'oldPersonaText' in overrides ? overrides.oldPersonaText! : OLD_PERSONA,
    newPersonaText: overrides.newPersonaText ?? NEW_PERSONA,
    reasoning: overrides.reasoning ?? '群里氛围偏温和，你可以少用夸张颜文字。',
    diffSummary: overrides.diffSummary ?? '- 轻快活泼\n+ 温柔克制',
    createdAt: overrides.createdAt ?? now,
  });
}

function seedConfig(db: Database, groupId = GROUP, persona: string | null = OLD_PERSONA): void {
  const cfg = defaultGroupConfig(groupId);
  db.groupConfig.upsert({ ...cfg, chatPersonaText: persona });
}

describe('PersonaPatchRepository', () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
    seedConfig(db);
  });

  describe('insert / getById', () => {
    it('insert returns id > 0 and the row round-trips via getById', () => {
      const id = insert(db);
      expect(id).toBeGreaterThan(0);
      const p = db.personaPatches.getById(id);
      expect(p).not.toBeNull();
      expect(p!.groupId).toBe(GROUP);
      expect(p!.newPersonaText).toBe(NEW_PERSONA);
      expect(p!.status).toBe('pending');
      expect(p!.decidedAt).toBeNull();
      expect(p!.decidedBy).toBeNull();
    });

    it('getById returns null for unknown id', () => {
      expect(db.personaPatches.getById(9999)).toBeNull();
    });

    it('preserves nullable oldPersonaText', () => {
      const id = insert(db, { oldPersonaText: null });
      const p = db.personaPatches.getById(id)!;
      expect(p.oldPersonaText).toBeNull();
    });
  });

  describe('listPending', () => {
    it('returns only pending rows for the group, newest first', () => {
      const now = Math.floor(Date.now() / 1000);
      const id1 = insert(db, { createdAt: now - 100 });
      const id2 = insert(db, { createdAt: now - 10 });
      // different group should not leak
      insert(db, { groupId: 'other', createdAt: now });

      const pending = db.personaPatches.listPending(GROUP, now, TTL_SEC);
      expect(pending.map(p => p.id)).toEqual([id2, id1]);
    });

    it('filters out rows older than ttlSec (expired), keeping them in DB', () => {
      const now = Math.floor(Date.now() / 1000);
      const freshId = insert(db, { createdAt: now - 60 });
      const staleId = insert(db, { createdAt: now - (TTL_SEC + 100) });

      const pending = db.personaPatches.listPending(GROUP, now, TTL_SEC);
      expect(pending.map(p => p.id)).toEqual([freshId]);
      // stale row still exists via getById
      expect(db.personaPatches.getById(staleId)).not.toBeNull();
    });

    it('does not list approved / rejected / superseded rows', () => {
      const now = Math.floor(Date.now() / 1000);
      const approvedId = insert(db);
      const rejectedId = insert(db, { newPersonaText: NEW_PERSONA + ' v2' });

      // Apply first: this also supersedes any other pending rows in the group,
      // so subsequent `reject` of rejectedId will no-op (reject only mutates
      // pending rows). Force-reject by re-inserting rejected separately.
      db.personaPatches.apply(approvedId, 'admin', now);
      db.personaPatches.reject(rejectedId, 'admin', now);
      const pendingId = insert(db, { newPersonaText: NEW_PERSONA + ' v3' });

      const pending = db.personaPatches.listPending(GROUP, now, TTL_SEC);
      expect(pending.map(p => p.id)).toEqual([pendingId]);
    });
  });

  describe('listHistory', () => {
    it('returns all statuses within window, newest first', () => {
      const now = Math.floor(Date.now() / 1000);
      const id1 = insert(db, { createdAt: now - 2 * DAY });
      const id2 = insert(db, { createdAt: now - DAY, newPersonaText: NEW_PERSONA + ' v2' });
      db.personaPatches.reject(id2, 'admin', now);

      const rows = db.personaPatches.listHistory(GROUP, now - 30 * DAY);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.id).toBe(id2);
      expect(rows[0]!.status).toBe('rejected');
      expect(rows[1]!.id).toBe(id1);
    });

    it('respects sinceSec cutoff', () => {
      const now = Math.floor(Date.now() / 1000);
      insert(db, { createdAt: now - 40 * DAY });
      const recentId = insert(db, { createdAt: now - DAY, newPersonaText: NEW_PERSONA + ' v2' });
      const rows = db.personaPatches.listHistory(GROUP, now - 30 * DAY);
      expect(rows.map(r => r.id)).toEqual([recentId]);
    });
  });

  describe('countProposalsSince', () => {
    it('counts rows with created_at >= sinceSec', () => {
      const now = Math.floor(Date.now() / 1000);
      insert(db, { createdAt: now - 3600 });
      insert(db, { createdAt: now - 1800, newPersonaText: NEW_PERSONA + ' v2' });
      insert(db, { createdAt: now - 86400 * 2, newPersonaText: NEW_PERSONA + ' v3' });

      expect(db.personaPatches.countProposalsSince(GROUP, now - 7200)).toBe(2);
      expect(db.personaPatches.countProposalsSince(GROUP, now - 86400 * 3)).toBe(3);
      expect(db.personaPatches.countProposalsSince(GROUP, now + 60)).toBe(0);
    });

    it('scopes by groupId', () => {
      const now = Math.floor(Date.now() / 1000);
      insert(db);
      insert(db, { groupId: 'other', newPersonaText: NEW_PERSONA + ' v2' });
      expect(db.personaPatches.countProposalsSince(GROUP, now - 86400)).toBe(1);
      expect(db.personaPatches.countProposalsSince('other', now - 86400)).toBe(1);
    });
  });

  describe('reject', () => {
    it('sets status=rejected + decidedAt/decidedBy; only on pending rows', () => {
      const id = insert(db);
      const now = Math.floor(Date.now() / 1000);
      db.personaPatches.reject(id, 'admin-1', now);
      const p = db.personaPatches.getById(id)!;
      expect(p.status).toBe('rejected');
      expect(p.decidedAt).toBe(now);
      expect(p.decidedBy).toBe('admin-1');

      // second reject on non-pending row is a no-op
      db.personaPatches.reject(id, 'admin-2', now + 100);
      const p2 = db.personaPatches.getById(id)!;
      expect(p2.decidedBy).toBe('admin-1');
      expect(p2.decidedAt).toBe(now);
    });
  });

  describe('apply — transactional', () => {
    it('marks approved + updates group_config.chat_persona_text + supersedes other pendings', () => {
      const now = Math.floor(Date.now() / 1000);
      const target = insert(db);
      const sibling = insert(db, { newPersonaText: NEW_PERSONA + ' v-alt' });

      const ok = db.personaPatches.apply(target, 'admin', now);
      expect(ok).toBe(true);

      expect(db.personaPatches.getById(target)!.status).toBe('approved');
      expect(db.personaPatches.getById(sibling)!.status).toBe('superseded');

      const cfg = db.groupConfig.get(GROUP)!;
      expect(cfg.chatPersonaText).toBe(NEW_PERSONA);
    });

    it('returns false when the proposal is not pending', () => {
      const now = Math.floor(Date.now() / 1000);
      const id = insert(db);
      db.personaPatches.reject(id, 'admin', now);
      const ok = db.personaPatches.apply(id, 'admin', now + 10);
      expect(ok).toBe(false);
      // group_config not touched
      expect(db.groupConfig.get(GROUP)!.chatPersonaText).toBe(OLD_PERSONA);
    });

    it('returns false and rolls back when group_config row is missing', () => {
      // drop the group_config row so UPDATE touches 0 rows
      const raw = db.rawDb;
      raw.prepare('DELETE FROM group_config WHERE group_id = ?').run(GROUP);

      const id = insert(db);
      const ok = db.personaPatches.apply(id, 'admin', Math.floor(Date.now() / 1000));
      expect(ok).toBe(false);
      // proposal must remain pending — no half-applied approve
      expect(db.personaPatches.getById(id)!.status).toBe('pending');
    });

    it('does not supersede proposals for other groups', () => {
      const now = Math.floor(Date.now() / 1000);
      seedConfig(db, 'other-grp', 'other persona');
      const target = insert(db);
      const otherPending = insert(db, { groupId: 'other-grp' });

      db.personaPatches.apply(target, 'admin', now);
      expect(db.personaPatches.getById(otherPending)!.status).toBe('pending');
    });

    it('expiry filtering does not touch approved / rejected / superseded rows', () => {
      const now = Math.floor(Date.now() / 1000);
      const approved = insert(db, { createdAt: now - (TTL_SEC + 100) });
      db.personaPatches.apply(approved, 'admin', now);

      // row still listable in history
      const history = db.personaPatches.listHistory(GROUP, now - TTL_SEC * 2);
      expect(history.find(r => r.id === approved)!.status).toBe('approved');
    });
  });

  describe('hasRecentDuplicate', () => {
    it('detects identical new_persona_text inside window', () => {
      const now = Math.floor(Date.now() / 1000);
      insert(db, { createdAt: now - 60 });
      expect(db.personaPatches.hasRecentDuplicate(GROUP, NEW_PERSONA, 3600, now)).toBe(true);
      expect(db.personaPatches.hasRecentDuplicate(GROUP, NEW_PERSONA + ' x', 3600, now)).toBe(false);
    });

    it('respects the window cutoff', () => {
      const now = Math.floor(Date.now() / 1000);
      insert(db, { createdAt: now - 7200 });
      expect(db.personaPatches.hasRecentDuplicate(GROUP, NEW_PERSONA, 3600, now)).toBe(false);
      expect(db.personaPatches.hasRecentDuplicate(GROUP, NEW_PERSONA, 10800, now)).toBe(true);
    });
  });

  describe('partial index on pending status', () => {
    it('is used by the listPending query (sqlite explain mentions idx_persona_patch_group_pending)', () => {
      // seed a few rows so the planner has something to optimise
      const now = Math.floor(Date.now() / 1000);
      insert(db, { createdAt: now - 60 });
      insert(db, { createdAt: now - 30, newPersonaText: NEW_PERSONA + ' v2' });

      const raw = db.rawDb;
      const plan = raw.prepare(
        `EXPLAIN QUERY PLAN
           SELECT * FROM persona_patch_proposals
            WHERE group_id = ? AND status = 'pending' AND created_at >= ?
            ORDER BY created_at DESC LIMIT ?`
      ).all(GROUP, now - TTL_SEC, 20) as Array<{ detail: string }>;
      const joined = plan.map(r => r.detail).join(' | ');
      expect(joined).toMatch(/idx_persona_patch_group_pending|idx_persona_patch_group_created/);
    });
  });

  describe('migration idempotency', () => {
    it('re-running the Database constructor on the same sqlite file does not break rows', () => {
      const path = require('node:path').join(require('node:os').tmpdir(), `persona-patch-mig-${Date.now()}.sqlite`);
      try {
        const d1 = new Database(path);
        d1.groupConfig.upsert({ ...defaultGroupConfig(GROUP), chatPersonaText: OLD_PERSONA });
        const id = d1.personaPatches.insert({
          groupId: GROUP, oldPersonaText: OLD_PERSONA, newPersonaText: NEW_PERSONA,
          reasoning: 'r', diffSummary: '-a\n+b', createdAt: Math.floor(Date.now() / 1000),
        });
        d1.close();

        const d2 = new Database(path);
        const p = d2.personaPatches.getById(id);
        expect(p).not.toBeNull();
        expect(p!.newPersonaText).toBe(NEW_PERSONA);
        d2.close();
      } finally {
        try { require('node:fs').unlinkSync(path); } catch { /* ignore */ }
      }
    });
  });
});
