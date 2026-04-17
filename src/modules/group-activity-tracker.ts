/**
 * M7.2: per-group activity tracker. Counts peer message timestamps in rolling
 * windows and classifies activity as idle / normal / busy so engagement-decision
 * can raise or lower the participation-score threshold accordingly.
 */
import { BoundedMap } from '../utils/bounded-map.js';

export type ActivityLevel = 'idle' | 'normal' | 'busy';

export interface IGroupActivityTracker {
  record(groupId: string, ts: number): void;
  countIn(groupId: string, windowMs: number, now?: number): number;
  level(groupId: string, now?: number): ActivityLevel;
}

const BUSY_THRESHOLD_PER_MIN = 8;
const IDLE_THRESHOLD_PER_5MIN = 2;
const PER_GROUP_TIMESTAMP_CAP = 60;

export class GroupActivityTracker implements IGroupActivityTracker {
  private readonly timestamps = new BoundedMap<string, number[]>(200);

  record(groupId: string, ts: number): void {
    const arr = this.timestamps.get(groupId) ?? [];
    arr.push(ts);
    while (arr.length > PER_GROUP_TIMESTAMP_CAP) arr.shift();
    this.timestamps.set(groupId, arr);
  }

  countIn(groupId: string, windowMs: number, now: number = Date.now()): number {
    const arr = this.timestamps.get(groupId);
    if (!arr) return 0;
    const cutoff = now - windowMs;
    while (arr.length > 0 && arr[0]! < cutoff) arr.shift();
    this.timestamps.set(groupId, arr);
    return arr.length;
  }

  level(groupId: string, now: number = Date.now()): ActivityLevel {
    // Groups the tracker has never seen default to 'normal' — we lack data
    // to call them idle, and pre-M7.2 behavior is the safest fallback
    // (no multiplier change until we've actually observed sparse traffic).
    // Groups with an empty array (observed, then fully pruned) DO count as
    // idle — we saw them, they went dry.
    if (!this.timestamps.has(groupId)) return 'normal';
    // Check the 5-min window first so countIn's destructive prune (on the
    // narrower 60s call below) doesn't wipe the 60..300s tail before we
    // can measure it.
    const in300s = this.countIn(groupId, 300_000, now);
    const in60s = this.countIn(groupId, 60_000, now);
    if (in60s >= BUSY_THRESHOLD_PER_MIN) return 'busy';
    if (in300s <= IDLE_THRESHOLD_PER_5MIN) return 'idle';
    return 'normal';
  }
}
