import type { GroupMessage } from '../adapter/napcat.js';

export interface DeferredItem {
  groupId: string;
  msg: GroupMessage;
  recentMsgs: GroupMessage[];
  queuedAtSec: number;
  deadlineSec: number;
  recheckCount: number;
}

export const DEFER_QUEUE_MAX = 20;
export const DEFER_TTL_SEC = 30;
export const DEFER_RECHECK_INTERVAL_MS = 10_000;

export class DeferQueue {
  private readonly queue = new Map<string, DeferredItem[]>();

  enqueue(item: DeferredItem): void {
    const group = this.queue.get(item.groupId) ?? [];
    if (group.length >= DEFER_QUEUE_MAX) {
      // Evict oldest (LIFO semantics: keep newest, drop oldest)
      group.shift();
    }
    group.push(item);
    this.queue.set(item.groupId, group);
  }

  /** Pull items whose deadline has passed (deadlineSec <= nowSec). Removes from queue. */
  dequeueReady(nowSec: number): DeferredItem[] {
    const result: DeferredItem[] = [];
    for (const [groupId, items] of this.queue) {
      const remaining: DeferredItem[] = [];
      for (const item of items) {
        if (item.deadlineSec <= nowSec) {
          result.push(item);
        } else {
          remaining.push(item);
        }
      }
      if (remaining.length === 0) {
        this.queue.delete(groupId);
      } else {
        this.queue.set(groupId, remaining);
      }
    }
    return result;
  }

  /** Pull items that are stale (past deadlineSec + DEFER_TTL_SEC). Removes from queue. */
  removeStale(nowSec: number): DeferredItem[] {
    const result: DeferredItem[] = [];
    for (const [groupId, items] of this.queue) {
      const remaining: DeferredItem[] = [];
      for (const item of items) {
        if (item.deadlineSec + DEFER_TTL_SEC < nowSec) {
          result.push(item);
        } else {
          remaining.push(item);
        }
      }
      if (remaining.length === 0) {
        this.queue.delete(groupId);
      } else {
        this.queue.set(groupId, remaining);
      }
    }
    return result;
  }

  /** Return a copy of all items for a group (mutation does not affect internal state). */
  getAll(groupId: string): DeferredItem[] {
    return [...(this.queue.get(groupId) ?? [])];
  }

  size(groupId: string): number {
    return this.queue.get(groupId)?.length ?? 0;
  }

  clear(groupId: string): void {
    this.queue.delete(groupId);
  }

  getAllGroups(): string[] {
    return [...this.queue.keys()];
  }
}
