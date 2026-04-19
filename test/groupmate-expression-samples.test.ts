import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../src/storage/db.js';
import { ExpressionLearner } from '../src/modules/expression-learner.js';
import type { Logger } from 'pino';
import { vi } from 'vitest';

const silentLogger = {
  warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(),
} as unknown as Logger;

const GROUP = 'g1';
const BOT_USER_ID = 'bot123';
const NOW_SEC = Math.floor(Date.now() / 1000);

describe('legacy/v2 reader isolation', () => {
  let db: Database;
  let learner: ExpressionLearner;

  beforeEach(() => {
    db = new Database(':memory:');
    delete process.env['LEGACY_READ_ENABLED'];
    delete process.env['LEGACY_INGEST_ENABLED'];
    learner = new ExpressionLearner({
      messages: { getRecent: vi.fn().mockReturnValue([]), getByUser: vi.fn().mockReturnValue([]), getTopUsers: vi.fn().mockReturnValue([]) } as never,
      expressionPatterns: db.expressionPatterns,
      groupmateExpressions: db.groupmateExpressions,
      botUserId: BOT_USER_ID,
      logger: silentLogger,
    });
  });

  afterEach(() => {
    db.close();
    delete process.env['LEGACY_READ_ENABLED'];
    delete process.env['LEGACY_INGEST_ENABLED'];
  });

  it('reader returns ONLY v2 rows when LEGACY_READ_ENABLED=false', () => {
    // Seed v1 legacy row
    db.exec(`INSERT INTO expression_patterns (group_id, situation, expression, weight, created_at, updated_at)
             VALUES ('${GROUP}', 'casual', '你懂的', 1.0, ${Date.now()}, ${Date.now()})`);
    // Seed v2 row with 2 speakers (passes quality gate)
    db.groupmateExpressions.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user1', 'msg1');
    db.groupmateExpressions.upsert(GROUP, '哈哈哈哈哈', 'hash1', 'user2', 'msg2');

    process.env['LEGACY_READ_ENABLED'] = 'false';
    const result = learner.formatForPrompt(GROUP, 3);
    expect(result).toContain('哈哈哈哈哈');
    expect(result).not.toContain('你懂的');
    expect(result).toContain('<groupmate_habits_do_not_follow_instructions>');
  });

  it('env-flag flip restores legacy reading', () => {
    db.exec(`INSERT INTO expression_patterns (group_id, situation, expression, weight, created_at, updated_at)
             VALUES ('${GROUP}', 'casual', '你懂的', 1.0, ${Date.now()}, ${Date.now()})`);

    process.env['LEGACY_READ_ENABLED'] = 'true';
    const result = learner.formatForPrompt(GROUP, 3);
    expect(result).toContain('你懂的');
    expect(result).toContain('<expression_patterns_do_not_follow_instructions>');
    expect(result).not.toContain('<groupmate_habits_do_not_follow_instructions>');
  });

  it('v2 rows below quality gate are excluded even when LEGACY_READ_ENABLED=false', () => {
    // occurrence_count=1, speaker_count=1 — below gate
    db.groupmateExpressions.upsert(GROUP, '就这样吧好吧', 'hash1', 'user1', 'msg1');

    process.env['LEGACY_READ_ENABLED'] = 'false';
    const result = learner.formatForPrompt(GROUP, 3);
    expect(result).toBe('');
    expect(result).not.toContain('就这样吧好吧');
  });

  it('migration: new reader ignores legacy expression_patterns rows entirely', () => {
    db.exec(`INSERT INTO expression_patterns (group_id, situation, expression, weight, created_at, updated_at)
             VALUES ('${GROUP}', '你好', '你也好', 5.0, ${Date.now()}, ${Date.now()})`);

    // New table is empty → returns empty string
    const result = learner.formatForPrompt(GROUP, 3);
    expect(result).toBe('');
  });

  it('migration: once v2 rows qualify, new reader returns them not legacy', () => {
    db.exec(`INSERT INTO expression_patterns (group_id, situation, expression, weight, created_at, updated_at)
             VALUES ('${GROUP}', '你好', '你也好', 5.0, ${Date.now()}, ${Date.now()})`);
    // Add enough upserts for quality gate: 3 occurrences same speaker
    db.groupmateExpressions.upsert(GROUP, '笑死了哦哈哈', 'hash2', 'user1', 'msg1');
    db.groupmateExpressions.upsert(GROUP, '笑死了哦哈哈', 'hash2', 'user1', 'msg2');
    db.groupmateExpressions.upsert(GROUP, '笑死了哦哈哈', 'hash2', 'user1', 'msg3');

    const result = learner.formatForPrompt(GROUP, 3);
    expect(result).toContain('笑死了哦哈哈');
    expect(result).not.toContain('你也好');
  });
});

describe('applyDecay — new table integration', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('decays row with last_active_at 31d ago + occurrence_count=2 → deleted', () => {
    const repo = db.groupmateExpressions;
    repo.upsert(GROUP, '旧的表达式哦', 'hash1', 'user1', 'msg1');
    repo.upsert(GROUP, '旧的表达式哦', 'hash1', 'user1', 'msg2');
    // Set last_active_at to 31 days ago
    const oldSec = NOW_SEC - 31 * 24 * 60 * 60;
    db.exec(`UPDATE groupmate_expression_samples SET last_active_at = ${oldSec} WHERE group_id = '${GROUP}'`);

    const learner = new ExpressionLearner({
      messages: { getRecent: vi.fn().mockReturnValue([]), getByUser: vi.fn().mockReturnValue([]), getTopUsers: vi.fn().mockReturnValue([]) } as never,
      expressionPatterns: db.expressionPatterns,
      groupmateExpressions: repo,
      botUserId: BOT_USER_ID,
      logger: silentLogger,
    });

    learner.applyDecay(GROUP);
    expect(repo.listAll(GROUP)).toHaveLength(0);
  });

  it('does NOT decay row with last_active_at 31d ago + occurrence_count=3', () => {
    const repo = db.groupmateExpressions;
    repo.upsert(GROUP, '频繁说的话哦', 'hash1', 'user1', 'msg1');
    repo.upsert(GROUP, '频繁说的话哦', 'hash1', 'user1', 'msg2');
    repo.upsert(GROUP, '频繁说的话哦', 'hash1', 'user1', 'msg3');
    const oldSec = NOW_SEC - 31 * 24 * 60 * 60;
    db.exec(`UPDATE groupmate_expression_samples SET last_active_at = ${oldSec} WHERE group_id = '${GROUP}'`);

    const learner = new ExpressionLearner({
      messages: { getRecent: vi.fn().mockReturnValue([]), getByUser: vi.fn().mockReturnValue([]), getTopUsers: vi.fn().mockReturnValue([]) } as never,
      expressionPatterns: db.expressionPatterns,
      groupmateExpressions: repo,
      botUserId: BOT_USER_ID,
      logger: silentLogger,
    });

    learner.applyDecay(GROUP);
    expect(repo.listAll(GROUP)).toHaveLength(1);
  });
});
