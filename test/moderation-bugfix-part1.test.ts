import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModeratorModule, extractJson } from '../src/modules/moderator.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type {
  IMessageRepository, IModerationRepository, IGroupConfigRepository,
  IRuleRepository, GroupConfig, ModerationRecord,
  PendingModeration,
} from '../src/storage/db.js';
import type { INapCatAdapter, GroupMessage } from '../src/adapter/napcat.js';
import { Database } from '../src/storage/db.js';
import { Router } from '../src/core/router.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const ADMIN_ID = '2331924739';

// ---- Helpers ----

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'msg-1', groupId: 'g1', userId: 'u1', nickname: 'Alice',
    role: 'member', content: 'bad content', rawContent: 'bad content',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<GroupConfig> = {}): GroupConfig {
  return {
    groupId: 'g1', enabledModules: ['moderator'], autoMod: true,
    dailyPunishmentLimit: 10, punishmentsToday: 0,
    punishmentsResetDate: new Date().toISOString().slice(0, 10),
    mimicActiveUserId: null, mimicStartedBy: null, chatTriggerKeywords: [],
    chatTriggerAtOnly: false, chatDebounceMs: 2000, modConfidenceThreshold: 0.7,
    modWhitelist: [], appealWindowHours: 24, kickConfirmModel: 'claude-opus-4-6',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  } as GroupConfig;
}

function makePrivateMsg(content: string, userId = ADMIN_ID): { messageId: string; userId: string; nickname: string; content: string; timestamp: number } {
  return {
    messageId: 'pm-1', userId, nickname: userId === ADMIN_ID ? 'Admin' : 'Other',
    content, timestamp: Math.floor(Date.now() / 1000),
  };
}

function makeClaudeVerdict(violation: boolean, severity: number | null, confidence = 0.9): IClaudeClient {
  const text = JSON.stringify({ violation, severity, reason: 'test reason', confidence });
  return { complete: vi.fn().mockResolvedValue({ text, inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } satisfies ClaudeResponse) };
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

function makeMessageRepo(): IMessageRepository {
  return {
    insert: vi.fn().mockReturnValue({ id: 1, groupId: 'g1', userId: 'u1', nickname: 'A', content: '', timestamp: 0, deleted: false }),
    getRecent: vi.fn().mockReturnValue([]),
    getByUser: vi.fn().mockReturnValue([]),
    sampleRandomHistorical: vi.fn().mockReturnValue([]),
    searchByKeywords: vi.fn().mockReturnValue([]),
    getTopUsers: vi.fn().mockReturnValue([]),
    softDelete: vi.fn(),
    findBySourceId: vi.fn().mockReturnValue(null),
    findNearTimestamp: vi.fn().mockReturnValue(null),
    getAroundTimestamp: vi.fn().mockReturnValue([]),
  };
}

function makeModerationRepo(): IModerationRepository {
  const records: ModerationRecord[] = [];
  let nextId = 1;
  return {
    insert: vi.fn().mockImplementation((r) => { const rec = { ...r, id: nextId++, reviewed: 0, reviewedBy: null, reviewedAt: null }; records.push(rec); return rec; }),
    findById: vi.fn().mockReturnValue(null),
    findByMsgId: vi.fn().mockImplementation((msgId: string) => records.find(r => r.msgId === msgId) ?? null),
    findRecentByUser: vi.fn().mockReturnValue([]),
    findRecentByGroup: vi.fn().mockReturnValue([]),
    findPendingAppeal: vi.fn().mockReturnValue(null),
    update: vi.fn(),
    countWarnsByUser: vi.fn().mockReturnValue(0),
    getForReview: vi.fn().mockReturnValue({ records: [], total: 0 }),
    markReviewed: vi.fn(),
    getStats: vi.fn().mockReturnValue({ total: 0, unreviewed: 0, approved: 0, rejected: 0, byGroup: {} }),
    updateAction: vi.fn().mockReturnValue(true),
  };
}

function makeConfigRepo(config: GroupConfig): IGroupConfigRepository {
  return {
    get: vi.fn().mockReturnValue(config),
    upsert: vi.fn(),
    incrementPunishments: vi.fn(),
    resetDailyPunishments: vi.fn(),
  };
}

function makeRuleRepo(): IRuleRepository {
  return {
    insert: vi.fn(),
    findById: vi.fn().mockReturnValue(null),
    getAll: vi.fn().mockReturnValue([]),
    getPage: vi.fn().mockReturnValue({ rules: [], total: 0 }),
    deleteBySource: vi.fn().mockReturnValue(0),
  };
}

// ---- Bug 2: Low-confidence verdict returns violation=false ----

describe('Bug 2: Low-confidence verdict returns violation=false', () => {
  it('assess() returns violation=false when confidence < 0.75', async () => {
    const claude = makeClaudeVerdict(true, 4, 0.5); // high severity, low confidence
    const moderation = makeModerationRepo();
    const mod = new ModeratorModule(
      claude, makeAdapter(), makeMessageRepo(), moderation,
      makeConfigRepo(makeConfig()), makeRuleRepo(), null,
    );
    const verdict = await mod.assess(makeMsg(), makeConfig());
    // The key fix: verdict.violation should be false for low confidence
    expect(verdict.violation).toBe(false);
  });

  it('assess() returns violation=true when confidence >= 0.75', async () => {
    const claude = makeClaudeVerdict(true, 4, 0.85);
    const moderation = makeModerationRepo();
    const mod = new ModeratorModule(
      claude, makeAdapter(), makeMessageRepo(), moderation,
      makeConfigRepo(makeConfig()), makeRuleRepo(), null,
    );
    const verdict = await mod.assess(makeMsg(), makeConfig());
    expect(verdict.violation).toBe(true);
  });

  it('low-confidence violation still gets logged in moderation_log', async () => {
    const claude = makeClaudeVerdict(true, 3, 0.4);
    const moderation = makeModerationRepo();
    const mod = new ModeratorModule(
      claude, makeAdapter(), makeMessageRepo(), moderation,
      makeConfigRepo(makeConfig()), makeRuleRepo(), null,
    );
    await mod.assess(makeMsg(), makeConfig());
    expect(moderation.insert).toHaveBeenCalledWith(
      expect.objectContaining({ violation: true, action: 'none' }),
    );
  });
});

// ---- Bug 1: Router doesn't queue sev 1-2 violations ----

describe('Bug 1: Router severity threshold >= 3', () => {
  let db: Database;
  let adapter: INapCatAdapter;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = makeAdapter();
    db.groupConfig.upsert(makeConfig());
  });

  it('sev 2 violation does NOT trigger admin DM or pending row', async () => {
    const claude = makeClaudeVerdict(true, 2, 0.9);
    const router = new Router(db, adapter, new RateLimiter());
    const mod = new ModeratorModule(
      claude, adapter, db.messages, db.moderation, db.groupConfig, db.rules, null,
    );
    router.setModerator(mod);
    await router.dispatch(makeMsg({ content: '轻微违规内容' }));
    // sev 2 should NOT create a pending row
    expect(db.pendingModeration.listPending(10)).toHaveLength(0);
    // No DM sent
    expect(adapter.sendPrivateMessage).not.toHaveBeenCalled();
    router.dispose();
  });

  it('sev 3 violation DOES trigger admin DM', async () => {
    const claude = makeClaudeVerdict(true, 3, 0.9);
    const router = new Router(db, adapter, new RateLimiter());
    const mod = new ModeratorModule(
      claude, adapter, db.messages, db.moderation, db.groupConfig, db.rules, null,
    );
    router.setModerator(mod);
    await router.dispatch(makeMsg({ content: '严重违规内容' }));
    // Wait for async moderation
    await vi.waitFor(() => {
      expect(db.pendingModeration.listPending(10).length).toBeGreaterThan(0);
    }, { timeout: 2000 });
    router.dispose();
  });
});

