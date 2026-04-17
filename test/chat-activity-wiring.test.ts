import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
import { defaultGroupConfig } from '../src/config.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { Database } from '../src/storage/db.js';
import { GroupActivityTracker } from '../src/modules/group-activity-tracker.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-act';
const GROUP_ID = 'g-act';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1', groupId: GROUP_ID, userId: 'u-peer',
    nickname: 'Alice', role: 'member',
    content: '随便聊聊', rawContent: '随便聊聊',
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
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 0,
    chatMinScore: -999,
    chatSilenceBonusSec: 999999,
    moodProactiveEnabled: false,
    deflectCacheEnabled: false,
  });
}

function getTracker(chat: ChatModule): GroupActivityTracker {
  return (chat as unknown as { activityTracker: GroupActivityTracker }).activityTracker;
}

describe('ChatModule — M7.2 activity tracker wiring', () => {
  let db: Database;
  let claude: ReturnType<typeof makeMockClaude>;
  let chat: ChatModule;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T12:00:00Z'));
    db = new Database(':memory:');
    claude = makeMockClaude();
    chat = makeChat(db, claude);
    db.groupConfig.upsert(defaultGroupConfig(GROUP_ID));
  });

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('peer messages pump the tracker → level flips to busy after burst', async () => {
    const tracker = getTracker(chat);
    const startSec = Math.floor(Date.now() / 1000);
    // 10 peer msgs, spread over 30 seconds of wall time
    for (let i = 0; i < 10; i++) {
      await chat.generateReply(
        GROUP_ID,
        makeMsg({ messageId: `p${i}`, content: `聊${i}`, timestamp: startSec + i * 3 }),
        [],
      );
      vi.advanceTimersByTime(3_000);
    }
    // Tracker should now flag the group as busy at the current wall time
    expect(tracker.level(GROUP_ID, Date.now())).toBe('busy');
  });

  it('bot-authored messages do NOT bump the tracker', async () => {
    const tracker = getTracker(chat);
    const startSec = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 10; i++) {
      await chat.generateReply(
        GROUP_ID,
        makeMsg({
          messageId: `b${i}`,
          userId: BOT_ID, // bot-authored
          content: `自言${i}`,
          timestamp: startSec + i * 3,
        }),
        [],
      );
    }
    // Nothing recorded → tracker has no history for this group → defaults to 'normal'
    expect(tracker.countIn(GROUP_ID, 60_000, Date.now())).toBe(0);
    expect(tracker.level(GROUP_ID, Date.now())).toBe('normal');
  });

  it('peer timestamp is recorded in milliseconds (OneBot seconds * 1000)', async () => {
    const tracker = getTracker(chat);
    const tsSec = Math.floor(Date.now() / 1000) - 30; // 30s ago
    await chat.generateReply(
      GROUP_ID,
      makeMsg({ messageId: 'p-unit', content: '你好', timestamp: tsSec }),
      [],
    );
    // 30s-old record should be inside the 60s window
    expect(tracker.countIn(GROUP_ID, 60_000, Date.now())).toBe(1);
    // ...but OUTSIDE a 10s window (confirming it's not being treated as a raw second value)
    expect(tracker.countIn(GROUP_ID, 10_000, Date.now())).toBe(0);
  });
});
