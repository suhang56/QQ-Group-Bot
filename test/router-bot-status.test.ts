import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from '../src/core/router.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { Database } from '../src/storage/db.js';
import { defaultGroupConfig } from '../src/config.js';
import type { PrivateMessage, INapCatAdapter } from '../src/adapter/napcat.js';
import type { IChatModule } from '../src/modules/chat.js';
import type { IFatigueSource } from '../src/modules/fatigue.js';
import { AffinityModule } from '../src/modules/affinity.js';
import { MoodTracker } from '../src/modules/mood.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const ADMIN = process.env['MOD_APPROVAL_ADMIN'] ?? '2331924739';
const GROUP = 'g-bot-status';

function makeAdapter(): INapCatAdapter {
  return {
    connect: vi.fn(), disconnect: vi.fn(), on: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    ban: vi.fn().mockResolvedValue(undefined),
    kick: vi.fn().mockResolvedValue(undefined),
    deleteMsg: vi.fn().mockResolvedValue(undefined),
    sendPrivate: vi.fn().mockResolvedValue(undefined),
    sendPrivateMessage: vi.fn().mockResolvedValue(42),
    getGroupNotices: vi.fn().mockResolvedValue([]),
    getGroupInfo: vi.fn().mockResolvedValue({ groupId: GROUP, name: 'g', description: '', memberCount: 1 }),
    getImage: vi.fn().mockResolvedValue({ filename: '', url: '', size: 0 }),
  } as unknown as INapCatAdapter;
}

