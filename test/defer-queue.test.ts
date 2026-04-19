import { describe, it, expect, beforeEach } from 'vitest';
import { DeferQueue, DEFER_QUEUE_MAX, DEFER_TTL_SEC, type DeferredItem } from '../src/utils/defer-queue.js';
import type { GroupMessage } from '../src/adapter/napcat.js';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'msg-1',
    groupId: 'g1',
    userId: 'u1',
    nickname: 'user',
    role: 'member',
    content: 'hello',
    rawContent: 'hello',
    timestamp: 1000000,
    ...overrides,
  };
}

function makeItem(overrides: Partial<DeferredItem> = {}): DeferredItem {
  return {
    groupId: 'g1',
    msg: makeMsg(),
    recentMsgs: [],
    queuedAtSec: 1000,
    deadlineSec: 1010,
    recheckCount: 0,
    ...overrides,
  };
}

describe('DeferQueue', () => {
  let q: DeferQueue;

  beforeEach(() => {
    q = new DeferQueue();
  });

  it('enqueue up to max — no eviction', () => {
    for (let i = 0; i < DEFER_QUEUE_MAX; i++) {
      q.enqueue(makeItem({ msg: makeMsg({ messageId: `msg-${i}` }) }));
    }
    expect(q.size('g1')).toBe(DEFER_QUEUE_MAX);
  });

  it('enqueue beyond max — oldest evicted, newest kept', () => {
    for (let i = 0; i < DEFER_QUEUE_MAX; i++) {
      q.enqueue(makeItem({ msg: makeMsg({ messageId: `msg-${i}` }) }));
    }
    q.enqueue(makeItem({ msg: makeMsg({ messageId: 'msg-overflow' }) }));
    expect(q.size('g1')).toBe(DEFER_QUEUE_MAX);
    const all = q.getAll('g1');
    expect(all[0]!.msg.messageId).toBe('msg-1');
    expect(all[all.length - 1]!.msg.messageId).toBe('msg-overflow');
  });

  it('dequeueReady returns only items where deadline passed', () => {
    q.enqueue(makeItem({ deadlineSec: 500 }));
    q.enqueue(makeItem({ deadlineSec: 2000 }));
    const ready = q.dequeueReady(1000);
    expect(ready).toHaveLength(1);
    expect(ready[0]!.deadlineSec).toBe(500);
  });

  it('dequeueReady does not return items with future deadlines', () => {
    q.enqueue(makeItem({ deadlineSec: 2000 }));
    const ready = q.dequeueReady(1000);
    expect(ready).toHaveLength(0);
    expect(q.size('g1')).toBe(1);
  });

  it('dequeueReady on empty queue — returns []', () => {
    const ready = q.dequeueReady(9999);
    expect(ready).toHaveLength(0);
  });

  it('removeStale removes only items past deadlineSec + DEFER_TTL_SEC', () => {
    q.enqueue(makeItem({ deadlineSec: 100 }));  // stale: 100 + 30 = 130 < 1000
    q.enqueue(makeItem({ deadlineSec: 990 }));  // not stale: 990 + 30 = 1020 > 1000
    const stale = q.removeStale(1000);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.deadlineSec).toBe(100);
    expect(q.size('g1')).toBe(1);
  });

  it('size returns correct count before and after operations', () => {
    expect(q.size('g1')).toBe(0);
    q.enqueue(makeItem());
    expect(q.size('g1')).toBe(1);
    q.dequeueReady(9999);
    expect(q.size('g1')).toBe(0);
  });

  it('multiple groups are isolated', () => {
    q.enqueue(makeItem({ groupId: 'g1' }));
    q.enqueue(makeItem({ groupId: 'g2' }));
    expect(q.size('g1')).toBe(1);
    expect(q.size('g2')).toBe(1);
    q.clear('g1');
    expect(q.size('g1')).toBe(0);
    expect(q.size('g2')).toBe(1);
  });

  it('clear empties group without affecting other groups', () => {
    q.enqueue(makeItem({ groupId: 'g1' }));
    q.enqueue(makeItem({ groupId: 'g2' }));
    q.clear('g1');
    expect(q.size('g1')).toBe(0);
    expect(q.size('g2')).toBe(1);
  });

  it('getAll returns a copy — mutation does not affect internal state', () => {
    q.enqueue(makeItem());
    const copy = q.getAll('g1');
    copy.splice(0, 1);
    expect(q.size('g1')).toBe(1);
  });

  it('enqueue then dequeueReady same item — queue is empty after', () => {
    q.enqueue(makeItem({ deadlineSec: 500 }));
    q.dequeueReady(1000);
    expect(q.size('g1')).toBe(0);
  });

  it('overflow eviction is FIFO — oldest dropped, newest retained', () => {
    for (let i = 0; i < DEFER_QUEUE_MAX; i++) {
      q.enqueue(makeItem({ msg: makeMsg({ messageId: `msg-${i}` }), queuedAtSec: i }));
    }
    q.enqueue(makeItem({ msg: makeMsg({ messageId: 'newest' }), queuedAtSec: 99 }));
    const all = q.getAll('g1');
    const ids = all.map(i => i.msg.messageId);
    expect(ids).not.toContain('msg-0');
    expect(ids).toContain('newest');
  });

  it('size returns 0 for unknown group without throwing', () => {
    expect(() => q.size('nonexistent')).not.toThrow();
    expect(q.size('nonexistent')).toBe(0);
  });

  it('getAllGroups returns all groups with queued items', () => {
    q.enqueue(makeItem({ groupId: 'g1' }));
    q.enqueue(makeItem({ groupId: 'g2' }));
    const groups = q.getAllGroups();
    expect(groups).toContain('g1');
    expect(groups).toContain('g2');
    expect(groups).toHaveLength(2);
  });

  it('getAllGroups excludes empty groups after dequeue', () => {
    q.enqueue(makeItem({ groupId: 'g1', deadlineSec: 100 }));
    q.dequeueReady(9999);
    const groups = q.getAllGroups();
    expect(groups).not.toContain('g1');
  });

  it('dequeueReady boundary: item with deadlineSec === nowSec is included', () => {
    q.enqueue(makeItem({ deadlineSec: 1000 }));
    const ready = q.dequeueReady(1000);
    expect(ready).toHaveLength(1);
  });

  it('removeStale boundary: item with deadlineSec + DEFER_TTL_SEC === nowSec is NOT stale', () => {
    // stale condition: deadlineSec + TTL < nowSec (strictly less than)
    q.enqueue(makeItem({ deadlineSec: 1000 - DEFER_TTL_SEC }));
    // deadlineSec + TTL = 1000 - TTL + TTL = 1000, which is NOT < 1000
    const stale = q.removeStale(1000);
    expect(stale).toHaveLength(0);
  });
});
