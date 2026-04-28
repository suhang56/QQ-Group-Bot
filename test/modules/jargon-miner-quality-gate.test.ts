import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { IClaudeClient, ClaudeResponse } from '../../src/ai/claude.js';
import type { IMessageRepository, ILearnedFactsRepository, Message } from '../../src/storage/db.js';
import { JargonMiner, HEDGE_RE } from '../../src/modules/jargon-miner.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

const USER_A = 'user-a';
const USER_B = 'user-b';
const USER_C = 'user-c';

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
      promoted              INTEGER NOT NULL DEFAULT 0,
      rejected              INTEGER NOT NULL DEFAULT 0,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      PRIMARY KEY (group_id, content)
    );
  `);
  return db;
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    groupId: 'g1',
    userId: USER_A,
    nickname: 'TestUser',
    content: '智械危机',
    rawContent: '智械危机',
    timestamp: Math.floor(Date.now() / 1000),
    deleted: false,
    ...overrides,
  };
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

function makeLearnedFactsStub(): ILearnedFactsRepository {
  return {
    insertOrSupersede: vi.fn().mockReturnValue({ newId: 1, supersededIds: [] }),
    listActive: vi.fn().mockReturnValue([]),
    findActiveByTopicTerm: vi.fn().mockReturnValue([]),
    findActiveByFactText: vi.fn().mockReturnValue(null),
    findById: vi.fn().mockReturnValue(null),
    updateStatus: vi.fn(),
    listPending: vi.fn().mockReturnValue([]),
    listStale: vi.fn().mockReturnValue([]),
    adminEdit: vi.fn(),
    pruneOld: vi.fn(),
  } as unknown as ILearnedFactsRepository;
}

function makeClaudeChain(payloads: object[]): IClaudeClient {
  const fn = vi.fn();
  for (const p of payloads) {
    fn.mockResolvedValueOnce({
      text: JSON.stringify(p),
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    } as ClaudeResponse);
  }
  // Default fallback in case more calls happen than seeded.
  fn.mockResolvedValue({
    text: '{}', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  } as ClaudeResponse);
  return {
    complete: fn,
    describeImage: vi.fn().mockResolvedValue(''),
    visionWithPrompt: vi.fn().mockResolvedValue(''),
  } as unknown as IClaudeClient;
}

function jcRowCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM jargon_candidates').get() as { n: number }).n;
}

interface SeedOpts {
  groupId: string;
  content: string;
  count?: number;
  contexts?: Array<{ user_id: string; content: string }>;
  is_jargon?: number;
  meaning?: string | null;
}

function seedCandidate(db: DatabaseSync, opts: SeedOpts): void {
  const count = opts.count ?? 2;
  const contexts = opts.contexts ?? [
    { user_id: USER_A, content: `${opts.content} 出现一次` },
    { user_id: USER_B, content: `${opts.content} 又来了` },
    { user_id: USER_C, content: `${opts.content} 还是这个` },
  ];
  const nowSec = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO jargon_candidates
      (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
  `).run(
    opts.groupId,
    opts.content,
    count,
    JSON.stringify(contexts),
    opts.meaning ?? null,
    opts.is_jargon ?? 0,
    nowSec,
    nowSec,
  );
}

// ---------------------------------------------------------------------------
// t8 / t9 — HEDGE_RE direct regex tests
// ---------------------------------------------------------------------------

