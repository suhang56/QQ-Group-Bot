/**
 * M9.1 — Silence-Breaker v2 (idle + time-of-day aware).
 *
 * Fires a proactive "break the silence" reply when a group has gone fully
 * quiet for >=30 min AND the current local hour is one of the group's
 * historically most-active hours AND mood is non-negative AND the per-group
 * cooldown has cleared.
 *
 * Coexists with ChatModule's existing `_moodProactiveTick` — does NOT
 * replace it. The mood tick handles short-lookback silence (3-10 min after
 * a bot utterance went unanswered); this engine handles the "group is
 * fully dead" case with a completely different gate structure.
 *
 * Defaults: ENABLED=false (ship dark). Route via `ChatModule.sendProactiveFromEngine`
 * which reuses the main chat pipeline + existing `_sendProactive` side-effects
 * (botSpeechTracking, _bumpConsecutive, fatigue, _proactiveAdapter).
 */

import { BoundedMap } from '../utils/bounded-map.js';
import type { GroupActivityTracker } from './group-activity-tracker.js';
import type { MoodTracker } from './mood.js';
import type { Database } from '../storage/db.js';
import type { IPreChatJudge } from './pre-chat-judge.js';
import type { Logger } from '../utils/logger.js';
import { createLogger } from '../utils/logger.js';

/** Public interface chat.ts calls into. Keeps circular deps manageable. */
export interface ChatModuleInterface {
  getKnownGroups(): Iterable<string>;
  getBotUserId(): string;
  sendProactiveFromEngine(groupId: string, reason: string): Promise<void>;
}

export interface DatabaseInterface {
  messages: Pick<Database['messages'], 'getRecent'>;
  groupConfig: Pick<Database['groupConfig'], 'get'>;
}

export interface ProactiveEngineConfig {
  /** Tick interval (ms). Minimum 60_000. */
  tickMs: number;
  /** Min idle duration before a group is eligible (ms). */
  idleMinMs: number;
  /** Per-group cooldown between fires (ms). */
  cooldownMs: number;
  /** Min peer messages required to build a TOD histogram. */
  todMinSamples: number;
  /** How many top-active hours count as "this hour is a good one". */
  todTopHours: number;
  /** Daily fire cap per group. */
  dailyCap: number;
  /** Master enable flag. */
  enabled: boolean;
  /** If true, log "would send" and skip the actual chat call. */
  dryrun: boolean;
}

export const DEFAULT_PROACTIVE_ENGINE_CONFIG: ProactiveEngineConfig = {
  tickMs: 300_000,
  idleMinMs: 1_800_000,
  cooldownMs: 7_200_000,
  todMinSamples: 30,
  todTopHours: 8,
  dailyCap: 2,
  enabled: false,
  dryrun: false,
};

export interface ProactiveEngineDeps {
  chat: ChatModuleInterface;
  activityTracker: GroupActivityTracker;
  moodTracker: MoodTracker;
  db: DatabaseInterface;
  preChatJudge?: IPreChatJudge | null;
  logger?: Logger;
  config: ProactiveEngineConfig;
  /** Test hook: override Date.now. */
  now?: () => number;
}

const TOD_CACHE_TTL_MS = 24 * 3_600_000;
const FAREWELL_RE = /睡了|下了|晚安|拜拜|明天见|不聊了|撤了|溜了|先走了/;
const CONVERSATION_CLOSE_RE = /^(嗯|好的|好嘞|好哒|ok|收到|行吧|懂了)$/i;
const DEAD_GROUP_MAX_AGE_MS = 4 * 3_600_000;
const NIGHT_END_HOUR = 7;
const MIN_TICK_MS = 60_000;

interface TodCacheEntry {
  hours: Set<number>;
  builtAt: number;
}

interface DailyCountEntry {
  date: string;
  n: number;
}

/**
 * Config loader from process.env. Exposed for index.ts wiring + tests.
 * Invalid numeric values fall back to default; tickMs is clamped to
 * >= MIN_TICK_MS to avoid accidental hot loops.
 */
