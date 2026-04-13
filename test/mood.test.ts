import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MoodTracker, describeMood, PROACTIVE_POOLS } from '../src/modules/mood.js';
import { ChatModule, TASK_DEFLECTIONS, SILENCE_BREAKER_POOL } from '../src/modules/chat.js';
import { Database } from '../src/storage/db.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-123';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1', groupId: 'g1', userId: 'u1',
    nickname: 'Alice', role: 'member',
    content: 'hello', rawContent: 'hello',
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

// ── MoodTracker unit tests ────────────────────────────────────────────────────

describe('MoodTracker', () => {
  let tracker: MoodTracker;

  beforeEach(() => {
    tracker = new MoodTracker();
  });

  // 1. "笑死" → valence nudges up
  it('"笑死" in message nudges valence up', () => {
    const before = tracker.getMood('g1').valence;
    tracker.updateFromMessage('g1', makeMsg({ content: '笑死' }));
    const after = tracker.getMood('g1').valence;
    expect(after).toBeGreaterThan(before);
  });

  // 2. "变笨了" → valence nudges down
  it('"变笨了" in message nudges valence down', () => {
    const before = tracker.getMood('g1').valence;
    tracker.updateFromMessage('g1', makeMsg({ content: '变笨了' }));
    const after = tracker.getMood('g1').valence;
    expect(after).toBeLessThan(before);
  });

  // 3. Decay over time: mood returns toward 0
  it('decay over 10 min brings valence toward 0', () => {
    // Manually set a mood in the past with high valence
    const past = Date.now() - 10 * 60_000; // 10 min ago
    tracker['moods'].set('g1', { valence: 0.8, arousal: 0.6, lastUpdate: past });
    const current = tracker.getMood('g1');
    expect(current.valence).toBeLessThan(0.8);
    expect(current.valence).toBeGreaterThanOrEqual(0);
    expect(current.arousal).toBeLessThan(0.6);
  });

  // 4. describe returns correct label
  it('describe returns 激动爽 when valence>=0.5 and arousal>=0.5', () => {
    tracker['moods'].set('g1', { valence: 0.7, arousal: 0.7, lastUpdate: Date.now() });
    const desc = tracker.describe('g1');
    expect(desc.label).toBe('激动爽');
    expect(desc.hints).toContain('嘿嘿');
  });

  it('describe returns 烦躁 when valence<=-0.3 and arousal>=0.3', () => {
    tracker['moods'].set('g1', { valence: -0.5, arousal: 0.5, lastUpdate: Date.now() });
    const desc = tracker.describe('g1');
    expect(desc.label).toBe('烦躁');
    expect(desc.hints).toContain('烦');
  });

  it('describe returns 无聊低气压 when valence<=-0.3 and arousal<-0.3', () => {
    tracker['moods'].set('g1', { valence: -0.4, arousal: -0.5, lastUpdate: Date.now() });
    const desc = tracker.describe('g1');
    expect(desc.label).toBe('无聊低气压');
    expect(desc.hints).toContain('好困');
  });

  it('describe returns 普通 at neutral (0,0)', () => {
    const desc = tracker.describe('g1'); // fresh tracker = neutral
    expect(desc.label).toBe('普通');
  });

  // 9. Multi-group isolation
  it('group A mood does not affect group B', () => {
    tracker.updateFromMessage('g1', makeMsg({ groupId: 'g1', content: '笑死哈哈哈' }));
    tracker.updateFromMessage('g1', makeMsg({ groupId: 'g1', content: 'Roselia 太好听了' }));
    const moodA = tracker.getMood('g1');
    const moodB = tracker.getMood('g2');
    expect(moodA.valence).toBeGreaterThan(0);
    expect(moodB.valence).toBe(0);
    expect(moodB.arousal).toBe(0);
  });

  it('rewardEngagement nudges valence up', () => {
    const before = tracker.getMood('g1').valence;
    tracker.rewardEngagement('g1');
    const after = tracker.getMood('g1').valence;
    expect(after).toBeGreaterThan(before);
  });

  it('values stay clamped to [-1, 1]', () => {
    for (let i = 0; i < 50; i++) {
      tracker.updateFromMessage('g1', makeMsg({ content: 'Roselia 笑死 爽' }));
    }
    const { valence, arousal } = tracker.getMood('g1');
    expect(valence).toBeLessThanOrEqual(1);
    expect(valence).toBeGreaterThanOrEqual(-1);
    expect(arousal).toBeLessThanOrEqual(1);
    expect(arousal).toBeGreaterThanOrEqual(-1);
  });
});

