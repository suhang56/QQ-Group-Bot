import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AliasMiner } from '../src/modules/alias-miner.js';
import type { IClaudeClient } from '../src/ai/claude.js';
import type { IMessageRepository, ILearnedFactsRepository, LearnedFact } from '../src/storage/db.js';
import type { Logger } from 'pino';

const silentLogger = {
  warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(),
} as unknown as Logger;

function makeMsg(userId: string, nickname: string, content: string, timestamp = 1700000000) {
  return { id: 0, groupId: 'g1', userId, nickname, content, rawContent: content, timestamp, deleted: false };
}

function makeMsgRepo(msgs: ReturnType<typeof makeMsg>[]): IMessageRepository {
  return {
    getRecent: vi.fn().mockReturnValue(msgs),
  } as unknown as IMessageRepository;
}

function makeFactRepo(existing: LearnedFact[] = []): ILearnedFactsRepository & { inserted: Parameters<ILearnedFactsRepository['insert']>[0][] } {
  const inserted: Parameters<ILearnedFactsRepository['insert']>[0][] = [];
  return {
    inserted,
    listActive: vi.fn().mockReturnValue(existing),
    listActiveWithEmbeddings: vi.fn().mockReturnValue([]),
    findSimilarActive: vi.fn().mockResolvedValue(null),
    listPending: vi.fn().mockReturnValue([]),
    countPending: vi.fn().mockReturnValue(0),
    insert: vi.fn().mockImplementation((row) => { inserted.push(row); return inserted.length; }),
    insertOrSupersede: vi.fn().mockReturnValue({ newId: 1, supersededCount: 0 }),
    markStatus: vi.fn(),
    clearGroup: vi.fn(),
    countActive: vi.fn().mockReturnValue(0),
  } as unknown as ILearnedFactsRepository & { inserted: Parameters<ILearnedFactsRepository['insert']>[0][] };
}

function makeClaudeWith(response: string): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({ text: response, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  } as unknown as IClaudeClient;
}

function makeRecentMsgs(count: number, baseUserId = 'u') {
  return Array.from({ length: count }, (_, i) => makeMsg(`${baseUserId}${i}`, `User${i}`, `msg ${i}`, 1700000000 + i));
}

const GROUP = 'g1';

