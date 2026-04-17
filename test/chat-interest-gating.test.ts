import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
import { defaultGroupConfig } from '../src/config.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { Database } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-interest-gating';
const GROUP_ID = 'g-interest';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1', groupId: GROUP_ID, userId: 'u1',
    nickname: 'Peer', role: 'member',
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

function makeChat(db: Database, claude: IClaudeClient, overrides: Record<string, unknown> = {}): ChatModule {
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 0,
    chatMinScore: 0.5,
    chatSilenceBonusSec: 999999, // suppress silence bonus
    chatBurstCount: 99,
    moodProactiveEnabled: false,
    deflectCacheEnabled: false,
    ...overrides,
  });
}

describe('defaultGroupConfig — interest category seeds', () => {
  it('has three default interest categories', () => {
    const cfg = defaultGroupConfig('g');
    const names = cfg.chatInterestCategories.map(c => c.name);
    expect(names).toEqual(expect.arrayContaining(['daily-share', 'bandori', 'anime']));
  });

  it('default min hits is 1', () => {
    expect(defaultGroupConfig('g').chatInterestMinHits).toBe(1);
  });

  it('each category has a valid regex and non-zero weight', () => {
    for (const cat of defaultGroupConfig('g').chatInterestCategories) {
      expect(cat.weight).toBeGreaterThan(0);
      expect(() => new RegExp(cat.pattern, 'iu')).not.toThrow();
    }
  });
});

describe('GroupConfigRepository — interest-category round trip', () => {
  it('round-trips populated interest categories via upsert + get', () => {
    const db = new Database(':memory:');
    const cfg = defaultGroupConfig(GROUP_ID);
    db.groupConfig.upsert(cfg);
    const out = db.groupConfig.get(GROUP_ID);
    expect(out).not.toBeNull();
    expect(out!.chatInterestCategories).toHaveLength(3);
    expect(out!.chatInterestCategories[0]!.name).toBe('daily-share');
    expect(out!.chatInterestMinHits).toBe(1);
  });
});

