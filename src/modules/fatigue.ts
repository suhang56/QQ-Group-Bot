import { BoundedMap } from '../utils/bounded-map.js';

export interface IFatigueSource {
  onReply(groupId: string): void;
  /** Raw decayed score (no threshold/clamp). Used by chat.ts to dampen positive signal sum. */
  getRawScore(groupId: string): number;
  /** Legacy penalty formula: 0 below threshold, -0.3 linear ramp over [THRESHOLD, THRESHOLD+2]. Kept for unit tests / observability. */
  getPenalty(groupId: string): number;
}

const FATIGUE_PER_REPLY = 1.0;
export const FATIGUE_THRESHOLD = 4;
// half-life = 30 min — TAU / ln(2) = 30 min
const TAU_MS = (30 * 60_000) / Math.LN2;

export class FatigueModule implements IFatigueSource {
  private readonly state = new BoundedMap<string, { score: number; lastUpdate: number }>(200);

  onReply(groupId: string): void {
    const now = Date.now();
    const prev = this._readWithDecay(groupId, now);
    this.state.set(groupId, { score: prev + FATIGUE_PER_REPLY, lastUpdate: now });
  }

  getRawScore(groupId: string): number {
    const now = Date.now();
    const score = this._readWithDecay(groupId, now);
    // write back decayed state so subsequent reads don't re-compute from stale point
    this.state.set(groupId, { score, lastUpdate: now });
    return score;
  }

  getPenalty(groupId: string): number {
    const score = this.getRawScore(groupId);
    if (score <= FATIGUE_THRESHOLD) return 0;
    return -0.3 * Math.min(1, (score - FATIGUE_THRESHOLD) / 2);
  }

  private _readWithDecay(groupId: string, now: number): number {
    const existing = this.state.get(groupId);
    if (!existing) return 0;
    const dt = now - existing.lastUpdate;
    if (dt <= 0) return existing.score;
    return existing.score * Math.exp(-dt / TAU_MS);
  }
}
