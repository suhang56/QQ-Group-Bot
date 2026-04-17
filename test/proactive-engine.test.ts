import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ProactiveEngine,
  loadProactiveEngineConfig,
  DEFAULT_PROACTIVE_ENGINE_CONFIG,
  type ChatModuleInterface,
  type DatabaseInterface,
  type ProactiveEngineConfig,
} from '../src/modules/proactive-engine.js';
import { GroupActivityTracker } from '../src/modules/group-activity-tracker.js';
import { MoodTracker } from '../src/modules/mood.js';
import type { Message, GroupConfig } from '../src/storage/db.js';

// ── Test harness ────────────────────────────────────────────────────────
// A silent logger keeps test output clean while preserving the interface
// shape the engine expects. We cast to the Logger type to avoid pulling in
// pino from the test.
const silentLogger = {
  info: () => { /* noop */ },
  warn: () => { /* noop */ },
  debug: () => { /* noop */ },
  error: () => { /* noop */ },
  fatal: () => { /* noop */ },
  trace: () => { /* noop */ },
  child: () => silentLogger,
} as unknown as ReturnType<typeof import('../src/utils/logger.js').createLogger>;

interface ChatHarness extends ChatModuleInterface {
  sentReasons: string[];
  knownGroups: Set<string>;
  sendError: Error | null;
}

function makeChat(botUserId = 'BOT'): ChatHarness {
  const knownGroups = new Set<string>();
  const sentReasons: string[] = [];
  return {
    sentReasons,
    knownGroups,
    sendError: null,
    getKnownGroups() { return knownGroups; },
    getBotUserId() { return botUserId; },
    async sendProactiveFromEngine(_groupId: string, reason: string) {
      if (this.sendError) throw this.sendError;
      sentReasons.push(reason);
    },
  };
}

interface DbHarness extends DatabaseInterface {
  setMessages(groupId: string, msgs: Message[]): void;
  setGroupConfig(groupId: string, cfg: Partial<GroupConfig> | null): void;
}

function makeDb(): DbHarness {
  const msgMap = new Map<string, Message[]>();
  const cfgMap = new Map<string, GroupConfig | null>();
  return {
    messages: {
      getRecent(groupId: string, limit: number): Message[] {
        const rows = msgMap.get(groupId) ?? [];
        // Real repo returns newest-first.
        return [...rows].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
      },
    } as DatabaseInterface['messages'],
    groupConfig: {
      get(groupId: string): GroupConfig | null {
        return cfgMap.get(groupId) ?? null;
      },
    } as DatabaseInterface['groupConfig'],
    setMessages(groupId, msgs) { msgMap.set(groupId, msgs); },
    setGroupConfig(groupId, cfg) {
      if (cfg === null) cfgMap.set(groupId, null);
      else cfgMap.set(groupId, { groupId, ...(cfg as GroupConfig) });
    },
  };
}

/** Build a Message with only the fields the engine touches. */
function msg(groupId: string, userId: string, epochSec: number, content = 'hi'): Message {
  return {
    id: Math.floor(Math.random() * 1e9),
    groupId,
    userId,
    nickname: userId,
    content,
    rawContent: content,
    timestamp: epochSec,
    deleted: false,
  };
}

/** Seed `count` peer messages evenly across the given hours within the last 24h so
 * the TOD histogram picks those hours. `nowMs` provides the reference. */
function seedPeerMessagesForTOD(db: DbHarness, groupId: string, nowMs: number, hours: number[], perHour = 20): Message[] {
  const msgs: Message[] = [];
  let id = 1;
  // Place the fixture on yesterday so TOD hour-histogram picks up the
  // intended hours without polluting "last peer msg age" (which must stay
  // ≥ 30 min in the past for Gate 4/5 to pass).
  const base = new Date(nowMs);
  base.setHours(0, 0, 0, 0);
  const yesterdayStartMs = base.getTime() - 24 * 3_600_000;
  for (const h of hours) {
    for (let i = 0; i < perHour; i++) {
      const ts = Math.floor((yesterdayStartMs + h * 3_600_000 + i * 30_000) / 1000);
      msgs.push({ ...msg(groupId, `peer${i % 3}`, ts), id: id++ });
    }
  }
  db.setMessages(groupId, msgs);
  return msgs;
}

