import { describe, it, expect, vi } from 'vitest';
import { IdCardGuard, containsIdCardNumber, extractIdCards } from '../src/modules/id-guard.js';
import type { INapCatAdapter } from '../src/adapter/napcat.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import type { IModerationRepository } from '../src/storage/db.js';
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

function makeGuard(opts: {
  adapter?: INapCatAdapter;
  moderation?: IModerationRepository;
  enabled?: boolean;
} = {}): { guard: IdCardGuard; adapter: INapCatAdapter; moderation: IModerationRepository } {
  const adapter = opts.adapter ?? makeAdapter();
  const moderation = opts.moderation ?? makeModeration();
  const enabled = opts.enabled ?? true;
  const guard = new IdCardGuard({
    adapter, moderation,
    botUserId: BOT_ID,
    enabled: () => enabled,
  });
  return { guard, adapter, moderation };
}

describe('IdCardGuard', () => {
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

  it('image-only message (no text ID) is not blocked — image moderation is delegated to assessImage', async () => {
    const { guard, adapter } = makeGuard();
    const msg = makeMsg({
      content: '',
      rawContent: '[CQ:image,file=abc.image,url=http://example.com/img.jpg]',
    });
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
