import type { GroupMessage } from '../adapter/napcat.js';
import type { IMoodRepository } from '../storage/db.js';
import { createLogger } from '../utils/logger.js';

export interface MoodState {
  valence: number;   // -1.0 (upset) to +1.0 (happy)
  arousal: number;   // -1.0 (bored/tired) to +1.0 (excited)
  lastUpdate: number; // ms timestamp
}

export interface MoodDescription {
  label: string;
  hints: string[];
}

const DECAY_PER_MINUTE = 0.10;

// M9.2: per-group debounced save window. Short enough to survive a typical
// restart without losing recent mood, long enough to coalesce bursts.
const SAVE_DEBOUNCE_MS = 10_000;

// Keyword nudge patterns — order matters for clarity, not for matching
const HAPPY_RE = /哈哈|笑死|绷不住|tql|牛逼|爽|舒服/i;
const ANNOYED_RE = /烦|草|操|卧槽|mmp|jb/i;
const BANGDREAM_RE = /Roselia|ygfn|ykn|湊友希那|邦|live|现地/i;
const BOT_CRITICISM_RE = /变笨|傻|死机|抽风|又|bot|机器人|ai/i;
const TIRED_RE = /无聊|困|累|死了|想睡/;
const PRAISE_RE = /牛|绝绝子|神|顶/;

function clamp(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

function applyDecay(state: MoodState, nowMs: number): MoodState {
  const minutesElapsed = (nowMs - state.lastUpdate) / 60_000;
  if (minutesElapsed <= 0) return state;
  const factor = Math.pow(1 - DECAY_PER_MINUTE, minutesElapsed);
  return {
    valence: state.valence * factor,
    arousal: state.arousal * factor,
    lastUpdate: nowMs,
  };
}

export class MoodTracker {
  private readonly logger = createLogger('mood');
  private readonly moods = new Map<string, MoodState>();
  // M9.2: per-group debounce handles for scheduleSave.
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly repo?: IMoodRepository) {
    if (repo) {
      try {
        for (const row of repo.loadAll()) {
          this.moods.set(row.groupId, {
            valence: row.valence,
            arousal: row.arousal,
            lastUpdate: row.lastUpdate,
          });
        }
      } catch (err) {
        this.logger.warn({ err }, 'mood hydrate failed — starting with empty state');
      }
    }
  }

  getMood(groupId: string): MoodState {
    const now = Date.now();
    const prev = this.moods.get(groupId) ?? { valence: 0, arousal: 0, lastUpdate: now };
    const decayed = applyDecay(prev, now);
    this.moods.set(groupId, decayed);
    // Only schedule save when decay actually mutated state — applyDecay returns
    // the same reference for minutesElapsed <= 0. Without this guard chatty
    // groups would schedule saves on every read-only mood lookup.
    if (decayed !== prev) {
      this.scheduleSave(groupId);
    }
    return decayed;
  }

  updateFromMessage(groupId: string, msg: GroupMessage): void {
    const now = Date.now();
    let state = applyDecay(
      this.moods.get(groupId) ?? { valence: 0, arousal: 0, lastUpdate: now },
      now,
    );

    const content = msg.content;
    let dv = 0;
    let da = 0;

    if (HAPPY_RE.test(content))       { dv += 0.025; }
    if (ANNOYED_RE.test(content))     { dv -= 0.01; da += 0.015; }
    if (BANGDREAM_RE.test(content))   { dv += 0.04; }
    if (BOT_CRITICISM_RE.test(content)) { dv -= 0.04; }
    if (TIRED_RE.test(content))       { da -= 0.025; }
    if (PRAISE_RE.test(content))      { dv += 0.02; }

    state = {
      valence: clamp(state.valence + dv),
      arousal: clamp(state.arousal + da),
      lastUpdate: now,
    };
    this.moods.set(groupId, state);
    this.scheduleSave(groupId);
    this.logger.debug({ groupId, dv, da, valence: state.valence, arousal: state.arousal }, 'mood updated');
  }

  /** Apply social reward when a message is a follow-up to the bot's last reply. */
  rewardEngagement(groupId: string): void {
    const now = Date.now();
    const state = applyDecay(
      this.moods.get(groupId) ?? { valence: 0, arousal: 0, lastUpdate: now },
      now,
    );
    this.moods.set(groupId, {
      valence: clamp(state.valence + 0.03),
      arousal: state.arousal,
      lastUpdate: now,
    });
    this.scheduleSave(groupId);
  }

  /** Apply environment-based arousal tick (group silence or burst). */
  tickEnvironment(groupId: string, silentMs: number, isBurst: boolean): void {
    const now = Date.now();
    const state = applyDecay(
      this.moods.get(groupId) ?? { valence: 0, arousal: 0, lastUpdate: now },
      now,
    );
    let da = 0;
    if (silentMs > 5 * 60_000) da -= 0.1;
    if (isBurst)                da += 0.1;

    // Time-of-day: 2–5am local → sleepy
    const hour = new Date().getHours();
    if (hour >= 2 && hour < 5) da -= 0.2;

    this.moods.set(groupId, {
      valence: state.valence,
      arousal: clamp(state.arousal + da),
      lastUpdate: now,
    });
    this.scheduleSave(groupId);
  }

  tickDecay(groupId: string): void {
    this.getMood(groupId); // side-effect: decay + store (+ conditional save)
  }

  describe(groupId: string): MoodDescription {
    const { valence, arousal } = this.getMood(groupId);
    return describeMood(valence, arousal);
  }

  /**
   * Flush all pending per-group saves immediately. Call from shutdown so the
   * most recent mood survives process exit without waiting for the debounce.
   */
  flushAll(): void {
    const groupIds = Array.from(this.saveTimers.keys());
    for (const groupId of groupIds) {
      const timer = this.saveTimers.get(groupId);
      if (timer) clearTimeout(timer);
      this.saveTimers.delete(groupId);
      this.flushOne(groupId);
    }
  }

  private scheduleSave(groupId: string): void {
    if (!this.repo) return;
    const existing = this.saveTimers.get(groupId);
    if (existing) clearTimeout(existing);
    const h = setTimeout(() => {
      this.saveTimers.delete(groupId);
      this.flushOne(groupId);
    }, SAVE_DEBOUNCE_MS);
    // unref mandatory — pending timers otherwise keep the process alive and
    // block clean shutdown (feedback_timer_unref).
    h.unref?.();
    this.saveTimers.set(groupId, h);
  }

  private flushOne(groupId: string): void {
    if (!this.repo) return;
    const state = this.moods.get(groupId);
    if (!state) return;
    try {
      this.repo.upsert({
        groupId,
        valence: state.valence,
        arousal: state.arousal,
        lastUpdate: state.lastUpdate,
      });
    } catch (err) {
      this.logger.warn({ err, groupId }, 'mood persist failed');
    }
  }
}

