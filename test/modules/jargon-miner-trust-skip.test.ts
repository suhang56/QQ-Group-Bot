import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../../src/storage/db.js';
import type { IClaudeClient } from '../../src/ai/claude.js';
import type {
  IMessageRepository,
  ILearnedFactsRepository,
  Message,
  LearnedFact,
} from '../../src/storage/db.js';
import { JargonMiner } from '../../src/modules/jargon-miner.js';
import { AliasMiner } from '../../src/modules/alias-miner.js';
import {
  findHigherTrustExistingFact,
  trustTierFromTopic,
  type TrustComparableFact,
} from '../../src/modules/fact-topic-prefixes.js';
import { _resetCacheForTesting } from '../../src/modules/fact-validator.js';
import { runScript, findConflicts } from '../../scripts/maintenance/supersede-jargon-tier-conflict.js';
import { initLogger } from '../../src/utils/logger.js';
import type { Logger } from 'pino';

initLogger({ level: 'silent' });

const silentLogger = {
  warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(),
} as unknown as Logger;

// ---- Helpers --------------------------------------------------------------

const GROUP = 'g-trust';
const NOW_MS = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function makeJargonDb(): DatabaseSync {
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

function seedJargonCandidate(
  db: DatabaseSync,
  opts: {
    groupId: string;
    content: string;
    meaning: string;
    contexts: Array<{ user_id: string; content: string }>;
  },
): void {
  db.prepare(`
    INSERT INTO jargon_candidates
      (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, 1, ?, ?)
  `).run(
    opts.groupId,
    opts.content,
    opts.contexts.length,
    JSON.stringify(opts.contexts),
    opts.meaning,
    NOW_SEC,
    NOW_SEC,
  );
}

function seedFact(
  factsDb: Database,
  opts: { topic: string; fact: string; status?: LearnedFact['status'] },
): number {
  const id = factsDb.learnedFacts.insert({
    groupId: GROUP,
    topic: opts.topic,
    fact: opts.fact,
    sourceUserId: null,
    sourceUserNickname: null,
    sourceMsgId: null,
    botReplyId: null,
  });
  if (opts.status && opts.status !== 'active') {
    factsDb.learnedFacts.markStatus(id, opts.status);
  }
  return id;
}

function makeMessageRepoStub(messages: Message[] = []): IMessageRepository {
  return {
    insert: vi.fn().mockReturnValue(messages[0]),
    getRecent: vi.fn().mockReturnValue(messages),
    getByUser: vi.fn().mockReturnValue([]),
    sampleRandomHistorical: vi.fn().mockReturnValue([]),
    searchByKeywords: vi.fn().mockReturnValue([]),
    getTopUsers: vi.fn().mockReturnValue([]),
    softDelete: vi.fn(),
    findBySourceId: vi.fn().mockReturnValue(null),
    findNearTimestamp: vi.fn().mockReturnValue(null),
    getAroundTimestamp: vi.fn().mockReturnValue([]),
  } as unknown as IMessageRepository;
}

function makeClaudeStub(): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text: '{}', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }),
    describeImage: vi.fn().mockResolvedValue(''),
    visionWithPrompt: vi.fn().mockResolvedValue(''),
  } as unknown as IClaudeClient;
}

// Always-empty grounding so validateFactForActive falls through to speaker
// rule rather than calling the live Gemini provider.
const emptyGrounding = {
  search: vi.fn().mockResolvedValue([]),
};

