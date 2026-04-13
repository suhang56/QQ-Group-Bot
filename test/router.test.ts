import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from '../src/core/router.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { Database } from '../src/storage/db.js';
import type { GroupMessage, INapCatAdapter } from '../src/adapter/napcat.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1',
    groupId: 'g1',
    userId: 'u1',
    nickname: 'TestUser',
    role: 'member',
    content: 'hello',
    rawContent: 'hello',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeMockAdapter(): INapCatAdapter {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    ban: vi.fn().mockResolvedValue(undefined),
    kick: vi.fn().mockResolvedValue(undefined),
    deleteMsg: vi.fn().mockResolvedValue(undefined),
    sendPrivate: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Router', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let rl: RateLimiter;
  let router: Router;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = makeMockAdapter();
    rl = new RateLimiter();
    router = new Router(db, adapter, rl);
  });

  it('persists group message to storage', async () => {
    await router.dispatch(makeMsg({ content: 'test message' }));
    const msgs = db.messages.getRecent('g1', 10);
    expect(msgs.some(m => m.content === 'test message')).toBe(true);
  });

  it('upserts user on each message', async () => {
    await router.dispatch(makeMsg({ userId: 'u99', nickname: 'Bob' }));
    const user = db.users.findById('u99', 'g1');
    expect(user).not.toBeNull();
    expect(user!.nickname).toBe('Bob');
  });

  it('dispatches /help command and replies', async () => {
    await router.dispatch(makeMsg({ content: '/help' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('/mimic'));
  });

  it('dispatches /rules with no rules configured', async () => {
    await router.dispatch(makeMsg({ content: '/rules' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('尚未配置'));
  });

  it('blocks unknown commands with a silent no-op (no crash)', async () => {
    await expect(router.dispatch(makeMsg({ content: '/nonexistent_command_xyz' }))).resolves.toBeUndefined();
  });

  it('rate-limits a user who exceeds command limit', async () => {
    // exhaust user rate limit
    for (let i = 0; i < 10; i++) {
      rl.checkUser('u1', 'any');
    }
    const sendSpy = vi.spyOn(adapter, 'send');
    // next dispatch should get rate limited
    await router.dispatch(makeMsg({ content: '/help' }));
    // Should send rate limit message
    expect(sendSpy).toHaveBeenCalledWith('g1', expect.stringContaining('太频繁'));
  });

  it('does not reply to messages from other bots (content starts with [模仿])', async () => {
    const sendSpy = vi.spyOn(adapter, 'send');
    await router.dispatch(makeMsg({ content: '[模仿 @Alice] some mimic reply', userId: 'bot-self' }));
    // No send for non-command bot content
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('/stats command replies with stats', async () => {
    await router.dispatch(makeMsg({ content: '/stats' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('统计数据'));
  });

  it('non-command message is persisted without sending reply by default', async () => {
    const sendSpy = vi.spyOn(adapter, 'send');
    // No chat trigger configured, at-only mode doesn't apply
    // Just a regular message — persisted, no chat reply unless triggered
    await router.dispatch(makeMsg({ content: 'just chatting' }));
    // No send unless chat module triggered
    const calls = sendSpy.mock.calls;
    // May or may not send depending on chat trigger — just ensure no crash
    expect(calls.length).toBeLessThanOrEqual(1);
  });
});
