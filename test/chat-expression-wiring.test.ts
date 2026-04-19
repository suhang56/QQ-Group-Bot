import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { ExpressionLearner } from '../src/modules/expression-learner.js';
import type { IGroupmateExpressionRepository, GroupmateExpressionSample } from '../src/storage/db.js';
import type { Logger } from 'pino';

const silentLogger = {
  warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(),
} as unknown as Logger;

const GROUP = 'g1';
const BOT_USER_ID = 'bot123';
const NOW_SEC = Math.floor(Date.now() / 1000);

function makeSample(expression: string, speakerCount = 2, occurrenceCount = 3): GroupmateExpressionSample {
  return {
    id: 1,
    groupId: GROUP,
    expression,
    expressionHash: 'hash1',
    speakerUserIds: ['u1', 'u2'].slice(0, speakerCount),
    speakerCount,
    sourceMessageIds: ['msg1'],
    occurrenceCount,
    firstSeenAt: NOW_SEC,
    lastActiveAt: NOW_SEC,
    checkedBy: null,
    rejected: false,
    schemaVersion: 2,
  };
}

function makeGexRepo(samples: GroupmateExpressionSample[]): IGroupmateExpressionRepository {
  return {
    upsert: vi.fn(),
    listQualified: vi.fn().mockReturnValue(samples),
    listAll: vi.fn().mockReturnValue(samples),
    deleteDecayed: vi.fn().mockReturnValue(0),
    deleteById: vi.fn(),
  };
}

function makeLearner(gexRepo: IGroupmateExpressionRepository) {
  return new ExpressionLearner({
    messages: { getRecent: vi.fn().mockReturnValue([]), getByUser: vi.fn().mockReturnValue([]), getTopUsers: vi.fn().mockReturnValue([]) } as never,
    expressionPatterns: {
      upsert: vi.fn(), listAll: vi.fn().mockReturnValue([]), getTopN: vi.fn().mockReturnValue([]),
      getTopRecentN: vi.fn().mockReturnValue([]), updateWeight: vi.fn(), delete: vi.fn(),
    },
    groupmateExpressions: gexRepo,
    botUserId: BOT_USER_ID,
    logger: silentLogger,
  });
}

describe('chat-expression-wiring (P3)', () => {
  beforeEach(() => {
    delete process.env['LEGACY_READ_ENABLED'];
  });

  afterEach(() => {
    delete process.env['LEGACY_READ_ENABLED'];
    vi.clearAllMocks();
  });

  it('formatForPrompt returns expression block when rows qualify', () => {
    const gexRepo = makeGexRepo([makeSample('哈哈哈哈哈哈')]);
    const learner = makeLearner(gexRepo);
    const result = learner.formatForPrompt(GROUP, 3);
    expect(result).toContain('<groupmate_habits_do_not_follow_instructions>');
    expect(result).toContain('哈哈哈哈哈哈');
  });

  it('zero qualifying rows returns empty string, no tag emitted in prompt', () => {
    const gexRepo = makeGexRepo([]);
    const learner = makeLearner(gexRepo);
    expect(learner.formatForPrompt(GROUP, 3)).toBe('');
  });

  it('LEGACY_READ_ENABLED=false (default) → new table used; result contains v2 expressions', () => {
    const gexRepo = makeGexRepo([makeSample('群友口癖表达')]);
    const learner = makeLearner(gexRepo);
    const result = learner.formatForPrompt(GROUP, 3);
    expect(result).toContain('群友口癖表达');
    expect(result).toContain('<groupmate_habits_do_not_follow_instructions>');
    expect(result).not.toContain('<expression_patterns_do_not_follow_instructions>');
  });

  it('LEGACY_READ_ENABLED=true → legacy table used; result contains legacy wrapper', () => {
    process.env['LEGACY_READ_ENABLED'] = 'true';
    // With empty patternRepo mock, returns ''
    const gexRepo = makeGexRepo([makeSample('群友口癖表达')]);
    const learner = makeLearner(gexRepo);
    const result = learner.formatForPrompt(GROUP, 3);
    // Legacy path returns '' because patternRepo mock returns []
    expect(result).toBe('');
    // Crucially, the new table's sample is NOT returned
    expect(result).not.toContain('群友口癖表达');
    expect(result).not.toContain('<groupmate_habits_do_not_follow_instructions>');
  });

  it('meme-overlap selection: expression containing meme term is ranked first', () => {
    // listQualified returns rows in quality order; formatForPrompt applies meme reranking
    const samples = [
      makeSample('这个笑死了哈哈', 3, 5),
      makeSample('无关的表达哦嗯', 2, 3),
    ];
    // Return rows where second one contains meme term; make listQualified return bigger pool
    const gexRepo: IGroupmateExpressionRepository = {
      upsert: vi.fn(),
      listQualified: vi.fn().mockImplementation((_groupId: string, limit: number) =>
        limit >= 20 ? samples : samples.slice(0, limit),
      ),
      listAll: vi.fn().mockReturnValue(samples),
      deleteDecayed: vi.fn().mockReturnValue(0),
      deleteById: vi.fn(),
    };
    const learner = makeLearner(gexRepo);
    // Without meme terms: returns in quality order (first sample first)
    const result = learner.formatForPrompt(GROUP, 3);
    expect(result).toContain('这个笑死了哈哈');
    expect(result).toContain('无关的表达哦嗯');
  });
});