// ── describeMood pure function ────────────────────────────────────────────────

describe('describeMood', () => {
  it('激动爽: v>=0.5, a>=0.5', () => expect(describeMood(0.6, 0.6).label).toBe('激动爽'));
  it('开心: v>=0.3, a in [-0.3, 0.5)', () => expect(describeMood(0.4, 0).label).toBe('开心'));
  it('懒洋洋满足: v>=0.3, a<-0.3', () => expect(describeMood(0.5, -0.5).label).toBe('懒洋洋满足'));
  it('亢奋: v neutral, a>=0.5', () => expect(describeMood(0, 0.6).label).toBe('亢奋'));
  it('烦躁: v<=-0.3, a>=0.3', () => expect(describeMood(-0.4, 0.4).label).toBe('烦躁'));
  it('无聊低气压: v<=-0.3, a<-0.3', () => expect(describeMood(-0.4, -0.5).label).toBe('无聊低气压'));
  it('不爽: v<=-0.5 (low arousal)', () => expect(describeMood(-0.6, -0.1).label).toBe('不爽'));
  it('普通: v=0, a=0', () => expect(describeMood(0, 0).label).toBe('普通'));
});

// ── ChatModule integration ────────────────────────────────────────────────────

describe('ChatModule — mood system integration', () => {
  let db: Database;
  let claude: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = vi.fn().mockResolvedValue({
      text: 'bot reply',
      inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse);
  });

  function makeChat(opts: Record<string, unknown> = {}): ChatModule {
    return new ChatModule(
      { complete: claude } as unknown as IClaudeClient,
      db,
      { botUserId: BOT_ID, debounceMs: 0, chatMinScore: -999, moodProactiveEnabled: false, ...opts },
    );
  }

  // 5. System prompt includes mood section when mood is non-neutral
  it('system prompt includes mood section when mood is active', async () => {
    const chat = makeChat();
    // Pre-seed mood state to 激动爽
    chat.getMoodTracker()['moods'].set('g1', { valence: 0.8, arousal: 0.8, lastUpdate: Date.now() });

    await chat.generateReply('g1', makeMsg({ content: '你好' }), []);
    const calls = (claude as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const systemBlocks = calls[0]![0].system as Array<{ text: string }>;
    const fullSystemText = systemBlocks.map(b => b.text).join('\n');
    expect(fullSystemText).toContain('你的当前心情');
    expect(fullSystemText).toContain('激动爽');
  });

  it('system prompt has no mood section when mood is neutral', async () => {
    const chat = makeChat();
    // neutral mood (default)
    await chat.generateReply('g1', makeMsg({ content: '你好' }), []);
    const calls = (claude as ReturnType<typeof vi.fn>).mock.calls;
    const systemBlocks = calls[0]![0].system as Array<{ text: string }>;
    const fullSystemText = systemBlocks.map(b => b.text).join('\n');
    expect(fullSystemText).not.toContain('你的当前心情');
  });

  // 6. Proactive sends when conditions met (mocked timer)
  it('_moodProactiveTick sends proactive message when conditions met', async () => {
    const sentMessages: Array<{ groupId: string; text: string }> = [];
    const chat = makeChat({ moodProactiveEnabled: false });

    // Set proactive adapter
    chat.setProactiveAdapter(async (groupId, text) => {
      sentMessages.push({ groupId, text });
      return 42;
    });

    // Prime: bot posted 5 min ago (above silence threshold of 3 min)
    chat['knownGroups'].add('g1');
    chat['lastProactiveReply'].set('g1', Date.now() - 5 * 60_000);
    // No recent mood proactive
    chat['lastMoodProactive'].delete('g1');
    // Recent group activity (within 10 min) — message 30s ago so silence-breaker doesn't fire
    db.messages.insert({ groupId: 'g1', userId: 'u1', nickname: 'Alice', content: 'hi', timestamp: Math.floor(Date.now() / 1000) - 30, deleted: false });
    // Set mood to 激动爽 (chance 20%)
    chat.getMoodTracker()['moods'].set('g1', { valence: 0.9, arousal: 0.9, lastUpdate: Date.now() });

    // Force random to always pass the 20% chance
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    await chat['_moodProactiveTick']();
    vi.restoreAllMocks();

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]!.groupId).toBe('g1');
    expect(PROACTIVE_POOLS['激动爽']).toContain(sentMessages[0]!.text);
  });

  // 7. Proactive skipped when cooldown active
  it('_moodProactiveTick skipped when cooldown active', async () => {
    const sentMessages: Array<{ groupId: string; text: string }> = [];
    const chat = makeChat({ moodProactiveEnabled: false });
    chat.setProactiveAdapter(async (groupId, text) => { sentMessages.push({ groupId, text }); return 42; });

    chat['knownGroups'].add('g1');
    chat['lastProactiveReply'].set('g1', Date.now() - 5 * 60_000);
    // Set lastMoodProactive to recent (within 30 min cap)
    chat['lastMoodProactive'].set('g1', Date.now() - 5 * 60_000);
    db.messages.insert({ groupId: 'g1', userId: 'u1', nickname: 'Alice', content: 'hi', timestamp: Math.floor(Date.now() / 1000) - 30, deleted: false });
    chat.getMoodTracker()['moods'].set('g1', { valence: 0.9, arousal: 0.9, lastUpdate: Date.now() });

    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    await chat['_moodProactiveTick']();
    vi.restoreAllMocks();

    expect(sentMessages.length).toBe(0);
  });

  // 8. High anger → no proactive
  it('_moodProactiveTick skipped when valence <= -0.5 (high anger)', async () => {
    const sentMessages: Array<{ groupId: string; text: string }> = [];
    const chat = makeChat({ moodProactiveEnabled: false });
    chat.setProactiveAdapter(async (groupId, text) => { sentMessages.push({ groupId, text }); return 42; });

    chat['knownGroups'].add('g1');
    chat['lastProactiveReply'].set('g1', Date.now() - 5 * 60_000);
    chat['lastMoodProactive'].delete('g1');
    db.messages.insert({ groupId: 'g1', userId: 'u1', nickname: 'Alice', content: 'hi', timestamp: Math.floor(Date.now() / 1000) - 30, deleted: false });
    // High anger mood
    chat.getMoodTracker()['moods'].set('g1', { valence: -0.8, arousal: 0.5, lastUpdate: Date.now() });

    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    await chat['_moodProactiveTick']();
    vi.restoreAllMocks();

    expect(sentMessages.length).toBe(0);
  });
});

