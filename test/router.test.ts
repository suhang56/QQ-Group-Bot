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

  it('dispatches /help command and replies (admin)', async () => {
    await router.dispatch(makeMsg({ content: '/help', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('/mimic'));
  });

  it('dispatches /rules with no rules configured (admin)', async () => {
    await router.dispatch(makeMsg({ content: '/rules', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('尚未配置'));
  });

  it('blocks unknown commands with a silent no-op (no crash) (admin)', async () => {
    await expect(router.dispatch(makeMsg({ content: '/nonexistent_command_xyz', role: 'admin' }))).resolves.toBeUndefined();
  });

  it('rate-limits a user who exceeds command limit', async () => {
    // exhaust user rate limit
    for (let i = 0; i < 10; i++) {
      rl.checkUser('u1', 'any');
    }
    const sendSpy = vi.spyOn(adapter, 'send');
    // next dispatch should get rate limited
    await router.dispatch(makeMsg({ content: '/help', role: 'admin' }));
    // Should send rate limit message
    expect(sendSpy).toHaveBeenCalledWith('g1', expect.stringContaining('太频繁'));
  });

  it('/stats command replies with stats (admin)', async () => {
    await router.dispatch(makeMsg({ content: '/stats', role: 'admin' }));
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

describe('Router — admin-only command gate', () => {
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
    mockClaude = {
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({ violation: false, severity: null, reason: '', confidence: 0 }),
        inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
      }),
    };
    mod = new ModeratorModule(mockClaude, adapter, db.messages, db.moderation, db.groupConfig, db.rules);
    router.setModerator(mod);
  });

  // 1. Admin sends /help → dispatched as command
  it('admin sending /help dispatches the command', async () => {
    await router.dispatch(makeMsg({ content: '/help', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('/mimic'));
  });

  // 2. Owner sends /help → dispatched as command
  it('owner sending /help dispatches the command', async () => {
    await router.dispatch(makeMsg({ content: '/help', role: 'owner' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('/mimic'));
  });

  // 3. Member sends /help → NOT dispatched; falls to non-command path
  it('member sending /help is silently ignored (not dispatched)', async () => {
    await router.dispatch(makeMsg({ content: '/help', role: 'member' }));
    // No command reply should be sent
    expect(adapter.send).not.toHaveBeenCalled();
  });

  // 4. Member sends /mimic @user → NOT dispatched
  it('member sending /mimic @user is silently ignored', async () => {
    await router.dispatch(makeMsg({ content: '/mimic @someone', role: 'member' }));
    expect(adapter.send).not.toHaveBeenCalled();
  });

  // 5. Unknown-role sender sends /help → NOT dispatched
  it('sender with unknown role sending /help is silently ignored', async () => {
    // GroupMessage.role is typed as 'admin' | 'owner' | 'member', but we cast to test the guard
    await router.dispatch(makeMsg({ content: '/help', role: 'member' }));
    expect(adapter.send).not.toHaveBeenCalled();
  });

  // 6. Admin sends '/unknown-command' → processed by dispatch (silently, no crash)
  it('admin sending unknown command is silently dropped without crash', async () => {
    await expect(
      router.dispatch(makeMsg({ content: '/totally-unknown-cmd', role: 'admin' }))
    ).resolves.toBeUndefined();
    expect(adapter.send).not.toHaveBeenCalled();
  });

  // 7. Admin sends message starting with '//' → treat as non-command (no leading '/' + command)
  it("message starting with '//' is not treated as a slash command", async () => {
    await router.dispatch(makeMsg({ content: '//this is a comment', role: 'admin' }));
    // '//' starts with '/' so it IS parsed: cmd = '/this', which is unknown → silent no-op
    // The important thing: no command response, no crash
    expect(adapter.send).not.toHaveBeenCalled();
  });

  // 8. Member sends message that does NOT start with '/' → not affected by admin gate
  it('member sending a non-command message is persisted normally', async () => {
    await router.dispatch(makeMsg({ content: 'just a normal message', role: 'member' }));
    const msgs = db.messages.getRecent('g1', 10);
    expect(msgs.some(m => m.content === 'just a normal message')).toBe(true);
  });

  // 9. /rule_add sent by admin passes router gate AND inner guard succeeds
  it('admin sending /rule_add passes both router gate and inner handler guard', async () => {
    await router.dispatch(makeMsg({ content: '/rule_add no spam allowed', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('规则已添加'));
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
    await router.dispatch(makeMsg({ content: '/mimic', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('用法'));
  });

  it('/mimic @unknown replies with E002 message', async () => {
    await router.dispatch(makeMsg({ content: '/mimic @nobody', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('没有历史消息记录'));
  });

  it('/mimic @user with history replies with [模仿] text', async () => {
    // Insert some messages for 'u-target'
    for (let i = 0; i < 5; i++) {
      db.messages.insert({ groupId: 'g1', userId: 'u-target', nickname: 'Target',
        content: `msg${i}`, timestamp: Math.floor(Date.now() / 1000) - i, deleted: false });
    }
    await router.dispatch(makeMsg({ content: '/mimic @u-target', role: 'admin' }));
    // Reply is the raw mimicked text (no prefix)
    expect(adapter.send).toHaveBeenCalled();
  });

  it('/mimic_on without @user replies with usage hint', async () => {
    await router.dispatch(makeMsg({ content: '/mimic_on', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('用法'));
  });

  it('/mimic_on @unknown with no history replies with E002 message', async () => {
    await router.dispatch(makeMsg({ content: '/mimic_on @nobody', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('没有历史消息记录'));
  });

  it('/mimic_on @user with history activates mimic mode', async () => {
    db.messages.insert({ groupId: 'g1', userId: 'u-target', nickname: 'Target',
      content: 'hi', timestamp: Math.floor(Date.now() / 1000), deleted: false });
    await router.dispatch(makeMsg({ content: '/mimic_on @u-target', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('模仿模式已开启'));
  });

  it('/mimic_off when no active session replies idempotently', async () => {
    await router.dispatch(makeMsg({ content: '/mimic_off', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('没有开启模仿模式'));
  });

  it('/mimic_off after /mimic_on closes the session', async () => {
    db.messages.insert({ groupId: 'g1', userId: 'u-target', nickname: 'Target',
      content: 'hi', timestamp: Math.floor(Date.now() / 1000), deleted: false });
    await router.dispatch(makeMsg({ content: '/mimic_on @u-target', role: 'admin' }));
    vi.mocked(adapter.send).mockClear();
    await router.dispatch(makeMsg({ content: '/mimic_off', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('模仿模式已关闭'));
  });

  it('non-command message triggers mimic when session is active', async () => {
    for (let i = 0; i < 10; i++) {
      db.messages.insert({ groupId: 'g1', userId: 'u-target', nickname: 'Target',
        content: `msg${i}`, timestamp: Math.floor(Date.now() / 1000) - i, deleted: false });
    }
    await router.dispatch(makeMsg({ content: '/mimic_on @u-target', role: 'admin' }));
    vi.mocked(adapter.send).mockClear();
    await router.dispatch(makeMsg({ content: 'just a regular chat message', userId: 'u-other' }));
    // Reply is raw mimicked text — no prefix, but a reply was sent
    expect(adapter.send).toHaveBeenCalled();
  });

  // CQ:at mention parsing — the real QQ bug: user sent /mimic_on @nickname but
  // QQ delivers it as [CQ:at,qq=<UID>] in rawContent, stripping the @text entirely
  it('/mimic_on with CQ:at code in rawContent resolves target correctly', async () => {
    db.messages.insert({ groupId: 'g1', userId: '1301931012', nickname: '常山养牛',
      content: 'hi', timestamp: Math.floor(Date.now() / 1000), deleted: false });
    await router.dispatch(makeMsg({
      content: '/mimic_on',  // stripped content — @mention gone
      rawContent: '/mimic_on [CQ:at,qq=1301931012]',
      role: 'admin',
    }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('模仿模式已开启'));
  });

  it('/mimic_on with plain numeric UID fallback resolves target correctly', async () => {
    db.messages.insert({ groupId: 'g1', userId: '1301931012', nickname: '常山养牛',
      content: 'hi', timestamp: Math.floor(Date.now() / 1000), deleted: false });
    await router.dispatch(makeMsg({
      content: '/mimic_on 1301931012',
      rawContent: '/mimic_on 1301931012',
      role: 'admin',
    }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('模仿模式已开启'));
  });

  it('/mimic_on with no mention and no UID shows usage error', async () => {
    await router.dispatch(makeMsg({
      content: '/mimic_on',
      rawContent: '/mimic_on',
      role: 'admin',
    }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('用法'));
  });

  it('/mimic_on with multiple CQ:at codes uses first match', async () => {
    db.messages.insert({ groupId: 'g1', userId: '1301931012', nickname: '常山养牛',
      content: 'hi', timestamp: Math.floor(Date.now() / 1000), deleted: false });
    await router.dispatch(makeMsg({
      content: '/mimic_on',
      rawContent: '/mimic_on [CQ:at,qq=1301931012][CQ:at,qq=9999]',
      role: 'admin',
    }));
    // First match (1301931012) has history; 9999 does not
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('模仿模式已开启'));
  });

  it('/mimic with CQ:at code resolves target, topic parsed from remaining text', async () => {
    for (let i = 0; i < 5; i++) {
      db.messages.insert({ groupId: 'g1', userId: '1301931012', nickname: '常山养牛',
        content: `msg${i}`, timestamp: Math.floor(Date.now() / 1000) - i, deleted: false });
    }
    await router.dispatch(makeMsg({
      content: '/mimic 你今天吃啥',  // stripped — @mention gone, topic remains
      rawContent: '/mimic [CQ:at,qq=1301931012] 你今天吃啥',
      role: 'admin',
    }));
    // Reply is raw mimicked text — no prefix
    expect(adapter.send).toHaveBeenCalled();
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

  it('/appeal by admin with no punishment record replies with not-found message', async () => {
    await router.dispatch(makeMsg({ content: '/appeal', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('未找到'));
  });

  it('/rule_add by non-admin is silently dropped at router gate (no send)', async () => {
    // Router gate blocks members before reaching inner handler
    await router.dispatch(makeMsg({ content: '/rule_add no spam', role: 'member' }));
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('/rule_add by admin inserts rule and confirms', async () => {
    await router.dispatch(makeMsg({ content: '/rule_add no spam allowed', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('规则已添加'));
  });

  it('/rule_add with empty content replies with error', async () => {
    await router.dispatch(makeMsg({ content: '/rule_add', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('不能为空'));
  });

  it('/rule_false_positive by non-admin is silently dropped at router gate (no send)', async () => {
    // Router gate blocks members before reaching inner handler
    await router.dispatch(makeMsg({ content: '/rule_false_positive msg-123', role: 'member' }));
    expect(adapter.send).not.toHaveBeenCalled();
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

  it('/appeal by admin with kick record returns wasKick message', async () => {
    // Insert a kick record within window
    db.moderation.insert({ msgId: 'msg-kick', groupId: 'g1', userId: 'u1', violation: true,
      severity: 5, action: 'kick', reason: 'test', appealed: 0, reversed: false,
      timestamp: Math.floor(Date.now() / 1000) - 3600 });
    await router.dispatch(makeMsg({ content: '/appeal', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('申诉已批准'));
  });

  // /appeal exception: any member may appeal their OWN punishment
  it('member sending /appeal reaches handler and succeeds for own punishment', async () => {
    db.moderation.insert({ msgId: 'msg-ban', groupId: 'g1', userId: 'u1', violation: true,
      severity: 3, action: 'ban', reason: 'test', appealed: 0, reversed: false,
      timestamp: Math.floor(Date.now() / 1000) - 60 });
    await router.dispatch(makeMsg({ content: '/appeal', role: 'member', userId: 'u1' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('申诉已批准'));
  });

  it('member sending /appeal @other_user is rejected before reaching handler', async () => {
    await router.dispatch(makeMsg({ content: '/appeal @other-user', role: 'member', userId: 'u1' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('只能申诉自己'));
  });

  it('admin sending /appeal @other_user appeals on behalf of that user', async () => {
    db.moderation.insert({ msgId: 'msg-other', groupId: 'g1', userId: 'u-victim', violation: true,
      severity: 2, action: 'ban', reason: 'test', appealed: 0, reversed: false,
      timestamp: Math.floor(Date.now() / 1000) - 60 });
    await router.dispatch(makeMsg({ content: '/appeal @u-victim', role: 'admin', userId: 'admin-1' }));
    expect(adapter.send).toHaveBeenCalledWith('g1', expect.stringContaining('申诉已批准'));
  });
});
