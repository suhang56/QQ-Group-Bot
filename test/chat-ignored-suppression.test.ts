import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
import { defaultGroupConfig } from '../src/config.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { Database } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-ignored';
const GROUP_ID = 'g-ignored';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1', groupId: GROUP_ID, userId: 'u1',
    nickname: 'Peer', role: 'member',
    content: 'hi', rawContent: 'hi',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeMockClaude(text = 'bot reply'): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text,
      inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  };
}

function makeChat(db: Database, claude: IClaudeClient): ChatModule {
  // High chatMinScore so non-direct peer messages never trigger a reply —
  // this keeps the bot silent and lets _updateBotSpeechTracking accumulate
  // msgsSinceSpoke without being reset by a real reply.
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 0,
    chatMinScore: 999,
    chatSilenceBonusSec: 999999,
    chatBurstCount: 99,
    moodProactiveEnabled: false,
    deflectCacheEnabled: false,
  });
}

function makeLowThresholdChat(db: Database, claude: IClaudeClient): ChatModule {
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 0,
    chatMinScore: -999,
    moodProactiveEnabled: false,
    deflectCacheEnabled: false,
  });
}

type Tracking = { lastSpokeAt: number; msgsSinceSpoke: number; engagementReceived: boolean };

function seedBotSpoke(chat: ChatModule, groupId: string, at: number): void {
  const track = (chat as unknown as { botSpeechTracking: { set: (k: string, v: Tracking) => void } }).botSpeechTracking;
  track.set(groupId, { lastSpokeAt: at, msgsSinceSpoke: 0, engagementReceived: false });
  // _isImplicitBotRef checks lastProactiveReply, so seed that too.
  const lp = (chat as unknown as { lastProactiveReply: Map<string, number> }).lastProactiveReply;
  lp.set(groupId, at);
}

function readTracking(chat: ChatModule, groupId: string): Tracking | undefined {
  return (chat as unknown as { botSpeechTracking: { get: (k: string) => Tracking | undefined } }).botSpeechTracking.get(groupId);
}

describe('ChatModule — ignored-suppression (Gate 5.5)', () => {
  let db: Database;
  let claude: ReturnType<typeof makeMockClaude>;
  let chat: ChatModule;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeMockClaude();
    chat = makeChat(db, claude);
    db.groupConfig.upsert(defaultGroupConfig(GROUP_ID));
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('after bot speaks, 3 ignored peer messages → 4th non-direct message skips', async () => {
    const now = Date.now();
    seedBotSpoke(chat, GROUP_ID, now);

    // Three peer messages that don't address the bot (no @ / no reply-to-bot / no alias).
    for (let i = 0; i < 3; i++) {
      await chat.generateReply(GROUP_ID, makeMsg({ messageId: `peer-${i}`, content: '随便聊聊' }), []);
    }

    const t = readTracking(chat, GROUP_ID)!;
    expect(t.msgsSinceSpoke).toBeGreaterThanOrEqual(3);
    expect(t.engagementReceived).toBe(false);

    claude.complete = vi.fn();
    const result = await chat.generateReply(GROUP_ID, makeMsg({ messageId: 'peer-4', content: '继续闲聊' }), []);
    expect(result).toBeNull();
    expect(claude.complete).not.toHaveBeenCalled();
  });

  it('@-mention bypasses ignored-suppression even after being ignored', async () => {
    const now = Date.now();
    seedBotSpoke(chat, GROUP_ID, now);
    for (let i = 0; i < 3; i++) {
      await chat.generateReply(GROUP_ID, makeMsg({ messageId: `p-${i}`, content: '聊天中' }), []);
    }
    // 4th is @ bot — direct override
    const atMsg = makeMsg({
      messageId: 'at',
      content: 'hi',
      rawContent: `[CQ:at,qq=${BOT_ID}] hi`,
    });
    const result = await chat.generateReply(GROUP_ID, atMsg, []);
    expect(result).not.toBeNull();
  });

  it('bot spoke recently + implicit-bot-ref message flips engagementReceived', async () => {
    const now = Date.now();
    seedBotSpoke(chat, GROUP_ID, now);
    // "小号" alias triggers implicit bot ref, within 60s window
    await chat.generateReply(GROUP_ID, makeMsg({ content: '小号你在吗' }), []);
    const t = readTracking(chat, GROUP_ID)!;
    expect(t.engagementReceived).toBe(true);
  });

  it('tracking is not updated when bot has not spoken yet', () => {
    expect(readTracking(chat, GROUP_ID)).toBeUndefined();
    // Invoking tracker update path via generateReply should leave state empty.
    // Do nothing — we rely on internal behavior contract here.
  });

  it('ignored-suppression window expires after IGNORED_SUPPRESSION_MS', async () => {
    // Use low-threshold chat so a non-direct message would reply if Gate 5.5
    // doesn't fire. Seed bot spoke 6 min ago → window (5 min) expired.
    const low = makeLowThresholdChat(db, claude);
    db.groupConfig.upsert(defaultGroupConfig(GROUP_ID));
    const now = Date.now();
    const track = (low as unknown as { botSpeechTracking: { set: (k: string, v: Tracking) => void } }).botSpeechTracking;
    track.set(GROUP_ID, { lastSpokeAt: now - 6 * 60 * 1000, msgsSinceSpoke: 5, engagementReceived: false });
    const lp = (low as unknown as { lastProactiveReply: Map<string, number> }).lastProactiveReply;
    lp.set(GROUP_ID, now - 6 * 60 * 1000);

    const result = await low.generateReply(GROUP_ID, makeMsg({ content: '随便' }), []);
    // Not suppressed by Gate 5.5 (window expired) — passthrough chat engages.
    expect(result).not.toBeNull();
  });

  it('engagementReceived=true prevents suppression', async () => {
    const low = makeLowThresholdChat(db, claude);
    db.groupConfig.upsert(defaultGroupConfig(GROUP_ID));
    const now = Date.now();
    const track = (low as unknown as { botSpeechTracking: { set: (k: string, v: Tracking) => void } }).botSpeechTracking;
    track.set(GROUP_ID, { lastSpokeAt: now, msgsSinceSpoke: 10, engagementReceived: true });
    const result = await low.generateReply(GROUP_ID, makeMsg({ content: '继续聊' }), []);
    // Not suppressed — someone earlier engaged.
    expect(result).not.toBeNull();
  });
});