function baseConfig(overrides: Partial<ProactiveEngineConfig> = {}): ProactiveEngineConfig {
  return { ...DEFAULT_PROACTIVE_ENGINE_CONFIG, enabled: true, ...overrides };
}

/** Force the activity tracker to report 'idle' for a group by recording a
 * single ancient timestamp — the "observed then dried up" path. */
function forceIdle(tracker: GroupActivityTracker, groupId: string, nowMs: number): void {
  // countIn prunes anything past its window, so a 10-min-old record flips
  // the tracker into the "observed but empty in the 5-min window" idle path.
  tracker.record(groupId, nowMs - 10 * 60_000);
}

describe('ProactiveEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 14:00 local — weekday afternoon, away from night-veto and edge hours.
    vi.setSystemTime(new Date(2026, 3, 17, 14, 0, 0));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('enabled=false → start() is a no-op (timer not created)', () => {
    const chat = makeChat();
    const engine = new ProactiveEngine({
      chat,
      activityTracker: new GroupActivityTracker(),
      moodTracker: new MoodTracker(),
      db: makeDb(),
      config: baseConfig({ enabled: false }),
      logger: silentLogger,
    });
    engine.start();
    expect(engine._getTimer()).toBeNull();
    engine.stop();
  });

  it('enabled=true → start() creates an unref-ed timer', () => {
    const chat = makeChat();
    const engine = new ProactiveEngine({
      chat,
      activityTracker: new GroupActivityTracker(),
      moodTracker: new MoodTracker(),
      db: makeDb(),
      config: baseConfig(),
      logger: silentLogger,
    });
    engine.start();
    const timer = engine._getTimer();
    expect(timer).not.toBeNull();
    // NodeJS.Timeout supports hasRef() when ref-tracked; unref() flips it off.
    expect(typeof (timer as NodeJS.Timeout).hasRef).toBe('function');
    expect((timer as NodeJS.Timeout).hasRef()).toBe(false);
    engine.stop();
    expect(engine._getTimer()).toBeNull();
  });

  it('unknown group (not in knownGroups) → no fire', async () => {
    const chat = makeChat();
    // knownGroups is empty.
    const engine = new ProactiveEngine({
      chat,
      activityTracker: new GroupActivityTracker(),
      moodTracker: new MoodTracker(),
      db: makeDb(),
      config: baseConfig(),
      logger: silentLogger,
    });
    await engine.runOnce();
    expect(chat.sentReasons).toEqual([]);
  });

  it('all green → fires once, increments dailyCount, sets lastBrokenAt', async () => {
    const chat = makeChat();
    chat.knownGroups.add('g1');
    const tracker = new GroupActivityTracker();
    const now = Date.now();
    forceIdle(tracker, 'g1', now);
    const db = makeDb();
    // Seed TOD so hour 14 is in the top list.
    seedPeerMessagesForTOD(db, 'g1', now, [14, 15, 16, 13]);
    // Push the newest peer msg 45 min old → satisfies idleMin, lastBot=none.
    const existing = db.messages.getRecent('g1', 500);
    const ts45 = Math.floor((now - 45 * 60_000) / 1000);
    db.setMessages('g1', [...existing, msg('g1', 'peer1', ts45)]);

    const engine = new ProactiveEngine({
      chat,
      activityTracker: tracker,
      moodTracker: new MoodTracker(),
      db,
      config: baseConfig(),
      logger: silentLogger,
    });
    await engine.runOnce();
    expect(chat.sentReasons).toEqual(['silence-break-idle-tod']);
    expect(engine._getLastBrokenAt('g1')).toBe(now);
    expect(engine._getDailyCount('g1')?.n).toBe(1);
  });

  it('dryrun=true → no actual send, still consumes the slot', async () => {
    const chat = makeChat();
    chat.knownGroups.add('g1');
    const tracker = new GroupActivityTracker();
    const now = Date.now();
    forceIdle(tracker, 'g1', now);
    const db = makeDb();
    seedPeerMessagesForTOD(db, 'g1', now, [14, 15, 16, 13]);
    const existing = db.messages.getRecent('g1', 500);
    db.setMessages('g1', [...existing, msg('g1', 'peer1', Math.floor((now - 45 * 60_000) / 1000))]);

    const engine = new ProactiveEngine({
      chat,
      activityTracker: tracker,
      moodTracker: new MoodTracker(),
      db,
      config: baseConfig({ dryrun: true }),
      logger: silentLogger,
    });
    await engine.runOnce();
    expect(chat.sentReasons).toEqual([]);
    // Slot WAS consumed — dryrun should still block subsequent real fires in
    // the same cooldown window; otherwise dryrun can't faithfully exercise
    // the cadence.
    expect(engine._getLastBrokenAt('g1')).toBe(now);
    expect(engine._getDailyCount('g1')?.n).toBe(1);
  });

  it('night veto — 02:30 local → skip (no cooldown consumption)', async () => {
    vi.setSystemTime(new Date(2026, 3, 17, 2, 30, 0));
    const chat = makeChat();
    chat.knownGroups.add('g1');
    const tracker = new GroupActivityTracker();
    const now = Date.now();
    forceIdle(tracker, 'g1', now);
    const db = makeDb();
    seedPeerMessagesForTOD(db, 'g1', now, [2, 3, 14]);
    const existing = db.messages.getRecent('g1', 500);
    db.setMessages('g1', [...existing, msg('g1', 'peer1', Math.floor((now - 45 * 60_000) / 1000))]);

    const engine = new ProactiveEngine({
      chat,
      activityTracker: tracker,
      moodTracker: new MoodTracker(),
      db,
      config: baseConfig(),
      logger: silentLogger,
    });
    await engine.runOnce();
    expect(chat.sentReasons).toEqual([]);
    // Cooldown not consumed: lastBrokenAt stays untouched.
    expect(engine._getLastBrokenAt('g1')).toBeUndefined();
  });

  it('cooldown 1h59m → skip; 2h01m → fire', async () => {
    const chat = makeChat();
    chat.knownGroups.add('g1');
    const tracker = new GroupActivityTracker();
    let now = Date.now();
    forceIdle(tracker, 'g1', now);
    const db = makeDb();
    seedPeerMessagesForTOD(db, 'g1', now, [14, 15, 16, 13]);
    const existing = db.messages.getRecent('g1', 500);
    db.setMessages('g1', [...existing, msg('g1', 'peer1', Math.floor((now - 45 * 60_000) / 1000))]);

    const engine = new ProactiveEngine({
      chat,
      activityTracker: tracker,
      moodTracker: new MoodTracker(),
      db,
      config: baseConfig(),
      logger: silentLogger,
    });
    // Prime lastBrokenAt to 1h59m ago.
    engine._setLastBrokenAt('g1', now - (1 * 3_600_000 + 59 * 60_000));
    await engine.runOnce();
    expect(chat.sentReasons).toEqual([]);

    // Advance to 2h01m ago (i.e. jump current time forward by 3 min).
    vi.advanceTimersByTime(3 * 60_000);
    now = Date.now();
    // Re-force idle at the new now (tracker pruned ancient timestamps).
    forceIdle(tracker, 'g1', now);
    // Refresh "last peer msg" to stay at least 30 min old.
    db.setMessages('g1', [...existing, msg('g1', 'peer1', Math.floor((now - 45 * 60_000) / 1000))]);

    await engine.runOnce();
    expect(chat.sentReasons).toEqual(['silence-break-idle-tod']);
  });

  it('daily cap 2 reached → skip until tomorrow', async () => {
    const chat = makeChat();
    chat.knownGroups.add('g1');
    const tracker = new GroupActivityTracker();
    const now = Date.now();
    forceIdle(tracker, 'g1', now);
    const db = makeDb();
    seedPeerMessagesForTOD(db, 'g1', now, [14, 15, 16, 13]);
    const existing = db.messages.getRecent('g1', 500);
    db.setMessages('g1', [...existing, msg('g1', 'peer1', Math.floor((now - 45 * 60_000) / 1000))]);

    const engine = new ProactiveEngine({
      chat,
      activityTracker: tracker,
      moodTracker: new MoodTracker(),
      db,
      config: baseConfig({ cooldownMs: 1 }), // disarm cooldown to isolate daily-cap gate
      logger: silentLogger,
    });
    const today = new Date(now);
    const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    engine._setDailyCount('g1', { date: dateKey, n: 2 });
    await engine.runOnce();
    expect(chat.sentReasons).toEqual([]);

    // Next-day reset.
    vi.setSystemTime(new Date(2026, 3, 18, 14, 0, 0));
    forceIdle(tracker, 'g1', Date.now());
    // Last peer msg age must still be >= 30 min after the day advance.
    const tomorrowNow = Date.now();
    db.setMessages('g1', [...existing, msg('g1', 'peer1', Math.floor((tomorrowNow - 45 * 60_000) / 1000))]);
    await engine.runOnce();
    expect(chat.sentReasons).toEqual(['silence-break-idle-tod']);
  });

  it('mood valence exactly 0 → passes; -0.1 → skips', async () => {
    const chat = makeChat();
    chat.knownGroups.add('g1');
    const tracker = new GroupActivityTracker();
    const now = Date.now();
    forceIdle(tracker, 'g1', now);
    const db = makeDb();
    seedPeerMessagesForTOD(db, 'g1', now, [14, 15, 16, 13]);
    const existing = db.messages.getRecent('g1', 500);
    db.setMessages('g1', [...existing, msg('g1', 'peer1', Math.floor((now - 45 * 60_000) / 1000))]);

    const mood = new MoodTracker();
    // Verify default mood (v=0) lets it through.
    const engineNeutral = new ProactiveEngine({
      chat,
      activityTracker: tracker,
      moodTracker: mood,
      db,
      config: baseConfig(),
      logger: silentLogger,
    });
    await engineNeutral.runOnce();
    expect(chat.sentReasons).toEqual(['silence-break-idle-tod']);

    // Now drive valence negative and confirm a fresh engine skips.
    const chat2 = makeChat();
    chat2.knownGroups.add('g1');
    const tracker2 = new GroupActivityTracker();
    forceIdle(tracker2, 'g1', Date.now());
    const db2 = makeDb();
    const nowB = Date.now();
    seedPeerMessagesForTOD(db2, 'g1', nowB, [14, 15, 16, 13]);
    const existing2 = db2.messages.getRecent('g1', 500);
    db2.setMessages('g1', [...existing2, msg('g1', 'peer1', Math.floor((nowB - 45 * 60_000) / 1000))]);
    const mood2 = new MoodTracker();
    // Inject a negative valence directly.
    const moodState = mood2.getMood('g1');
    (mood2 as unknown as { moods: Map<string, typeof moodState> }).moods.set('g1', {
      ...moodState,
      valence: -0.1,
      lastUpdate: Date.now(),
    });
    const engineNegative = new ProactiveEngine({
      chat: chat2,
      activityTracker: tracker2,
      moodTracker: mood2,
      db: db2,
      config: baseConfig(),
      logger: silentLogger,
    });
    await engineNegative.runOnce();
    expect(chat2.sentReasons).toEqual([]);
  });

  it('<30 peer msgs → TOD gate blocks (insufficient data)', async () => {
    const chat = makeChat();
    chat.knownGroups.add('g1');
    const tracker = new GroupActivityTracker();
    const now = Date.now();
    forceIdle(tracker, 'g1', now);
    const db = makeDb();
    // Only 5 peer messages in the window.
    const msgs: Message[] = [];
    for (let i = 0; i < 5; i++) {
      msgs.push(msg('g1', 'peerX', Math.floor((now - (30 + i) * 60_000) / 1000)));
    }
    // Plus an idle-satisfying newest-peer message.
    msgs.push(msg('g1', 'peerY', Math.floor((now - 45 * 60_000) / 1000)));
    db.setMessages('g1', msgs);

    const engine = new ProactiveEngine({
      chat,
      activityTracker: tracker,
      moodTracker: new MoodTracker(),
      db,
      config: baseConfig(),
      logger: silentLogger,
    });
    await engine.runOnce();
    expect(chat.sentReasons).toEqual([]);
  });

  it('500 peer msgs concentrated in 2 hours → only those hours pass TOD', async () => {
    const chat = makeChat();
    chat.knownGroups.add('g1');
    const tracker = new GroupActivityTracker();
    const db = makeDb();

    // Seed 250 messages in hour 10 + 250 in hour 11. At 14:00 (current hour)
    // TOD should NOT contain 14 → skip.
    const now = Date.now();
    seedPeerMessagesForTOD(db, 'g1', now, [10, 11], 250);
    const existing = db.messages.getRecent('g1', 500);
    db.setMessages('g1', [...existing, msg('g1', 'peer1', Math.floor((now - 45 * 60_000) / 1000))]);
    forceIdle(tracker, 'g1', now);

    const engine = new ProactiveEngine({
      chat,
      activityTracker: tracker,
      moodTracker: new MoodTracker(),
      db,
      config: baseConfig(),
      logger: silentLogger,
    });
    await engine.runOnce();
    expect(chat.sentReasons).toEqual([]);

    // Move clock to 10:30 — hour 10 IS in TOD.
    vi.setSystemTime(new Date(2026, 3, 17, 10, 30, 0));
    const nowB = Date.now();
    forceIdle(tracker, 'g1', nowB);
    // Rebuild message history with last-msg 45min old at the new now.
    const fresh = db.messages.getRecent('g1', 500).filter(m => m.userId !== 'peer1');
    db.setMessages('g1', [...fresh, msg('g1', 'peer1', Math.floor((nowB - 45 * 60_000) / 1000))]);
    // TOD was cached — force a fresh engine so we pick up current hour.
    const chat2 = makeChat();
    chat2.knownGroups.add('g1');
    const engine2 = new ProactiveEngine({
      chat: chat2,
      activityTracker: tracker,
      moodTracker: new MoodTracker(),
      db,
      config: baseConfig(),
      logger: silentLogger,
    });
    await engine2.runOnce();
    expect(chat2.sentReasons).toEqual(['silence-break-idle-tod']);
  });

  it('air-reading veto fires on farewell phrase when enabled', async () => {
    const chat = makeChat();
    chat.knownGroups.add('g1');
    const tracker = new GroupActivityTracker();
    const now = Date.now();
    forceIdle(tracker, 'g1', now);
    const db = makeDb();
    seedPeerMessagesForTOD(db, 'g1', now, [14, 15, 16, 13]);
    const existing = db.messages.getRecent('g1', 500);
    // Newest peer msg (45 min old) says "晚安".
    db.setMessages('g1', [
      ...existing,
      msg('g1', 'peerA', Math.floor((now - 45 * 60_000) / 1000), '晚安了各位'),
    ]);
    db.setGroupConfig('g1', { airReadingEnabled: true } as GroupConfig);
    const stubJudge = { judge: async () => null };

    const engine = new ProactiveEngine({
      chat,
      activityTracker: tracker,
      moodTracker: new MoodTracker(),
      db,
      preChatJudge: stubJudge,
      config: baseConfig(),
      logger: silentLogger,
    });
    await engine.runOnce();
    expect(chat.sentReasons).toEqual([]);
  });

  it('airReading disabled for group → farewell phrase is ignored, TOD alone decides', async () => {
    const chat = makeChat();
    chat.knownGroups.add('g1');
    const tracker = new GroupActivityTracker();
    const now = Date.now();
    forceIdle(tracker, 'g1', now);
    const db = makeDb();
    seedPeerMessagesForTOD(db, 'g1', now, [14, 15, 16, 13]);
    const existing = db.messages.getRecent('g1', 500);
    db.setMessages('g1', [
      ...existing,
      msg('g1', 'peerA', Math.floor((now - 45 * 60_000) / 1000), '晚安了各位'),
    ]);
    // No group config → airReadingEnabled=false; no veto triggered.
    const engine = new ProactiveEngine({
      chat,
      activityTracker: tracker,
      moodTracker: new MoodTracker(),
      db,
      preChatJudge: { judge: async () => null },
      config: baseConfig(),
      logger: silentLogger,
    });
    await engine.runOnce();
    expect(chat.sentReasons).toEqual(['silence-break-idle-tod']);
  });

  it('two overlapping ticks → second sees updated lastBrokenAt and skips', async () => {
    const chat = makeChat();
    chat.knownGroups.add('g1');
    // Make sendProactive slow so two ticks can race. Use a deferred promise
    // that the second tick can see (lastBrokenAt was already set before the
    // await landed in tick #1).
    let resolveFirst: (() => void) | null = null;
    const firstSendGate = new Promise<void>((res) => { resolveFirst = res; });
    chat.sendProactiveFromEngine = async (_gid: string, reason: string) => {
      chat.sentReasons.push(reason);
      await firstSendGate;
    };
    const tracker = new GroupActivityTracker();
    const now = Date.now();
    forceIdle(tracker, 'g1', now);
    const db = makeDb();
    seedPeerMessagesForTOD(db, 'g1', now, [14, 15, 16, 13]);
    const existing = db.messages.getRecent('g1', 500);
    db.setMessages('g1', [...existing, msg('g1', 'peer1', Math.floor((now - 45 * 60_000) / 1000))]);

    const engine = new ProactiveEngine({
      chat,
      activityTracker: tracker,
      moodTracker: new MoodTracker(),
      db,
      config: baseConfig(),
      logger: silentLogger,
    });
    const p1 = engine.runOnce();
    // Yield once so tick #1 reaches the await inside sendProactiveFromEngine
    // and stores lastBrokenAt before tick #2 reads it.
    await Promise.resolve();
    await Promise.resolve();
    const p2 = engine.runOnce();
    resolveFirst!();
    await p1;
    await p2;
    expect(chat.sentReasons).toEqual(['silence-break-idle-tod']);
  });

  it('BoundedMap 200 cap on lastBrokenAt evicts oldest', async () => {
    const chat = makeChat();
    const tracker = new GroupActivityTracker();
    const mood = new MoodTracker();
    const db = makeDb();
    const engine = new ProactiveEngine({
      chat,
      activityTracker: tracker,
      moodTracker: mood,
      db,
      config: baseConfig(),
      logger: silentLogger,
    });
    // Prime past capacity via the test hook.
    for (let i = 0; i < 201; i++) {
      engine._setLastBrokenAt(`g${i}`, i);
    }
    expect(engine._getLastBrokenAt('g0')).toBeUndefined();
    expect(engine._getLastBrokenAt('g200')).toBe(200);
  });

  it('loadProactiveEngineConfig honors env vars; clamps tickMs to ≥60000', () => {
    const cfg = loadProactiveEngineConfig({
      PROACTIVE_ENGINE_ENABLED: '1',
      PROACTIVE_ENGINE_TICK_MS: '1000', // below min → clamped
      PROACTIVE_ENGINE_DRYRUN: 'true',
      PROACTIVE_ENGINE_DAILY_CAP: '5',
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.dryrun).toBe(true);
    expect(cfg.dailyCap).toBe(5);
    expect(cfg.tickMs).toBeGreaterThanOrEqual(60_000);

    const def = loadProactiveEngineConfig({});
    expect(def.enabled).toBe(false);
    expect(def.dryrun).toBe(false);
    expect(def.tickMs).toBe(300_000);
  });

  it('bot recently spoke (<30 min ago) → skip even if peer-last-msg is old', async () => {
    const chat = makeChat('BOT');
    chat.knownGroups.add('g1');
    const tracker = new GroupActivityTracker();
    const now = Date.now();
    forceIdle(tracker, 'g1', now);
    const db = makeDb();
    seedPeerMessagesForTOD(db, 'g1', now, [14, 15, 16, 13]);
    const existing = db.messages.getRecent('g1', 500);
    // Bot spoke 10 min ago — the lastBotMsg age gate must block.
    db.setMessages('g1', [
      ...existing,
      msg('g1', 'BOT', Math.floor((now - 10 * 60_000) / 1000), 'hi'),
    ]);

    const engine = new ProactiveEngine({
      chat,
      activityTracker: tracker,
      moodTracker: new MoodTracker(),
      db,
      config: baseConfig(),
      logger: silentLogger,
    });
    await engine.runOnce();
    expect(chat.sentReasons).toEqual([]);
  });
});
