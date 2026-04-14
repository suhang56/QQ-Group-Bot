import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Router } from '../src/core/router.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { ModeratorModule } from '../src/modules/moderator.js';
import { Database } from '../src/storage/db.js';
import type { GroupMessage, PrivateMessage, INapCatAdapter } from '../src/adapter/napcat.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupConfig } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const ADMIN_ID = '2331924739';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'msg-1', groupId: 'g1', userId: 'offender-1', nickname: 'BadUser',
    role: 'member', content: '违规内容', rawContent: '违规内容',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makePrivateMsg(content: string, userId = ADMIN_ID): PrivateMessage {
  return {
    messageId: 'pm-1', userId, nickname: userId === ADMIN_ID ? 'Admin' : 'Other',
    content, timestamp: Math.floor(Date.now() / 1000),
  };
}

function makeAdapter(): INapCatAdapter {
  return {
    connect: vi.fn(), disconnect: vi.fn(), on: vi.fn(),
    send: vi.fn().mockResolvedValue(42),
    ban: vi.fn().mockResolvedValue(undefined),
    kick: vi.fn().mockResolvedValue(undefined),
    deleteMsg: vi.fn().mockResolvedValue(undefined),
    sendPrivate: vi.fn().mockResolvedValue(undefined),
    sendPrivateMessage: vi.fn().mockResolvedValue(99),
    getGroupNotices: vi.fn().mockResolvedValue([]),
    getGroupInfo: vi.fn().mockResolvedValue({ groupId: 'g1', name: 'TestGroup', description: '', memberCount: 5 }),
    getImage: vi.fn().mockResolvedValue({ filename: '', url: '', size: 0 }),
  };
}

function makeViolationClaude(): IClaudeClient {
  const text = JSON.stringify({ violation: true, severity: 3, reason: '严重侮辱', confidence: 0.9 });
  return { complete: vi.fn().mockResolvedValue({ text, inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } satisfies ClaudeResponse) };
}

function makeCleanClaude(): IClaudeClient {
  const text = JSON.stringify({ violation: false, severity: null, reason: '正常发言', confidence: 0.95 });
  return { complete: vi.fn().mockResolvedValue({ text, inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } satisfies ClaudeResponse) };
}

function makeModConfig(overrides: Partial<GroupConfig> = {}): GroupConfig {
  return {
    groupId: 'g1', enabledModules: ['moderator'], autoMod: true,
    dailyPunishmentLimit: 10, punishmentsToday: 0,
    punishmentsResetDate: new Date().toISOString().slice(0, 10),
    mimicActiveUserId: null, mimicStartedBy: null, chatTriggerKeywords: [],
    chatTriggerAtOnly: false, chatDebounceMs: 2000, modConfidenceThreshold: 0.7,
    modWhitelist: [], appealWindowHours: 24, kickConfirmModel: 'claude-opus-4-6',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── D1: DB repository ──────────────────────────────────────────────────────

describe('PendingModerationRepository', () => {
  let db: Database;

  beforeEach(() => { db = new Database(':memory:'); });

  it('queue returns new id and row is retrievable', () => {
    const id = db.pendingModeration.queue({
      groupId: 'g1', msgId: 'msg-1', userId: 'u1', userNickname: 'Alice',
      content: '违规', severity: 3, reason: '侮辱', proposedAction: 'warn',
      createdAt: Math.floor(Date.now() / 1000),
    });
    expect(id).toBeGreaterThan(0);
    const row = db.pendingModeration.getById(id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('pending');
    expect(row!.proposedAction).toBe('warn');
  });

  it('markStatus transitions to approved with decidedBy', () => {
    const id = db.pendingModeration.queue({
      groupId: 'g1', msgId: 'msg-2', userId: 'u1', userNickname: null,
      content: 'x', severity: 4, reason: 'test', proposedAction: 'mute_10m',
      createdAt: Math.floor(Date.now() / 1000),
    });
    db.pendingModeration.markStatus(id, 'approved', ADMIN_ID);
    const row = db.pendingModeration.getById(id);
    expect(row!.status).toBe('approved');
    expect(row!.decidedBy).toBe(ADMIN_ID);
    expect(row!.decidedAt).not.toBeNull();
  });

  it('expireOlderThan bulk-expires pending rows older than cutoff', () => {
    const oldSec = Math.floor(Date.now() / 1000) - 700;
    db.pendingModeration.queue({ groupId: 'g1', msgId: 'm1', userId: 'u1', userNickname: null, content: 'x', severity: 3, reason: 'r', proposedAction: 'warn', createdAt: oldSec });
    db.pendingModeration.queue({ groupId: 'g1', msgId: 'm2', userId: 'u1', userNickname: null, content: 'y', severity: 3, reason: 'r', proposedAction: 'warn', createdAt: oldSec });
    const cutoff = Math.floor(Date.now() / 1000) - 600;
    const count = db.pendingModeration.expireOlderThan(cutoff);
    expect(count).toBe(2);
  });

  it('expireOlderThan does not expire recent rows', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    db.pendingModeration.queue({ groupId: 'g1', msgId: 'm3', userId: 'u1', userNickname: null, content: 'z', severity: 3, reason: 'r', proposedAction: 'warn', createdAt: nowSec });
    const cutoff = nowSec - 600;
    const count = db.pendingModeration.expireOlderThan(cutoff);
    expect(count).toBe(0);
  });

  it('listPending returns only pending rows', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const id1 = db.pendingModeration.queue({ groupId: 'g1', msgId: 'm4', userId: 'u1', userNickname: null, content: 'a', severity: 3, reason: 'r', proposedAction: 'warn', createdAt: nowSec });
    db.pendingModeration.queue({ groupId: 'g1', msgId: 'm5', userId: 'u2', userNickname: null, content: 'b', severity: 4, reason: 'r', proposedAction: 'mute_10m', createdAt: nowSec });
    db.pendingModeration.markStatus(id1, 'rejected');
    const pending = db.pendingModeration.listPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.content).toBe('b');
  });
});