// Spy wrapper around a real LearnedFactsRepository so we can both observe
// insertOrSupersede AND let it actually persist (so listActive / findActive
// reflect the writes).
function wrapLearnedFacts(repo: ILearnedFactsRepository): {
  spy: ILearnedFactsRepository;
  insertOrSupersede: ReturnType<typeof vi.fn>;
} {
  const insertOrSupersede = vi.fn(repo.insertOrSupersede.bind(repo));
  const spy: ILearnedFactsRepository = new Proxy(repo, {
    get(target, key, receiver) {
      if (key === 'insertOrSupersede') return insertOrSupersede;
      const v = Reflect.get(target, key, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as ILearnedFactsRepository;
  return { spy, insertOrSupersede };
}

beforeEach(() => {
  _resetCacheForTesting();
  vi.clearAllMocks();
});

// ---- T7 / T7b — pure helper unit tests ------------------------------------

describe('findHigherTrustExistingFact (pure helper)', () => {
  it('T7: empty array returns null', () => {
    const out = findHigherTrustExistingFact([], '群内黑话:abc');
    expect(out).toBeNull();
  });

  it('T7b: returns the higher-trust same-term row when proposed is lower trust', () => {
    const facts: TrustComparableFact[] = [
      { id: 1, topic: 'user-taught:xtt', confidence: 1.0 },
      { id: 2, topic: '群内黑话:xtt', confidence: 0.85 },
    ];
    const out = findHigherTrustExistingFact(facts, '群内黑话:xtt');
    expect(out).not.toBeNull();
    expect(out!.id).toBe(1);
    expect(out!.topic).toBe('user-taught:xtt');
    expect(trustTierFromTopic(out!.topic)).toBe(0);
  });

  it('T7c: returns null when proposed tier matches existing tier', () => {
    const facts: TrustComparableFact[] = [
      { id: 1, topic: '群内黑话:foo' },
    ];
    const out = findHigherTrustExistingFact(facts, '群内黑话:foo');
    expect(out).toBeNull();
  });

  it('T7d: returns null when existing rows are different terms', () => {
    const facts: TrustComparableFact[] = [
      { id: 1, topic: 'user-taught:other' },
    ];
    const out = findHigherTrustExistingFact(facts, '群内黑话:xtt');
    expect(out).toBeNull();
  });

  it('T7e: opus-classified beats jargon-miner topic', () => {
    const facts: TrustComparableFact[] = [
      { id: 7, topic: 'opus-classified:slang:bar' },
    ];
    const out = findHigherTrustExistingFact(facts, '群内黑话:bar');
    expect(out).not.toBeNull();
    expect(out!.id).toBe(7);
  });

  it('T7f: invalid proposed topic returns null (defensive)', () => {
    const facts: TrustComparableFact[] = [
      { id: 1, topic: 'user-taught:foo' },
    ];
    // proposed topic without canonical prefix
    const out = findHigherTrustExistingFact(facts, 'unknown-prefix:foo');
    expect(out).toBeNull();
  });
});

// ---- T1 / T2 / T3 / T4 / T6 — jargon-miner integration --------------------

async function runJargonPromote(opts: {
  jc: DatabaseSync;
  factsDb: Database;
  candidate: { content: string; meaning: string };
}) {
  const { spy, insertOrSupersede } = wrapLearnedFacts(opts.factsDb.learnedFacts);
  seedJargonCandidate(opts.jc, {
    groupId: GROUP,
    content: opts.candidate.content,
    meaning: opts.candidate.meaning,
    contexts: [
      { user_id: 'u1', content: `${opts.candidate.content} = ${opts.candidate.meaning}` },
      { user_id: 'u2', content: `${opts.candidate.content} 就是 ${opts.candidate.meaning}` },
      { user_id: 'u3', content: `${opts.candidate.content} 即 ${opts.candidate.meaning}` },
    ],
  });
  const miner = new JargonMiner({
    db: opts.jc,
    messages: makeMessageRepoStub(),
    learnedFacts: spy,
    claude: makeClaudeStub(),
    activeGroups: [GROUP],
    logger: silentLogger,
    groundingProvider: emptyGrounding,
    now: () => NOW_MS,
  });
  await miner.promoteToFacts(GROUP);
  return { insertOrSupersede };
}

describe('JargonMiner.promoteToFacts trust-tier guard', () => {
  it('T1: no existing fact -- write proceeds', async () => {
    const jc = makeJargonDb();
    const factsDb = new Database(':memory:');
    const { insertOrSupersede } = await runJargonPromote({
      jc, factsDb,
      candidate: { content: 'abc', meaning: '指 a-b-c 缩写' },
    });
    expect(insertOrSupersede).toHaveBeenCalledTimes(1);
    const arg = insertOrSupersede.mock.calls[0]![0];
    expect(arg.topic).toBe('群内黑话:abc');
    jc.close();
  });

  it('T2: user-taught:xtt blocks 群内黑话:xtt write (no insertOrSupersede)', async () => {
    const jc = makeJargonDb();
    const factsDb = new Database(':memory:');
    seedFact(factsDb, {
      topic: 'user-taught:xtt',
      fact: 'xtt 是小团体 拼音首字母 abbreviation',
    });
    const { insertOrSupersede } = await runJargonPromote({
      jc, factsDb,
      candidate: { content: 'xtt', meaning: '指 感叹词或语气词' },
    });
    expect(insertOrSupersede).not.toHaveBeenCalled();
    jc.close();
  });

  it('T3: same-tier same-prefix proceeds (exact-topic supersede path preserved)', async () => {
    const jc = makeJargonDb();
    const factsDb = new Database(':memory:');
    seedFact(factsDb, {
      topic: '群内黑话:foo',
      fact: 'foo = 旧含义',
    });
    const { insertOrSupersede } = await runJargonPromote({
      jc, factsDb,
      candidate: { content: 'foo', meaning: '指 新含义' },
    });
    expect(insertOrSupersede).toHaveBeenCalledTimes(1);
    expect(insertOrSupersede.mock.calls[0]![0].topic).toBe('群内黑话:foo');
    jc.close();
  });

  it('T4: opus-classified:slang:bar blocks 群内黑话:bar write', async () => {
    const jc = makeJargonDb();
    const factsDb = new Database(':memory:');
    seedFact(factsDb, {
      topic: 'opus-classified:slang:bar',
      fact: 'bar = opus 分类的含义',
    });
    const { insertOrSupersede } = await runJargonPromote({
      jc, factsDb,
      candidate: { content: 'bar', meaning: '指 群内别的含义' },
    });
    expect(insertOrSupersede).not.toHaveBeenCalled();
    jc.close();
  });

  it('T6: superseded user-taught row does NOT block (only active rows checked)', async () => {
    const jc = makeJargonDb();
    const factsDb = new Database(':memory:');
    seedFact(factsDb, {
      topic: 'user-taught:zzz',
      fact: 'zzz 旧含义',
      status: 'superseded',
    });
    const { insertOrSupersede } = await runJargonPromote({
      jc, factsDb,
      candidate: { content: 'zzz', meaning: '指 zzz 缩写' },
    });
    expect(insertOrSupersede).toHaveBeenCalledTimes(1);
    expect(insertOrSupersede.mock.calls[0]![0].topic).toBe('群内黑话:zzz');
    jc.close();
  });
});

// ---- T5 — alias-miner integration -----------------------------------------

function makeMsgs(n: number, idPrefix = 'u'): Message[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    groupId: GROUP,
    userId: `${idPrefix}${i}`,
    nickname: `User${i}`,
    content: `m${i}`,
    rawContent: `m${i}`,
    timestamp: NOW_SEC + i,
    deleted: false,
  } as Message));
}

function makeMsgRepoForAlias(msgs: Message[]): IMessageRepository {
  return { getRecent: vi.fn().mockReturnValue(msgs) } as unknown as IMessageRepository;
}

function makeAliasClaudeWith(payload: unknown): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text: JSON.stringify(payload),
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }),
  } as unknown as IClaudeClient;
}