export function loadProactiveEngineConfig(env: NodeJS.ProcessEnv = process.env): ProactiveEngineConfig {
  const readInt = (key: string, fallback: number): number => {
    const raw = env[key];
    if (!raw) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const tickMs = Math.max(MIN_TICK_MS, readInt('PROACTIVE_ENGINE_TICK_MS', DEFAULT_PROACTIVE_ENGINE_CONFIG.tickMs));
  return {
    tickMs,
    idleMinMs: readInt('PROACTIVE_ENGINE_IDLE_MIN_MS', DEFAULT_PROACTIVE_ENGINE_CONFIG.idleMinMs),
    cooldownMs: readInt('PROACTIVE_ENGINE_COOLDOWN_MS', DEFAULT_PROACTIVE_ENGINE_CONFIG.cooldownMs),
    todMinSamples: readInt('PROACTIVE_ENGINE_TOD_MIN_SAMPLES', DEFAULT_PROACTIVE_ENGINE_CONFIG.todMinSamples),
    todTopHours: readInt('PROACTIVE_ENGINE_TOD_TOP_HOURS', DEFAULT_PROACTIVE_ENGINE_CONFIG.todTopHours),
    dailyCap: readInt('PROACTIVE_ENGINE_DAILY_CAP', DEFAULT_PROACTIVE_ENGINE_CONFIG.dailyCap),
    enabled: env['PROACTIVE_ENGINE_ENABLED'] === '1' || env['PROACTIVE_ENGINE_ENABLED'] === 'true',
    dryrun: env['PROACTIVE_ENGINE_DRYRUN'] === '1' || env['PROACTIVE_ENGINE_DRYRUN'] === 'true',
  };
}

export class ProactiveEngine {
  private timer: NodeJS.Timeout | null = null;
  private readonly lastBrokenAt = new BoundedMap<string, number>(200);
  private readonly todCache = new BoundedMap<string, TodCacheEntry>(200);
  private readonly dailyCount = new BoundedMap<string, DailyCountEntry>(200);
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(private readonly deps: ProactiveEngineDeps) {
    this.logger = deps.logger ?? createLogger('proactive-engine');
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (!this.deps.config.enabled) {
      this.logger.info('proactive-engine disabled (enabled=false) — start() is a no-op');
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this._tick().catch(err => {
        this.logger.warn({ err: String(err) }, 'proactive-engine tick threw (swallowed)');
      });
    }, this.deps.config.tickMs);
    this.timer.unref?.();
    this.logger.info({ config: this.deps.config }, 'proactive-engine started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Test hook: run one tick synchronously. Production code uses start(). */
  async runOnce(): Promise<void> {
    await this._tick();
  }

  private async _tick(): Promise<void> {
    const nowMs = this.now();
    for (const groupId of this.deps.chat.getKnownGroups()) {
      try {
        await this._evaluateGroup(groupId, nowMs);
      } catch (err) {
        this.logger.warn({ err: String(err), groupId }, 'proactive-engine group eval failed');
      }
    }
  }

  private async _evaluateGroup(groupId: string, nowMs: number): Promise<void> {
    const cfg = this.deps.config;

    // Gate 1: activity level must be idle. Also respects cross-group isolation —
    // groups the activity tracker has never seen return 'normal' (we don't know
    // enough to call them idle without evidence).
    if (this.deps.activityTracker.level(groupId, nowMs) !== 'idle') return;

    // Gate 2: night veto. Never fire between midnight and 07:00 local time.
    // Don't consume cooldown — a silent 3am should not delay a 10am fire.
    // Night veto [00:00, 07:00); upper bound only since NIGHT_START_HOUR=0.
    // For overnight wrap (e.g. 22-7), change to (hour >= START || hour < END).
    const hour = new Date(nowMs).getHours();
    if (hour < NIGHT_END_HOUR) return;

    // Gate 3: daily cap. Reset on local-date rollover.
    const today = this._localDateString(nowMs);
    const daily = this.dailyCount.get(groupId);
    if (daily && daily.date === today && daily.n >= cfg.dailyCap) return;

    // Gate 4+5: last bot msg + last group msg age. We pull a reasonable window
    // and inspect the most recent message for the "last group msg" check, then
    // scan for the most recent bot message for the "last bot msg" check.
    const recent = this.deps.db.messages.getRecent(groupId, 100);
    if (recent.length === 0) return;
    const newest = recent[0]!;
    const lastGroupMsgAgeMs = nowMs - newest.timestamp * 1000;
    if (lastGroupMsgAgeMs < cfg.idleMinMs) return;

    const botUserId = this.deps.chat.getBotUserId();
    const lastBotMsg = botUserId ? recent.find(m => m.userId === botUserId) : undefined;
    // If the bot has never spoken here, treat it as "infinitely old" — no block.
    const lastBotMsgAgeMs = lastBotMsg ? nowMs - lastBotMsg.timestamp * 1000 : Number.POSITIVE_INFINITY;
    if (lastBotMsgAgeMs < cfg.idleMinMs) return;

    // Gate 6: time-of-day pattern. Requires >= todMinSamples peer messages in
    // the scan window, then the current local hour must be in the top-N most
    // active hours. Cached per-group for 24h.
    const todHours = this._getTodHours(groupId, nowMs);
    if (!todHours) return;
    if (!todHours.has(hour)) return;

    // Gate 7: mood. Block on negative valence — the group may be upset and
    // a cheerful bot barging in is adversarial.
    const mood = this.deps.moodTracker.getMood(groupId);
    if (mood.valence < 0) return;

    // Gate 8: per-group cooldown. Must come AFTER the cheap gates so we don't
    // waste the cooldown reset when the group wasn't going to fire anyway.
    const lastBrokenAt = this.lastBrokenAt.get(groupId) ?? 0;
    if (nowMs - lastBrokenAt < cfg.cooldownMs) return;

    // Gate 9: air-reading local veto. Only when the group has enabled it.
    if (this._airReadingVeto(groupId, recent, nowMs)) return;

    // All gates passed. Claim the slot BEFORE the async call to prevent a
    // concurrent tick from double-firing (lastBrokenAt update wins the race).
    this.lastBrokenAt.set(groupId, nowMs);
    this._incrementDailyCount(groupId, today);

    if (cfg.dryrun) {
      this.logger.info({ groupId, reason: 'silence-break-idle-tod' }, 'proactive-engine would send (dryrun)');
      return;
    }

    try {
      await this.deps.chat.sendProactiveFromEngine(groupId, 'silence-break-idle-tod');
    } catch (err) {
      this.logger.warn({ err: String(err), groupId }, 'proactive-engine sendProactiveFromEngine failed');
    }
  }

  private _airReadingVeto(
    groupId: string,
    recent: ReadonlyArray<{ userId: string; content: string; timestamp: number }>,
    nowMs: number,
  ): boolean {
    const cfg = this.deps.db.groupConfig.get(groupId);
    if (!cfg?.airReadingEnabled) return false;
    if (!this.deps.preChatJudge) return false;

    const botUserId = this.deps.chat.getBotUserId();
    const lastPeer = recent.find(m => m.userId !== botUserId);
    if (!lastPeer) return false;

    const age = nowMs - lastPeer.timestamp * 1000;
    if (age > DEAD_GROUP_MAX_AGE_MS) return true;

    const content = (lastPeer.content ?? '').trim();
    if (!content) return false;
    if (FAREWELL_RE.test(content)) return true;
    if (CONVERSATION_CLOSE_RE.test(content)) return true;

    return false;
  }

  private _getTodHours(groupId: string, nowMs: number): Set<number> | null {
    const cached = this.todCache.get(groupId);
    if (cached && nowMs - cached.builtAt < TOD_CACHE_TTL_MS) {
      return cached.hours.size > 0 ? cached.hours : null;
    }

    const rows = this.deps.db.messages.getRecent(groupId, 500);
    const botUserId = this.deps.chat.getBotUserId();
    const peerRows = rows.filter(r => !botUserId || r.userId !== botUserId);
    if (peerRows.length < this.deps.config.todMinSamples) {
      this.todCache.set(groupId, { hours: new Set(), builtAt: nowMs });
      return null;
    }

    const histogram = new Array<number>(24).fill(0);
    for (const r of peerRows) {
      const hr = new Date(r.timestamp * 1000).getHours();
      if (hr >= 0 && hr < 24) histogram[hr] = (histogram[hr] ?? 0) + 1;
    }
    const ranked = histogram
      .map((count, hour) => ({ hour, count }))
      .filter(e => e.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, this.deps.config.todTopHours)
      .map(e => e.hour);
    const hours = new Set(ranked);
    this.todCache.set(groupId, { hours, builtAt: nowMs });
    return hours.size > 0 ? hours : null;
  }

  private _incrementDailyCount(groupId: string, today: string): void {
    const cur = this.dailyCount.get(groupId);
    if (cur && cur.date === today) {
      this.dailyCount.set(groupId, { date: today, n: cur.n + 1 });
    } else {
      this.dailyCount.set(groupId, { date: today, n: 1 });
    }
  }

  private _localDateString(ms: number): string {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // Test-only accessors ──────────────────────────────────────────────────
  /** @internal */ _getLastBrokenAt(groupId: string): number | undefined { return this.lastBrokenAt.get(groupId); }
  /** @internal */ _getDailyCount(groupId: string): DailyCountEntry | undefined { return this.dailyCount.get(groupId); }
  /** @internal */ _getTimer(): NodeJS.Timeout | null { return this.timer; }
  /** @internal */ _setLastBrokenAt(groupId: string, ms: number): void { this.lastBrokenAt.set(groupId, ms); }
  /** @internal */ _setDailyCount(groupId: string, entry: DailyCountEntry): void { this.dailyCount.set(groupId, entry); }
}

/** Legacy interface retained for backward-compat imports. */
export interface IProactiveEngine {
  start(): void;
  stop(): void;
}