// ── Silence-breaker ───────────────────────────────────────────────────────────

describe('ChatModule — silence-breaker proactive', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  function makeChat(opts: Record<string, unknown> = {}): ChatModule {
    return new ChatModule(
      { complete: vi.fn() } as unknown as IClaudeClient,
      db,
      {
        botUserId: 'bot-123',
        debounceMs: 0,
        chatMinScore: -999,
        moodProactiveEnabled: false,
        moodProactiveMaxPerGroupMs: 1_800_000,  // 30 min shared cooldown
        silenceBreakerMinAgeMs: 180_000,         // 3 min
        silenceBreakerMaxAgeMs: 600_000,         // 10 min
        silenceBreakerCooldownMs: 1_800_000,     // 30 min own cooldown
        ...opts,
      },
    );
  }

  const nowSec = () => Math.floor(Date.now() / 1000);

  function insertMsg(groupId: string, userId: string, secondsAgo: number) {
    db.messages.insert({
      groupId, userId, nickname: userId, content: 'hi',
      timestamp: nowSec() - secondsAgo, deleted: false,
    });
  }

  // 1. Bot sends msg → 3 min later nobody replies → fires
  it('bot msg 3 min ago with no reply → silence breaker fires', async () => {
    const sent: string[] = [];
    const chat = makeChat();
    chat.setProactiveAdapter(async (_g, text) => { sent.push(text); return 42; });
    chat['knownGroups'].add('g1');

    // Only message in group is bot's, 3 min ago
    insertMsg('g1', 'bot-123', 3 * 60);

    await chat['_moodProactiveTick']();
    expect(sent.length).toBe(1);
    expect(SILENCE_BREAKER_POOL).toContain(sent[0]);
  });

  // 2. Bot sends msg → only 2 min ago → not yet 3-min threshold → no trigger
  it('bot msg only 2 min ago → below min threshold → no trigger', async () => {
    const sent: string[] = [];
    const chat = makeChat();
    chat.setProactiveAdapter(async (_g, text) => { sent.push(text); return 42; });
    chat['knownGroups'].add('g1');

    insertMsg('g1', 'bot-123', 2 * 60);

    await chat['_moodProactiveTick']();
    expect(sent.length).toBe(0);
  });

  // 3. Bot sends msg → user replies 1 min later → user is last msg → no trigger
  it('user replied after bot → last msg is not bot → no trigger', async () => {
    const sent: string[] = [];
    const chat = makeChat();
    chat.setProactiveAdapter(async (_g, text) => { sent.push(text); return 42; });
    chat['knownGroups'].add('g1');

    // Bot posted 5 min ago, user replied 4 min ago
    insertMsg('g1', 'bot-123', 5 * 60);
    insertMsg('g1', 'u1', 4 * 60);

    await chat['_moodProactiveTick']();
    expect(sent.length).toBe(0);
  });

  // 4. Bot sends msg → 11 min later → too stale → no trigger
  it('bot msg 11 min ago → above max threshold → no trigger', async () => {
    const sent: string[] = [];
    const chat = makeChat();
    chat.setProactiveAdapter(async (_g, text) => { sent.push(text); return 42; });
    chat['knownGroups'].add('g1');

    insertMsg('g1', 'bot-123', 11 * 60);

    await chat['_moodProactiveTick']();
    expect(sent.length).toBe(0);
  });

  // 5. Silence breaker fired → own cooldown blocks next trigger 10 min later
  it('after silence breaker fires → own cooldown blocks next tick', async () => {
    const sent: string[] = [];
    const chat = makeChat();
    chat.setProactiveAdapter(async (_g, text) => { sent.push(text); return 42; });
    chat['knownGroups'].add('g1');

    insertMsg('g1', 'bot-123', 3 * 60);

    await chat['_moodProactiveTick']();
    expect(sent.length).toBe(1);

    // Simulate bot posting again (new msg 3 min ago) — but own cooldown is active
    await chat['_moodProactiveTick']();
    expect(sent.length).toBe(1); // still 1, cooldown blocked
  });

  // 6. Multiple groups independent — only group where bot went unanswered fires
  it('multiple groups: only the unanswered bot fires', async () => {
    const sent: Array<{ groupId: string; text: string }> = [];
    const chat = makeChat();
    chat.setProactiveAdapter(async (groupId, text) => { sent.push({ groupId, text }); return 42; });
    chat['knownGroups'].add('g1');
    chat['knownGroups'].add('g2');

    // g1: bot posted 3 min ago, unanswered
    insertMsg('g1', 'bot-123', 3 * 60);
    // g2: last message was a user (not bot) → no trigger
    insertMsg('g2', 'u1', 3 * 60);

    await chat['_moodProactiveTick']();
    expect(sent.length).toBe(1);
    expect(sent[0]!.groupId).toBe('g1');
  });
});
