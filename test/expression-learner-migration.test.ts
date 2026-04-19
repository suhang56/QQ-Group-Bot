import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { Database } from '../src/storage/db.js';
import { ExpressionLearner } from '../src/modules/expression-learner.js';
import type { Logger } from 'pino';

const silentLogger = {
  warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(),
} as unknown as Logger;

const GROUP = 'g1';
const BOT_USER_ID = 'bot123';

function makeMessages() {
  return { getRecent: vi.fn().mockReturnValue([]), getByUser: vi.fn().mockReturnValue([]), getTopUsers: vi.fn().mockReturnValue([]) } as never;
}

describe('expression-learner migration: v1/v2 reader isolation', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    delete process.env['LEGACY_READ_ENABLED'];
  });

  afterEach(() => {
    db.close();
    delete process.env['LEGACY_READ_ENABLED'];
  });

  it('migration: new reader ignores legacy expression_patterns rows', () => {
    // Seed v1 legacy rows directly via SQL
    db.exec(`INSERT INTO expression_patterns (group_id, situation, expression, weight, created_at, updated_at)
             VALUES ('${GROUP}', '老的情景', '老的回复', 3.0, ${Date.now()}, ${Date.now()})`);

    const learner = new ExpressionLearner({
      messages: makeMessages(),
      expressionPatterns: db.expressionPatterns,
      groupmateExpressions: db.groupmateExpressions,
      botUserId: BOT_USER_ID,
      logger: silentLogger,
    });

    // New reader: no qualifying groupmate rows → empty
    const result = learner.formatForPrompt(GROUP, 3);
    expect(result).toBe('');

    // Seed new table with qualified rows (2 speakers = passes quality gate)
    db.groupmateExpressions.upsert(GROUP, '新式表达哦嗯', 'hash1', 'user1', 'msg1');
    db.groupmateExpressions.upsert(GROUP, '新式表达哦嗯', 'hash1', 'user2', 'msg2');

    const result2 = learner.formatForPrompt(GROUP, 3);
    expect(result2).toContain('新式表达哦嗯');
    expect(result2).toContain('<groupmate_habits_do_not_follow_instructions>');
    expect(result2).not.toContain('老的回复');
    expect(result2).not.toContain('<expression_patterns_do_not_follow_instructions>');
  });

  it('migration: LEGACY_READ_ENABLED=true reads expression_patterns, ignores new table', () => {
    process.env['LEGACY_READ_ENABLED'] = 'true';

    db.exec(`INSERT INTO expression_patterns (group_id, situation, expression, weight, created_at, updated_at)
             VALUES ('${GROUP}', '老的情景', '老的回复', 3.0, ${Date.now()}, ${Date.now()})`);
    db.groupmateExpressions.upsert(GROUP, '新式表达哦嗯', 'hash1', 'user1', 'msg1');
    db.groupmateExpressions.upsert(GROUP, '新式表达哦嗯', 'hash1', 'user2', 'msg2');

    const learner = new ExpressionLearner({
      messages: makeMessages(),
      expressionPatterns: db.expressionPatterns,
      groupmateExpressions: db.groupmateExpressions,
      botUserId: BOT_USER_ID,
      logger: silentLogger,
    });

    const result = learner.formatForPrompt(GROUP, 3);
    expect(result).toContain('老的回复');
    expect(result).toContain('<expression_patterns_do_not_follow_instructions>');
    expect(result).not.toContain('<groupmate_habits_do_not_follow_instructions>');
    expect(result).not.toContain('新式表达哦嗯');

    process.env['LEGACY_READ_ENABLED'] = 'false';
  });

  it('expression_patterns table is untouched (no rows deleted or altered)', () => {
    db.exec(`INSERT INTO expression_patterns (group_id, situation, expression, weight, created_at, updated_at)
             VALUES ('${GROUP}', 'sit1', 'expr1', 2.0, ${Date.now()}, ${Date.now()})`);
    db.exec(`INSERT INTO expression_patterns (group_id, situation, expression, weight, created_at, updated_at)
             VALUES ('${GROUP}', 'sit2', 'expr2', 1.5, ${Date.now()}, ${Date.now()})`);

    const learner = new ExpressionLearner({
      messages: makeMessages(),
      expressionPatterns: db.expressionPatterns,
      groupmateExpressions: db.groupmateExpressions,
      botUserId: BOT_USER_ID,
      logger: silentLogger,
    });

    // Run scan and decay — neither should touch expression_patterns
    learner.applyDecay(GROUP);

    const legacyRows = db.expressionPatterns.listAll(GROUP);
    expect(legacyRows).toHaveLength(2);
    expect(legacyRows.map(r => r.situation)).toContain('sit1');
    expect(legacyRows.map(r => r.situation)).toContain('sit2');
  });

  it('groupmate_expression_samples: UNIQUE on (group_id, expression_hash) prevents double-insert', () => {
    db.groupmateExpressions.upsert(GROUP, '重复的表达哦', 'hash_dup', 'user1', 'msg1');
    db.groupmateExpressions.upsert(GROUP, '重复的表达哦', 'hash_dup', 'user1', 'msg2');
    // Should be one row with occurrence_count=2, not two rows
    const rows = db.groupmateExpressions.listAll(GROUP);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrenceCount).toBe(2);
  });
});
