import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModeratorModule } from '../src/modules/moderator.js';
import type { IClaudeClient } from '../src/ai/claude.js';
import type {
  IMessageRepository, IModerationRepository, IGroupConfigRepository,
  IRuleRepository, IImageModCacheRepository, ImageModVerdict, GroupConfig,
} from '../src/storage/db.js';
import type { INapCatAdapter, GroupMessage } from '../src/adapter/napcat.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

// ── Helpers ───────────────────────────────────────────────────────────────────

const GROUP_ID = 'g1';
const USER_ID = 'u1';
const FILE_KEY = 'abc123hash';

function makeTarget() {
  return { userId: USER_ID, nickname: 'Alice', messageId: 'msg-1', groupId: GROUP_ID, fileKey: FILE_KEY };
}

function makeImageBytes() {
  return Buffer.from([0xff, 0xd8, 0x00]); // JPEG magic bytes
}

function makeClaudeVision(json: object): IClaudeClient {
  return {
    complete: vi.fn(),
    describeImage: vi.fn(),
    visionWithPrompt: vi.fn().mockResolvedValue(JSON.stringify(json)),
  } as unknown as IClaudeClient;
}

function makeAdapter(): INapCatAdapter {
  return {
    connect: vi.fn(), disconnect: vi.fn(), on: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    ban: vi.fn(), kick: vi.fn(),
    deleteMsg: vi.fn().mockResolvedValue(undefined),
    sendPrivate: vi.fn(),
    sendPrivateMessage: vi.fn().mockResolvedValue(42),
    getGroupNotices: vi.fn(),
    getImage: vi.fn().mockResolvedValue({ filename: '', url: '', size: 0, base64: Buffer.from([0xff, 0xd8, 0x00]).toString('base64') }),
    getGroupInfo: vi.fn(),
  } as unknown as INapCatAdapter;
}

function makeMessageRepo(): IMessageRepository {
  return { insert: vi.fn(), getRecent: vi.fn().mockReturnValue([]), getByUser: vi.fn(), sampleRandomHistorical: vi.fn(), searchByKeywords: vi.fn(), getTopUsers: vi.fn(), softDelete: vi.fn() } as unknown as IMessageRepository;
}

function makeModerationRepo(): IModerationRepository {
  return { insert: vi.fn().mockReturnValue({ id: 1 }), findById: vi.fn(), findByMsgId: vi.fn(), findRecentByUser: vi.fn().mockReturnValue([]), findRecentByGroup: vi.fn(), findPendingAppeal: vi.fn(), update: vi.fn(), countWarnsByUser: vi.fn() } as unknown as IModerationRepository;
}

function makeConfigRepo(): IGroupConfigRepository {
  return { get: vi.fn(), upsert: vi.fn(), incrementPunishments: vi.fn(), resetDailyPunishments: vi.fn() } as unknown as IGroupConfigRepository;
}

function makeRuleRepo(rules: string[] = []): IRuleRepository {
  return {
    insert: vi.fn(), findById: vi.fn().mockReturnValue(null),
    getAll: vi.fn().mockReturnValue(rules.map((c, i) => ({ id: i + 1, groupId: GROUP_ID, content: c, type: 'positive' as const, embedding: null }))),
    getPage: vi.fn().mockReturnValue({ rules: [], total: 0 }),
  };
}

function makeImageCache(cached: ImageModVerdict | null = null): IImageModCacheRepository {
  return {
    get: vi.fn().mockReturnValue(cached),
    set: vi.fn(),
    purgeOlderThan: vi.fn().mockReturnValue(0),
  };
}

function makeModule(
  claude: IClaudeClient,
  opts: {
    rules?: string[];
    imageCache?: IImageModCacheRepository | null;
  } = {},
): ModeratorModule {
  return new ModeratorModule(
    claude,
    makeAdapter(),
    makeMessageRepo(),
    makeModerationRepo(),
    makeConfigRepo(),
    makeRuleRepo(opts.rules ?? ['no NSFW', 'no doxxing']),
    null,
    opts.imageCache !== undefined ? opts.imageCache : makeImageCache(),
  );
}

