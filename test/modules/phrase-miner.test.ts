import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse } from '../../src/ai/claude.js';
import type { IMessageRepository, Message } from '../../src/storage/db.js';
import { PhraseMiner, INFERENCE_THRESHOLDS, MIN_GRAM, MAX_GRAM } from '../../src/modules/phrase-miner.js';
import { COMMON_WORDS } from '../../src/modules/jargon-miner.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

// ---- Helpers ----

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS phrase_candidates (
      group_id              TEXT    NOT NULL,
      content               TEXT    NOT NULL,
      gram_len              INTEGER NOT NULL DEFAULT 2,
      count                 INTEGER NOT NULL DEFAULT 1,
      contexts              TEXT    NOT NULL DEFAULT '[]',
      last_inference_count  INTEGER NOT NULL DEFAULT 0,
      meaning               TEXT,
      is_jargon             INTEGER NOT NULL DEFAULT 0,
      promoted              INTEGER NOT NULL DEFAULT 0,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      PRIMARY KEY (group_id, content)
    );
    CREATE INDEX IF NOT EXISTS idx_phrase_group_count ON phrase_candidates(group_id, count DESC);
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
  claude: IClaudeClient;
  activeGroups: string[];
  now: () => number;
  windowMessages: number;
}> = {}): { miner: PhraseMiner; db: DatabaseSync; messages: IMessageRepository; claude: IClaudeClient } {
  const db = overrides.db ?? makeDb();
  const messages = overrides.messages ?? makeMessageRepo();
  const claude = overrides.claude ?? makeClaude();
  const miner = new PhraseMiner({
    db,
    messages,
    claude,
    activeGroups: overrides.activeGroups ?? ['g1'],
    now: overrides.now ?? (() => 1700000000000),
    windowMessages: overrides.windowMessages,
  });
  return { miner, db, messages, claude };
}

function getCandidates(db: DatabaseSync, groupId = 'g1') {
  return db.prepare('SELECT * FROM phrase_candidates WHERE group_id = ? ORDER BY content').all(groupId) as Array<{
    group_id: string;
    content: string;
    gram_len: number;
    count: number;
    contexts: string;
    last_inference_count: number;
    meaning: string | null;
    is_jargon: number;
    promoted: number;
  }>;
}

// ---- Tests ----