/** Pure function — exported for testing. */
export function describeMood(valence: number, arousal: number): MoodDescription {
  if (valence >= 0.5 && arousal >= 0.5) {
    return { label: '激动爽', hints: ['嘿嘿', 'yes', '舒服', '爽'] };
  }
  if (valence >= 0.3 && arousal >= -0.3 && arousal < 0.5) {
    return { label: '开心', hints: ['哈哈', '嘻嘻', '好耶'] };
  }
  if (valence >= 0.3 && arousal < -0.3) {
    return { label: '懒洋洋满足', hints: ['嗯', '好好好', '还行'] };
  }
  if (valence > -0.3 && valence < 0.3 && arousal >= 0.5) {
    return { label: '亢奋', hints: ['！！', '等等', '这个这个'] };
  }
  if (valence <= -0.3 && arousal >= 0.3) {
    return { label: '烦躁', hints: ['烦', 'tmd', '什么玩意儿'] };
  }
  if (valence <= -0.3 && arousal < -0.3) {
    return { label: '无聊低气压', hints: ['好困', '没意思', '累'] };
  }
  if (valence <= -0.5) {
    return { label: '不爽', hints: ['不行', '你别', '算了'] };
  }
  return { label: '普通', hints: [] };
}

// Proactive message pools keyed by mood label
export const PROACTIVE_POOLS: Record<string, string[]> = {
  '激动爽': ['嘿嘿', '爽啊', '嗯嗯嗯', 'yes', '真不错'],
  '开心': ['哈哈', '嗨', '嘻嘻', '挺好的'],
  '无聊低气压': ['好困', '没人聊天吗', '困死了', '有人吗', '好无聊'],
};