// ---- Bug 3: executePunishment updates existing record instead of inserting duplicate ----

describe('Bug 3: executePunishment updates instead of duplicating', () => {
  it('executePunishment calls updateAction instead of insert', async () => {
    const claude = makeClaudeVerdict(true, 3, 0.9);
    const adapter = makeAdapter();
    const moderation = makeModerationRepo();
    const mod = new ModeratorModule(
      claude, adapter, makeMessageRepo(), moderation,
      makeConfigRepo(makeConfig()), makeRuleRepo(), null,
    );

    const pending: PendingModeration = {
      id: 1, groupId: 'g1', msgId: 'msg-99', userId: 'u1',
      userNickname: 'Alice', content: '违规', severity: 3,
      reason: '侮辱', proposedAction: 'warn', status: 'approved',
      createdAt: Math.floor(Date.now() / 1000), decidedAt: null, decidedBy: null,
    };

    await mod.executePunishment(pending, makeConfig());

    // Should call updateAction, not insert for the punishment
    expect(moderation.updateAction).toHaveBeenCalledWith('msg-99', 'warn');
  });

  it('executePunishment falls back to insert if updateAction returns false', async () => {
    const claude = makeClaudeVerdict(true, 3, 0.9);
    const adapter = makeAdapter();
    const moderation = makeModerationRepo();
    (moderation.updateAction as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const mod = new ModeratorModule(
      claude, adapter, makeMessageRepo(), moderation,
      makeConfigRepo(makeConfig()), makeRuleRepo(), null,
    );

    const pending: PendingModeration = {
      id: 1, groupId: 'g1', msgId: 'msg-99', userId: 'u1',
      userNickname: 'Alice', content: '违规', severity: 3,
      reason: '侮辱', proposedAction: 'warn', status: 'approved',
      createdAt: Math.floor(Date.now() / 1000), decidedAt: null, decidedBy: null,
    };

    await mod.executePunishment(pending, makeConfig());

    // Fallback: should insert when updateAction returns false
    expect(moderation.insert).toHaveBeenCalledWith(
      expect.objectContaining({ msgId: 'msg-99', action: 'warn' }),
    );
  });
});

// ---- Design flaw: /reject and /approve sync moderation_log.reviewed ----

describe('Design flaw: /reject syncs moderation_log.reviewed', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let router: Router;
  let pendingId: number;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = makeAdapter();
    db.groupConfig.upsert(makeConfig());
    router = new Router(db, adapter, new RateLimiter());
    const mod = new ModeratorModule(
      makeClaudeVerdict(true, 3, 0.9), adapter,
      db.messages, db.moderation, db.groupConfig, db.rules, null,
    );
    router.setModerator(mod);

    // Pre-seed: insert a moderation_log record (assess() would have done this)
    db.moderation.insert({
      msgId: 'msg-99', groupId: 'g1', userId: 'u1',
      violation: true, severity: 3, action: 'none',
      reason: '侮辱', appealed: 0, reversed: false,
      timestamp: Math.floor(Date.now() / 1000), originalContent: '违规内容',
    });

    // Queue a pending moderation row
    pendingId = db.pendingModeration.queue({
      groupId: 'g1', msgId: 'msg-99', userId: 'u1', userNickname: 'Alice',
      content: '违规内容', severity: 3, reason: '侮辱', proposedAction: 'warn',
      createdAt: Math.floor(Date.now() / 1000),
    });
  });

  afterEach(() => { router.dispose(); });

  it('/reject marks moderation_log.reviewed = 2', async () => {
    await router.dispatchPrivate(makePrivateMsg(`/reject ${pendingId}`));
    const modRecord = db.moderation.findByMsgId('msg-99');
    expect(modRecord).not.toBeNull();
    expect(modRecord!.reviewed).toBe(2);
    expect(modRecord!.reviewedBy).toBe(ADMIN_ID);
  });

  it('/approve + executePunishment marks moderation_log.reviewed = 1', async () => {
    await router.dispatchPrivate(makePrivateMsg(`/approve ${pendingId}`));
    const modRecord = db.moderation.findByMsgId('msg-99');
    expect(modRecord).not.toBeNull();
    expect(modRecord!.reviewed).toBe(1);
    expect(modRecord!.reviewedBy).toBe(ADMIN_ID);
  });
});

