import { describe, it, expect, vi } from 'vitest';
import { IdCardGuard, containsIdCardNumber, extractIdCards } from '../src/modules/id-guard.js';
import type { INapCatAdapter } from '../src/adapter/napcat.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import type { IModerationRepository, IPendingModerationRepository } from '../src/storage/db.js';
import type { VisionService } from '../src/modules/vision.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

// ── Regex unit tests ──────────────────────────────────────────────────────────

describe('containsIdCardNumber', () => {
  it('detects 18-digit PRC ID in text', () => {
    expect(containsIdCardNumber('我的身份证是310110199701093724')).toBe(true);
  });

  it('returns false for a 10-digit number (too short)', () => {
    expect(containsIdCardNumber('1234567890')).toBe(false);
  });

  it('returns true for province code starting with 9 (regex is format-only, not semantic)', () => {
    // Regex validates format, not province code semantics — first digit [1-9] is accepted
    expect(containsIdCardNumber('999999199901011234')).toBe(true);
  });

  it('returns true for Feb 30 (regex is format-only, not calendar-aware)', () => {
    // Regex validates digit structure, not whether the date is calendrically valid
    expect(containsIdCardNumber('110101199902301234')).toBe(true);
  });

  it('detects ID with X check digit', () => {
    expect(containsIdCardNumber('31011019970109372X')).toBe(true);
  });

  it('detects ID with lowercase x check digit', () => {
    expect(containsIdCardNumber('31011019970109372x')).toBe(true);
  });

  it('returns false for 19-digit number (too long — word boundary blocks)', () => {
    expect(containsIdCardNumber('1234567890123456789')).toBe(false);
  });

  it('returns false for plain text with no digits', () => {
    expect(containsIdCardNumber('hello world')).toBe(false);
  });

  it('detects 15-digit legacy ID', () => {
    // 6 province + 6 YYMMDD + 3 seq
    expect(containsIdCardNumber('310110970109372')).toBe(true);
  });
});

describe('extractIdCards', () => {
  it('extracts multiple IDs from text', () => {
    const text = '310110199701093724 and 31011019970109372X';
    const result = extractIdCards(text);
    expect(result.length).toBe(2);
  });

  it('deduplicates identical IDs', () => {
    const id = '310110199701093724';
    expect(extractIdCards(`${id} ${id}`)).toHaveLength(1);
  });
});

// ── IdCardGuard integration tests ─────────────────────────────────────────────

const BOT_ID = 'bot-42';
const ADMIN_ID = 'admin-99';
const GROUP_ID = 'g1';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1', groupId: GROUP_ID, userId: 'u1',
    nickname: 'Alice', role: 'member',
    content: 'hello', rawContent: 'hello',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeAdapter(): INapCatAdapter {
  return {
    connect: vi.fn(), disconnect: vi.fn(), on: vi.fn(),
    send: vi.fn().mockResolvedValue(42),
    ban: vi.fn(), kick: vi.fn(),
    deleteMsg: vi.fn().mockResolvedValue(undefined),
    sendPrivate: vi.fn(), sendPrivateMessage: vi.fn().mockResolvedValue(42),
    getGroupNotices: vi.fn(), getImage: vi.fn(), getGroupInfo: vi.fn(),
  } as unknown as INapCatAdapter;
}

function makeModeration(): IModerationRepository {
  return {
    insert: vi.fn().mockReturnValue({ id: 1 }),
    findById: vi.fn(), findByMsgId: vi.fn(),
    findRecentByUser: vi.fn(), findRecentByGroup: vi.fn(),
    findPendingAppeal: vi.fn(), update: vi.fn(),
    countWarnsByUser: vi.fn(),
  } as unknown as IModerationRepository;
}

function makePendingModeration(): IPendingModerationRepository {
  return {
    queue: vi.fn().mockReturnValue(1),
    getById: vi.fn(), markStatus: vi.fn(),
    expireOlderThan: vi.fn(), listPending: vi.fn(),
  } as unknown as IPendingModerationRepository;
}

