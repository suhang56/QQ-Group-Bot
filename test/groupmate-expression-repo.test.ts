import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../src/storage/db.js';
import type { IGroupmateExpressionRepository } from '../src/storage/db.js';

const GROUP = 'g1';
const NOW_SEC = Math.floor(Date.now() / 1000);

describe('GroupmateExpressionRepository (via Database)', () => {
  let db: Database;
  let repo: IGroupmateExpressionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repo = db.groupmateExpressions;
  });

  afterEach(() => {
    db.close();
  });

  describe('upsert', () => {
    it('first occurrence inserts row with occurrence_count=1, speaker_count=1', () => {
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user1', 'msg1');
      const rows = repo.listAll(GROUP);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.occurrenceCount).toBe(1);
      expect(rows[0]!.speakerCount).toBe(1);
      expect(rows[0]!.speakerUserIds).toEqual(['user1']);
      expect(rows[0]!.sourceMessageIds).toEqual(['msg1']);
      expect(rows[0]!.expression).toBe('哈哈哈哈哈');
      expect(rows[0]!.schemaVersion).toBe(2);
    });

    it('same hash + same speaker: occurrence_count increments, speaker_count stays 1', () => {
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user1', 'msg1');
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user1', 'msg2');
      const rows = repo.listAll(GROUP);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.occurrenceCount).toBe(2);
      expect(rows[0]!.speakerCount).toBe(1);
      expect(rows[0]!.speakerUserIds).toEqual(['user1']);
    });

    it('same hash + new speaker: speaker_count increments', () => {
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user1', 'msg1');
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user2', 'msg2');
      const rows = repo.listAll(GROUP);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.occurrenceCount).toBe(2);
      expect(rows[0]!.speakerCount).toBe(2);
      expect(rows[0]!.speakerUserIds).toContain('user1');
      expect(rows[0]!.speakerUserIds).toContain('user2');
    });

    it('source_message_ids capped at 50 entries', () => {
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user1', 'msg0');
      for (let i = 1; i <= 55; i++) {
        repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user1', `msg${i}`);
      }
      const rows = repo.listAll(GROUP);
      expect(rows[0]!.sourceMessageIds).toHaveLength(50);
    });

    it('different hashes create separate rows', () => {
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user1', 'msg1');
      repo.upsert(GROUP, '笑死了吧', 'hash2', 'user1', 'msg2');
      expect(repo.listAll(GROUP)).toHaveLength(2);
    });

    it('different groups create separate rows for same hash', () => {
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user1', 'msg1');
      repo.upsert('g2', '哈哈哈哈哈', 'hash1', 'user1', 'msg1');
      expect(repo.listAll(GROUP)).toHaveLength(1);
      expect(repo.listAll('g2')).toHaveLength(1);
    });
  });

  describe('listQualified', () => {
    it('occurrence_count=2, speaker_count=1: excluded from quality gate', () => {
      repo.upsert(GROUP, '测试一下吧', 'hash1', 'user1', 'msg1');
      repo.upsert(GROUP, '测试一下吧', 'hash1', 'user1', 'msg2');
      expect(repo.listQualified(GROUP, 10)).toHaveLength(0);
    });

    it('occurrence_count=3, speaker_count=1: included (occurrence_count>=3)', () => {
      repo.upsert(GROUP, '测试一下吧', 'hash1', 'user1', 'msg1');
      repo.upsert(GROUP, '测试一下吧', 'hash1', 'user1', 'msg2');
      repo.upsert(GROUP, '测试一下吧', 'hash1', 'user1', 'msg3');
      const rows = repo.listQualified(GROUP, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.occurrenceCount).toBe(3);
    });

    it('occurrence_count=1, speaker_count=2: included (speaker_count>=2)', () => {
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user1', 'msg1');
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user2', 'msg2');
      const rows = repo.listQualified(GROUP, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.speakerCount).toBe(2);
    });

    it('rejected=1: excluded regardless of counts', () => {
      // Two speakers so it passes the quality gate, then reject it
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user1', 'msg1');
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user2', 'msg2');
      // Get the id and mark rejected via admin path (deleteById then reinsert is too complex;
      // use db.exec to mark rejected — this tests the read path correctly)
      const rows = repo.listAll(GROUP);
      expect(rows).toHaveLength(1);
      // Mark rejected: we need rawDb access — use db.exec
      db.exec(`UPDATE groupmate_expression_samples SET rejected = 1 WHERE id = ${rows[0]!.id}`);
      expect(repo.listQualified(GROUP, 10)).toHaveLength(0);
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        repo.upsert(GROUP, `哈哈哈哈哈${i}`, `hash${i}`, 'user1', `msg${i}`);
        repo.upsert(GROUP, `哈哈哈哈哈${i}`, `hash${i}`, 'user2', `msg${i}b`);
      }
      expect(repo.listQualified(GROUP, 3)).toHaveLength(3);
    });

    it('returns empty array when no rows pass quality gate', () => {
      expect(repo.listQualified(GROUP, 10)).toHaveLength(0);
    });
  });

  describe('deleteDecayed', () => {
    it('last_active_at old + occurrence_count<3: deleted', () => {
      repo.upsert(GROUP, '旧的表达式哦', 'hash1', 'user1', 'msg1');
      const oldSec = NOW_SEC - 31 * 24 * 60 * 60;
      db.exec(`UPDATE groupmate_expression_samples SET last_active_at = ${oldSec} WHERE group_id = '${GROUP}'`);
      const cutoff = NOW_SEC - 30 * 24 * 60 * 60;
      const deleted = repo.deleteDecayed(GROUP, cutoff);
      expect(deleted).toBe(1);
      expect(repo.listAll(GROUP)).toHaveLength(0);
    });

    it('last_active_at old + occurrence_count>=3: NOT deleted', () => {
      repo.upsert(GROUP, '频繁说的话哦', 'hash1', 'user1', 'msg1');
      repo.upsert(GROUP, '频繁说的话哦', 'hash1', 'user1', 'msg2');
      repo.upsert(GROUP, '频繁说的话哦', 'hash1', 'user1', 'msg3');
      const oldSec = NOW_SEC - 31 * 24 * 60 * 60;
      db.exec(`UPDATE groupmate_expression_samples SET last_active_at = ${oldSec} WHERE group_id = '${GROUP}'`);
      const cutoff = NOW_SEC - 30 * 24 * 60 * 60;
      const deleted = repo.deleteDecayed(GROUP, cutoff);
      expect(deleted).toBe(0);
      expect(repo.listAll(GROUP)).toHaveLength(1);
    });

    it('last_active_at recent + occurrence_count<3: NOT deleted', () => {
      repo.upsert(GROUP, '新鲜的表达式', 'hash1', 'user1', 'msg1');
      const cutoff = NOW_SEC - 30 * 24 * 60 * 60;
      const deleted = repo.deleteDecayed(GROUP, cutoff);
      expect(deleted).toBe(0);
      expect(repo.listAll(GROUP)).toHaveLength(1);
    });

    it('returns count of deleted rows', () => {
      const oldSec = NOW_SEC - 31 * 24 * 60 * 60;
      const cutoff = NOW_SEC - 30 * 24 * 60 * 60;
      for (let i = 0; i < 3; i++) {
        repo.upsert(GROUP, `旧的${i}哦hello`, `hash${i}`, 'user1', `msg${i}`);
        db.exec(`UPDATE groupmate_expression_samples SET last_active_at = ${oldSec} WHERE expression_hash = 'hash${i}'`);
      }
      expect(repo.deleteDecayed(GROUP, cutoff)).toBe(3);
    });
  });

  describe('deleteById', () => {
    it('removes the correct row by id', () => {
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user1', 'msg1');
      repo.upsert(GROUP, '笑死了吧', 'hash2', 'user1', 'msg2');
      const all = repo.listAll(GROUP);
      const id = all[0]!.id;
      repo.deleteById(id);
      const remaining = repo.listAll(GROUP);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.id).not.toBe(id);
    });

    it('no-op when id does not exist', () => {
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user1', 'msg1');
      repo.deleteById(99999);
      expect(repo.listAll(GROUP)).toHaveLength(1);
    });
  });

  describe('listQualifiedCandidates (R1-B)', () => {
    it('excludes rows with schema_version != 2', () => {
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user1', 'msg1');
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user2', 'msg2');
      // Default upsert sets schema_version=2; force it to 1 to test exclusion
      db.exec("UPDATE groupmate_expression_samples SET schema_version = 1 WHERE expression_hash = 'hash1'");
      expect(repo.listQualifiedCandidates(GROUP, 50)).toHaveLength(0);
    });

    it('includes rows with schema_version=2 and passing quality gate', () => {
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user1', 'msg1');
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user2', 'msg2');
      const rows = repo.listQualifiedCandidates(GROUP, 50);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.schemaVersion).toBe(2);
    });

    it('excludes rejected=1 rows', () => {
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user1', 'msg1');
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user2', 'msg2');
      const all = repo.listAll(GROUP);
      db.exec(`UPDATE groupmate_expression_samples SET rejected = 1 WHERE id = ${all[0]!.id}`);
      expect(repo.listQualifiedCandidates(GROUP, 50)).toHaveLength(0);
    });

    it('excludes rows failing quality gate (occurrence_count<3 AND speaker_count<2)', () => {
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user1', 'msg1');
      repo.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user1', 'msg2');
      // 2 occurrences, 1 speaker → excluded
      expect(repo.listQualifiedCandidates(GROUP, 50)).toHaveLength(0);
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        repo.upsert(GROUP, `哈哈哈哈哈${i}`, `hash${i}`, 'user1', `msg${i}`);
        repo.upsert(GROUP, `哈哈哈哈哈${i}`, `hash${i}`, 'user2', `msg${i}b`);
      }
      expect(repo.listQualifiedCandidates(GROUP, 3)).toHaveLength(3);
    });

    it('returns empty when table is empty', () => {
      expect(repo.listQualifiedCandidates(GROUP, 50)).toHaveLength(0);
    });
  });
});
