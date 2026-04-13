import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from '../src/core/router.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { MimicModule } from '../src/modules/mimic.js';
import { ModeratorModule } from '../src/modules/moderator.js';
import { Database } from '../src/storage/db.js';
import type { GroupMessage, INapCatAdapter } from '../src/adapter/napcat.js';
import type { IClaudeClient } from '../src/ai/claude.js';
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

  it('non-command message is persisted without sending reply when no chat module attached', async () => {
    // Router created without setChat() — no chat module, so no reply should be sent
    const isolatedRouter = new Router(db, adapter, rl);
    const sendSpy = vi.spyOn(adapter, 'send');
    await isolatedRouter.dispatch(makeMsg({ content: 'just chatting' }));
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('moderator runs before persist — violation message is not saved to messages table', async () => {
    // Wire a moderator that returns violation=true, severity=2
    const violationText = JSON.stringify({ violation: true, severity: 2, reason: 'spam', confidence: 0.9 });
    const mockClaude: IClaudeClient = {
      complete: vi.fn().mockResolvedValue({ text: violationText, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    };
    const mod = new ModeratorModule(mockClaude, adapter, db.messages, db.moderation, db.groupConfig, db.rules);
    router.setModerator(mod);
    await router.dispatch(makeMsg({ content: 'bad content here', messageId: 'bad-msg' }));
    // Message should NOT be in messages table (moderation stopped pipeline)
    const stored = db.messages.getRecent('g1', 10);
    expect(stored.every(m => m.content !== 'bad content here')).toBe(true);
  });
});

describe('Router — mimic commands', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let rl: RateLimiter;
  let router: Router;
  let mimic: MimicModule;
  let mockClaude: IClaudeClient;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = makeMockAdapter();
    rl = new RateLimiter();
    router = new Router(db, adapter, rl);
    mockClaude = {
      complete: vi.fn().mockResolvedValue({
        text: '随便说一句', inputTokens: 10, outputTokens: 5,
        cacheReadTokens: 0, cacheWriteTokens: 0,
      }),
    };
    mimic = new MimicModule(mockClaude, db.messages, db.groupConfig, 'bot-self');
    router.setMimic(mimic);
  });

  it('/mimic without @user replies with usage hint', async () => {
    await router.dispatch(makeMsg({ content: '/mimic' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('用法'));
  });

  it('/mimic @unknown replies with E002 message', async () => {
    await router.dispatch(makeMsg({ content: '/mimic @nobody' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('没有历史消息记录'));
  });

  it('/mimic @user with history replies with [模仿] text', async () => {
    // Insert some messages for 'u-target'
    for (let i = 0; i < 5; i++) {
      db.messages.insert({ groupId: 'g1', userId: 'u-target', nickname: 'Target',
        content: `msg${i}`, timestamp: Math.floor(Date.now() / 1000) - i, deleted: false });
    }
    await router.dispatch(makeMsg({ content: '/mimic @u-target' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('[模仿'));
  });

  it('/mimic_on without @user replies with usage hint', async () => {
    await router.dispatch(makeMsg({ content: '/mimic_on' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('用法'));
  });

  it('/mimic_on @unknown with no history replies with E002 message', async () => {
    await router.dispatch(makeMsg({ content: '/mimic_on @nobody' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('没有历史消息记录'));
  });

  it('/mimic_on @user with history activates mimic mode', async () => {
    db.messages.insert({ groupId: 'g1', userId: 'u-target', nickname: 'Target',
      content: 'hi', timestamp: Math.floor(Date.now() / 1000), deleted: false });
    await router.dispatch(makeMsg({ content: '/mimic_on @u-target' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('模仿模式已开启'));
  });

  it('/mimic_off when no active session replies idempotently', async () => {
    await router.dispatch(makeMsg({ content: '/mimic_off' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('没有开启模仿模式'));
  });

  it('/mimic_off after /mimic_on closes the session', async () => {
    db.messages.insert({ groupId: 'g1', userId: 'u-target', nickname: 'Target',
      content: 'hi', timestamp: Math.floor(Date.now() / 1000), deleted: false });
    await router.dispatch(makeMsg({ content: '/mimic_on @u-target' }));
    vi.mocked(adapter.send).mockClear();
    await router.dispatch(makeMsg({ content: '/mimic_off' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('模仿模式已关闭'));
  });

  it('non-command message triggers mimic when session is active', async () => {
    for (let i = 0; i < 10; i++) {
      db.messages.insert({ groupId: 'g1', userId: 'u-target', nickname: 'Target',
        content: `msg${i}`, timestamp: Math.floor(Date.now() / 1000) - i, deleted: false });
    }
    await router.dispatch(makeMsg({ content: '/mimic_on @u-target' }));
    vi.mocked(adapter.send).mockClear();
    await router.dispatch(makeMsg({ content: 'just a regular chat message', userId: 'u-other' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('[模仿'));
  });
});

describe('Router — moderator commands (appeal, rule_add, rule_false_positive)', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let rl: RateLimiter;
  let router: Router;
  let mockClaude: IClaudeClient;
  let mod: ModeratorModule;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = makeMockAdapter();
    rl = new RateLimiter();
    router = new Router(db, adapter, rl);
    mockClaude = { complete: vi.fn().mockResolvedValue({ text: JSON.stringify({ violation: false, severity: null, reason: '', confidence: 0 }), inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }) };
    mod = new ModeratorModule(mockClaude, adapter, db.messages, db.moderation, db.groupConfig, db.rules);
    router.setModerator(mod);
  });

  it('/appeal with no punishment record replies with not-found message', async () => {
    await router.dispatch(makeMsg({ content: '/appeal' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('未找到'));
  });

  it('/rule_add by non-admin replies with permission denied', async () => {
    await router.dispatch(makeMsg({ content: '/rule_add no spam', role: 'member' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('没有权限'));
  });

  it('/rule_add by admin inserts rule and confirms', async () => {
    await router.dispatch(makeMsg({ content: '/rule_add no spam allowed', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('规则已添加'));
  });

  it('/rule_add with empty content replies with error', async () => {
    await router.dispatch(makeMsg({ content: '/rule_add', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('不能为空'));
  });

  it('/rule_false_positive by non-admin replies with permission denied', async () => {
    await router.dispatch(makeMsg({ content: '/rule_false_positive msg-123', role: 'member' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('没有权限'));
  });

  it('/rule_false_positive with unknown msgId replies with not-found', async () => {
    await router.dispatch(makeMsg({ content: '/rule_false_positive no-such-msg', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('未找到'));
  });

  it('/rule_false_positive without msgId replies with usage hint', async () => {
    await router.dispatch(makeMsg({ content: '/rule_false_positive', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('用法'));
  });

  it('/rule_false_positive with known msgId marks as FP and confirms', async () => {
    // Insert a moderation record so findByMsgId returns it
    db.moderation.insert({ msgId: 'msg-known', groupId: 'g1', userId: 'u1', violation: true,
      severity: 2, action: 'warn', reason: 'test', appealed: 0, reversed: false,
      timestamp: Math.floor(Date.now() / 1000) });
    await router.dispatch(makeMsg({ content: '/rule_false_positive msg-known', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('已标记为误判'));
  });

  it('/appeal with kick record returns wasKick message', async () => {
    // Insert a kick record within window
    db.moderation.insert({ msgId: 'msg-kick', groupId: 'g1', userId: 'u1', violation: true,
      severity: 5, action: 'kick', reason: 'test', appealed: 0, reversed: false,
      timestamp: Math.floor(Date.now() / 1000) - 3600 });
    await router.dispatch(makeMsg({ content: '/appeal' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('申诉已批准'));
  });
});