function makeVision(result: { what: 'full-id' | 'region-prefix'; evidence: string } | null = null): VisionService {
  return {
    checkKnownLeaks: vi.fn().mockResolvedValue(result),
    describeFromMessage: vi.fn().mockResolvedValue(''),
    extractFileToken: vi.fn(),
    fileKey: vi.fn(),
  } as unknown as VisionService;
}

function makeGuard(opts: {
  adapter?: INapCatAdapter;
  moderation?: IModerationRepository;
  pendingModeration?: IPendingModerationRepository;
  vision?: VisionService;
  enabled?: boolean;
} = {}): { guard: IdCardGuard; adapter: INapCatAdapter; moderation: IModerationRepository; pendingModeration: IPendingModerationRepository; vision: VisionService } {
  const adapter = opts.adapter ?? makeAdapter();
  const moderation = opts.moderation ?? makeModeration();
  const pendingModeration = opts.pendingModeration ?? makePendingModeration();
  const vision = opts.vision ?? makeVision();
  const enabled = opts.enabled ?? true;
  const guard = new IdCardGuard({
    adapter, moderation, pendingModeration, vision,
    adminUserId: ADMIN_ID,
    botUserId: BOT_ID,
    enabled: () => enabled,
  });
  return { guard, adapter, moderation, pendingModeration, vision };
}

describe('IdCardGuard — text path', () => {
  it('blocks text with 18-digit ID: deleteMsg called, moderation_log written', async () => {
    const { guard, adapter, moderation } = makeGuard();
    const msg = makeMsg({ content: '我的身份证是310110199701093724', rawContent: '我的身份证是310110199701093724' });
    const blocked = await guard.check(msg);

    expect(blocked).toBe(true);
    expect(adapter.deleteMsg).toHaveBeenCalledWith('m1');
    expect(moderation.insert).toHaveBeenCalledWith(expect.objectContaining({
      violation: true, severity: 5, action: 'delete',
    }));
  });

  it('blocks text with 15-digit legacy ID', async () => {
    const { guard, adapter } = makeGuard();
    const msg = makeMsg({ content: '旧身份证: 310110970109372', rawContent: '旧身份证: 310110970109372' });
    const blocked = await guard.check(msg);

    expect(blocked).toBe(true);
    expect(adapter.deleteMsg).toHaveBeenCalled();
  });

  it('does not block short number like "10086"', async () => {
    const { guard, adapter } = makeGuard();
    const msg = makeMsg({ content: '打10086', rawContent: '打10086' });
    const blocked = await guard.check(msg);

    expect(blocked).toBe(false);
    expect(adapter.deleteMsg).not.toHaveBeenCalled();
  });

  it('does not block 19-digit number (too long)', async () => {
    const { guard, adapter } = makeGuard();
    const msg = makeMsg({ content: '1234567890123456789', rawContent: '1234567890123456789' });
    const blocked = await guard.check(msg);

    expect(blocked).toBe(false);
    expect(adapter.deleteMsg).not.toHaveBeenCalled();
  });

  it('does not block clean message — no adapter calls', async () => {
    const { guard, adapter } = makeGuard();
    const msg = makeMsg({ content: '今天天气真好', rawContent: '今天天气真好' });
    const blocked = await guard.check(msg);

    expect(blocked).toBe(false);
    expect(adapter.deleteMsg).not.toHaveBeenCalled();
  });

  it('does not block when guard is disabled via config', async () => {
    const { guard, adapter } = makeGuard({ enabled: false });
    const msg = makeMsg({ content: '310110199701093724', rawContent: '310110199701093724' });
    const blocked = await guard.check(msg);

    expect(blocked).toBe(false);
    expect(adapter.deleteMsg).not.toHaveBeenCalled();
  });

  it('text with multiple IDs: blocked once, deleteMsg called once', async () => {
    const { guard, adapter } = makeGuard();
    const msg = makeMsg({
      content: '310110199701093724 and 31011019970109372X',
      rawContent: '310110199701093724 and 31011019970109372X',
    });
    const blocked = await guard.check(msg);

    expect(blocked).toBe(true);
    expect(adapter.deleteMsg).toHaveBeenCalledTimes(1);
  });

  it('skips check entirely for bot own messages', async () => {
    const { guard, adapter } = makeGuard();
    const msg = makeMsg({ userId: BOT_ID, content: '310110199701093724', rawContent: '310110199701093724' });
    const blocked = await guard.check(msg);

    expect(blocked).toBe(false);
    expect(adapter.deleteMsg).not.toHaveBeenCalled();
  });
});