describe('AliasMiner trust-tier guard', () => {
  it('T5: user-taught:ygfn blocks 群友别名:ygfn write', async () => {
    const factsDb = new Database(':memory:');
    seedFact(factsDb, {
      topic: 'user-taught:ygfn',
      fact: 'ygfn = 用户教的真实映射',
    });
    const { spy, insertOrSupersede } = wrapLearnedFacts(factsDb.learnedFacts);

    const msgs = makeMsgs(60);
    const claude = makeAliasClaudeWith([
      { alias: 'ygfn', realUserNickname: 'User5', realUserId: 'u5', evidence: '群友直接叫他' },
    ]);
    const miner = new AliasMiner({
      messages: makeMsgRepoForAlias(msgs),
      learnedFacts: spy,
      claude,
      activeGroups: [GROUP],
      logger: silentLogger,
      enabled: true,
    });
    await miner._run();

    expect(insertOrSupersede).not.toHaveBeenCalled();
  });

  it('T5b: alias-miner writes when no higher-trust row exists', async () => {
    const factsDb = new Database(':memory:');
    const { spy, insertOrSupersede } = wrapLearnedFacts(factsDb.learnedFacts);
    const msgs = makeMsgs(60);
    const claude = makeAliasClaudeWith([
      { alias: 'lasm', realUserNickname: 'User5', realUserId: 'u5', evidence: '直接叫 lasm' },
    ]);
    const miner = new AliasMiner({
      messages: makeMsgRepoForAlias(msgs),
      learnedFacts: spy,
      claude,
      activeGroups: [GROUP],
      logger: silentLogger,
      enabled: true,
    });
    await miner._run();
    expect(insertOrSupersede).toHaveBeenCalledTimes(1);
    expect(insertOrSupersede.mock.calls[0]![0].topic).toBe('群友别名:lasm');
  });
});

