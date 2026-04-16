import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse } from '../src/ai/claude.js';
import type { IMessageRepository, ILearnedFactsRepository, Message, LearnedFact } from '../src/storage/db.js';
import { JargonMiner, COMMON_WORDS } from '../src/modules/jargon-miner.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

// ---- Helpers ----

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS jargon_candidates (
      group_id              TEXT    NOT NULL,
      content               TEXT    NOT NULL,
      count                 INTEGER NOT NULL DEFAULT 1,
      contexts              TEXT    NOT NULL DEFAULT '[]',
      last_inference_count  INTEGER NOT NULL DEFAULT 0,
      meaning               TEXT,
      is_jargon             INTEGER NOT NULL DEFAULT 0,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      PRIMARY KEY (group_id, content)
    );
    CREATE INDEX IF NOT EXISTS idx_jargon_group_count ON jargon_candidates(group_id, count DESC);
  `);
  return db;
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    groupId: 'g1',
    userId: 'u1',
    nickname: 'TestUser',
    content: 'hello world',
    rawContent: 'hello world',
    timestamp: Math.floor(Date.now() / 1000),
    deleted: false,
    ...overrides,
  };
}

function makeMessages(contents: string[], groupId = 'g1'): Message[] {
  return contents.map((content, i) => makeMessage({
    id: i + 1,
    groupId,
    content,
    rawContent: content,
    userId: `u${i}`,
    nickname: `User${i}`,
  }));
}

function makeMessageRepo(messages: Message[] = []): IMessageRepository {
  return {
    insert: vi.fn().mockReturnValue(messages[0] ?? makeMessage()),
    getRecent: vi.fn().mockReturnValue(messages),
    getByUser: vi.fn().mockReturnValue([]),
    sampleRandomHistorical: vi.fn().mockReturnValue([]),
    searchByKeywords: vi.fn().mockReturnValue([]),
    getTopUsers: vi.fn().mockReturnValue([]),
    softDelete: vi.fn(),
    findBySourceId: vi.fn().mockReturnValue(null),
    findNearTimestamp: vi.fn().mockReturnValue(null),
    getAroundTimestamp: vi.fn().mockReturnValue([]),
  };
}

function makeLearnedFactsRepo(facts: LearnedFact[] = []): ILearnedFactsRepository {
  const stored = [...facts];
  return {
    insert: vi.fn().mockImplementation(() => {
      const id = stored.length + 1;
      return id;
    }),
    listActive: vi.fn().mockReturnValue(stored),
    listActiveWithEmbeddings: vi.fn().mockReturnValue([]),
    listNullEmbeddingActive: vi.fn().mockReturnValue([]),
    listAllNullEmbeddingActive: vi.fn().mockReturnValue([]),
    updateEmbedding: vi.fn(),
    markStatus: vi.fn(),
    clearGroup: vi.fn().mockReturnValue(0),
    countActive: vi.fn().mockReturnValue(stored.length),
    setEmbeddingService: vi.fn(),
    findSimilarActive: vi.fn().mockResolvedValue(null),
    listPending: vi.fn().mockReturnValue([]),
    countPending: vi.fn().mockReturnValue(0),
    expirePendingOlderThan: vi.fn().mockReturnValue(0),
    approveAllPending: vi.fn().mockReturnValue(0),
  };
}

function makeClaude(responses: string[] = []): IClaudeClient {
  let callIdx = 0;
  return {
    complete: vi.fn().mockImplementation((): Promise<ClaudeResponse> => {
      const text = responses[callIdx] ?? '{"meaning": "unknown"}';
      callIdx++;
      return Promise.resolve({
        text,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    }),
    describeImage: vi.fn().mockResolvedValue(''),
    visionWithPrompt: vi.fn().mockResolvedValue(''),
  };
}

function makeMiner(overrides: Partial<{
  db: DatabaseSync;
  messages: IMessageRepository;
  learnedFacts: ILearnedFactsRepository;
  claude: IClaudeClient;
  activeGroups: string[];
  now: () => number;
  windowMessages: number;
}> = {}): { miner: JargonMiner; db: DatabaseSync; messages: IMessageRepository; learnedFacts: ILearnedFactsRepository; claude: IClaudeClient } {
  const db = overrides.db ?? makeDb();
  const messages = overrides.messages ?? makeMessageRepo();
  const learnedFacts = overrides.learnedFacts ?? makeLearnedFactsRepo();
  const claude = overrides.claude ?? makeClaude();
  const miner = new JargonMiner({
    db,
    messages,
    learnedFacts,
    claude,
    activeGroups: overrides.activeGroups ?? ['g1'],
    now: overrides.now ?? (() => 1700000000000),
    windowMessages: overrides.windowMessages,
  });
  return { miner, db, messages, learnedFacts, claude };
}

function getCandidates(db: DatabaseSync, groupId = 'g1'): Array<{
  group_id: string; content: string; count: number; contexts: string;
  last_inference_count: number; meaning: string | null; is_jargon: number;
}> {
  return db.prepare(
    'SELECT * FROM jargon_candidates WHERE group_id = ? ORDER BY count DESC'
  ).all(groupId) as any[];
}

// ---- Tests ----

describe('JargonMiner', () => {
  describe('extractCandidates', () => {
    it('extracts tokens from messages and inserts candidates', () => {
      const msgs = makeMessages(['刻晴 好玩 操作厉害', '刻晴 真不错']);
      const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });

      miner.extractCandidates('g1');

      const candidates = getCandidates(db);
      const contents = candidates.map(c => c.content);
      expect(contents).toContain('刻晴');
    });

    it('increments count on duplicate tokens', () => {
      const msgs = makeMessages([
        '梦之星 好好听', '梦之星 真不错', '又在听 梦之星',
      ]);
      const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });

      miner.extractCandidates('g1');

      const candidates = getCandidates(db);
      const target = candidates.find(c => c.content === '梦之星');
      expect(target).toBeDefined();
      expect(target!.count).toBe(3);
    });

    it('filters out COMMON_WORDS', () => {
      const msgs = makeMessages(['哈哈 谢谢 你好 刻晴 操作厉害']);
      const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });

      miner.extractCandidates('g1');

      const candidates = getCandidates(db);
      const contents = candidates.map(c => c.content);
      expect(contents).not.toContain('哈哈');
      expect(contents).not.toContain('谢谢');
      expect(contents).not.toContain('你好');
      expect(contents).toContain('刻晴');
    });

    it('filters out CQ codes', () => {
      const msgs = makeMessages(['[CQ:at,qq=123456] 刻晴 厉害']);
      const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });

      miner.extractCandidates('g1');

      const candidates = getCandidates(db);
      const contents = candidates.map(c => c.content);
      // Should not contain any CQ fragments
      expect(contents.some(c => c.includes('CQ:'))).toBe(false);
      expect(contents.some(c => c.includes('123456'))).toBe(false);
    });

    it('filters out pure numbers', () => {
      const msgs = makeMessages(['12345 6789.01 刻晴 打架']);
      const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });

      miner.extractCandidates('g1');

      const candidates = getCandidates(db);
      const contents = candidates.map(c => c.content);
      expect(contents).not.toContain('12345');
      expect(contents).not.toContain('6789.01');
    });

    it('filters out command tokens starting with /', () => {
      const msgs = makeMessages(['/help /ban 刻晴 来了']);
      const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });

      miner.extractCandidates('g1');

      const candidates = getCandidates(db);
      const contents = candidates.map(c => c.content);
      expect(contents).not.toContain('/help');
      expect(contents).not.toContain('/ban');
    });

    it('filters out tokens shorter than 2 chars or longer than 8', () => {
      const msgs = makeMessages(['我 a 超长的一个词汇名称测试 刻晴 好玩']);
      const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });

      miner.extractCandidates('g1');

      const candidates = getCandidates(db);
      const contents = candidates.map(c => c.content);
      // '我' is 1 char, 'a' is 1 char → filtered
      expect(contents).not.toContain('我');
      expect(contents).not.toContain('a');
      // Very long token → filtered
      expect(contents.some(c => c.length > 8)).toBe(false);
    });

    it('handles empty messages gracefully', () => {
      const msgs = makeMessages(['', '  ', '\n']);
      const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });

      miner.extractCandidates('g1');

      const candidates = getCandidates(db);
      expect(candidates.length).toBe(0);
    });

    it('handles messages with only CQ codes', () => {
      const msgs = makeMessages(['[CQ:image,file=abc.jpg][CQ:at,qq=999]']);
      const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });

      miner.extractCandidates('g1');

      const candidates = getCandidates(db);
      expect(candidates.length).toBe(0);
    });

    it('caps context array at 10 entries', () => {
      // Create 15 messages with the same token (space-separated)
      const msgs = makeMessages(
        Array.from({ length: 15 }, (_, i) => `刻晴 context${i}`)
      );
      const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });

      miner.extractCandidates('g1');

      const candidates = getCandidates(db);
      const target = candidates.find(c => c.content === '刻晴');
      expect(target).toBeDefined();
      const contexts = JSON.parse(target!.contexts);
      expect(contexts.length).toBeLessThanOrEqual(10);
    });

    it('truncates long context sentences to 100 chars', () => {
      const longMsg = '刻晴 ' + 'x'.repeat(200);
      const msgs = makeMessages([longMsg]);
      const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });

      miner.extractCandidates('g1');

      const candidates = getCandidates(db);
      const target = candidates.find(c => c.content === '刻晴');
      expect(target).toBeDefined();
      const contexts: string[] = JSON.parse(target!.contexts);
      expect(contexts[0].length).toBeLessThanOrEqual(103); // 100 + '...'
    });

    it('does not extract from no messages', () => {
      const { miner, db } = makeMiner({ messages: makeMessageRepo([]) });

      miner.extractCandidates('g1');

      const candidates = getCandidates(db);
      expect(candidates.length).toBe(0);
    });
  });

  describe('inferJargon', () => {
    it('does nothing when no candidates at threshold', async () => {
      const { miner, claude } = makeMiner();

      await miner.inferJargon('g1');

      expect(claude.complete).not.toHaveBeenCalled();
    });

    it('triggers inference at count=3 threshold', async () => {
      const db = makeDb();
      const nowSec = 1700000;
      // Insert a candidate at count=3
      db.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, created_at, updated_at)
        VALUES ('g1', '梦之星', 3, '["ctx1","ctx2","ctx3"]', 0, NULL, 0, ?, ?)
      `).run(nowSec, nowSec);

      const claude = makeClaude([
        '{"meaning": "群里的一首歌"}',
        '{"meaning": "一种天文现象"}',
      ]);
      const { miner } = makeMiner({ db, claude });

      await miner.inferJargon('g1');

      expect(claude.complete).toHaveBeenCalledTimes(2);
      const candidates = getCandidates(db);
      const target = candidates.find(c => c.content === '梦之星');
      expect(target!.meaning).toBe('群里的一首歌');
      expect(target!.last_inference_count).toBe(3);
    });

    it('skips candidates already inferred at current count', async () => {
      const db = makeDb();
      const nowSec = 1700000;
      db.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, created_at, updated_at)
        VALUES ('g1', '梦之星', 3, '["ctx"]', 3, '已知含义', 0, ?, ?)
      `).run(nowSec, nowSec);

      const claude = makeClaude();
      const { miner } = makeMiner({ db, claude });

      await miner.inferJargon('g1');

      expect(claude.complete).not.toHaveBeenCalled();
    });

    it('marks is_jargon=1 when meanings differ', async () => {
      const db = makeDb();
      const nowSec = 1700000;
      db.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, created_at, updated_at)
        VALUES ('g1', 'ykn', 6, '["说ykn好厉害","ykn唱歌"]', 0, NULL, 0, ?, ?)
      `).run(nowSec, nowSec);

      const claude = makeClaude([
        '{"meaning": "凑友希那，BanG Dream角色"}',  // with context
        '{"meaning": "不知道这是什么缩写"}',         // without context
      ]);
      const { miner } = makeMiner({ db, claude });

      await miner.inferJargon('g1');

      const candidates = getCandidates(db);
      const target = candidates.find(c => c.content === 'ykn');
      expect(target!.is_jargon).toBe(1);
    });

    it('marks is_jargon=0 when meanings are similar', async () => {
      const db = makeDb();
      const nowSec = 1700000;
      db.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, created_at, updated_at)
        VALUES ('g1', '手机', 3, '["手机没电了"]', 0, NULL, 0, ?, ?)
      `).run(nowSec, nowSec);

      const claude = makeClaude([
        '{"meaning": "手机，移动通讯设备"}',
        '{"meaning": "手机是一种移动通讯设备"}',
      ]);
      const { miner } = makeMiner({ db, claude });

      await miner.inferJargon('g1');

      const candidates = getCandidates(db);
      const target = candidates.find(c => c.content === '手机');
      expect(target!.is_jargon).toBe(0);
    });

    it('limits inference to MAX_INFER_PER_CYCLE (5)', async () => {
      const db = makeDb();
      const nowSec = 1700000;
      // Insert 10 candidates at threshold count=3
      for (let i = 0; i < 10; i++) {
        db.prepare(`
          INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, created_at, updated_at)
          VALUES ('g1', ?, 3, '["ctx"]', 0, NULL, 0, ?, ?)
        `).run(`word${i}`, nowSec, nowSec);
      }

      const claude = makeClaude(Array(20).fill('{"meaning": "test"}'));
      const { miner } = makeMiner({ db, claude });

      await miner.inferJargon('g1');

      // 5 candidates * 2 calls each = 10
      expect(claude.complete).toHaveBeenCalledTimes(10);
    });

    it('handles LLM returning unparseable JSON gracefully', async () => {
      const db = makeDb();
      const nowSec = 1700000;
      db.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, created_at, updated_at)
        VALUES ('g1', '梦之星', 3, '["ctx"]', 0, NULL, 0, ?, ?)
      `).run(nowSec, nowSec);

      const claude = makeClaude(['not json at all', '{"meaning": "test"}']);
      const { miner } = makeMiner({ db, claude });

      await miner.inferJargon('g1');

      // Should not crash, should update last_inference_count
      const candidates = getCandidates(db);
      const target = candidates.find(c => c.content === '梦之星');
      expect(target!.last_inference_count).toBe(3);
    });

    it('handles LLM failure gracefully', async () => {
      const db = makeDb();
      const nowSec = 1700000;
      db.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, created_at, updated_at)
        VALUES ('g1', '梦之星', 3, '["ctx"]', 0, NULL, 0, ?, ?)
      `).run(nowSec, nowSec);

      const claude: IClaudeClient = {
        complete: vi.fn().mockRejectedValue(new Error('LLM down')),
        describeImage: vi.fn().mockResolvedValue(''),
        visionWithPrompt: vi.fn().mockResolvedValue(''),
      };
      const { miner } = makeMiner({ db, claude });

      // Should not throw
      await miner.inferJargon('g1');
    });
  });

  describe('promoteToFacts', () => {
    it('promotes is_jargon=1 candidates to learned_facts', () => {
      const db = makeDb();
      const nowSec = 1700000;
      db.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, created_at, updated_at)
        VALUES ('g1', 'ykn', 10, '[]', 10, '凑友希那', 1, ?, ?)
      `).run(nowSec, nowSec);

      const learnedFacts = makeLearnedFactsRepo();
      const { miner } = makeMiner({ db, learnedFacts });

      miner.promoteToFacts('g1');

      expect(learnedFacts.insert).toHaveBeenCalledWith({
        groupId: 'g1',
        topic: '群内黑话',
        fact: 'ykn的意思是凑友希那',
        sourceUserId: null,
        sourceUserNickname: '[jargon-miner]',
        sourceMsgId: null,
        botReplyId: null,
        confidence: 0.85,
        status: 'active',
      });

      // Should mark as promoted (is_jargon=2)
      const candidates = getCandidates(db);
      const target = candidates.find(c => c.content === 'ykn');
      expect(target!.is_jargon).toBe(2);
    });

    it('does not promote already-promoted candidates (is_jargon=2)', () => {
      const db = makeDb();
      const nowSec = 1700000;
      db.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, created_at, updated_at)
        VALUES ('g1', 'ykn', 10, '[]', 10, '凑友希那', 2, ?, ?)
      `).run(nowSec, nowSec);

      const learnedFacts = makeLearnedFactsRepo();
      const { miner } = makeMiner({ db, learnedFacts });

      miner.promoteToFacts('g1');

      expect(learnedFacts.insert).not.toHaveBeenCalled();
    });

    it('does not promote is_jargon=0 candidates', () => {
      const db = makeDb();
      const nowSec = 1700000;
      db.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, created_at, updated_at)
        VALUES ('g1', '手机', 10, '[]', 10, '移动设备', 0, ?, ?)
      `).run(nowSec, nowSec);

      const learnedFacts = makeLearnedFactsRepo();
      const { miner } = makeMiner({ db, learnedFacts });

      miner.promoteToFacts('g1');

      expect(learnedFacts.insert).not.toHaveBeenCalled();
    });

    it('skips duplicate facts already in learned_facts', () => {
      const db = makeDb();
      const nowSec = 1700000;
      db.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, created_at, updated_at)
        VALUES ('g1', 'ykn', 10, '[]', 10, '凑友希那', 1, ?, ?)
      `).run(nowSec, nowSec);

      const existingFact: LearnedFact = {
        id: 1, groupId: 'g1', topic: '群内黑话', fact: 'ykn的意思是凑友希那',
        sourceUserId: null, sourceUserNickname: null, sourceMsgId: null,
        botReplyId: null, confidence: 0.85, status: 'active',
        createdAt: nowSec, updatedAt: nowSec, embedding: null,
      };
      const learnedFacts = makeLearnedFactsRepo([existingFact]);
      const { miner } = makeMiner({ db, learnedFacts });

      miner.promoteToFacts('g1');

      expect(learnedFacts.insert).not.toHaveBeenCalled();
      // Should still mark as promoted
      const candidates = getCandidates(db);
      expect(candidates.find(c => c.content === 'ykn')!.is_jargon).toBe(2);
    });

    it('handles empty jargon_candidates table', () => {
      const learnedFacts = makeLearnedFactsRepo();
      const { miner } = makeMiner({ learnedFacts });

      miner.promoteToFacts('g1');

      expect(learnedFacts.insert).not.toHaveBeenCalled();
    });
  });

  describe('run (integration)', () => {
    it('orchestrates extract → infer → promote', async () => {
      const msgs = makeMessages(Array.from({ length: 4 }, () => 'ykn 好厉害'));
      const db = makeDb();
      const messageRepo = makeMessageRepo(msgs);
      const learnedFacts = makeLearnedFactsRepo();
      const claude = makeClaude([
        '{"meaning": "凑友希那"}',
        '{"meaning": "不知道"}',
      ]);

      const miner = new JargonMiner({
        db,
        messages: messageRepo,
        learnedFacts,
        claude,
        activeGroups: ['g1'],
        now: () => 1700000000000,
      });

      // Extract first to populate candidates
      miner.extractCandidates('g1');

      // Manually bump count to threshold for the token we want to test
      const candidates = getCandidates(db);
      const ykn = candidates.find(c => c.content === 'ykn');
      if (ykn) {
        // It should already have count=4 from 4 messages
        // But we need count in INFERENCE_THRESHOLDS. Let's check.
        // If count is 4, it won't hit threshold [3,6,10,20,40] — count must equal a threshold.
        // Actually count=4 doesn't match any threshold. Let's adjust.
      }

      // For a proper integration test, seed the DB directly at a threshold
      db.prepare(`
        INSERT OR REPLACE INTO jargon_candidates
          (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, created_at, updated_at)
        VALUES ('g1', 'ygfn', 6, '["ygfn唱歌好听","ygfn新歌"]', 0, NULL, 0, 1700000, 1700000)
      `).run();

      await miner.run('g1');

      // inferJargon should have been called and made LLM calls
      expect(claude.complete).toHaveBeenCalled();
    });
  });

  describe('_meaningsDiffer', () => {
    let miner: JargonMiner;

    beforeEach(() => {
      ({ miner } = makeMiner());
    });

    it('returns true when without-context meaning is null', () => {
      expect(miner._meaningsDiffer('群里的黑话', null)).toBe(true);
    });

    it('returns false when meanings are substrings', () => {
      expect(miner._meaningsDiffer('手机', '手机是一种移动设备')).toBe(false);
      expect(miner._meaningsDiffer('一种移动通讯设备叫手机', '手机')).toBe(false);
    });

    it('returns true when meanings are completely different', () => {
      expect(miner._meaningsDiffer('凑友希那', '不知道这个缩写')).toBe(true);
    });

    it('returns false when meanings share high character overlap', () => {
      expect(miner._meaningsDiffer('移动通讯设备', '通讯移动设备')).toBe(false);
    });

    it('handles empty strings', () => {
      expect(miner._meaningsDiffer('', '')).toBe(false);
      // 'something' includes '' as a substring
      expect(miner._meaningsDiffer('something', '')).toBe(false);
    });
  });

  describe('COMMON_WORDS', () => {
    it('contains at least 100 entries', () => {
      expect(COMMON_WORDS.size).toBeGreaterThanOrEqual(100);
    });

    it('includes expected common words', () => {
      expect(COMMON_WORDS.has('吃饭')).toBe(true);
      expect(COMMON_WORDS.has('谢谢')).toBe(true);
      expect(COMMON_WORDS.has('哈哈')).toBe(true);
      expect(COMMON_WORDS.has('可以')).toBe(true);
      expect(COMMON_WORDS.has('什么')).toBe(true);
      expect(COMMON_WORDS.has('怎么')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles messages with mixed CQ codes and text', () => {
      const msgs = makeMessages([
        '[CQ:at,qq=123] 梦之星 [CQ:face,id=5] 好听啊',
      ]);
      const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });

      miner.extractCandidates('g1');

      const candidates = getCandidates(db);
      const contents = candidates.map(c => c.content);
      expect(contents).toContain('梦之星');
      expect(contents).not.toContain('CQ');
      expect(contents).not.toContain('qq');
    });

    it('handles rapid repeated extraction (idempotent upsert)', () => {
      const msgs = makeMessages(['刻晴 厉害']);
      const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });

      miner.extractCandidates('g1');
      miner.extractCandidates('g1');

      const candidates = getCandidates(db);
      const target = candidates.find(c => c.content === '刻晴');
      expect(target).toBeDefined();
      // Called twice with same messages → count should be 2
      expect(target!.count).toBe(2);
    });

    it('isolates candidates by group_id', () => {
      const db = makeDb();
      const msgs1 = makeMessages(['刻晴 好玩'], 'g1');
      const msgs2 = makeMessages(['刻晴 厉害'], 'g2');

      const messageRepo1 = makeMessageRepo(msgs1);
      const messageRepo2 = makeMessageRepo(msgs2);

      const miner1 = new JargonMiner({
        db, messages: messageRepo1, learnedFacts: makeLearnedFactsRepo(),
        claude: makeClaude(), activeGroups: ['g1'],
        now: () => 1700000000000,
      });
      const miner2 = new JargonMiner({
        db, messages: messageRepo2, learnedFacts: makeLearnedFactsRepo(),
        claude: makeClaude(), activeGroups: ['g2'],
        now: () => 1700000000000,
      });

      miner1.extractCandidates('g1');
      miner2.extractCandidates('g2');

      const g1Candidates = getCandidates(db, 'g1');
      const g2Candidates = getCandidates(db, 'g2');

      expect(g1Candidates.find(c => c.content === '刻晴')!.count).toBe(1);
      expect(g2Candidates.find(c => c.content === '刻晴')!.count).toBe(1);
    });

    it('handles corrupt contexts JSON in DB gracefully', async () => {
      const db = makeDb();
      const nowSec = 1700000;
      db.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, created_at, updated_at)
        VALUES ('g1', '梦之星', 3, 'NOT_JSON', 0, NULL, 0, ?, ?)
      `).run(nowSec, nowSec);

      const claude = makeClaude([
        '{"meaning": "一首歌"}',
        '{"meaning": "天文现象"}',
      ]);
      const { miner } = makeMiner({ db, claude });

      // Should not throw
      await miner.inferJargon('g1');
    });

    it('multiple thresholds: re-infers when count reaches next threshold', async () => {
      const db = makeDb();
      const nowSec = 1700000;
      // Candidate inferred at count=3, now at count=6
      db.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, created_at, updated_at)
        VALUES ('g1', '梦之星', 6, '["ctx"]', 3, '旧含义', 0, ?, ?)
      `).run(nowSec, nowSec);

      const claude = makeClaude([
        '{"meaning": "更新的含义"}',
        '{"meaning": "不同的意思"}',
      ]);
      const { miner } = makeMiner({ db, claude });

      await miner.inferJargon('g1');

      expect(claude.complete).toHaveBeenCalledTimes(2);
      const candidates = getCandidates(db);
      const target = candidates.find(c => c.content === '梦之星');
      expect(target!.last_inference_count).toBe(6);
      expect(target!.meaning).toBe('更新的含义');
    });
  });
});