// ── assessImage unit tests ─────────────────────────────────────────────────────

describe('ModeratorModule.assessImage', () => {
  it('violation: returns capped severity verdict when Claude returns violation', async () => {
    const claude = makeClaudeVision({ violation: true, severity: 5, reason: 'NSFW content', ruleId: 1 });
    const mod = makeModule(claude);
    const verdict = await mod.assessImage(makeTarget(), makeImageBytes());

    expect(verdict.violation).toBe(true);
    expect(verdict.severity).toBe(3); // capped at IMAGE_MOD_SEVERITY_CAP=3
    expect(verdict.reason).toBe('NSFW content');
  });

  it('no violation: returns violation=false when Claude returns clean', async () => {
    const claude = makeClaudeVision({ violation: false, severity: null, reason: '', ruleId: null });
    const mod = makeModule(claude);
    const verdict = await mod.assessImage(makeTarget(), makeImageBytes());

    expect(verdict.violation).toBe(false);
    expect(verdict.severity).toBeNull();
  });

  it('malformed JSON: fail-safe returns violation=false', async () => {
    const claude = {
      complete: vi.fn(), describeImage: vi.fn(),
      visionWithPrompt: vi.fn().mockResolvedValue('not json at all'),
    } as unknown as IClaudeClient;
    const mod = makeModule(claude);
    const verdict = await mod.assessImage(makeTarget(), makeImageBytes());

    expect(verdict.violation).toBe(false);
    expect(verdict.severity).toBeNull();
  });

  it('vision API throws: fail-safe returns violation=false', async () => {
    const claude = {
      complete: vi.fn(), describeImage: vi.fn(),
      visionWithPrompt: vi.fn().mockRejectedValue(new Error('API down')),
    } as unknown as IClaudeClient;
    const mod = makeModule(claude);
    const verdict = await mod.assessImage(makeTarget(), makeImageBytes());

    expect(verdict.violation).toBe(false);
    expect((claude.visionWithPrompt as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('cache hit: returns cached verdict, no vision call', async () => {
    const cached: ImageModVerdict = { fileKey: FILE_KEY, violation: true, severity: 2, reason: 'cached reason', ruleId: null, createdAt: Math.floor(Date.now() / 1000) };
    const imageCache = makeImageCache(cached);
    const claude = makeClaudeVision({ violation: false, severity: null, reason: '', ruleId: null });
    const mod = makeModule(claude, { imageCache });

    const verdict = await mod.assessImage(makeTarget(), makeImageBytes());

    expect(verdict.violation).toBe(true);
    expect(verdict.severity).toBe(2);
    expect(verdict.reason).toBe('cached reason');
    expect((claude.visionWithPrompt as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('cache miss: calls vision, stores result in cache', async () => {
    const imageCache = makeImageCache(null);
    const claude = makeClaudeVision({ violation: true, severity: 2, reason: 'doxxing', ruleId: 2 });
    const mod = makeModule(claude, { imageCache });

    await mod.assessImage(makeTarget(), makeImageBytes());

    expect((claude.visionWithPrompt as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((imageCache.set as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const stored = (imageCache.set as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ImageModVerdict;
    expect(stored.fileKey).toBe(FILE_KEY);
    expect(stored.violation).toBe(true);
  });

  it('rate limit: 11th uncached check in same group-hour is skipped', async () => {
    const imageCache = makeImageCache(null); // always miss
    const claude = makeClaudeVision({ violation: false, severity: null, reason: '', ruleId: null });
    const mod = makeModule(claude, { imageCache });

    // 10 calls should succeed
    for (let i = 0; i < 10; i++) {
      await mod.assessImage({ ...makeTarget(), fileKey: `key-${i}` }, makeImageBytes());
    }
    // 11th call should be rate-limited
    const verdict = await mod.assessImage({ ...makeTarget(), fileKey: 'key-11' }, makeImageBytes());

    expect((claude.visionWithPrompt as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(10);
    expect(verdict.violation).toBe(false); // fail-safe
  });

  it('severity cap: severity 4 returned by Claude is capped to 3 when not obfuscation', async () => {
    const claude = makeClaudeVision({ violation: true, severity: 4, reason: 'severe', ruleId: 1, obfuscation: false });
    const mod = makeModule(claude);
    const verdict = await mod.assessImage(makeTarget(), makeImageBytes());

    expect(verdict.severity).toBe(3);
  });

  it('obfuscation=true: severity floor raised to 4 even if Claude returned 2', async () => {
    const claude = makeClaudeVision({ violation: true, severity: 2, reason: '310110在计算结果中', ruleId: null, obfuscation: true });
    const mod = makeModule(claude);
    const verdict = await mod.assessImage(makeTarget(), makeImageBytes());

    expect(verdict.violation).toBe(true);
    expect(verdict.severity).toBe(4);
    expect(verdict.reason).toBe('310110在计算结果中');
  });

  it('obfuscation=true with severity 5: keeps 5 (floor only, not cap)', async () => {
    const claude = makeClaudeVision({ violation: true, severity: 5, reason: '确认人肉', ruleId: null, obfuscation: true });
    const mod = makeModule(claude);
    const verdict = await mod.assessImage(makeTarget(), makeImageBytes());

    expect(verdict.severity).toBe(5);
  });

  it('cache TTL is ~1h: purgeOlderThan called with cutoff ~3600s ago', async () => {
    const imageCache = makeImageCache(null);
    const claude = makeClaudeVision({ violation: false, severity: null, reason: '', ruleId: null, obfuscation: false });
    const mod = makeModule(claude, { imageCache });

    const before = Math.floor(Date.now() / 1000);
    await mod.assessImage(makeTarget(), makeImageBytes());
    await new Promise(r => setImmediate(r));

    expect((imageCache.purgeOlderThan as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    const cutoffArg = (imageCache.purgeOlderThan as ReturnType<typeof vi.fn>).mock.calls[0]![0] as number;
    expect(cutoffArg).toBeGreaterThan(before - 3602);
    expect(cutoffArg).toBeLessThan(before - 3598);
  });
});

// ── Router integration: image assessment ──────────────────────────────────────

const mockQuery = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }));

import { Router, _extractImageFile } from '../src/core/router.js';
import type { Database } from '../src/storage/db.js';
import type { RateLimiter } from '../src/core/rateLimiter.js';

function makeDb(groupConfig?: Partial<GroupConfig>): Database {
  const cfg: GroupConfig = {
    groupId: GROUP_ID, enabledModules: [], autoMod: true,
    dailyPunishmentLimit: 10, punishmentsToday: 0,
    punishmentsResetDate: '', mimicActiveUserId: null, mimicStartedBy: null,
    chatTriggerKeywords: [], chatTriggerAtOnly: false, chatDebounceMs: 2000,
    modConfidenceThreshold: 0.7, modWhitelist: [], appealWindowHours: 24,
    kickConfirmModel: 'claude-opus-4-6', createdAt: '', updatedAt: '',
    ...groupConfig,
  };
  return {
    groupConfig: { get: vi.fn().mockReturnValue(cfg), upsert: vi.fn(), incrementPunishments: vi.fn(), resetDailyPunishments: vi.fn() },
    messages: { insert: vi.fn(), getRecent: vi.fn().mockReturnValue([]), getByUser: vi.fn(), sampleRandomHistorical: vi.fn(), searchByKeywords: vi.fn(), getTopUsers: vi.fn(), softDelete: vi.fn() },
    users: { upsert: vi.fn() },
    pendingModeration: { queue: vi.fn().mockReturnValue(1), getById: vi.fn(), markStatus: vi.fn(), expireOlderThan: vi.fn().mockReturnValue(0), listPending: vi.fn().mockReturnValue([]) },
    botReplies: { insert: vi.fn().mockReturnValue({ id: 1 }), getById: vi.fn(), markEvasive: vi.fn() },
    liveStickers: { upsert: vi.fn(), getTopByGroup: vi.fn().mockReturnValue([]) },
    localStickers: { upsert: vi.fn(), findAll: vi.fn().mockReturnValue([]), findByFileUnique: vi.fn() },
  } as unknown as Database;
}

function makeRateLimiter(): RateLimiter {
  return { checkUser: vi.fn().mockReturnValue(true), cooldownSecondsUser: vi.fn().mockReturnValue(0) } as unknown as RateLimiter;
}

function makeGroupMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'msg-img-1', groupId: GROUP_ID, userId: USER_ID,
    nickname: 'Alice', role: 'member',
    content: '',
    rawContent: '[CQ:image,file=abc123.image,url=http://example.com/img.jpg]',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe('Router image moderation integration', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('message with image + autoMod on + violation detected → assessImage called, pending_moderation queued + DM sent', async () => {
    const db = makeDb({ autoMod: true });
    const adapter = makeAdapter();
    const router = new Router(db, adapter, makeRateLimiter(), 'bot-id');

    // Capture the assessImage promise so we can await it
    let resolveAssessImage!: (v: object) => void;
    const assessImagePromise = new Promise<object>(r => { resolveAssessImage = r; });
    const mod = {
      assess: vi.fn().mockResolvedValue({ violation: false, severity: null, reason: '', confidence: 1 }),
      assessImage: vi.fn().mockImplementation(() => {
        resolveAssessImage({ violation: true, severity: 2, reason: 'NSFW', confidence: 1 });
        return Promise.resolve({ violation: true, severity: 2, reason: 'NSFW', confidence: 1 });
      }),
    } as unknown as ModeratorModule;
    router.setModerator(mod);

    await router.dispatch(makeGroupMsg());
    // Wait for the fire-and-forget _assessImageAsync to invoke assessImage
    await assessImagePromise;
    // One more tick for the _queueModerationApproval to complete
    await new Promise(r => setImmediate(r));

    expect(mod.assessImage).toHaveBeenCalled();
    expect((db.pendingModeration.queue as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((adapter.sendPrivateMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('message with image + autoMod off → assessImage NOT called', async () => {
    const db = makeDb({ autoMod: false });
    const adapter = makeAdapter();
    const router = new Router(db, adapter, makeRateLimiter(), 'bot-id');

    const mod = {
      assess: vi.fn().mockResolvedValue({ violation: false, severity: null, reason: '', confidence: 1 }),
      assessImage: vi.fn().mockResolvedValue({ violation: false, severity: null, reason: '', confidence: 1 }),
    } as unknown as ModeratorModule;
    router.setModerator(mod);

    await router.dispatch(makeGroupMsg());
    await new Promise(r => setImmediate(r));

    expect(mod.assessImage).not.toHaveBeenCalled();
  });

  it('image blocked by id-guard → assessImage NOT called (short-circuit)', async () => {
    const db = makeDb({ autoMod: true, idGuardEnabled: true });
    const adapter = makeAdapter();
    const router = new Router(db, adapter, makeRateLimiter(), 'bot-id');

    const idGuard = { check: vi.fn().mockResolvedValue(true) };
    router.setIdGuard(idGuard as unknown as import('../src/modules/id-guard.js').IdCardGuard);

    const mod = {
      assess: vi.fn().mockResolvedValue({ violation: false, severity: null, reason: '', confidence: 1 }),
      assessImage: vi.fn(),
    } as unknown as ModeratorModule;
    router.setModerator(mod);

    await router.dispatch(makeGroupMsg({
      rawContent: '[CQ:image,file=abc123.image,url=http://example.com/img.jpg]',
    }));
    await new Promise(r => setImmediate(r));

    expect(idGuard.check).toHaveBeenCalled();
    expect(mod.assessImage).not.toHaveBeenCalled();
  });
});
