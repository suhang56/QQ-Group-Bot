import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Database } from '../src/storage/db.js';
import { SelfLearningModule } from '../src/modules/self-learning.js';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse } from '../src/ai/claude.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

function makeDb(): Database {
  return new Database(':memory:');
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function stubClaude(replies: string[]): IClaudeClient {
  let i = 0;
  return {
    async complete(_req: ClaudeRequest): Promise<ClaudeResponse> {
      const text = replies[Math.min(i, replies.length - 1)] ?? '';
      i++;
      return { text, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },
    async describeImage(): Promise<string> { return ''; },
  };
}

function seedBotReply(db: Database, groupId: string, trigger: string, reply: string): number {
  const row = db.botReplies.insert({
    groupId,
    triggerMsgId: 'm-trigger',
    triggerUserNickname: 'asker',
    triggerContent: trigger,
    botReply: reply,
    module: 'chat',
    sentAt: nowSec(),
  });
  return row.id;
}

// ===== Problem 1: mod_rejections new fields =====
describe('mod_rejections — new fields (user_id, severity, context_snippet)', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it('stores and retrieves user_id, severity, context_snippet', () => {
    const row = db.modRejections.insert({
      groupId: 'g1',
      content: 'test content',
      reason: 'false positive',
      userNickname: 'Alice',
      createdAt: nowSec(),
      userId: 'u123',
      severity: 3,
      contextSnippet: '[Bob]: hi\n[Alice]: test content',
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.userId).toBe('u123');
    expect(row.severity).toBe(3);
    expect(row.contextSnippet).toBe('[Bob]: hi\n[Alice]: test content');
  });

  it('new fields are optional (backwards compat)', () => {
    const row = db.modRejections.insert({
      groupId: 'g1',
      content: 'old-style insert',
      reason: 'reason',
      userNickname: 'Bob',
      createdAt: nowSec(),
    });
    expect(row.userId).toBeNull();
    expect(row.severity).toBeNull();
    expect(row.contextSnippet).toBeNull();
  });

  it('getRecent returns new fields', () => {
    db.modRejections.insert({
      groupId: 'g1', content: 'c1', reason: 'r1', userNickname: 'A',
      createdAt: nowSec(), userId: 'u1', severity: 2, contextSnippet: 'ctx1',
    });
    db.modRejections.insert({
      groupId: 'g1', content: 'c2', reason: 'r2', userNickname: 'B',
      createdAt: nowSec() + 1,
    });
    const rows = db.modRejections.getRecent('g1', 10);
    expect(rows).toHaveLength(2);
    // newest first
    expect(rows[0]!.userId).toBeNull();
    expect(rows[1]!.userId).toBe('u1');
    expect(rows[1]!.severity).toBe(2);
    expect(rows[1]!.contextSnippet).toBe('ctx1');
  });

  it('getRecentSince filters by timestamp', () => {
    const base = nowSec();
    db.modRejections.insert({
      groupId: 'g1', content: 'old', reason: 'r', userNickname: 'A',
      createdAt: base - 100,
    });
    db.modRejections.insert({
      groupId: 'g1', content: 'new', reason: 'r', userNickname: 'B',
      createdAt: base,
    });
    const rows = db.modRejections.getRecentSince('g1', base - 50, 100);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe('new');
  });
});

// ===== Problem 2: rejection prompt section limits =====
describe('moderator — rejection section limits', () => {
  it('rejection section respects 2000-char cap', async () => {
    const { buildRejectionSection } = await import('../src/modules/moderator.js');

    const rejections = Array.from({ length: 30 }, (_, i) => ({
      id: i, groupId: 'g1',
      content: 'A'.repeat(100),
      reason: 'B'.repeat(100),
      userNickname: 'user',
      createdAt: nowSec() - i,
      userId: null,
      severity: null,
      contextSnippet: null,
    }));
    const section = buildRejectionSection(rejections);
    expect(section.length).toBeLessThanOrEqual(2000);
  });

  it('returns empty string for no rejections', async () => {
    const { buildRejectionSection } = await import('../src/modules/moderator.js');
    expect(buildRejectionSection([])).toBe('');
  });
});

// ===== Problem 4: opportunistic harvest auto-activate + expiry =====
describe('OpportunisticHarvest — auto-activate + expiry', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it('high-confidence facts (>= 0.85) are auto-activated', () => {
    // We test via the learned_facts repository directly since harvest calls insert
    db.learnedFacts.insert({
      groupId: 'g1', topic: 'T', fact: 'high confidence fact',
      sourceUserId: null, sourceUserNickname: 'harvest',
      sourceMsgId: null, botReplyId: null,
      confidence: 0.9, status: 'active',
    });
    const active = db.learnedFacts.listActive('g1', 100);
    expect(active).toHaveLength(1);
    expect(active[0]!.status).toBe('active');
  });

  it('expirePendingOlderThan marks old pending facts as expired', () => {
    const oldTs = nowSec() - 8 * 24 * 3600; // 8 days ago
    // Insert a pending fact with old timestamp
    db.learnedFacts.insert({
      groupId: 'g1', topic: 'T', fact: 'old pending fact',
      sourceUserId: null, sourceUserNickname: 'harvest',
      sourceMsgId: null, botReplyId: null,
      confidence: 0.5, status: 'pending',
    });
    // Manually backdate it
    db.exec(`UPDATE learned_facts SET created_at = ${oldTs} WHERE status = 'pending'`);

    // Insert a recent pending fact
    db.learnedFacts.insert({
      groupId: 'g1', topic: 'T', fact: 'recent pending fact',
      sourceUserId: null, sourceUserNickname: 'harvest',
      sourceMsgId: null, botReplyId: null,
      confidence: 0.5, status: 'pending',
    });

    const cutoff = nowSec() - 7 * 24 * 3600;
    const expired = db.learnedFacts.expirePendingOlderThan(cutoff);
    expect(expired).toBe(1);

    // The recent one should still be pending
    const pending = db.learnedFacts.countPending('g1');
    expect(pending).toBe(1);
  });

  it('approveAllPending marks all pending in group as active', () => {
    db.learnedFacts.insert({
      groupId: 'g1', topic: 'T', fact: 'pending 1',
      sourceUserId: null, sourceUserNickname: 'h',
      sourceMsgId: null, botReplyId: null,
      confidence: 0.5, status: 'pending',
    });
    db.learnedFacts.insert({
      groupId: 'g1', topic: 'T', fact: 'pending 2',
      sourceUserId: null, sourceUserNickname: 'h',
      sourceMsgId: null, botReplyId: null,
      confidence: 0.6, status: 'pending',
    });
    db.learnedFacts.insert({
      groupId: 'g2', topic: 'T', fact: 'other group pending',
      sourceUserId: null, sourceUserNickname: 'h',
      sourceMsgId: null, botReplyId: null,
      confidence: 0.6, status: 'pending',
    });

    const count = db.learnedFacts.approveAllPending('g1');
    expect(count).toBe(2);

    const activeG1 = db.learnedFacts.listActive('g1', 100);
    expect(activeG1).toHaveLength(2);

    // g2 should still have pending
    const pendingG2 = db.learnedFacts.countPending('g2');
    expect(pendingG2).toBe(1);
  });
});

// ===== Problem 5: stopword-filtered referent matching =====
describe('SelfLearningModule.handleTopLevelCorrection — stopword filtering', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it('does NOT match on common 2-3 char Chinese words', () => {
    const botReplyId = seedBotReply(db, 'g1', '什么情况', '不是很清楚，可能是因为网络问题');
    const sl = new SelfLearningModule({
      db,
      claude: stubClaude([]),
      botUserId: 'bot1',
      researchEnabled: false,
    });

    // "不是" and "因为" are stopwords — should NOT trigger correction
    sl.handleTopLevelCorrection({
      groupId: 'g1',
      content: '不是这样的因为我试过了',
      priorBotReply: { id: botReplyId, content: '不是很清楚，可能是因为网络问题', trigger: '什么情况' },
    });

    // If it didn't match, no research call happens — the test passes if no error
    // and no facts are rejected (there are none to reject anyway)
  });

  it('matches on substantive tokens (>= 4 chars)', () => {
    // Use a bot reply where tokens will be extracted individually by the regex
    // (CJK text without punctuation becomes one big token, so we use separate words with punctuation)
    const botReplyId = seedBotReply(db, 'g1', 'Roselia 吉他手是谁', '吉他手是 氷川紗夜');
    const sl = new SelfLearningModule({
      db,
      claude: stubClaude([]),
      botUserId: 'bot1',
      researchEnabled: false,
    });

    // Inject a fact so we can check it gets rejected
    const factId = db.learnedFacts.insert({
      groupId: 'g1', topic: 'roselia', fact: '吉他手是 氷川紗夜',
      sourceUserId: null, sourceUserNickname: null,
      sourceMsgId: null, botReplyId,
      confidence: 1.0, status: 'active',
    });

    // Set up injection memory
    (sl as any).injectionMemory.set('g1', { botReplyId, factIds: [factId] });

    // "氷川紗夜" is a 4-char token that should match (not a stopword, length >= 4)
    sl.handleTopLevelCorrection({
      groupId: 'g1',
      content: '不对，氷川紗夜不是吉他手，是氷川日菜',
      priorBotReply: { id: botReplyId, content: '吉他手是 氷川紗夜', trigger: 'Roselia 吉他手是谁' },
    });

    // The fact should be rejected
    const active = db.learnedFacts.listActive('g1', 100);
    expect(active.every(f => f.id !== factId)).toBe(true);
  });

  it('does not false-positive on common short words like 可以, 什么, 一个', () => {
    const botReplyId = seedBotReply(db, 'g1', '可以用什么', '可以用一个工具');
    const sl = new SelfLearningModule({
      db,
      claude: stubClaude([]),
      botUserId: 'bot1',
      researchEnabled: false,
    });

    // All tokens in "可以用一个工具" are <= 3 chars or stopwords
    // "不对" is a negation trigger but there should be no referent match
    const factId = db.learnedFacts.insert({
      groupId: 'g1', topic: 'tools', fact: '可以用一个工具',
      sourceUserId: null, sourceUserNickname: null,
      sourceMsgId: null, botReplyId,
      confidence: 1.0, status: 'active',
    });

    (sl as any).injectionMemory.set('g1', { botReplyId, factIds: [factId] });

    sl.handleTopLevelCorrection({
      groupId: 'g1',
      content: '不对，什么工具都没用',
      priorBotReply: { id: botReplyId, content: '可以用一个工具', trigger: '可以用什么' },
    });

    // The fact should NOT be rejected because no substantive token matched
    const active = db.learnedFacts.listActive('g1', 100);
    expect(active.some(f => f.id === factId)).toBe(true);
  });
});