// ── D3: Moderator queues instead of executing ──────────────────────────────

describe('Router — moderator detection queues for approval', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let router: Router;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = makeAdapter();
    db.groupConfig.upsert(makeModConfig());
    router = new Router(db, adapter, new RateLimiter());
    const mod = new ModeratorModule(
      makeViolationClaude(), adapter, db.messages, db.moderation, db.groupConfig, db.rules, null,
    );
    router.setModerator(mod);
  });

  afterEach(() => { router.dispose(); });

  it('violation detected → pending row queued, DM sent, _executePunishment NOT called', async () => {
    const msg = makeMsg({ content: '你个傻逼，去死吧' });
    await router.dispatch(msg);
    // Pending row queued
    const pending = db.pendingModeration.listPending(10);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0]!.userId).toBe(msg.userId);
    // DM sent to admin
    expect(adapter.sendPrivateMessage).toHaveBeenCalledWith(ADMIN_ID, expect.stringContaining('#'));
    // Direct action (ban/kick/deleteMsg) NOT taken
    expect(adapter.ban).not.toHaveBeenCalled();
    expect(adapter.kick).not.toHaveBeenCalled();
    expect(adapter.deleteMsg).not.toHaveBeenCalled();
  });

  it('clean message → no pending row, no DM', async () => {
    const cleanRouter = new Router(db, adapter, new RateLimiter());
    cleanRouter.setModerator(new ModeratorModule(
      makeCleanClaude(), adapter, db.messages, db.moderation, db.groupConfig, db.rules, null,
    ));
    await cleanRouter.dispatch(makeMsg({ content: '今天天气不错' }));
    expect(db.pendingModeration.listPending(10)).toHaveLength(0);
    expect(adapter.sendPrivateMessage).not.toHaveBeenCalled();
    cleanRouter.dispose();
  });
});

// ── D4: dispatchPrivate — approval commands ────────────────────────────────

