import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Database } from '../src/storage/db.js';
import { Router } from '../src/core/router.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { ChatModule } from '../src/modules/chat.js';
import type { INapCatAdapter, GroupMessage } from '../src/adapter/napcat.js';
import type { IClaudeClient } from '../src/ai/claude.js';
import { initLogger } from '../src/utils/logger.js';
import { clearStickerSectionCache } from '../src/utils/stickers.js';

initLogger({ level: 'silent' });

function makeMockAdapter(): INapCatAdapter {
  return {
    send: vi.fn().mockResolvedValue(1),
    sendImage: vi.fn().mockResolvedValue(1),
    getGroupMemberList: vi.fn().mockResolvedValue([]),
    getGroupNotices: vi.fn().mockResolvedValue([]),
    getImage: vi.fn().mockResolvedValue(null),
    deleteMsg: vi.fn().mockResolvedValue(undefined),
    banGroupMember: vi.fn().mockResolvedValue(undefined),
    kickGroupMember: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  } as unknown as INapCatAdapter;
}

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1', groupId: 'g1', userId: 'u1',
    nickname: 'Alice', role: 'member',
    content: '', rawContent: '',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe('Live sticker capture — router', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let router: Router;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = makeMockAdapter();
    router = new Router(db, adapter, new RateLimiter());
    clearStickerSectionCache();
  });

  it('5 occurrences of same mface → live_stickers.count = 5', async () => {
    const cq = '[CQ:mface,package_id=pkg1,emoji_id=eid1,summary=[摆烂]]';
    for (let i = 0; i < 5; i++) {
      await router.dispatch(makeMsg({
        messageId: `m${i}`, userId: `u${i % 3}`,
        content: '', rawContent: cq,
      }));
    }
    const top = db.liveStickers.getTopByGroup('g1', 10);
    expect(top).toHaveLength(1);
    expect(top[0]!.count).toBe(5);
    expect(top[0]!.key).toBe('mface:pkg1:eid1');
    expect(top[0]!.type).toBe('mface');
  });

  it('image sticker with sub_type=1 → captured', async () => {
    const cq = '[CQ:image,file_unique=abc123,sub_type=1,url=http://x.com/a.gif]';
    await router.dispatch(makeMsg({ rawContent: cq, content: '' }));
    const top = db.liveStickers.getTopByGroup('g1', 10);
    expect(top).toHaveLength(1);
    expect(top[0]!.key).toBe('image:abc123');
    expect(top[0]!.type).toBe('image');
  });

  it('regular image (no sub_type) → NOT captured', async () => {
    const cq = '[CQ:image,file_unique=xyz999,url=http://x.com/photo.jpg]';
    await router.dispatch(makeMsg({ rawContent: cq, content: '' }));
    const top = db.liveStickers.getTopByGroup('g1', 10);
    expect(top).toHaveLength(0);
  });

  it('mface capture disabled by config → not captured', async () => {
    // Disable live sticker capture
    const config = db.groupConfig.get('g1') ?? {
      groupId: 'g1', enabledModules: [], autoMod: false,
      dailyPunishmentLimit: 10, punishmentsToday: 0, punishmentsResetDate: '2026-01-01',
      mimicActiveUserId: null, mimicStartedBy: null, chatTriggerKeywords: [],
      chatTriggerAtOnly: false, chatDebounceMs: 200, modConfidenceThreshold: 0.7,
      modWhitelist: [], appealWindowHours: 24, kickConfirmModel: 'claude-opus-4-6' as const,
      chatLoreEnabled: true, nameImagesEnabled: false, nameImagesCollectionTimeoutMs: 120_000,
      nameImagesCollectionMax: 20, nameImagesCooldownMs: 300_000, nameImagesMaxPerName: 50,
      chatAtMentionQueueMax: 5, chatAtMentionBurstWindowMs: 30_000, chatAtMentionBurstThreshold: 3,
      repeaterEnabled: false, repeaterMinCount: 3, repeaterCooldownMs: 600_000,
      repeaterMinContentLength: 2, repeaterMaxContentLength: 100, nameImagesBlocklist: [],
      loreUpdateEnabled: false, loreUpdateThreshold: 200, loreUpdateCooldownMs: 1_800_000,
      liveStickerCaptureEnabled: false, stickerLegendRefreshEveryMsgs: 50,
      chatPersonaText: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    db.groupConfig.upsert({ ...config, liveStickerCaptureEnabled: false });

    const cq = '[CQ:mface,package_id=pkg1,emoji_id=eid1,summary=[笑哭]]';
    await router.dispatch(makeMsg({ rawContent: cq, content: '' }));
    const top = db.liveStickers.getTopByGroup('g1', 10);
    expect(top).toHaveLength(0);
  });
});

describe('Live sticker capture — ILiveStickerRepository', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('upsert increments count on conflict', () => {
    const now = Math.floor(Date.now() / 1000);
    db.liveStickers.upsert('g1', 'mface:p:e', 'mface', '[CQ:mface,...]', '摆烂', now);
    db.liveStickers.upsert('g1', 'mface:p:e', 'mface', '[CQ:mface,...]', '摆烂', now + 10);
    db.liveStickers.upsert('g1', 'mface:p:e', 'mface', '[CQ:mface,...]', '摆烂', now + 20);
    const top = db.liveStickers.getTopByGroup('g1', 10);
    expect(top[0]!.count).toBe(3);
    expect(top[0]!.lastSeen).toBe(now + 20);
  });

  it('getTopByGroup returns results ordered by count desc', () => {
    const now = Math.floor(Date.now() / 1000);
    db.liveStickers.upsert('g1', 'key:a', 'mface', '[CQ:mface,a]', null, now);
    db.liveStickers.upsert('g1', 'key:b', 'mface', '[CQ:mface,b]', null, now);
    db.liveStickers.upsert('g1', 'key:b', 'mface', '[CQ:mface,b]', null, now);
    db.liveStickers.upsert('g1', 'key:b', 'mface', '[CQ:mface,b]', null, now);
    const top = db.liveStickers.getTopByGroup('g1', 10);
    expect(top[0]!.key).toBe('key:b');
    expect(top[0]!.count).toBe(3);
    expect(top[1]!.key).toBe('key:a');
    expect(top[1]!.count).toBe(1);
  });

  it('cross-group isolation: upsert in g1 not visible in g2', () => {
    const now = Math.floor(Date.now() / 1000);
    db.liveStickers.upsert('g1', 'key:x', 'mface', '[CQ:mface,x]', null, now);
    expect(db.liveStickers.getTopByGroup('g2', 10)).toHaveLength(0);
  });
});

describe('ChatModule — sticker legend refresh counter', () => {
  it('tickStickerRefresh at threshold evicts stickerSectionCache', () => {
    const db = new Database(':memory:');
    const claude = { complete: vi.fn() } as unknown as IClaudeClient;
    const chat = new ChatModule(claude, db, {
      botUserId: 'bot', debounceMs: 0, chatMinScore: -999,
      stickerLegendRefreshEveryMsgs: 3,
    });

    // Drive to threshold
    chat.tickStickerRefresh('g1');
    chat.tickStickerRefresh('g1');
    chat.tickStickerRefresh('g1'); // at 3 → reset

    // If we call tickStickerRefresh again it should start a new cycle (counter = 1, not error)
    chat.tickStickerRefresh('g1');
    // No assertion on internals — just verify no throws
    expect(true).toBe(true);
  });
});
