import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from '../src/core/router.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { Database } from '../src/storage/db.js';
import type { INapCatAdapter } from '../src/adapter/napcat.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

function makeMockAdapter(sendReturn: number | null = 111): INapCatAdapter {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    send: vi.fn().mockResolvedValue(sendReturn),
    ban: vi.fn().mockResolvedValue(undefined),
    kick: vi.fn().mockResolvedValue(undefined),
    deleteMsg: vi.fn().mockResolvedValue(undefined),
    sendPrivate: vi.fn().mockResolvedValue(undefined),
    sendPrivateMessage: vi.fn().mockResolvedValue(42),
    getGroupNotices: vi.fn().mockResolvedValue([]),
    getGroupInfo: vi.fn().mockResolvedValue({ groupId: 'g1', name: 'Test', description: '', memberCount: 1 }),
    getImage: vi.fn().mockResolvedValue({ filename: '', url: '', size: 0 }),
  } as unknown as INapCatAdapter;
}

type RouterWithPrivates = Router & {
  _sendReply: (
    groupId: string,
    text: string,
    replyToMsgId?: number,
    logCtx?: {
      module: string;
      triggerMsgId?: string;
      triggerUserId?: string;
      triggerUserNickname?: string;
      triggerContent: string;
    },
  ) => Promise<number | null>;
};

describe('Router._sendReply → messages persistence', () => {
  const BOT = '9999';
  let db: Database;
  let adapter: INapCatAdapter;
  let rl: RateLimiter;

  beforeEach(() => {
    db = new Database(':memory:');
    rl = new RateLimiter();
  });

  it('inserts one messages row per sent line with userId=botUserId and source-message dedupe', async () => {
    adapter = makeMockAdapter(555);
    const router = new Router(db, adapter, rl, BOT) as RouterWithPrivates;

    await router._sendReply('g1', 'hello world');

    const rows = db.messages.getRecent('g1', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(BOT);
    expect(rows[0]!.nickname).toBe('机器人');
    expect(rows[0]!.content).toBe('hello world');

    // Duplicate insert with same source_message_id must be absorbed by INSERT OR IGNORE.
    const dup = db.messages.insert(
      {
        groupId: 'g1', userId: BOT, nickname: '机器人',
        content: 'dup', rawContent: 'dup',
        timestamp: Math.floor(Date.now() / 1000),
        deleted: false,
      },
      '555',
    );
    expect(dup.id).toBe(0);
    expect(db.messages.getRecent('g1', 10)).toHaveLength(1);
  });

  it('inserts 3 rows with distinct msgIds for a 3-line reply', async () => {
    adapter = makeMockAdapter();
    let counter = 0;
    (adapter.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      counter += 1;
      return 1000 + counter;
    });
    const router = new Router(db, adapter, rl, BOT) as RouterWithPrivates;

    await router._sendReply('g1', 'line1\nline2\nline3');

    const rows = db.messages.getRecent('g1', 10);
    expect(rows).toHaveLength(3);
    const contents = rows.map(r => r.content).sort();
    expect(contents).toEqual(['line1', 'line2', 'line3']);
    expect(new Set(rows.map(r => r.id)).size).toBe(3);
  });

  it('still writes bot_replies row when logCtx is provided (both tables written)', async () => {
    adapter = makeMockAdapter(777);
    const router = new Router(db, adapter, rl, BOT) as RouterWithPrivates;

    const id = await router._sendReply('g1', 'hi', undefined, {
      module: 'chat',
      triggerUserId: 'u2',
      triggerContent: 'hello',
    });

    expect(id).not.toBeNull();
    expect(db.messages.getRecent('g1', 10)).toHaveLength(1);
    expect(db.botReplies.getRecent('g1', 10)).toHaveLength(1);
  });

  it('does NOT insert when adapter.send returns null (send failure)', async () => {
    adapter = makeMockAdapter(null);
    const router = new Router(db, adapter, rl, BOT) as RouterWithPrivates;

    await router._sendReply('g1', 'this never sends');

    expect(db.messages.getRecent('g1', 10)).toHaveLength(0);
  });

  it('does NOT insert when botUserId is empty/undefined (no crash, send still called)', async () => {
    adapter = makeMockAdapter(111);
    const router = new Router(db, adapter, rl) as RouterWithPrivates;

    await router._sendReply('g1', 'headless send');

    expect(db.messages.getRecent('g1', 10)).toHaveLength(0);
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  it('setBotNickname overrides default; empty/whitespace is rejected', async () => {
    adapter = makeMockAdapter();
    let n = 0;
    (adapter.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      n += 1;
      return 2000 + n;
    });
    const router = new Router(db, adapter, rl, BOT) as RouterWithPrivates;

    router.setBotNickname('小机');
    await router._sendReply('g1', 'one');
    router.setBotNickname('   ');
    await router._sendReply('g1', 'two');
    router.setBotNickname('');
    await router._sendReply('g1', 'three');

    const rows = db.messages.getRecent('g1', 10).sort((a, b) => a.id - b.id);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.nickname).toBe('小机');
  });
});