function makePrivate(text: string, userId = ADMIN): PrivateMessage {
  return {
    messageId: 'm' + Math.random().toString(36).slice(2),
    userId,
    nickname: userId === ADMIN ? 'admin' : 'user',
    content: text,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

function makeFakeChat(): IChatModule & {
  _consecutive: Map<string, number>;
  _activity: Map<string, 'idle' | 'normal' | 'busy'>;
  _mood: MoodTracker;
} {
  const consecutive = new Map<string, number>();
  const activity = new Map<string, 'idle' | 'normal' | 'busy'>();
  const mood = new MoodTracker();
  return {
    generateReply: vi.fn().mockResolvedValue(null),
    generatePrivateReply: vi.fn().mockResolvedValue(null),
    recordOutgoingMessage: vi.fn(),
    markReplyToUser: vi.fn(),
    invalidateLore: vi.fn(),
    getLastStickerKey: vi.fn().mockReturnValue(null),
    tickStickerRefresh: vi.fn(),
    getMoodTracker: () => mood,
    noteAdminActivity: vi.fn(),
    getEvasiveFlagForLastReply: () => false,
    getInjectedFactIdsForLastReply: () => [],
    getConsecutiveReplies: (gid: string) => consecutive.get(gid) ?? 0,
    getActivityLevel: (gid: string) => activity.get(gid) ?? 'normal',
    _consecutive: consecutive,
    _activity: activity,
    _mood: mood,
  } as unknown as IChatModule & {
    _consecutive: Map<string, number>;
    _activity: Map<string, 'idle' | 'normal' | 'busy'>;
    _mood: MoodTracker;
  };
}

function makeFakeFatigue(score: number | null): IFatigueSource | null {
  if (score === null) return null;
  return {
    onReply: vi.fn(),
    getRawScore: () => score,
    getPenalty: () => 0,
  };
}

function lastReply(adapter: INapCatAdapter): string {
  const calls = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls;
  return calls.at(-1)?.[1] as string;
}

describe('Router — M9.4 /bot_status', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let router: Router;
  let rl: RateLimiter;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = makeAdapter();
    rl = new RateLimiter();
    router = new Router(db, adapter, rl);
    db.groupConfig.upsert(defaultGroupConfig(GROUP));
  });

  it('non-admin DM → ignored entirely (no data leaked)', async () => {
    const chat = makeFakeChat();
    router.setChat(chat);
    router.setAffinity(new AffinityModule(db.rawDb));
    router.setFatigue(makeFakeFatigue(2.5)!);

    await router.dispatchPrivate(makePrivate('/bot_status', 'random-user-123'));
    // dispatchPrivate's unauthorized-path returns before any send — no DM at all
    expect(adapter.sendPrivateMessage).not.toHaveBeenCalled();
  });

  it('rate limit: 11th call within 60s returns cooldown message, does NOT query data', async () => {
    const chat = makeFakeChat();
    router.setChat(chat);
    const affinity = new AffinityModule(db.rawDb);
    const listSpy = vi.spyOn(affinity, 'listTopN');
    router.setAffinity(affinity);

    for (let i = 0; i < 10; i++) {
      await router.dispatchPrivate(makePrivate(`/bot_status ${GROUP}`));
    }
    const callsBefore = listSpy.mock.calls.length;

    await router.dispatchPrivate(makePrivate(`/bot_status ${GROUP}`));
    const replyText = lastReply(adapter);
    expect(replyText).toMatch(/操作太频繁/);
    // Data layer should NOT be called on the rate-limited attempt
    expect(listSpy.mock.calls.length).toBe(callsBefore);
  });

  it('no groupId arg + empty ACTIVE_GROUPS (fresh db, no group_config) → usage hint', async () => {
    // Fresh DB with no group_config rows → _defaultReviewGroupId returns null
    const freshDb = new Database(':memory:');
    const freshRouter = new Router(freshDb, adapter, new RateLimiter());
    await freshRouter.dispatchPrivate(makePrivate('/bot_status'));
    const replyText = lastReply(adapter);
    expect(replyText).toMatch(/用法/);
  });

  it('zero affinity rows → renders "(无)"', async () => {
    const chat = makeFakeChat();
    router.setChat(chat);
    router.setAffinity(new AffinityModule(db.rawDb));

    await router.dispatchPrivate(makePrivate(`/bot_status ${GROUP}`));
    const replyText = lastReply(adapter);
    expect(replyText).toContain('affinity top3: (无)');
  });

  it('group never touched (no mood state) → getMood returns default v=0 a=0, no crash', async () => {
    const chat = makeFakeChat();
    router.setChat(chat);
    router.setAffinity(new AffinityModule(db.rawDb));

    await router.dispatchPrivate(makePrivate(`/bot_status ${GROUP}`));
    const replyText = lastReply(adapter);
    expect(replyText).toContain('mood: v=0.00 a=0.00');
  });

  it('zero persona patches in 7d → "7天内无提案"', async () => {
    const chat = makeFakeChat();
    router.setChat(chat);

    await router.dispatchPrivate(makePrivate(`/bot_status ${GROUP}`));
    const replyText = lastReply(adapter);
    expect(replyText).toContain('persona: 7天内无提案');
  });

  it('>5 persona patches in 7d → exactly 5 shown', async () => {
    const chat = makeFakeChat();
    router.setChat(chat);
    const nowSec = Math.floor(Date.now() / 1000);
    const ids: number[] = [];
    for (let i = 0; i < 8; i++) {
      ids.push(db.personaPatches.insert({
        groupId: GROUP,
        oldPersonaText: 'old',
        newPersonaText: `new-${i}`,
        reasoning: `r${i}`,
        diffSummary: `d${i}`,
        createdAt: nowSec - i * 3600,
      }));
    }

    await router.dispatchPrivate(makePrivate(`/bot_status ${GROUP}`));
    const replyText = lastReply(adapter);
    const hashCount = (replyText.match(/#\d+/g) ?? []).length;
    expect(hashCount).toBe(5);
    // The 5 most recent (smallest i) should appear, the 3 oldest (largest i) should not
    expect(replyText).toContain(`#${ids[0]}`);
    expect(replyText).toContain(`#${ids[4]}`);
    expect(replyText).not.toContain(`#${ids[7]}`);
  });

  it('fatigue never set (null) → line omitted, no crash', async () => {
    const chat = makeFakeChat();
    router.setChat(chat);
    router.setAffinity(new AffinityModule(db.rawDb));
    // deliberately DO NOT call router.setFatigue

    await router.dispatchPrivate(makePrivate(`/bot_status ${GROUP}`));
    const replyText = lastReply(adapter);
    expect(replyText).not.toContain('fatigue:');
    expect(replyText).toContain('bot_status');
  });

  it('fatigue wired → rendered with threshold', async () => {
    const chat = makeFakeChat();
    router.setChat(chat);
    router.setFatigue(makeFakeFatigue(3.14)!);

    await router.dispatchPrivate(makePrivate(`/bot_status ${GROUP}`));
    const replyText = lastReply(adapter);
    expect(replyText).toContain('fatigue: 3.14 / 阈值 4.0');
  });

  it('output >1500 chars → truncated with "...(截断)"', async () => {
    const chat = makeFakeChat();
    router.setChat(chat);
    // Stuff many persona patches so the persona block alone blows past 1500 chars.
    // Each line is ~22 chars → we need ~70+ rows, but listHistory is capped at 5,
    // so instead use a giant single reasoning for them (no, we only render id/status/age).
    // Pad `groupId` itself to push the header + group echoes; but simpler:
    // recordInteraction 60 users with short ids → each rendered as `xxxxxx=32, ` ~11 chars
    // inside a single line. Spec only renders top3. So instead, push mood line
    // by making the groupId itself long (it's echoed in header + persona label).
    const longGroup = 'G' + 'x'.repeat(1600);
    db.groupConfig.upsert(defaultGroupConfig(longGroup));
    router.setAffinity(new AffinityModule(db.rawDb));

    await router.dispatchPrivate(makePrivate(`/bot_status ${longGroup}`));
    const replyText = lastReply(adapter);
    expect(replyText.length).toBeLessThanOrEqual(1500);
    expect(replyText).toContain('...(截断)');
  });

  it('affinity.listTopN on empty table → returns [] and no throw', () => {
    const aff = new AffinityModule(db.rawDb);
    expect(aff.listTopN(GROUP, 3)).toEqual([]);
    expect(aff.listTopN(GROUP, 0)).toEqual([]);
  });

  it('two admins rate-limited independently (per-user bucket)', async () => {
    const chat = makeFakeChat();
    router.setChat(chat);
    router.setAffinity(new AffinityModule(db.rawDb));

    // Admin exhausts their bucket
    for (let i = 0; i < 10; i++) {
      await router.dispatchPrivate(makePrivate(`/bot_status ${GROUP}`));
    }
    await router.dispatchPrivate(makePrivate(`/bot_status ${GROUP}`));
    expect(lastReply(adapter)).toMatch(/操作太频繁/);

    // A different user id on the same command: goes through dispatchPrivate's
    // non-admin rejection first and never reaches the rate limiter at all.
    // So to exercise per-user independence at the rateLimiter level, we
    // verify directly:
    expect(rl.checkUser('a-different-admin-id', 'bot_status')).toBe(true);
    expect(rl.checkUser(ADMIN, 'bot_status')).toBe(false);
  });

  it('happy path: all sources wired renders mood + fatigue + affinity + consecutive + activity', async () => {
    const chat = makeFakeChat();
    chat._consecutive.set(GROUP, 7);
    chat._activity.set(GROUP, 'busy');
    // Seed the mood for GROUP so v/a aren't both 0
    chat._mood.updateFromMessage(GROUP, {
      messageId: 1, groupId: GROUP, userId: 'u1', nickname: 'u1',
      content: '哈哈 牛逼', rawContent: '哈哈 牛逼', timestamp: Math.floor(Date.now() / 1000),
    } as never);
    router.setChat(chat);

    const aff = new AffinityModule(db.rawDb);
    aff.recordInteraction(GROUP, '123456abcdef', 'at_friendly');
    router.setAffinity(aff);
    router.setFatigue(makeFakeFatigue(1.23)!);

    await router.dispatchPrivate(makePrivate(`/bot_status ${GROUP}`));
    const replyText = lastReply(adapter);
    expect(replyText).toContain(`=== bot_status 群 ${GROUP} ===`);
    expect(replyText).toMatch(/mood: v=[\d.\-]+ a=[\d.\-]+/);
    expect(replyText).toContain('fatigue: 1.23 / 阈值 4.0');
    expect(replyText).toMatch(/affinity top3: \S+=\d+/);
    expect(replyText).toContain('consecutive_replies: 7');
    expect(replyText).toContain('activity: busy');
  });
});
