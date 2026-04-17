import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModule, formatAddressingHint, type IRelationshipPromptSource } from '../src/modules/chat.js';
import type { SocialRelation } from '../src/modules/relationship-tracker.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { Database } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-123';
const NOW_SEC = Math.floor(Date.now() / 1000);

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1', groupId: 'g1', userId: 'u-speaker',
    nickname: 'Alice', role: 'member',
    content: '你好啊 bot 你最近在干嘛',
    rawContent: '你好啊 bot 你最近在干嘛',
    timestamp: NOW_SEC,
    ...overrides,
  };
}

function makeMockClaude(text = '普通回复一句'): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text,
      inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  };
}

function makeChat(claude: IClaudeClient, db: Database): ChatModule {
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 0,
    chatMinScore: -999,
  });
}

function makeRelation(overrides: Partial<SocialRelation> = {}): SocialRelation {
  return {
    groupId: 'g1',
    fromUser: 'u-peer',
    toUser: BOT_ID,
    relationType: '铁磁/密友',
    strength: 0.8,
    evidence: '互动频繁',
    updatedAt: NOW_SEC,
    ...overrides,
  };
}

function makeRelSource(overrides: Partial<IRelationshipPromptSource> = {}): IRelationshipPromptSource {
  return {
    getRelevantRelations: vi.fn().mockReturnValue([]),
    formatRelationsForPrompt: vi.fn().mockReturnValue(''),
    getBotUserRelation: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

function captureCall(claude: IClaudeClient) {
  const mock = (claude.complete as ReturnType<typeof vi.fn>).mock;
  if (mock.calls.length === 0) return { systemText: '', userText: '' };
  const call = mock.calls[0]![0] as {
    system: Array<{ text: string }>;
    messages: Array<{ content: string }>;
  };
  return {
    systemText: call.system.map(s => s.text).join('\n---\n'),
    userText: call.messages.map(m => m.content).join('\n---\n'),
  };
}

describe('formatAddressingHint (pure function)', () => {
  it('returns facts-only string for 铁磁/密友 with sufficient strength', () => {
    const hint = formatAddressingHint(makeRelation({ relationType: '铁磁/密友', strength: 0.8 }), 'Alice');
    expect(hint).toBe('你和 Alice 是【铁磁/密友】');
  });

  it('does NOT emit behavior prescriptions (persona infers tone)', () => {
    const hint = formatAddressingHint(makeRelation({ relationType: '铁磁/密友', strength: 0.8 }), 'Alice');
    expect(hint).not.toContain('可以带调侃');
    expect(hint).not.toContain('调戏');
    expect(hint).not.toContain('别热情');
  });

  it.each([
    '铁磁/密友', 'CP/暧昧', '互怼/欢喜冤家', '前辈后辈',
    '崇拜/粉丝', '冷淡', '敌对',
  ])('emits fact-only sentence for %s', (type) => {
    const hint = formatAddressingHint(makeRelation({ relationType: type, strength: 0.6 }), 'Alice');
    expect(hint).toBe(`你和 Alice 是【${type}】`);
  });

  it('returns null for 普通群友 (skip list — empty information)', () => {
    expect(formatAddressingHint(makeRelation({ relationType: '普通群友', strength: 0.9 }), 'Alice')).toBeNull();
  });

  it('returns null when strength < 0.3 (evidence too weak)', () => {
    expect(formatAddressingHint(makeRelation({ relationType: '铁磁/密友', strength: 0.29 }), 'Alice')).toBeNull();
  });

  it('emits hint for unknown relationType as long as not in skip list (facts-only)', () => {
    // Facts-only design: any non-skip relationType produces the same fact sentence.
    // This is intentional — we don't gate on a whitelist; persona handles whatever it sees.
    const hint = formatAddressingHint(makeRelation({ relationType: 'made-up', strength: 0.9 }), 'Alice');
    expect(hint).toBe('你和 Alice 是【made-up】');
  });
});

describe('ChatModule — M6.5 addressing-hint wiring', () => {
  let db: Database;
  let claude: IClaudeClient;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeMockClaude();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('injects addressing hint into userContent on direct @-trigger with 铁磁 relation', async () => {
    const rel = makeRelation({ fromUser: 'u-peer', relationType: '铁磁/密友', strength: 0.8 });
    const src = makeRelSource({
      getBotUserRelation: vi.fn().mockReturnValue(rel),
    });
    const chat = makeChat(claude, db);
    chat.setRelationshipSource(src);

    const msg = makeMsg({
      userId: 'u-peer', nickname: 'Alice',
      rawContent: `[CQ:at,qq=${BOT_ID}] hey`,
      content: 'hey',
    });
    await chat.generateReply('g1', msg, []);

    const { systemText, userText } = captureCall(claude);
    expect(userText).toContain('你和 Alice 是【铁磁/密友】');
    expect(userText).toContain('context 注释');
    // Facts-only: no behavior prescription in output
    expect(userText).not.toContain('可以带调侃');
    // Must live in user content, NOT system prompt
    expect(systemText).not.toContain('铁磁/密友');
    expect(src.getBotUserRelation).toHaveBeenCalledWith('g1', BOT_ID, 'u-peer');
  });

  it('omits hint when relationType is 普通群友 (skip list)', async () => {
    const src = makeRelSource({
      getBotUserRelation: vi.fn().mockReturnValue(
        makeRelation({ fromUser: 'u-peer', relationType: '普通群友', strength: 0.9 }),
      ),
    });
    const chat = makeChat(claude, db);
    chat.setRelationshipSource(src);

    const msg = makeMsg({
      userId: 'u-peer',
      rawContent: `[CQ:at,qq=${BOT_ID}] hey`,
      content: 'hey',
    });
    await chat.generateReply('g1', msg, []);

    const { userText } = captureCall(claude);
    // Look-up fired but emitted no content
    expect(src.getBotUserRelation).toHaveBeenCalled();
    expect(userText).not.toMatch(/你和 .*? 是【普通群友】/);
    expect(userText).not.toContain('普通群友');
  });

  it('omits hint when strength < 0.3', async () => {
    const src = makeRelSource({
      getBotUserRelation: vi.fn().mockReturnValue(
        makeRelation({ fromUser: 'u-peer', relationType: '铁磁/密友', strength: 0.25 }),
      ),
    });
    const chat = makeChat(claude, db);
    chat.setRelationshipSource(src);

    const msg = makeMsg({
      userId: 'u-peer',
      rawContent: `[CQ:at,qq=${BOT_ID}] hey`,
      content: 'hey',
    });
    await chat.generateReply('g1', msg, []);

    const { userText } = captureCall(claude);
    expect(userText).not.toMatch(/你和 .*? 是【铁磁\/密友】/);
  });

  it('does NOT query relation on ambient (non-direct) trigger', async () => {
    const src = makeRelSource({
      getBotUserRelation: vi.fn().mockReturnValue(
        makeRelation({ fromUser: 'u-peer', relationType: '铁磁/密友', strength: 0.8 }),
      ),
    });
    const chat = makeChat(claude, db);
    chat.setRelationshipSource(src);

    // No @-mention, no reply-to-bot → ambient
    const msg = makeMsg({ userId: 'u-peer', content: '今天天气真好', rawContent: '今天天气真好' });
    await chat.generateReply('g1', msg, []);

    expect(src.getBotUserRelation).not.toHaveBeenCalled();
  });

  it('does NOT query relation when trigger userId is bot itself', async () => {
    const src = makeRelSource({
      getBotUserRelation: vi.fn().mockReturnValue(
        makeRelation({ fromUser: BOT_ID, relationType: '铁磁/密友', strength: 0.8 }),
      ),
    });
    const chat = makeChat(claude, db);
    chat.setRelationshipSource(src);

    const msg = makeMsg({
      userId: BOT_ID,
      rawContent: `[CQ:at,qq=${BOT_ID}] hey`,
      content: 'hey',
    });
    await chat.generateReply('g1', msg, []);

    expect(src.getBotUserRelation).not.toHaveBeenCalled();
  });

  it('no-op and does not throw when relationshipSource is not set (backward compat)', async () => {
    const chat = makeChat(claude, db);
    // NO setRelationshipSource call
    const msg = makeMsg({
      userId: 'u-peer',
      rawContent: `[CQ:at,qq=${BOT_ID}] hey`,
      content: 'hey',
    });
    const reply = await chat.generateReply('g1', msg, []);
    expect(reply).not.toBeNull();

    const { userText } = captureCall(claude);
    expect(userText).not.toMatch(/你和 .*? 是【/);
  });

  it('does not leave a dangling "context 注释" header when no hint fires', async () => {
    const src = makeRelSource({ getBotUserRelation: vi.fn().mockReturnValue(null) });
    const chat = makeChat(claude, db);
    chat.setRelationshipSource(src);

    const msg = makeMsg({
      userId: 'u-peer',
      rawContent: `[CQ:at,qq=${BOT_ID}] hey`,
      content: 'hey',
    });
    await chat.generateReply('g1', msg, []);

    const { userText } = captureCall(claude);
    expect(userText).not.toMatch(/〔context 注释：〕/);
  });
});