describe('IdCardGuard — image path', () => {
  const IMAGE_RAW = '[CQ:image,file=abc.image,url=http://example.com/img.jpg]';

  it('full-id hit: deleteMsg called, moderation insert, no pendingModeration.queue', async () => {
    const vision = makeVision({ what: 'full-id', evidence: '图中含完整身份证号' });
    const { guard, adapter, moderation, pendingModeration } = makeGuard({ vision });
    const msg = makeMsg({ content: '', rawContent: IMAGE_RAW });
    const blocked = await guard.check(msg);

    expect(blocked).toBe(true);
    expect(adapter.deleteMsg).toHaveBeenCalledWith('m1');
    expect(moderation.insert).toHaveBeenCalledWith(expect.objectContaining({ severity: 5, action: 'delete' }));
    expect(pendingModeration.queue).not.toHaveBeenCalled();
  });

  it('region-prefix hit: no deleteMsg, pendingModeration.queue(severity:4), sendPrivateMessage to admin', async () => {
    const vision = makeVision({ what: 'region-prefix', evidence: '图中含310110前缀' });
    const { guard, adapter, moderation, pendingModeration } = makeGuard({ vision });
    const msg = makeMsg({ content: '', rawContent: IMAGE_RAW });
    const blocked = await guard.check(msg);

    expect(blocked).toBe(true);
    expect(adapter.deleteMsg).not.toHaveBeenCalled();
    expect(moderation.insert).not.toHaveBeenCalled();
    expect(pendingModeration.queue).toHaveBeenCalledWith(expect.objectContaining({ severity: 4, proposedAction: 'delete' }));
    expect(adapter.sendPrivateMessage).toHaveBeenCalledWith(ADMIN_ID, expect.stringContaining('310110'));
  });

  it('vision returns null: message not blocked', async () => {
    const vision = makeVision(null);
    const { guard, adapter, pendingModeration } = makeGuard({ vision });
    const msg = makeMsg({ content: '', rawContent: IMAGE_RAW });
    const blocked = await guard.check(msg);

    expect(blocked).toBe(false);
    expect(adapter.deleteMsg).not.toHaveBeenCalled();
    expect(pendingModeration.queue).not.toHaveBeenCalled();
  });

  it('vision throws: fail-safe, message not blocked', async () => {
    const vision = {
      checkKnownLeaks: vi.fn().mockRejectedValue(new Error('vision API error')),
      describeFromMessage: vi.fn(),
    } as unknown as VisionService;
    const { guard, adapter, pendingModeration } = makeGuard({ vision });
    const msg = makeMsg({ content: '', rawContent: IMAGE_RAW });
    const blocked = await guard.check(msg);

    expect(blocked).toBe(false);
    expect(adapter.deleteMsg).not.toHaveBeenCalled();
    expect(pendingModeration.queue).not.toHaveBeenCalled();
  });

  it('image-only message with no CQ code is not checked via vision', async () => {
    const vision = makeVision({ what: 'full-id', evidence: 'test' });
    const { guard, adapter } = makeGuard({ vision });
    const msg = makeMsg({ content: '', rawContent: 'just plain text no image' });
    const blocked = await guard.check(msg);

    expect(blocked).toBe(false);
    expect(vision.checkKnownLeaks).not.toHaveBeenCalled();
    expect(adapter.deleteMsg).not.toHaveBeenCalled();
  });
});