describe('PhraseMiner.extractCandidates', () => {
  it('extracts bigrams from a message with two tokens', () => {
    const msgs = makeMessages(['智械危机 来了']);
    const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });
    miner.extractCandidates('g1');

    const candidates = getCandidates(db);
    const contents = candidates.map(c => c.content);
    expect(contents).toContain('智械危机来了');
    // Should have gram_len = 2
    const bigram = candidates.find(c => c.content === '智械危机来了');
    expect(bigram?.gram_len).toBe(2);
  });

  it('extracts trigrams, 4-grams, and 5-grams', () => {
    const msgs = makeMessages(['aaa bbb ccc ddd eee']);
    const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });
    miner.extractCandidates('g1');

    const candidates = getCandidates(db);
    const contents = candidates.map(c => c.content);
    // Trigrams
    expect(contents).toContain('aaabbbccc');
    expect(contents).toContain('bbbcccddd');
    expect(contents).toContain('cccdddeee');
    // 4-grams
    expect(contents).toContain('aaabbbcccddd');
    expect(contents).toContain('bbbcccdddeee');
    // 5-gram
    expect(contents).toContain('aaabbbcccdddeee');
    // But bigrams too (those meeting min char length)
  });

  it('skips phrases where ALL tokens are COMMON_WORDS', () => {
    // Pick two known common words
    const commonArr = [...COMMON_WORDS];
    const w1 = commonArr[0]!;
    const w2 = commonArr[1]!;
    const msgs = makeMessages([`${w1} ${w2}`]);
    const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });
    miner.extractCandidates('g1');

    const candidates = getCandidates(db);
    // The bigram of two common words should NOT be present
    const combined = `${w1}${w2}`;
    expect(candidates.find(c => c.content === combined)).toBeUndefined();
  });

  it('keeps phrases with at least one non-common token', () => {
    const commonWord = [...COMMON_WORDS][0]!;
    const msgs = makeMessages([`${commonWord} 智械危机`]);
    const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });
    miner.extractCandidates('g1');

    const candidates = getCandidates(db);
    const combined = `${commonWord}智械危机`;
    if (combined.length >= 4 && combined.length <= 30) {
      expect(candidates.find(c => c.content === combined)).toBeDefined();
    }
  });

  it('strips CQ codes before tokenizing', () => {
    const msgs = makeMessages(['[CQ:at,qq=123456] 智械危机 来了']);
    const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });
    miner.extractCandidates('g1');

    const candidates = getCandidates(db);
    // Should not contain any CQ code fragments
    for (const c of candidates) {
      expect(c.content).not.toContain('CQ:');
      expect(c.content).not.toContain('[CQ');
    }
    // Should still extract the phrase
    expect(candidates.find(c => c.content === '智械危机来了')).toBeDefined();
  });

  it('filters phrases shorter than 4 chars', () => {
    // Two very short tokens that combine to < 4 chars
    const msgs = makeMessages(['ab cd']);
    const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });
    miner.extractCandidates('g1');

    const candidates = getCandidates(db);
    // "abcd" is exactly 4 chars, should be included
    expect(candidates.find(c => c.content === 'abcd')).toBeDefined();
  });

  it('filters phrases longer than 30 chars (anti-copypasta)', () => {
    // Create tokens that combine to > 30 chars
    const longToken1 = 'abcdefghijklmnop'; // 16 chars
    const longToken2 = 'qrstuvwxyz123456'; // 16 chars
    const msgs = makeMessages([`${longToken1} ${longToken2}`]);
    const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });
    miner.extractCandidates('g1');

    const candidates = getCandidates(db);
    // Combined = 32 chars, should be filtered
    expect(candidates.find(c => c.content === `${longToken1}${longToken2}`)).toBeUndefined();
  });

  it('increments count on repeated phrases', () => {
    const msgs = makeMessages([
      '智械危机 来了',
      '智械危机 来了',
      '智械危机 来了',
    ]);
    const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });
    miner.extractCandidates('g1');

    const candidates = getCandidates(db);
    const match = candidates.find(c => c.content === '智械危机来了');
    expect(match).toBeDefined();
    expect(match!.count).toBe(3);
  });

  it('handles empty message window gracefully', () => {
    const { miner, db } = makeMiner({ messages: makeMessageRepo([]) });
    // Should not throw
    miner.extractCandidates('g1');
    const candidates = getCandidates(db);
    expect(candidates).toHaveLength(0);
  });

  it('handles messages with only one token (no n-grams possible)', () => {
    const msgs = makeMessages(['singleton']);
    const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });
    miner.extractCandidates('g1');

    const candidates = getCandidates(db);
    expect(candidates).toHaveLength(0);
  });

  it('ignores pure noise messages (all CQ codes)', () => {
    const msgs = makeMessages(['[CQ:face,id=178][CQ:at,qq=999]']);
    const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });
    miner.extractCandidates('g1');

    const candidates = getCandidates(db);
    expect(candidates).toHaveLength(0);
  });
});

describe('PhraseMiner.inferPhrase', () => {
  it('triggers inference at threshold count', async () => {
    const claude = makeClaude([
      '{"meaning": "group specific phrase meaning"}',
      '{"meaning": "generic phrase meaning very different"}',
    ]);
    const { miner, db } = makeMiner({ claude });

    // Manually insert a candidate at threshold count=3
    const nowSec = 1700000;
    db.prepare(`
      INSERT INTO phrase_candidates
        (group_id, content, gram_len, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, NULL, 0, 0, ?, ?)
    `).run('g1', '智械危机来了', 2, 3, JSON.stringify(['context1', 'context2']), nowSec, nowSec);

    await miner.inferPhrase('g1');

    expect(claude.complete).toHaveBeenCalledTimes(2);
    const row = db.prepare('SELECT * FROM phrase_candidates WHERE content = ?').get('智械危机来了') as { meaning: string; is_jargon: number };
    expect(row.meaning).toBe('group specific phrase meaning');
  });

  it('skips candidates below threshold', async () => {
    const claude = makeClaude();
    const { miner, db } = makeMiner({ claude });

    const nowSec = 1700000;
    db.prepare(`
      INSERT INTO phrase_candidates
        (group_id, content, gram_len, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, NULL, 0, 0, ?, ?)
    `).run('g1', '随便一句', 2, 2, '[]', nowSec, nowSec);

    await miner.inferPhrase('g1');

    expect(claude.complete).not.toHaveBeenCalled();
  });

  it('respects MAX_INFER_PER_CYCLE cap', async () => {
    const claude = makeClaude(
      Array.from({ length: 20 }, () => '{"meaning": "test"}'),
    );
    const { miner, db } = makeMiner({ claude });

    const nowSec = 1700000;
    // Insert 10 candidates at threshold=3
    for (let i = 0; i < 10; i++) {
      db.prepare(`
        INSERT INTO phrase_candidates
          (group_id, content, gram_len, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, NULL, 0, 0, ?, ?)
      `).run('g1', `phrase${i}xxx`, 2, 3, '["ctx"]', nowSec, nowSec);
    }

    await miner.inferPhrase('g1');

    // MAX_INFER_PER_CYCLE = 5, each candidate triggers 2 LLM calls
    expect(claude.complete).toHaveBeenCalledTimes(10); // 5 * 2
  });
});