// ---- DB: updateAction method ----

describe('IModerationRepository.updateAction', () => {
  let db: Database;

  beforeEach(() => { db = new Database(':memory:'); });

  it('updates action for existing record with action=none', () => {
    db.moderation.insert({
      msgId: 'msg-1', groupId: 'g1', userId: 'u1',
      violation: true, severity: 3, action: 'none',
      reason: 'test', appealed: 0, reversed: false,
      timestamp: Math.floor(Date.now() / 1000), originalContent: 'content',
    });

    const result = db.moderation.updateAction('msg-1', 'warn');
    expect(result).toBe(true);

    const record = db.moderation.findByMsgId('msg-1');
    expect(record!.action).toBe('warn');
  });

  it('returns false when no record with action=none exists', () => {
    const result = db.moderation.updateAction('nonexistent', 'warn');
    expect(result).toBe(false);
  });

  it('does not update record where action is already set', () => {
    db.moderation.insert({
      msgId: 'msg-1', groupId: 'g1', userId: 'u1',
      violation: true, severity: 3, action: 'warn',
      reason: 'test', appealed: 0, reversed: false,
      timestamp: Math.floor(Date.now() / 1000), originalContent: 'content',
    });

    const result = db.moderation.updateAction('msg-1', 'ban');
    expect(result).toBe(false);
  });
});

// ---- Edge cases ----

describe('Edge cases', () => {
  it('confidence exactly at threshold (0.75) is treated as sufficient', async () => {
    const claude = makeClaudeVerdict(true, 4, 0.75);
    const moderation = makeModerationRepo();
    const mod = new ModeratorModule(
      claude, makeAdapter(), makeMessageRepo(), moderation,
      makeConfigRepo(makeConfig()), makeRuleRepo(), null,
    );
    const verdict = await mod.assess(makeMsg(), makeConfig());
    // 0.75 >= 0.75 so should pass the confidence gate
    expect(verdict.violation).toBe(true);
  });

  it('confidence just below threshold (0.749) returns violation=false', async () => {
    const claude = makeClaudeVerdict(true, 4, 0.749);
    const moderation = makeModerationRepo();
    const mod = new ModeratorModule(
      claude, makeAdapter(), makeMessageRepo(), moderation,
      makeConfigRepo(makeConfig()), makeRuleRepo(), null,
    );
    const verdict = await mod.assess(makeMsg(), makeConfig());
    expect(verdict.violation).toBe(false);
  });

  it('severity exactly 3 passes the severity gate', async () => {
    const claude = makeClaudeVerdict(true, 3, 0.9);
    const moderation = makeModerationRepo();
    const mod = new ModeratorModule(
      claude, makeAdapter(), makeMessageRepo(), moderation,
      makeConfigRepo(makeConfig()), makeRuleRepo(), null,
    );
    const verdict = await mod.assess(makeMsg(), makeConfig());
    expect(verdict.violation).toBe(true);
    expect(verdict.severity).toBe(3);
  });

  it('updateAction with empty string msgId returns false', () => {
    const db = new Database(':memory:');
    const result = db.moderation.updateAction('', 'warn');
    expect(result).toBe(false);
  });
});