// ---- T8 — maintenance script ----------------------------------------------

describe('supersede-jargon-tier-conflict script', () => {
  it('T8a: dry-run finds 群内黑话:xtt vs user-taught:xtt conflict (no DB writes)', () => {
    const factsDb = new Database(':memory:');
    seedFact(factsDb, {
      topic: 'user-taught:xtt',
      fact: 'xtt = 小团体 拼音首字母 abbreviation',
    });
    const jargonId = seedFact(factsDb, {
      topic: '群内黑话:xtt',
      fact: 'xtt 的意思是 感叹词/语气词',
    });

    const lines: string[] = [];
    const result = runScript({
      db: factsDb.rawDb,
      apply: false,
      log: (l) => lines.push(l),
      now: () => NOW_MS,
    });

    expect(result.found).toBe(1);
    expect(result.applied).toBe(0);
    expect(result.conflicts[0]!.loId).toBe(jargonId);
    expect(result.conflicts[0]!.loTopic).toBe('群内黑话:xtt');
    expect(result.conflicts[0]!.hiTopic).toBe('user-taught:xtt');

    // No DB write — both rows still active.
    const jargonRow = factsDb.learnedFacts.findById(jargonId);
    expect(jargonRow?.status).toBe('active');

    // Output mentions dry-run marker.
    expect(lines.some(l => l.includes('[DRY RUN]'))).toBe(true);
  });

  it('T8b: --apply supersedes the lower-trust row; user-taught untouched; idempotent re-run', () => {
    const factsDb = new Database(':memory:');
    const userTaughtId = seedFact(factsDb, {
      topic: 'user-taught:xtt',
      fact: 'xtt = 小团体 拼音首字母 abbreviation',
    });
    const jargonId = seedFact(factsDb, {
      topic: '群内黑话:xtt',
      fact: 'xtt 的意思是 感叹词/语气词',
    });

    const result = runScript({
      db: factsDb.rawDb,
      apply: true,
      log: () => {},
      now: () => NOW_MS,
    });
    expect(result.found).toBe(1);
    expect(result.applied).toBe(1);

    // Lower-trust row is now superseded; higher-trust row untouched.
    expect(factsDb.learnedFacts.findById(jargonId)?.status).toBe('superseded');
    expect(factsDb.learnedFacts.findById(userTaughtId)?.status).toBe('active');

    // Idempotent: re-run finds 0 conflicts.
    const second = runScript({
      db: factsDb.rawDb,
      apply: true,
      log: () => {},
      now: () => NOW_MS,
    });
    expect(second.found).toBe(0);
    expect(second.applied).toBe(0);
  });

  it('T8c: findConflicts returns empty when no conflicts exist', () => {
    const factsDb = new Database(':memory:');
    seedFact(factsDb, {
      topic: 'user-taught:foo',
      fact: 'foo = something',
    });
    expect(findConflicts(factsDb.rawDb)).toHaveLength(0);
  });

  it('T8d: same-tier rows are NOT treated as conflicts', () => {
    const factsDb = new Database(':memory:');
    // Two 群内黑话: rows for different terms — both tier 4. Should not conflict.
    seedFact(factsDb, { topic: '群内黑话:foo', fact: 'foo = bar' });
    seedFact(factsDb, { topic: '群内黑话:baz', fact: 'baz = qux' });
    expect(findConflicts(factsDb.rawDb)).toHaveLength(0);
  });
});
