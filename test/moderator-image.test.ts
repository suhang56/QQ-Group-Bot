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

function makeRuleRepo(): IRuleRepository {
  return {
    insert: vi.fn(), findById: vi.fn().mockReturnValue(null),
    getAll: vi.fn().mockReturnValue([]),
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
  opts: { imageCache?: IImageModCacheRepository | null } = {},
): ModeratorModule {
  return new ModeratorModule(
    claude,
    makeAdapter(),
    makeMessageRepo(),
    makeModerationRepo(),
    makeConfigRepo(),
    makeRuleRepo(),
    null,
    opts.imageCache !== undefined ? opts.imageCache : makeImageCache(),
  );
}

// ── assessImage watchlist tests ────────────────────────────────────────────────

describe('ModeratorModule.assessImage — dual-layer prompt', () => {
  it('full 18-digit ID detected → severity 5, category watchlist', async () => {
    const claude = makeClaudeVision({ violation: true, severity: 5, reason: '含完整身份证号', category: 'watchlist', components_seen: ['310110199701093724'], rule_id: null });
    const mod = makeModule(claude);
    const verdict = await mod.assessImage(makeTarget(), makeImageBytes());

    expect(verdict.violation).toBe(true);
    expect(verdict.severity).toBe(5);
    expect(verdict.reason).toBe('含完整身份证号');
  });

  it('310110 only → severity 4, category watchlist', async () => {
    const claude = makeClaudeVision({ violation: true, severity: 4, reason: '含310110前缀', category: 'watchlist', components_seen: ['310110'], rule_id: null });
    const mod = makeModule(claude);
    const verdict = await mod.assessImage(makeTarget(), makeImageBytes());

    expect(verdict.violation).toBe(true);
    expect(verdict.severity).toBe(4);
  });

  it('single fragment (1997 only) → severity 2, log only', async () => {
    const claude = makeClaudeVision({ violation: true, severity: 2, reason: '出生年1997单独出现', category: 'watchlist', components_seen: ['1997'], rule_id: null });
    const mod = makeModule(claude);
    const verdict = await mod.assessImage(makeTarget(), makeImageBytes());

    expect(verdict.violation).toBe(true);
    expect(verdict.severity).toBe(2);
  });

  it('two fragments together (310110 + 1997) → severity 5', async () => {
    const claude = makeClaudeVision({ violation: true, severity: 5, reason: '310110与1997同时出现', category: 'watchlist', components_seen: ['310110', '1997'], rule_id: null });
    const mod = makeModule(claude);
    const verdict = await mod.assessImage(makeTarget(), makeImageBytes());

    expect(verdict.violation).toBe(true);
    expect(verdict.severity).toBe(5);
  });

  it('no components → violation: false', async () => {
    const claude = makeClaudeVision({ violation: false, severity: null, reason: '', category: null, components_seen: [], rule_id: null });
    const mod = makeModule(claude);
    const verdict = await mod.assessImage(makeTarget(), makeImageBytes());

    expect(verdict.violation).toBe(false);
    expect(verdict.severity).toBeNull();
  });

  it('rules hit (rule 575 黑屁声优) → severity 4, category rules, prompt includes rules list', async () => {
    const ruleRepo: IRuleRepository = {
      insert: vi.fn(), findById: vi.fn().mockReturnValue(null),
      getAll: vi.fn().mockReturnValue([{ id: 575, groupId: GROUP_ID, content: '禁止黑屁声优', type: 'positive', source: 'manual', embedding: null }]),
      getPage: vi.fn().mockReturnValue({ rules: [], total: 0 }),
    };
    const claude: IClaudeClient = {
      complete: vi.fn(), describeImage: vi.fn(),
      visionWithPrompt: vi.fn().mockResolvedValue(JSON.stringify({ violation: true, severity: 4, reason: '黑屁声优', category: 'rules', components_seen: [], rule_id: 575 })),
    } as unknown as IClaudeClient;
    const mod = new ModeratorModule(claude, makeAdapter(), makeMessageRepo(), makeModerationRepo(), makeConfigRepo(), ruleRepo, null, makeImageCache());

    const verdict = await mod.assessImage(makeTarget(), makeImageBytes());

    expect(verdict.violation).toBe(true);
    expect(verdict.severity).toBe(4);
    expect(verdict.reason).toBe('黑屁声优');
    // Verify rules were included in prompt
    const promptArg = (claude.visionWithPrompt as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string;
    expect(promptArg).toContain('禁止黑屁声优');
    expect(promptArg).toContain('[规则575]');
  });

  it('malformed JSON → fail-safe returns violation=false', async () => {
    const claude = {
      complete: vi.fn(), describeImage: vi.fn(),
      visionWithPrompt: vi.fn().mockResolvedValue('not json at all'),
    } as unknown as IClaudeClient;
    const mod = makeModule(claude);
    const verdict = await mod.assessImage(makeTarget(), makeImageBytes());

    expect(verdict.violation).toBe(false);
    expect(verdict.severity).toBeNull();
  });

  it('vision API throws → fail-safe returns violation=false', async () => {
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
    const cached: ImageModVerdict = { fileKey: FILE_KEY, violation: true, severity: 4, reason: '310110前缀', ruleId: null, createdAt: Math.floor(Date.now() / 1000) };
    const imageCache = makeImageCache(cached);
    const claude = makeClaudeVision({ violation: false, severity: null, reason: '', components_seen: [] });
    const mod = makeModule(claude, { imageCache });

    const verdict = await mod.assessImage(makeTarget(), makeImageBytes());

    expect(verdict.violation).toBe(true);
    expect(verdict.reason).toBe('310110前缀');
    expect((claude.visionWithPrompt as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('cache miss: calls vision, stores result in cache', async () => {
    const imageCache = makeImageCache(null);
    const claude = makeClaudeVision({ violation: true, severity: 4, reason: '310110', components_seen: ['310110'] });
    const mod = makeModule(claude, { imageCache });

    await mod.assessImage(makeTarget(), makeImageBytes());

    expect((claude.visionWithPrompt as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((imageCache.set as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const stored = (imageCache.set as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ImageModVerdict;
    expect(stored.fileKey).toBe(FILE_KEY);
    expect(stored.violation).toBe(true);
  });

  it('no rate limit: every uncached check calls vision (cap removed)', async () => {
    const imageCache = makeImageCache(null); // always miss
    const claude = makeClaudeVision({ violation: false, severity: null, reason: '', components_seen: [] });
    const mod = makeModule(claude, { imageCache });

    for (let i = 0; i < 150; i++) {
      await mod.assessImage({ ...makeTarget(), fileKey: `key-${i}` }, makeImageBytes());
    }

    expect((claude.visionWithPrompt as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(150);
  });

  it('cache TTL is ~1h: purgeOlderThan called with cutoff ~3600s ago', async () => {
    const imageCache = makeImageCache(null);
    const claude = makeClaudeVision({ violation: false, severity: null, reason: '', components_seen: [] });
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

function makeModerationForRouter(): IModerationRepository {
  return {
    insert: vi.fn().mockReturnValue({ id: 1 }),
    findById: vi.fn(), findByMsgId: vi.fn(),
    findRecentByUser: vi.fn().mockReturnValue([]), findRecentByGroup: vi.fn(),
    findPendingAppeal: vi.fn(), update: vi.fn(), countWarnsByUser: vi.fn(),
  } as unknown as IModerationRepository;
}

function makeDb(groupConfig?: Partial<GroupConfig>, moderationRepo?: IModerationRepository): Database {
  const cfg: GroupConfig = {
    groupId: GROUP_ID, enabledModules: [], autoMod: true,
    dailyPunishmentLimit: 10, punishmentsToday: 0,
    punishmentsResetDate: '', mimicActiveUserId: null, mimicStartedBy: null,
    chatTriggerKeywords: [], chatTriggerAtOnly: false, chatDebounceMs: 2000,
    modConfidenceThreshold: 0.7, modWhitelist: [], appealWindowHours: 24,
    kickConfirmModel: 'claude-opus-4-6', createdAt: '', updatedAt: '',
    idGuardEnabled: false,
    welcomeEnabled: true,
    ...groupConfig,
  };
  return {
    groupConfig: { get: vi.fn().mockReturnValue(cfg), upsert: vi.fn(), incrementPunishments: vi.fn(), resetDailyPunishments: vi.fn() },
    messages: { insert: vi.fn(), getRecent: vi.fn().mockReturnValue([]), getByUser: vi.fn(), sampleRandomHistorical: vi.fn(), searchByKeywords: vi.fn(), getTopUsers: vi.fn(), softDelete: vi.fn() },
    users: { upsert: vi.fn() },
    moderation: moderationRepo ?? makeModerationForRouter(),
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

async function dispatchAndWait(router: Router, msg: GroupMessage, mod: { assessImage: ReturnType<typeof vi.fn> }): Promise<void> {
  let resolveAssess!: () => void;
  const assessDone = new Promise<void>(r => { resolveAssess = r; });
  const origImpl = mod.assessImage.getMockImplementation();
  mod.assessImage.mockImplementationOnce(async (...args) => {
    const result = origImpl ? await origImpl(...args) : { violation: false, severity: null, reason: '', confidence: 1 };
    resolveAssess();
    return result;
  });
  await router.dispatch(msg);
  await assessDone;
  await new Promise(r => setImmediate(r));
}

describe('Router image moderation — severity routing', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('severity 5 (full ID): deleteMsg called immediately, moderation.insert, no pendingModeration.queue', async () => {
    const moderation = makeModerationForRouter();
    const db = makeDb({ autoMod: true }, moderation);
    const adapter = makeAdapter();
    const router = new Router(db, adapter, makeRateLimiter(), 'bot-id');

    const mod = {
      assess: vi.fn().mockResolvedValue({ violation: false, severity: null, reason: '', confidence: 1 }),
      assessImage: vi.fn().mockResolvedValue({ violation: true, severity: 5, reason: '含完整身份证号', confidence: 1 }),
    } as unknown as ModeratorModule;
    router.setModerator(mod);

    await dispatchAndWait(router, makeGroupMsg(), mod as unknown as { assessImage: ReturnType<typeof vi.fn> });

    expect((adapter.deleteMsg as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('msg-img-1');
    expect((moderation.insert as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.objectContaining({ severity: 5, action: 'delete' }));
    expect((db.pendingModeration.queue as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((adapter.sendPrivateMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('severity 4 (310110 prefix): no deleteMsg, pendingModeration.queue, DM sent', async () => {
    const moderation = makeModerationForRouter();
    const db = makeDb({ autoMod: true }, moderation);
    const adapter = makeAdapter();
    const router = new Router(db, adapter, makeRateLimiter(), 'bot-id');

    const mod = {
      assess: vi.fn().mockResolvedValue({ violation: false, severity: null, reason: '', confidence: 1 }),
      assessImage: vi.fn().mockResolvedValue({ violation: true, severity: 4, reason: '310110前缀', confidence: 1 }),
    } as unknown as ModeratorModule;
    router.setModerator(mod);

    await dispatchAndWait(router, makeGroupMsg(), mod as unknown as { assessImage: ReturnType<typeof vi.fn> });

    expect((adapter.deleteMsg as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((moderation.insert as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((db.pendingModeration.queue as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((adapter.sendPrivateMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('severity 2 (single fragment): no deleteMsg, no pendingModeration.queue, moderation.insert with action=none', async () => {
    const moderation = makeModerationForRouter();
    const db = makeDb({ autoMod: true }, moderation);
    const adapter = makeAdapter();
    const router = new Router(db, adapter, makeRateLimiter(), 'bot-id');

    const mod = {
      assess: vi.fn().mockResolvedValue({ violation: false, severity: null, reason: '', confidence: 1 }),
      assessImage: vi.fn().mockResolvedValue({ violation: true, severity: 2, reason: '1997单独出现', confidence: 1 }),
    } as unknown as ModeratorModule;
    router.setModerator(mod);

    await dispatchAndWait(router, makeGroupMsg(), mod as unknown as { assessImage: ReturnType<typeof vi.fn> });

    expect((adapter.deleteMsg as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((db.pendingModeration.queue as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((moderation.insert as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.objectContaining({ severity: 2, action: 'none' }));
    expect((adapter.sendPrivateMessage as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('violation: false → no action', async () => {
    const moderation = makeModerationForRouter();
    const db = makeDb({ autoMod: true }, moderation);
    const adapter = makeAdapter();
    const router = new Router(db, adapter, makeRateLimiter(), 'bot-id');

    const mod = {
      assess: vi.fn().mockResolvedValue({ violation: false, severity: null, reason: '', confidence: 1 }),
      assessImage: vi.fn().mockResolvedValue({ violation: false, severity: null, reason: '', confidence: 1 }),
    } as unknown as ModeratorModule;
    router.setModerator(mod);

    await dispatchAndWait(router, makeGroupMsg(), mod as unknown as { assessImage: ReturnType<typeof vi.fn> });

    expect((adapter.deleteMsg as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((db.pendingModeration.queue as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((moderation.insert as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('rules hit severity 4 (category=rules): no deleteMsg, pendingModeration.queue, DM sent', async () => {
    const moderation = makeModerationForRouter();
    const db = makeDb({ autoMod: true }, moderation);
    const adapter = makeAdapter();
    const router = new Router(db, adapter, makeRateLimiter(), 'bot-id');

    const mod = {
      assess: vi.fn().mockResolvedValue({ violation: false, severity: null, reason: '', confidence: 1 }),
      assessImage: vi.fn().mockResolvedValue({ violation: true, severity: 4, reason: '黑屁声优', confidence: 1 }),
    } as unknown as ModeratorModule;
    router.setModerator(mod);

    await dispatchAndWait(router, makeGroupMsg(), mod as unknown as { assessImage: ReturnType<typeof vi.fn> });

    expect((adapter.deleteMsg as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
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
