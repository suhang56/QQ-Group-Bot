import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Router } from '../src/core/router.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { PokeModule, type IPokeModule } from '../src/modules/poke.js';
import { Database } from '../src/storage/db.js';
import { defaultGroupConfig } from '../src/config.js';
import type { GroupMessage, GroupPokeNotice, INapCatAdapter } from '../src/adapter/napcat.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-42';

function makeNotice(overrides: Partial<GroupPokeNotice> = {}): GroupPokeNotice {
  return {
    groupId: 'g1',
    userId: 'u1',
    targetId: BOT_ID,
    operatorId: 'u1',
    timestamp: 1700000000,
    ...overrides,
  };
}

function makeMockAdapter(): INapCatAdapter {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    send: vi.fn().mockResolvedValue(123),
    ban: vi.fn().mockResolvedValue(undefined),
    kick: vi.fn().mockResolvedValue(undefined),
    deleteMsg: vi.fn().mockResolvedValue(undefined),
    sendPrivate: vi.fn().mockResolvedValue(undefined),
    sendPrivateMessage: vi.fn().mockResolvedValue(42),
    getGroupNotices: vi.fn().mockResolvedValue([]),
    getGroupInfo: vi.fn().mockResolvedValue({ groupId: 'g1', name: 'Test', description: '', memberCount: 1 }),
    getForwardMessages: vi.fn().mockResolvedValue([]),
    getImage: vi.fn().mockResolvedValue({ filename: '', url: '', size: 0 }),
  };
}

describe('PokeModule', () => {
  it('responds to an allowed poke', async () => {
    const adapter = makeMockAdapter();
    const mod = new PokeModule({
      adapter,
      botUserId: BOT_ID,
      replies: ['pong'],
      replyChance: 1,
      random: () => 0,
      now: () => 1000,
    });

    await mod.handle(makeNotice(), defaultGroupConfig('g1'));

    expect(adapter.send).toHaveBeenCalledWith('g1', 'pong');
  });

  it('responds by default without depending on random chance', async () => {
    const adapter = makeMockAdapter();
    const mod = new PokeModule({
      adapter,
      botUserId: BOT_ID,
      replies: ['pong'],
      random: () => 0.99,
      now: () => 1000,
    });

    await mod.handle(makeNotice(), defaultGroupConfig('g1'));

    expect(adapter.send).toHaveBeenCalledWith('g1', 'pong');
  });

  it('rate-limits repeated pokes in the same group', async () => {
    let now = 1000;
    const adapter = makeMockAdapter();
    const mod = new PokeModule({
      adapter,
      botUserId: BOT_ID,
      replies: ['pong'],
      replyChance: 1,
      random: () => 0,
      now: () => now,
      userCooldownMs: 60_000,
      groupCooldownMs: 30_000,
    });

    await mod.handle(makeNotice({ userId: 'u1' }), defaultGroupConfig('g1'));
    now += 1000;
    await mod.handle(makeNotice({ userId: 'u2' }), defaultGroupConfig('g1'));
    now += 1000;
    await mod.handle(makeNotice({ userId: 'u1' }), defaultGroupConfig('g1'));

    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  it('mutes burst pokes from the same user', async () => {
    let now = 1000;
    const adapter = makeMockAdapter();
    const mod = new PokeModule({
      adapter,
      botUserId: BOT_ID,
      replies: ['pong'],
      replyChance: 1,
      random: () => 0,
      now: () => now,
      userCooldownMs: 0,
      groupCooldownMs: 0,
      burstLimit: 1,
      burstWindowMs: 60_000,
      burstMuteMs: 300_000,
    });

    await mod.handle(makeNotice(), defaultGroupConfig('g1'));
    now += 1000;
    await mod.handle(makeNotice(), defaultGroupConfig('g1'));
    now += 1000;
    await mod.handle(makeNotice(), defaultGroupConfig('g1'));

    expect(adapter.send).toHaveBeenCalledTimes(1);
  });
});

describe('Router poke dispatch', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let router: Router;
  let poke: IPokeModule;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = makeMockAdapter();
    router = new Router(db, adapter, new RateLimiter(), BOT_ID);
    poke = { handle: vi.fn().mockResolvedValue(undefined) };
    router.setPoke(poke);
  });

  afterEach(() => {
    router.dispose();
    db.close();
  });

  it('routes bot-target pokes to PokeModule without persisting a message', async () => {
    await router.dispatchPoke(makeNotice({ targetId: BOT_ID }));

    expect(poke.handle).toHaveBeenCalledTimes(1);
    expect(db.messages.getRecent('g1', 10)).toEqual([]);
  });

  it('normalizes reversed poke notices where user_id is the bot', async () => {
    await router.dispatchPoke(makeNotice({ userId: BOT_ID, targetId: 'u1', operatorId: 'u1' }));

    expect(poke.handle).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', targetId: BOT_ID }),
      expect.anything(),
    );
  });

  it('ignores pokes aimed at other users', async () => {
    await router.dispatchPoke(makeNotice({ targetId: 'someone-else' }));

    expect(poke.handle).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('ignores malformed poke payloads', async () => {
    await router.dispatchPoke(makeNotice({ targetId: '' }));

    expect(poke.handle).not.toHaveBeenCalled();
  });

  it('keeps normal message source IDs available for moderation review context', async () => {
    const msg: GroupMessage = {
      messageId: 'msg-123',
      groupId: 'g1',
      userId: 'u1',
      nickname: 'Alice',
      role: 'member',
      content: 'hello',
      rawContent: 'hello',
      timestamp: 1700000000,
    };

    await router.dispatch(msg);

    const saved = db.messages.findBySourceId('msg-123');
    expect(saved).toMatchObject({ groupId: 'g1', userId: 'u1', content: 'hello' });
  });
});