describe('JargonMiner — hedge regex (HEDGE_RE)', () => {
  it('t8: HEDGE_RE matches all 7 hedge strings', () => {
    const cases = [
      '无法判断',
      '没有特殊含义',
      '需要更多上下文',
      '图片文件名的UUID',
      '可能是某个人的名字',
      '上下文不足无法判断',
      '没有进一步信息',
    ];
    for (const s of cases) {
      expect(HEDGE_RE.test(s), `should match: ${s}`).toBe(true);
    }
  });

  it('t9: HEDGE_RE does not match legit slang meanings', () => {
    const cases = [
      '别盒我',
      '难绷',
      '未能通过图灵测试',
      '通常表示惊叹',
      '一般指群内流行语',
    ];
    for (const s of cases) {
      expect(HEDGE_RE.test(s), `should not match: ${s}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// t4 / t5 / t6 / t7 — extractCandidatesFromMessages UUID/image strip + length
// ---------------------------------------------------------------------------

describe('JargonMiner — extractCandidatesFromMessages UUID/image strip', () => {
  it('t4: [图片:{UUID}.gif] does not yield UUID fragments as candidates', () => {
    const db = makeDb();
    const msgs = [
      makeMessage({ id: 1, content: '[图片:{D291632C-D05E-1AA4-151F-2ECCDAE794C0}.gif]' }),
    ];
    const miner = new JargonMiner({
      db,
      messages: makeMessageRepo(msgs),
      learnedFacts: makeLearnedFactsStub(),
      claude: makeClaudeChain([]),
      activeGroups: ['g1'],
      now: () => 1_700_000_000_000,
    });
    miner.extractCandidatesFromMessages('g1', msgs);
    const rows = db.prepare('SELECT content FROM jargon_candidates').all() as Array<{ content: string }>;
    const contents = rows.map(r => r.content);
    // None of the UUID fragments should leak through.
    for (const frag of ['1AA4', '151F', 'D05E', 'D291632C', '2ECCDAE794C0']) {
      expect(contents, `fragment ${frag} should not be a candidate`).not.toContain(frag);
    }
    // The whole bracketed payload was stripped, so we expect zero rows.
    expect(jcRowCount(db)).toBe(0);
    db.close();
  });

  it('t7: image bracket stripped, surrounding tokens still tokenized', () => {
    const db = makeDb();
    const msgs = [
      makeMessage({
        id: 1,
        content: '智械危机 [图片:{D291632C-D05E-1AA4-151F-2ECCDAE794C0}.gif] 摆烂',
      }),
    ];
    const miner = new JargonMiner({
      db,
      messages: makeMessageRepo(msgs),
      learnedFacts: makeLearnedFactsStub(),
      claude: makeClaudeChain([]),
      activeGroups: ['g1'],
      now: () => 1_700_000_000_000,
    });
    miner.extractCandidatesFromMessages('g1', msgs);
    const rows = db.prepare('SELECT content FROM jargon_candidates').all() as Array<{ content: string }>;
    const contents = rows.map(r => r.content);
    // Surrounding tokens preserved.
    expect(contents).toContain('智械危机');
    expect(contents).toContain('摆烂');
    // UUID fragments rejected.
    for (const frag of ['1AA4', '151F', 'D05E', 'D291632C']) {
      expect(contents).not.toContain(frag);
    }
    db.close();
  });

  it('t5: 1-char token rejected by length gate', () => {
    const db = makeDb();
    const msgs = [makeMessage({ id: 1, content: '好' })];
    const miner = new JargonMiner({
      db,
      messages: makeMessageRepo(msgs),
      learnedFacts: makeLearnedFactsStub(),
      claude: makeClaudeChain([]),
      activeGroups: ['g1'],
      now: () => 1_700_000_000_000,
    });
    miner.extractCandidatesFromMessages('g1', msgs);
    expect(jcRowCount(db)).toBe(0);
    db.close();
  });

  it('t6: 9-char token rejected by length gate', () => {
    const db = makeDb();
    const msgs = [makeMessage({ id: 1, content: '非常非常非常好的' })];
    // 8 chars is borderline accepted by MAX_TOKEN_LEN=8, so use 9-char string for rejection.
    const nineChar = '非常非常非常好的呢';
    msgs[0] = makeMessage({ id: 1, content: nineChar });
    const miner = new JargonMiner({
      db,
      messages: makeMessageRepo(msgs),
      learnedFacts: makeLearnedFactsStub(),
      claude: makeClaudeChain([]),
      activeGroups: ['g1'],
      now: () => 1_700_000_000_000,
    });
    miner.extractCandidatesFromMessages('g1', msgs);
    // The 9-char token is > MAX_TOKEN_LEN=8, so it must not appear.
    const rows = db.prepare('SELECT content FROM jargon_candidates').all() as Array<{ content: string }>;
    expect(rows.map(r => r.content)).not.toContain(nineChar);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// t1 / t2 / t10 — _inferSingle hedge / confidence gates (via inferJargon)
// ---------------------------------------------------------------------------

describe('JargonMiner — _inferSingle hedge / confidence gates', () => {
  it('t1: hedge meaning blocks update — is_jargon stays 0, meaning stays null', async () => {
    const db = makeDb();
    seedCandidate(db, { groupId: 'g1', content: '电死这个' });
    const claude = makeClaudeChain([
      // pre-filter
      { results: [true] },
      // with-context: HEDGE_RE matches
      { meaning: '无法判断这个词的含义', confidence: 0.8 },
      // without-context (should not be reached due to hedge gate, but guard with seeded payload)
      { meaning: '一种说法', confidence: 0.5 },
    ]);
    const facts = makeLearnedFactsStub();
    const miner = new JargonMiner({
      db,
      messages: makeMessageRepo([]),
      learnedFacts: facts,
      claude,
      activeGroups: ['g1'],
      now: () => 1_700_000_000_000,
    });
    await miner.inferJargon('g1');
    const row = db.prepare(
      'SELECT is_jargon, meaning, last_inference_count FROM jargon_candidates WHERE group_id = ? AND content = ?'
    ).get('g1', '电死这个') as { is_jargon: number; meaning: string | null; last_inference_count: number };
    expect(row.is_jargon).toBe(0);
    expect(row.meaning).toBeNull();
    expect(row.last_inference_count).toBe(2); // _updateInferenceCount fired
    expect(facts.insertOrSupersede).not.toHaveBeenCalled();
    db.close();
  });

  it('t2: confidence < 0.6 blocks update — is_jargon stays 0, meaning stays null', async () => {
    const db = makeDb();
    seedCandidate(db, { groupId: 'g1', content: '阿弥诺斯' });
    const claude = makeClaudeChain([
      { results: [true] },
      { meaning: '这是一个明确的群内黑话', confidence: 0.3 },
      { meaning: '佛教术语', confidence: 0.9 },
    ]);
    const facts = makeLearnedFactsStub();
    const miner = new JargonMiner({
      db,
      messages: makeMessageRepo([]),
      learnedFacts: facts,
      claude,
      activeGroups: ['g1'],
      now: () => 1_700_000_000_000,
    });
    await miner.inferJargon('g1');
    const row = db.prepare(
      'SELECT is_jargon, meaning, last_inference_count FROM jargon_candidates WHERE group_id = ? AND content = ?'
    ).get('g1', '阿弥诺斯') as { is_jargon: number; meaning: string | null; last_inference_count: number };
    expect(row.is_jargon).toBe(0);
    expect(row.meaning).toBeNull();
    expect(row.last_inference_count).toBe(2);
    expect(facts.insertOrSupersede).not.toHaveBeenCalled();
    db.close();
  });

  it('t10: legit meaning + confidence 0.8 — is_jargon=1; passes both gates', async () => {
    const db = makeDb();
    seedCandidate(db, { groupId: 'g1', content: '智械危机' });
    const claude = makeClaudeChain([
      { results: [true] },
      { meaning: '群内对某个知名战败玩家的调侃', confidence: 0.8 },
      { meaning: '汉语词组', confidence: 0.9 },
    ]);
    const facts = makeLearnedFactsStub();
    const miner = new JargonMiner({
      db,
      messages: makeMessageRepo([]),
      learnedFacts: facts,
      claude,
      activeGroups: ['g1'],
      now: () => 1_700_000_000_000,
    });
    await miner.inferJargon('g1');
    const row = db.prepare(
      'SELECT is_jargon, meaning FROM jargon_candidates WHERE group_id = ? AND content = ?'
    ).get('g1', '智械危机') as { is_jargon: number; meaning: string | null };
    expect(row.is_jargon).toBe(1);
    expect(row.meaning).toBe('群内对某个知名战败玩家的调侃');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// t3 — promoteToFacts isValidStructuredTerm gate
// ---------------------------------------------------------------------------

describe('JargonMiner — promoteToFacts isValidStructuredTerm gate', () => {
  it('t3: dirty term ("是谁啊") never reaches insertOrSupersede; _markPromoted fires', async () => {
    const db = makeDb();
    // Seed an is_jargon=1 row with a dirty term that should fail isValidStructuredTerm
    // (contains a structural particle / sentence fragment shape).
    seedCandidate(db, {
      groupId: 'g1',
      content: '是谁啊',
      is_jargon: 1,
      meaning: '某种问询',
    });
    const facts = makeLearnedFactsStub();
    const miner = new JargonMiner({
      db,
      messages: makeMessageRepo([]),
      learnedFacts: facts,
      claude: makeClaudeChain([]),
      activeGroups: ['g1'],
      now: () => 1_700_000_000_000,
    });
    await miner.promoteToFacts('g1');
    expect((facts.insertOrSupersede as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    // _markPromoted sets is_jargon = 2
    const row = db.prepare(
      'SELECT is_jargon FROM jargon_candidates WHERE group_id = ? AND content = ?'
    ).get('g1', '是谁啊') as { is_jargon: number };
    expect(row.is_jargon).toBe(2);
    db.close();
  });
});
