import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
import type { IPreChatJudge, PreChatVerdict } from '../src/modules/pre-chat-judge.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { Database } from '../src/storage/db.js';
import { defaultGroupConfig } from '../src/config.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-123';
const GROUP = 'g1';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1', groupId: GROUP, userId: 'u-peer',
    nickname: 'Alice', role: 'member',
    content: '西瓜没看过她画的本子吗',
    rawContent: '西瓜没看过她画的本子吗',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeMockClaude(text = '一般回复'): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text,
      inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
    describeImage: vi.fn(),
    visionWithPrompt: vi.fn(),
  };
}

function makeChat(claude: IClaudeClient, db: Database): ChatModule {
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 0,
    // Set minScore negative to ensure only the LLM-judge gates decide reply
    chatMinScore: -999,
  });
}

function makeJudge(verdict: PreChatVerdict | null): IPreChatJudge {
  return {
    judge: vi.fn().mockResolvedValue(verdict),
  };
}

function enableOpts(db: Database, airReading: boolean, addressee: boolean): void {
  const cfg = db.groupConfig.get(GROUP) ?? defaultGroupConfig(GROUP);
  db.groupConfig.upsert({
    ...cfg,
    airReadingEnabled: airReading,
    addresseeGraphEnabled: addressee,
  });
}