describe('AliasMiner', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('inserts alias fact with correct shape when Claude returns valid entry', async () => {
    const msgs = makeRecentMsgs(60);
    // Ensure userId 'u5' is in the message list
    const msgRepo = makeMsgRepo(msgs);
    const factRepo = makeFactRepo();
    const claude = makeClaudeWith(JSON.stringify([
      { alias: '拉神', realUserNickname: 'User5', realUserId: 'u5', evidence: '群友直接叫他拉神' },
    ]));

    const miner = new AliasMiner({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true,
    });

    await miner._run();

    expect(factRepo.inserted).toHaveLength(1);
    const row = factRepo.inserted[0]!;
    expect(row.topic).toBe('群友别名 拉神');
    expect(row.fact).toContain('拉神');
    expect(row.fact).toContain('User5');
    expect(row.fact).toContain('u5');
    expect(row.confidence).toBe(0.8);
    expect(row.sourceUserNickname).toBe('[alias-miner]');
    expect(row.status).toBe('pending');
  });

  it('skips entry when realUserId is not found in recent messages', async () => {
    const msgs = makeRecentMsgs(60);
    const msgRepo = makeMsgRepo(msgs);
    const factRepo = makeFactRepo();
    // ghost999 never appears in msgs
    const claude = makeClaudeWith(JSON.stringify([
      { alias: '幽灵', realUserNickname: 'Ghost', realUserId: 'ghost999', evidence: '没有人见过' },
    ]));

    const miner = new AliasMiner({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true,
    });

    await miner._run();

    expect(factRepo.inserted).toHaveLength(0);
  });

  it('skips duplicate entry already in DB (same alias + nickname)', async () => {
    const msgs = makeRecentMsgs(60);
    const msgRepo = makeMsgRepo(msgs);
    const existingFact: LearnedFact = {
      id: 1, groupId: GROUP, topic: '群友别名 常山', fact: '常山 = User3 (QQ u3)。已记录',
      sourceUserId: null, sourceUserNickname: '[alias-miner]', sourceMsgId: null,
      botReplyId: null, confidence: 0.85, status: 'active', createdAt: 0, updatedAt: 0,
    };
    const factRepo = makeFactRepo([existingFact]);
    const claude = makeClaudeWith(JSON.stringify([
      { alias: '常山', realUserNickname: 'User3', realUserId: 'u3', evidence: '再次出现的别名' },
      { alias: '新外号', realUserNickname: 'User7', realUserId: 'u7', evidence: '全新外号' },
    ]));

    const miner = new AliasMiner({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true,
    });

    await miner._run();

    expect(factRepo.inserted).toHaveLength(1);
    expect(factRepo.inserted[0]!.topic).toBe('群友别名 新外号');
  });

  it('skips run when fewer than 50 new messages since last run', async () => {
    // msgs timestamps: 1700000000 to 1700000059 seconds
    // After first run, set lastRunTs well past all of them → second run sees 0 new msgs
    const now = vi.fn()
      .mockReturnValueOnce(1700001000000);  // first run records timestamp well past all msgs

    const msgs = makeRecentMsgs(60);
    const msgRepo = makeMsgRepo(msgs);
    const factRepo = makeFactRepo();
    const claude = makeClaudeWith(JSON.stringify([
      { alias: '飞鸟', realUserNickname: 'User1', realUserId: 'u1', evidence: '叫了很多次' },
    ]));

    const miner = new AliasMiner({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true, now,
    });

    // First run succeeds (lastRunTs=0, all 60 msgs are new)
    await miner._run();
    expect(factRepo.inserted).toHaveLength(1);

    // Second run: lastRunTs = 1700001000000ms > all msg timestamps → 0 new msgs → skipped
    await miner._run();
    expect(factRepo.inserted).toHaveLength(1);
  });

  it('returns empty and logs when Claude returns []', async () => {
    const msgs = makeRecentMsgs(60);
    const msgRepo = makeMsgRepo(msgs);
    const factRepo = makeFactRepo();
    const claude = makeClaudeWith('[]');

    const miner = new AliasMiner({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true,
    });

    await miner._run();

    expect(factRepo.inserted).toHaveLength(0);
    expect(silentLogger.info).toHaveBeenCalledWith({ groupId: GROUP }, 'alias-miner: no aliases found');
  });

  it('catches and logs Claude error without crashing', async () => {
    const msgs = makeRecentMsgs(60);
    const msgRepo = makeMsgRepo(msgs);
    const factRepo = makeFactRepo();
    const claude = {
      complete: vi.fn().mockRejectedValue(new Error('API timeout')),
    } as unknown as IClaudeClient;

    const miner = new AliasMiner({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true,
    });

    await expect(miner._run()).resolves.toBeUndefined();
    expect(silentLogger.error).toHaveBeenCalled();
    expect(factRepo.inserted).toHaveLength(0);
  });

  it('start() is no-op when enabled=false, dispose() clears timers', () => {
    const msgRepo = makeMsgRepo([]);
    const factRepo = makeFactRepo();
    const claude = makeClaudeWith('[]');

    const miner = new AliasMiner({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: false,
    });

    miner.start();
    expect((miner as unknown as { timer: unknown }).timer).toBeNull();

    // Calling dispose on a never-started miner should be safe
    miner.dispose();
    expect((miner as unknown as { firstTimer: unknown }).firstTimer).toBeNull();
  });

  it('end-to-end: miner insert lands in listAliasFactsForMap (M6.2c)', async () => {
    // Real DB to exercise the full write + read path through listAliasFactsForMap.
    const { Database } = await import('../src/storage/db.js');
    const db = new Database(':memory:');

    // Seed 60 messages so miner passes the MIN_NEW_MESSAGES gate.
    const ts = 1700000000;
    for (let i = 0; i < 60; i++) {
      db.messages.insert({
        groupId: GROUP, userId: `u${i}`, nickname: `User${i}`,
        content: `msg ${i}`, timestamp: ts + i, deleted: false,
      });
    }

    const claude = makeClaudeWith(JSON.stringify([
      { alias: '拉神', realUserNickname: 'User5', realUserId: 'u5', evidence: '直接叫拉神' },
    ]));
    const miner = new AliasMiner({
      messages: db.messages, learnedFacts: db.learnedFacts, claude,
      activeGroups: [GROUP], logger: silentLogger, enabled: true,
    });

    await miner._run();

    // Miner writes pending; listAliasFactsForMap MUST surface it so the
    // alias-map fast-path lights up without admin approval.
    const mapRows = db.learnedFacts.listAliasFactsForMap(GROUP);
    expect(mapRows).toHaveLength(1);
    expect(mapRows[0]!.status).toBe('pending');
    expect(mapRows[0]!.topic).toBe('群友别名 拉神');

    // Regression: listActiveAliasFacts must still exclude the pending miner row.
    const activeRows = db.learnedFacts.listActiveAliasFacts(GROUP);
    expect(activeRows).toHaveLength(0);
  });
});