describe('ChatModule — interest-gating scoring', () => {
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

  it('_matchesBotInterest returns bandori weight for BanG Dream content', () => {
    const w = chat._matchesBotInterest(GROUP_ID, '今天 MyGO 新活动开了');
    expect(w).toBeCloseTo(0.85, 10);
  });

  it('_matchesBotInterest returns daily-share weight for first-person share', () => {
    const w = chat._matchesBotInterest(GROUP_ID, '我今天去秋叶原了');
    expect(w).toBeCloseTo(0.8, 10);
  });

  it('_matchesBotInterest returns anime weight for anime-meme content', () => {
    const w = chat._matchesBotInterest(GROUP_ID, '这个番真的绝了');
    expect(w).toBeCloseTo(0.75, 10);
  });

  it('_matchesBotInterest returns max category weight when multiple match', () => {
    // 我今天 (daily-share 0.8) + MyGO (bandori 0.85)
    const w = chat._matchesBotInterest(GROUP_ID, '我今天听了 MyGO');
    expect(w).toBeCloseTo(0.85, 10);
  });

  it('_matchesBotInterest returns 0 for content with no hits', () => {
    const w = chat._matchesBotInterest(GROUP_ID, '初中那几个');
    expect(w).toBe(0);
  });

  it('_matchesBotInterest returns 0 when config has no categories', () => {
    const emptyCfg = { ...defaultGroupConfig('g-empty'), chatInterestCategories: [] };
    db.groupConfig.upsert(emptyCfg);
    expect(chat._matchesBotInterest('g-empty', 'MyGO 新活动')).toBe(0);
  });

  // ── Screenshot replay: all four failure messages should skip ──────────
  describe('screenshot replay — four failure cases should not engage', () => {
    it('case 1: "别想了" out-of-nowhere — no interest match → skip', async () => {
      const result = await chat.generateReply(GROUP_ID, makeMsg({ content: '别想了' }), []);
      expect(result).toBeNull();
    });

    it('case 2 literal: "西瓜没看过她画的本子吗" (screenshot bug) → bot stays silent', async () => {
      // Original user-reported bug. Before the TASK_REQUEST narrow, bare "画"
      // was matching as a labor-request and the bot replied with a sassy
      // "我又不是工具人" — pure assistant-leaning failure. A groupmate hearing
      // this just scrolls past. Now: TASK_REQUEST doesn't fire, anime
      // interest (本子, 0.75) + silence (0.2) − twoUser (−0.3) = 0.65 <
      // non-direct threshold 0.75 → skip.
      const now = Math.floor(Date.now() / 1000);
      db.messages.insert({ groupId: GROUP_ID, userId: 'u2', nickname: 'A', content: 'prev', timestamp: now - 5, deleted: false });
      db.messages.insert({ groupId: GROUP_ID, userId: 'u3', nickname: 'B', content: 'prev2', timestamp: now - 3, deleted: false });
      db.messages.insert({ groupId: GROUP_ID, userId: 'u2', nickname: 'A', content: 'prev3', timestamp: now - 1, deleted: false });
      const result = await chat.generateReply(
        GROUP_ID,
        makeMsg({ userId: 'u3', content: '西瓜没看过她画的本子吗', rawContent: '西瓜没看过她画的本子吗' }),
        [],
      );
      expect(result).toBeNull();
    });

    it('case 3 literal: "贯穿了我的整个二次元生涯了" (screenshot bug) → bot stays silent', async () => {
      // Original user-reported bug. Before the narrow, "整个" fired
      // TASK_REQUEST and the bot replied with "自己玩去" / "你恩师是谁啊" —
      // accusing the peer of demanding labor when they were just sharing
      // fandom feelings. Now: TASK_REQUEST doesn't fire on attributive "整个",
      // no interest match, no direct trigger → skip.
      const result = await chat.generateReply(GROUP_ID, makeMsg({ content: '贯穿了我的整个二次元生涯了' }), []);
      expect(result).toBeNull();
    });

    it('case 4: "初中那几个" — no interest match at all → skip', async () => {
      const result = await chat.generateReply(GROUP_ID, makeMsg({ content: '初中那几个' }), []);
      expect(result).toBeNull();
    });
  });

  describe('positive case — daily-share + bandori engages', () => {
    it('"我今天去秋叶原买了 MyGO 专辑" → engage', async () => {
      const result = await chat.generateReply(
        GROUP_ID,
        makeMsg({ content: '我今天去秋叶原买了 MyGO 专辑', rawContent: '我今天去秋叶原买了 MyGO 专辑' }),
        [],
      );
      expect(result).toBe('bot reply');
    });
  });
});

describe('ChatModule — novelty penalty', () => {
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

  it('_computeNoveltyOverlap counts shared bigram tokens against recent bot outputs', () => {
    // Seed bot output so overlap ≥ 2 (two distinct bigrams — "新番", "专辑")
    (chat as unknown as { botRecentOutputs: Map<string, string[]> }).botRecentOutputs.set(
      GROUP_ID, ['新番专辑好听'],
    );
    // Trigger also contains "新番" bigram and "专辑" bigram
    const overlap = chat._computeNoveltyOverlap(GROUP_ID, '我也买了新番专辑');
    expect(overlap).toBeGreaterThanOrEqual(2);
  });

  it('_computeNoveltyOverlap returns 0 when no recent outputs', () => {
    expect(chat._computeNoveltyOverlap(GROUP_ID, '新番 买 了')).toBe(0);
  });

  it('_computeNoveltyOverlap returns 0 for unrelated content', () => {
    (chat as unknown as { botRecentOutputs: Map<string, string[]> }).botRecentOutputs.set(
      GROUP_ID, ['买新番了?'],
    );
    const overlap = chat._computeNoveltyOverlap(GROUP_ID, '完全不相关的内容');
    expect(overlap).toBe(0);
  });
});