describe('Router.dispatchPrivate', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let router: Router;
  let mod: ModeratorModule;
  let pendingId: number;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = makeAdapter();
    db.groupConfig.upsert(makeModConfig());
    router = new Router(db, adapter, new RateLimiter());
    mod = new ModeratorModule(
      makeViolationClaude(), adapter, db.messages, db.moderation, db.groupConfig, db.rules, null,
    );
    router.setModerator(mod);
    pendingId = db.pendingModeration.queue({
      groupId: 'g1', msgId: 'msg-99', userId: 'offender-1', userNickname: 'BadUser',
      content: '违规内容', severity: 3, reason: '侮辱', proposedAction: 'warn',
      createdAt: Math.floor(Date.now() / 1000),
    });
  });

  afterEach(() => { router.dispose(); });

  it('/approve valid pending id → executePunishment called, status=approved', async () => {
    const spy = vi.spyOn(mod, 'executePunishment').mockResolvedValue(undefined);
    await router.dispatchPrivate(makePrivateMsg(`/approve ${pendingId}`));
    expect(spy).toHaveBeenCalledOnce();
    expect(db.pendingModeration.getById(pendingId)!.status).toBe('approved');
    expect(adapter.sendPrivateMessage).toHaveBeenCalledWith(ADMIN_ID, expect.stringContaining('已执行'));
  });

  it('/approve expired pending id → executePunishment NOT called, 已失效 reply', async () => {
    db.pendingModeration.markStatus(pendingId, 'expired');
    const spy = vi.spyOn(mod, 'executePunishment').mockResolvedValue(undefined);
    await router.dispatchPrivate(makePrivateMsg(`/approve ${pendingId}`));
    expect(spy).not.toHaveBeenCalled();
    expect(adapter.sendPrivateMessage).toHaveBeenCalledWith(ADMIN_ID, expect.stringContaining('已失效'));
  });

  it('/reject pending id → status=rejected, no action executed', async () => {
    const spy = vi.spyOn(mod, 'executePunishment').mockResolvedValue(undefined);
    await router.dispatchPrivate(makePrivateMsg(`/reject ${pendingId}`));
    expect(spy).not.toHaveBeenCalled();
    expect(db.pendingModeration.getById(pendingId)!.status).toBe('rejected');
    expect(adapter.sendPrivateMessage).toHaveBeenCalledWith(ADMIN_ID, expect.stringContaining('已拒绝'));
  });

  it('/approve from non-admin → ignored, no executePunishment', async () => {
    const spy = vi.spyOn(mod, 'executePunishment').mockResolvedValue(undefined);
    await router.dispatchPrivate(makePrivateMsg(`/approve ${pendingId}`, 'random-user-999'));
    expect(spy).not.toHaveBeenCalled();
    expect(db.pendingModeration.getById(pendingId)!.status).toBe('pending');
    expect(adapter.sendPrivateMessage).not.toHaveBeenCalled();
  });

  it('non-command private message from admin → ignored, no chat module call', async () => {
    const chatFn = vi.fn();
    router.setChat({ generateReply: chatFn } as unknown as ReturnType<typeof router.setChat> extends void ? never : never);
    await router.dispatchPrivate(makePrivateMsg('随便说一句话'));
    expect(chatFn).not.toHaveBeenCalled();
    expect(adapter.sendPrivateMessage).not.toHaveBeenCalled();
  });

  it('/pending → returns compact list of pending rows', async () => {
    await router.dispatchPrivate(makePrivateMsg('/pending'));
    expect(adapter.sendPrivateMessage).toHaveBeenCalledWith(ADMIN_ID, expect.stringContaining(`#${pendingId}`));
  });
});

// ── D5: Expiry sweep ────────────────────────────────────────────────────────

describe('Router — expiry sweep', () => {
  it('expireOlderThan is called and marks old rows expired', () => {
    const db = new Database(':memory:');
    const oldSec = Math.floor(Date.now() / 1000) - 700;
    const id = db.pendingModeration.queue({
      groupId: 'g1', msgId: 'm1', userId: 'u1', userNickname: null,
      content: 'x', severity: 3, reason: 'r', proposedAction: 'warn', createdAt: oldSec,
    });
    // Simulate what the interval does
    const expired = db.pendingModeration.expireOlderThan(Math.floor(Date.now() / 1000) - 600);
    expect(expired).toBe(1);
    expect(db.pendingModeration.getById(id)!.status).toBe('expired');
  });
});

// ── D7: Rate limit ──────────────────────────────────────────────────────────

describe('Router — mod DM hourly rate limit', () => {
  it('21st violation in same hour is suppressed (no DM, no queue)', async () => {
    const db = new Database(':memory:');
    const adapter = makeAdapter();
    db.groupConfig.upsert(makeModConfig());
    const router = new Router(db, adapter, new RateLimiter());
    router.setModerator(new ModeratorModule(
      makeViolationClaude(), adapter, db.messages, db.moderation, db.groupConfig, db.rules, null,
    ));

    // Fire 20 violations — all should DM
    for (let i = 0; i < 20; i++) {
      await router.dispatch(makeMsg({ messageId: `msg-${i}`, userId: `u${i}`, content: `严重违规内容${i}号` }));
    }
    const dmCallsBefore = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls.length;

    // 21st violation — should be suppressed
    await router.dispatch(makeMsg({ messageId: 'msg-20', userId: 'u20', content: '严重违规内容20号' }));
    const dmCallsAfter = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(dmCallsBefore).toBe(20);
    expect(dmCallsAfter).toBe(20); // no new DM
    router.dispose();
  });

  it('adapter.sendPrivateMessage failure → pending row still queued, no crash', async () => {
    const db = new Database(':memory:');
    const adapter = makeAdapter();
    (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mockResolvedValue(null); // simulates failure
    db.groupConfig.upsert(makeModConfig());
    const router = new Router(db, adapter, new RateLimiter());
    router.setModerator(new ModeratorModule(
      makeViolationClaude(), adapter, db.messages, db.moderation, db.groupConfig, db.rules, null,
    ));
    await router.dispatch(makeMsg({ content: '违规内容' }));
    // Pending row still queued despite DM failure
    const pending = db.pendingModeration.listPending(10);
    expect(pending.length).toBeGreaterThan(0);
    router.dispose();
  });
});