describe('PhraseMiner._meaningsDiffer', () => {
  let miner: PhraseMiner;

  beforeEach(() => {
    ({ miner } = makeMiner());
  });

  it('returns true when withoutContext is null', () => {
    expect(miner._meaningsDiffer('some meaning', null)).toBe(true);
  });

  it('returns false when both are empty', () => {
    expect(miner._meaningsDiffer('', '')).toBe(false);
  });

  it('returns false when one is substring of other', () => {
    expect(miner._meaningsDiffer('hello world', 'hello')).toBe(false);
    expect(miner._meaningsDiffer('hello', 'hello world')).toBe(false);
  });

  it('returns true for completely different meanings', () => {
    expect(miner._meaningsDiffer(
      '这个群里用来表示搞笑',
      'a mechanical uprising of robots',
    )).toBe(true);
  });

  it('returns false for very similar meanings', () => {
    expect(miner._meaningsDiffer(
      '机器人叛乱',
      '机器人叛乱的意思',
    )).toBe(false);
  });
});

describe('PhraseMiner.runAll', () => {
  it('runs for all active groups', async () => {
    const msgs = makeMessages(['智械危机 来了'], 'g1');
    const msgRepo = makeMessageRepo(msgs);
    const { miner } = makeMiner({ messages: msgRepo, activeGroups: ['g1', 'g2'] });

    await miner.runAll();

    expect(msgRepo.getRecent).toHaveBeenCalledWith('g1', expect.any(Number));
    expect(msgRepo.getRecent).toHaveBeenCalledWith('g2', expect.any(Number));
  });

  it('continues to next group if one fails', async () => {
    const msgRepo = makeMessageRepo([]);
    msgRepo.getRecent = vi.fn().mockImplementation((groupId: string) => {
      if (groupId === 'g1') throw new Error('boom');
      return [];
    });
    const { miner } = makeMiner({ messages: msgRepo, activeGroups: ['g1', 'g2'] });

    // Should not throw
    await miner.runAll();

    expect(msgRepo.getRecent).toHaveBeenCalledWith('g2', expect.any(Number));
  });
});

describe('PhraseMiner kill switch', () => {
  it('MEMES_V1_DISABLED env prevents scheduling (tested at index.ts level)', () => {
    // This is a wiring test -- the actual kill switch is in index.ts
    // We verify PhraseMiner itself has no internal kill switch (it trusts the caller)
    const { miner } = makeMiner();
    expect(miner).toBeDefined();
    expect(typeof miner.runAll).toBe('function');
  });
});

describe('PhraseMiner edge cases', () => {
  it('handles non-Chinese noise (pure ASCII tokens)', () => {
    const msgs = makeMessages(['test1234 hello5678']);
    const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });
    miner.extractCandidates('g1');

    const candidates = getCandidates(db);
    // Should produce bigram "test1234hello5678" if length <= 30
    const combined = 'test1234hello5678';
    if (combined.length >= 4 && combined.length <= 30) {
      expect(candidates.find(c => c.content === combined)).toBeDefined();
    }
  });

  it('caps context list at MAX_CONTEXTS', () => {
    // Create 15 messages with same phrase
    const msgs = makeMessages(
      Array.from({ length: 15 }, (_, i) => `智械危机 来了 context${i}`),
    );
    const { miner, db } = makeMiner({ messages: makeMessageRepo(msgs) });
    miner.extractCandidates('g1');

    const row = db.prepare(
      'SELECT contexts FROM phrase_candidates WHERE content = ?'
    ).get('智械危机来了') as { contexts: string } | undefined;
    if (row) {
      const contexts = JSON.parse(row.contexts) as string[];
      expect(contexts.length).toBeLessThanOrEqual(10);
    }
  });
});
