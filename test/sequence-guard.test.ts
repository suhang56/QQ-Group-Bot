import { describe, it, expect, vi } from 'vitest';
import { SequenceGuard } from '../src/modules/sequence-guard.js';
import type { INapCatAdapter, GroupMessage } from '../src/adapter/napcat.js';
import type { IPendingModerationRepository } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const GROUP_ID = 'g1';
const BOT_ID = 'bot-42';
const ADMIN_ID = 'admin-99';

let msgCounter = 0;
function makeMsg(content: string, overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: `m${++msgCounter}`,
    groupId: GROUP_ID,
    userId: `u${msgCounter}`,
    nickname: `User${msgCounter}`,
    role: 'member',
    content,
    rawContent: content,
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeAdapter(): INapCatAdapter {
  return {
    connect: vi.fn(), disconnect: vi.fn(), on: vi.fn(),
    send: vi.fn(), ban: vi.fn(), kick: vi.fn(),
    deleteMsg: vi.fn().mockResolvedValue(undefined),
    sendPrivate: vi.fn(),
    sendPrivateMessage: vi.fn().mockResolvedValue(42),
    getGroupNotices: vi.fn(), getImage: vi.fn(), getGroupInfo: vi.fn(),
  } as unknown as INapCatAdapter;
}

function makePending(): IPendingModerationRepository {
  return {
    queue: vi.fn().mockReturnValue(1),
    getById: vi.fn(), markStatus: vi.fn(),
    expireOlderThan: vi.fn(), listPending: vi.fn(),
  } as unknown as IPendingModerationRepository;
}

function makeGuard(adapter?: INapCatAdapter, pending?: IPendingModerationRepository): { guard: SequenceGuard; adapter: INapCatAdapter; pending: IPendingModerationRepository } {
  const a = adapter ?? makeAdapter();
  const p = pending ?? makePending();
  const guard = new SequenceGuard({ adapter: a, pendingModeration: p, adminUserId: ADMIN_ID, botUserId: BOT_ID });
  return { guard, adapter: a, pending: p };
}

describe('SequenceGuard', () => {
  it('single message with full 18-digit ID → hit, buffer cleared', async () => {
    const { guard, pending, adapter } = makeGuard();
    const now = Math.floor(Date.now() / 1000);
    const hit = await guard.check(makeMsg('310110199701093724', { timestamp: now }));

    expect(hit).toBe(true);
    expect(pending.queue).toHaveBeenCalledWith(expect.objectContaining({ severity: 5, proposedAction: 'delete' }));
    expect(adapter.sendPrivateMessage).toHaveBeenCalledWith(ADMIN_ID, expect.stringContaining('310110199701093724'));

    // Buffer should be cleared — next clean message should not re-trigger
    const hit2 = await guard.check(makeMsg('hello', { groupId: GROUP_ID, timestamp: now + 1 }));
    expect(hit2).toBe(false);
    expect(pending.queue).toHaveBeenCalledTimes(1);
  });

  it('two-user relay: 19970 + 1093724 → hit on second message (199701093724 target)', async () => {
    const { guard, pending } = makeGuard();
    const now = Math.floor(Date.now() / 1000);

    // Neither part alone contains any target:
    // "19970" (5d): no match for 310110/199701093724/19970109/full-ID
    // "1093724" (7d): no match for any target
    // Combined "199701093724" → matches target "199701093724"
    const hit1 = await guard.check(makeMsg('19970', { groupId: GROUP_ID, userId: 'u-a', timestamp: now }));
    expect(hit1).toBe(false);

    const hit2 = await guard.check(makeMsg('1093724', { groupId: GROUP_ID, userId: 'u-b', timestamp: now + 10 }));
    expect(hit2).toBe(true);
    expect(pending.queue).toHaveBeenCalledWith(expect.objectContaining({ severity: 5 }));
  });

  it('three-user relay across 3 messages → hit on third', async () => {
    const { guard, pending } = makeGuard();
    const now = Math.floor(Date.now() / 1000);

    // Split "199701093724" target across 3 parts:
    // "199" + "7010" + "93724" — none individually matches any target
    // Combined: "199" + "7010" = "1997010" (no target), then + "93724" = "199701093724" (target!)
    await guard.check(makeMsg('199', { groupId: GROUP_ID, userId: 'u-a', timestamp: now }));
    await guard.check(makeMsg('7010', { groupId: GROUP_ID, userId: 'u-b', timestamp: now + 5 }));
    const hit = await guard.check(makeMsg('93724', { groupId: GROUP_ID, userId: 'u-c', timestamp: now + 10 }));

    expect(hit).toBe(true);
    expect(pending.queue).toHaveBeenCalledTimes(1);
  });

  it('5+ minute gap between messages: buffer expires, no hit', async () => {
    const { guard, pending } = makeGuard();
    const now = Math.floor(Date.now() / 1000);

    await guard.check(makeMsg('19970', { groupId: GROUP_ID, userId: 'u-a', timestamp: now }));
    // 6 minutes later — expires the first message
    const hit = await guard.check(makeMsg('1093724', { groupId: GROUP_ID, userId: 'u-b', timestamp: now + 361 }));
    // Only "1093724" remains in buffer — "1093724" alone is no target

    expect(hit).toBe(false);
    expect(pending.queue).not.toHaveBeenCalled();
  });

  it('unrelated digit chatter (dates, scores) → no hit', async () => {
    const { guard, pending } = makeGuard();
    const now = Math.floor(Date.now() / 1000);

    // Use digit sequences that clearly cannot form any target even concatenated
    let t = now;
    for (const content of ['今天2024年', '比分32', '电话82345678', '门牌号88号']) {
      const hit = await guard.check(makeMsg(content, { groupId: GROUP_ID, timestamp: t++ }));
      expect(hit).toBe(false);
    }
    // Concatenated digits: "2024" + "32" + "82345678" + "88" = "20243282345678 88" — no target
    expect(pending.queue).not.toHaveBeenCalled();
  });

  it('buffer cap: 20+ messages, stale digits drop off → no false hit', async () => {
    const { guard, pending } = makeGuard();
    const now = Math.floor(Date.now() / 1000);

    // Push "19970" (start of target "199701093724") then fill the buffer past capacity to evict it
    await guard.check(makeMsg('19970', { groupId: GROUP_ID, userId: 'u-start', timestamp: now }));

    // Push 15 filler messages (digits "00" — safe) to push "19970" off the buffer
    for (let i = 0; i < 15; i++) {
      await guard.check(makeMsg('00', { groupId: GROUP_ID, userId: `u-filler-${i}`, timestamp: now + 1 + i }));
    }
    // Buffer is now [f1..f15 = "00"×15] — "19970" was evicted

    const hit = await guard.check(makeMsg('1093724', { groupId: GROUP_ID, userId: 'u-last', timestamp: now + 16 }));
    // Only "00"×15 + "1093724" in buffer — no target ("1093724" alone doesn't match any target)
    expect(hit).toBe(false);
    expect(pending.queue).not.toHaveBeenCalled();
  });

  it('mixed content: Chinese text with embedded digits → digits extracted correctly', async () => {
    const { guard, pending } = makeGuard();
    const now = Math.floor(Date.now() / 1000);

    await guard.check(makeMsg('来接龙：310', { groupId: GROUP_ID, userId: 'u-a', timestamp: now }));
    const hit = await guard.check(makeMsg('110 不会发的哈哈', { groupId: GROUP_ID, userId: 'u-b', timestamp: now + 5 }));

    // digits so far: "310" + "110" = "310110" → target "310110" matches
    expect(hit).toBe(true);
    expect(pending.queue).toHaveBeenCalledTimes(1);
  });

  it('clear after hit: subsequent messages start fresh buffer', async () => {
    const { guard, pending } = makeGuard();
    const now = Math.floor(Date.now() / 1000);

    // First relay — triggers (neither part individually matches "199701093724")
    await guard.check(makeMsg('19970', { groupId: GROUP_ID, userId: 'u-a', timestamp: now }));
    await guard.check(makeMsg('1093724', { groupId: GROUP_ID, userId: 'u-b', timestamp: now + 5 }));

    expect(pending.queue).toHaveBeenCalledTimes(1);

    // After hit, buffer is cleared. Next single message should not retrigger.
    const hit2 = await guard.check(makeMsg('19970', { groupId: GROUP_ID, userId: 'u-c', timestamp: now + 10 }));
    expect(hit2).toBe(false); // fresh buffer, only "19970" — no target
    expect(pending.queue).toHaveBeenCalledTimes(1); // still only 1
  });

  it('bot own messages are skipped', async () => {
    const { guard, pending } = makeGuard();
    const now = Math.floor(Date.now() / 1000);

    const hit = await guard.check(makeMsg('310110199701093724', { groupId: GROUP_ID, userId: BOT_ID, timestamp: now }));
    expect(hit).toBe(false);
    expect(pending.queue).not.toHaveBeenCalled();
  });

  it('different groups have isolated buffers', async () => {
    const { guard, pending } = makeGuard();
    const now = Math.floor(Date.now() / 1000);

    // Group 1 sends first part (no target alone)
    await guard.check(makeMsg('19970', { groupId: 'group-1', userId: 'u-a', timestamp: now }));
    // Group 2 sends complementary part — should NOT combine with group 1's buffer
    const hit = await guard.check(makeMsg('1093724', { groupId: 'group-2', userId: 'u-b', timestamp: now + 5 }));
    // group-2 buffer only has "1093724" — no target

    expect(hit).toBe(false);
    expect(pending.queue).not.toHaveBeenCalled();
  });
});