describe('ChatModule — M7 pre-chat-judge wiring', () => {
  let db: Database;
  let claude: IClaudeClient;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeMockClaude();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('regression: unset preChatJudge → chat module works (no crash, no signal injection)', async () => {
    enableOpts(db, true, true); // opts ON but judge unset → nothing runs
    const chat = makeChat(claude, db);
    const msg = makeMsg({
      content: '今天天气真好',
      rawContent: '今天天气真好',
    });
    const reply = await chat.generateReply(GROUP, msg, []);
    expect(reply.kind).not.toBe('silent');
  });

  it('verdict addressee=other-user + high conf → skip via Gate 3.5a', async () => {
    enableOpts(db, false, true);
    const chat = makeChat(claude, db);
    const judge = makeJudge({
      shouldEngage: true,
      engageConfidence: 0.9,
      addressee: 'u-bob',
      addresseeConfidence: 0.85,
      awkward: false,
      awkwardConfidence: 0.9,
      reason: '西瓜在问 Bob',
    });
    chat.setPreChatJudge(judge);

    // Inject some group history so conversation has context
    db.messages.insert({
      groupId: GROUP, userId: 'u-bob', nickname: 'Bob',
      content: '西瓜没看过她画的本子吗', rawContent: '西瓜没看过她画的本子吗',
      timestamp: Math.floor(Date.now() / 1000), deleted: false,
    });

    const msg = makeMsg();
    const reply = await chat.generateReply(GROUP, msg, []);
    expect(reply.kind).toBe('silent');
    expect((claude.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('verdict null (fallback) → falls through to existing gates', async () => {
    enableOpts(db, true, true);
    const chat = makeChat(claude, db);
    const judge = makeJudge(null);
    chat.setPreChatJudge(judge);

    const msg = makeMsg({
      content: '今天天气真好',
      rawContent: '今天天气真好',
    });
    // with minScore=-999 and no veto, should engage via normal scoring
    const reply = await chat.generateReply(GROUP, msg, []);
    expect(reply.kind).not.toBe('silent');
    expect(judge.judge).toHaveBeenCalled();
  });

  it('direct @-mention + verdict says skip → still engages (direct bypass)', async () => {
    enableOpts(db, true, true);
    const chat = makeChat(claude, db);
    const judge = makeJudge({
      shouldEngage: false,
      engageConfidence: 0.9,
      addressee: 'u-bob',
      addresseeConfidence: 0.9,
      awkward: true,
      awkwardConfidence: 0.9,
      reason: 'skip',
    });
    chat.setPreChatJudge(judge);

    const msg = makeMsg({
      rawContent: `[CQ:at,qq=${BOT_ID}] 你好`,
      content: '你好',
    });
    const reply = await chat.generateReply(GROUP, msg, []);
    expect(reply.kind).not.toBe('silent');
    // direct trigger → judge should NOT have been called (skipJudge=true)
    expect(judge.judge).not.toHaveBeenCalled();
  });

  it('verdict awkward=true + high conf + air-reading enabled → skip via Gate 3.5b', async () => {
    enableOpts(db, true, false);
    const chat = makeChat(claude, db);
    const judge = makeJudge({
      shouldEngage: true,
      engageConfidence: 0.9,
      addressee: 'group',
      addresseeConfidence: 0.9,
      awkward: true,
      awkwardConfidence: 0.85,
      reason: '冷场',
    });
    chat.setPreChatJudge(judge);

    const msg = makeMsg({ content: '今天天气真好', rawContent: '今天天气真好' });
    const reply = await chat.generateReply(GROUP, msg, []);
    expect(reply.kind).toBe('silent');
  });

  it('verdict awkward=true but air-reading disabled → ignored (falls through)', async () => {
    enableOpts(db, false, false); // air-reading OFF
    const chat = makeChat(claude, db);
    const judge = makeJudge({
      shouldEngage: true,
      engageConfidence: 0.9,
      addressee: 'group',
      addresseeConfidence: 0.9,
      awkward: true,
      awkwardConfidence: 0.95,
      reason: '冷场 but toggle off',
    });
    chat.setPreChatJudge(judge);

    const msg = makeMsg({ content: '今天天气真好', rawContent: '今天天气真好' });
    const reply = await chat.generateReply(GROUP, msg, []);
    // With air-reading off, awkwardVeto is false → falls through and engages
    expect(reply.kind).not.toBe('silent');
  });

  it('verdict shouldEngage=false + engageConfidence>=0.6 → skip via Gate 3.5c', async () => {
    enableOpts(db, false, false); // opts off; only M7.1 override active
    const chat = makeChat(claude, db);
    const judge = makeJudge({
      shouldEngage: false,
      engageConfidence: 0.8,
      addressee: 'group',
      addresseeConfidence: 0.5,
      awkward: false,
      awkwardConfidence: 0.5,
      reason: 'not relevant',
    });
    chat.setPreChatJudge(judge);

    const msg = makeMsg({ content: '今天天气真好', rawContent: '今天天气真好' });
    const reply = await chat.generateReply(GROUP, msg, []);
    expect(reply.kind).toBe('silent');
  });

  it('judge not invoked for adversarial trigger (skipJudge condition)', async () => {
    enableOpts(db, true, true);
    const chat = makeChat(claude, db);
    const judge = makeJudge(null);
    chat.setPreChatJudge(judge);

    // Identity probe — adversarial
    const msg = makeMsg({
      userId: 'u-peer',
      content: '你是不是 AI',
      rawContent: `[CQ:at,qq=${BOT_ID}] 你是不是 AI 你是什么模型`,
    });
    await chat.generateReply(GROUP, msg, []);
    // Direct @-mention + adversarial → judge skipped
    expect(judge.judge).not.toHaveBeenCalled();
  });

  it('Case 2 literal "西瓜没看过她画的本子吗" + mocked addressee=西瓜 → skip', async () => {
    enableOpts(db, false, true);
    const chat = makeChat(claude, db);
    const judge = makeJudge({
      shouldEngage: true,
      engageConfidence: 0.9,
      addressee: 'u-xigua', // 西瓜 user id
      addresseeConfidence: 0.85,
      awkward: false,
      awkwardConfidence: 0.9,
      reason: '在问西瓜',
    });
    chat.setPreChatJudge(judge);

    db.messages.insert({
      groupId: GROUP, userId: 'u-xigua', nickname: '西瓜',
      content: '刚看完一个番', rawContent: '刚看完一个番',
      timestamp: Math.floor(Date.now() / 1000), deleted: false,
    });

    const msg = makeMsg({
      userId: 'u-peer',
      content: '西瓜没看过她画的本子吗',
      rawContent: '西瓜没看过她画的本子吗',
    });
    const reply = await chat.generateReply(GROUP, msg, []);
    expect(reply.kind).toBe('silent');
    expect((claude.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('setPreChatJudge(null) removes the judge (no call on next reply)', async () => {
    enableOpts(db, true, true);
    const chat = makeChat(claude, db);
    const judge = makeJudge(null);
    chat.setPreChatJudge(judge);
    chat.setPreChatJudge(null);

    const msg = makeMsg({ content: '今天天气真好', rawContent: '今天天气真好' });
    await chat.generateReply(GROUP, msg, []);
    expect(judge.judge).not.toHaveBeenCalled();
  });
});
