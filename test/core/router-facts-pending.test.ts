import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from '../../src/core/router.js';
import { RateLimiter } from '../../src/core/rateLimiter.js';
import { Database } from '../../src/storage/db.js';
import type { GroupMessage, INapCatAdapter } from '../../src/adapter/napcat.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

const OWNER_USER_ID = '2331924739';

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

function makeAdapter(): INapCatAdapter {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    ban: vi.fn().mockResolvedValue(undefined),
    kick: vi.fn().mockResolvedValue(undefined),
    deleteMsg: vi.fn().mockResolvedValue(undefined),
    sendPrivate: vi.fn().mockResolvedValue(undefined),
    sendPrivateMessage: vi.fn().mockResolvedValue(42),
    getGroupNotices: vi.fn().mockResolvedValue([]),
    getGroupInfo: vi.fn().mockResolvedValue({ groupId: 'g1', name: '', description: '', memberCount: 1 }),
    getImage: vi.fn().mockResolvedValue({ filename: '', url: '', size: 0 }),
  } as unknown as INapCatAdapter;
}

function seedPending(db: Database, groupId: string, count: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const id = db.learnedFacts.insert({
      groupId, topic: null, fact: `pending fact ${i}`,
      sourceUserId: null, sourceUserNickname: null,
      sourceMsgId: null, botReplyId: null,
      confidence: 0.7 + i * 0.01,
      status: 'pending',
    });
    ids.push(id);
  }
  return ids;
}

describe('Router — /facts_pending and /fact_approve', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let router: Router;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = makeAdapter();
    router = new Router(db, adapter, new RateLimiter());
  });

  it('/facts_pending: member role is rejected (silently dropped by router-level gate)', async () => {
    seedPending(db, 'g1', 3);
    await router.dispatch(makeMsg({ content: '/facts_pending', role: 'member' }));
    // openCmds does not include facts_pending → router silently drops for non-admin.
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('/facts_pending: admin sees page 1 by default with id DESC order', async () => {
    const ids = seedPending(db, 'g1', 3);
    await router.dispatch(makeMsg({ content: '/facts_pending', role: 'admin' }));
    expect(adapter.send).toHaveBeenCalledTimes(1);
    const msgText = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(msgText).toContain('待审知识');
    expect(msgText).toContain('共 3 条');
    // Newest first — ids[2] appears before ids[0]
    const posNewest = msgText.indexOf(`[${ids[2]}]`);
    const posOldest = msgText.indexOf(`[${ids[0]}]`);
    expect(posNewest).toBeGreaterThan(-1);
    expect(posOldest).toBeGreaterThan(posNewest);
  });

  it('/facts_pending: owner can also view', async () => {
    seedPending(db, 'g1', 1);
    await router.dispatch(makeMsg({ content: '/facts_pending', role: 'owner' }));
    expect(adapter.send).toHaveBeenCalled();
  });

  it('/facts_pending: empty queue returns friendly message', async () => {
    await router.dispatch(makeMsg({ content: '/facts_pending', role: 'admin' }));
    const msgText = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(msgText).toContain('待审队列为空');
  });

  it('/facts_pending: paginates 10 per page', async () => {
    seedPending(db, 'g1', 25);
    await router.dispatch(makeMsg({ content: '/facts_pending', role: 'admin' }));
    const page1 = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    // Count "[<id>]" lines
    const matches1 = page1.match(/\[\d+\]/g) ?? [];
    expect(matches1.length).toBeGreaterThanOrEqual(10);
    expect(page1).toContain('第 1/3 页');

    (adapter.send as ReturnType<typeof vi.fn>).mockClear();
    await router.dispatch(makeMsg({ content: '/facts_pending 2', role: 'admin' }));
    const page2 = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(page2).toContain('第 2/3 页');

    (adapter.send as ReturnType<typeof vi.fn>).mockClear();
    await router.dispatch(makeMsg({ content: '/facts_pending 3', role: 'admin' }));
    const page3 = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(page3).toContain('第 3/3 页');
  });

  it('/facts_pending: out-of-range page clamps to last page', async () => {
    seedPending(db, 'g1', 5);
    await router.dispatch(makeMsg({ content: '/facts_pending 99', role: 'admin' }));
    const msgText = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(msgText).toContain('第 1/1 页');
  });

  it('/facts_pending: invalid page string defaults to 1', async () => {
    seedPending(db, 'g1', 3);
    await router.dispatch(makeMsg({ content: '/facts_pending abc', role: 'admin' }));
    const msgText = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(msgText).toContain('第 1/1 页');
  });

  it('/facts_pending: total message stays under 4000 chars even with long facts', async () => {
    const longFact = '长事实'.repeat(200);  // very long
    for (let i = 0; i < 10; i++) {
      db.learnedFacts.insert({
        groupId: 'g1', topic: null, fact: longFact + i,
        sourceUserId: null, sourceUserNickname: null,
        sourceMsgId: null, botReplyId: null,
        confidence: 0.8, status: 'pending',
      });
    }
    await router.dispatch(makeMsg({ content: '/facts_pending', role: 'admin' }));
    const msgText = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(msgText.length).toBeLessThan(4000);
    // Each line ≤ 120 chars (truncated)
    for (const line of msgText.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(120);
    }
  });

  it('/fact_approve: member is rejected by router gate (command dropped silently)', async () => {
    const [id] = seedPending(db, 'g1', 1);
    await router.dispatch(makeMsg({ content: `/fact_approve ${id}`, role: 'member' }));
    expect(adapter.send).not.toHaveBeenCalled();
    // status unchanged
    expect(db.learnedFacts.countPending('g1')).toBe(1);
  });

  it('/fact_approve: admin who is NOT the configured owner is rejected by handler', async () => {
    const [id] = seedPending(db, 'g1', 1);
    await router.dispatch(makeMsg({
      content: `/fact_approve ${id}`, role: 'admin', userId: 'other-admin',
    }));
    expect(adapter.send).toHaveBeenCalledTimes(1);
    const msgText = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(msgText).toContain('没有权限');
    expect(db.learnedFacts.countPending('g1')).toBe(1);
  });

  it('/fact_approve: MOD_APPROVAL_ADMIN promotes row to active', async () => {
    const [id] = seedPending(db, 'g1', 1);
    await router.dispatch(makeMsg({
      content: `/fact_approve ${id}`, role: 'owner', userId: OWNER_USER_ID,
    }));
    const msgText = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(msgText).toContain('已通过');
    expect(db.learnedFacts.countPending('g1')).toBe(0);
    expect(db.learnedFacts.countActive('g1')).toBe(1);
  });

  it('/fact_approve: missing ID returns usage hint', async () => {
    await router.dispatch(makeMsg({
      content: '/fact_approve', role: 'owner', userId: OWNER_USER_ID,
    }));
    const msgText = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(msgText).toContain('用法');
  });

  it('/fact_approve: non-numeric ID returns usage hint', async () => {
    await router.dispatch(makeMsg({
      content: '/fact_approve abc', role: 'owner', userId: OWNER_USER_ID,
    }));
    const msgText = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(msgText).toContain('用法');
  });

  it('/fact_reject: unchanged — still works on pending rows (rejects them)', async () => {
    const [id] = seedPending(db, 'g1', 1);
    await router.dispatch(makeMsg({
      content: `/fact_reject ${id}`, role: 'admin',
    }));
    expect(db.learnedFacts.countPending('g1')).toBe(0);
    expect(db.learnedFacts.countActive('g1')).toBe(0);
    const msgText = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(msgText).toContain('已拒绝');
  });
});
