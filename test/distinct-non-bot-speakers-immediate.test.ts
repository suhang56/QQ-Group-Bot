import { describe, it, expect } from 'vitest';
import { distinctNonBotSpeakersImmediate } from '../src/modules/chat.js';

const BOT = 'bot-1';

function msg(userId: string, ts: number, content = 'hi') {
  return { userId, content, rawContent: content, timestamp: ts };
}

describe('distinctNonBotSpeakersImmediate — time window + thread-break', () => {
  // T=trigger.timestamp; offsets are SECONDS (Message.timestamp is sec).

  it('T1: same-speaker cluster within window → 1', () => {
    const T = 1000;
    const chron = [msg('A', T - 50), msg('A', T - 30), msg('A', T - 10)];
    const trig = { userId: 'X', timestamp: T };
    expect(distinctNonBotSpeakersImmediate(chron, trig, BOT)).toBe(1);
  });

  it('T2: 3 distinct speakers in tight window → 3', () => {
    const T = 1000;
    const chron = [
      msg('A', T - 50),
      msg('B', T - 35),
      msg('C', T - 20),
      msg('A', T - 10),
    ];
    const trig = { userId: 'X', timestamp: T };
    expect(distinctNonBotSpeakersImmediate(chron, trig, BOT)).toBe(3);
  });

  it('T3: live bug scenario — all msgs >90s ago → 0', () => {
    const T = 1000;
    const chron = [
      msg('A', T - 1020),
      msg('B', T - 640),
      msg('C', T - 180),
    ];
    const trig = { userId: 'D', timestamp: T };
    expect(distinctNonBotSpeakersImmediate(chron, trig, BOT)).toBe(0);
  });

  it('T4: thread-break cuts off pre-gap speakers → 2', () => {
    const T = 1000;
    const chron = [
      msg('A', T - 1063),
      msg('B', T - 1062),
      msg('C', T - 28),
      msg('D', T - 13),
    ];
    const trig = { userId: 'X', timestamp: T };
    // Gap C(T-28) ↔ B(T-1062) = 1034s > 60s → break before reaching A,B.
    expect(distinctNonBotSpeakersImmediate(chron, trig, BOT)).toBe(2);
  });

  it('T5: trigger sender excluded — solo trigger pattern → 0', () => {
    const T = 1000;
    const chron = [msg('X', T - 40), msg('X', T - 20)];
    const trig = { userId: 'X', timestamp: T };
    expect(distinctNonBotSpeakersImmediate(chron, trig, BOT)).toBe(0);
  });

  it('T6: boundary inclusive — msg at exactly trigger.ts - 90s → counted', () => {
    const T = 1000;
    const chron = [msg('A', T - 90)];
    const trig = { userId: 'X', timestamp: T };
    expect(distinctNonBotSpeakersImmediate(chron, trig, BOT)).toBe(1);
  });

  it('T7: empty array → 0', () => {
    const trig = { userId: 'X', timestamp: 1000 };
    expect(distinctNonBotSpeakersImmediate([], trig, BOT)).toBe(0);
  });

  it('T8: windowSeconds=0 — no msg before trigger included', () => {
    const T = 1000;
    const chron = [msg('A', T - 1)];
    const trig = { userId: 'X', timestamp: T };
    expect(distinctNonBotSpeakersImmediate(chron, trig, BOT, 0)).toBe(0);
  });

  // ─── Edge cases ────────────────────────────────────────────────────────

  it('skips bot messages without counting them as speakers', () => {
    const T = 1000;
    const chron = [msg(BOT, T - 30), msg('A', T - 20)];
    const trig = { userId: 'X', timestamp: T };
    expect(distinctNonBotSpeakersImmediate(chron, trig, BOT)).toBe(1);
  });

  it('bot message in middle does not fabricate a thread-break', () => {
    const T = 1000;
    // Bot msg between two human msgs that are 70s apart (would break if bot
    // skipped lastSeenTs update); with bot at T-50 lastSeenTs advances so
    // gap A(T-80) ↔ bot(T-50) = 30s, then bot ↔ B(T-20) = 30s, neither >60s.
    const chron = [msg('A', T - 80), msg(BOT, T - 50), msg('B', T - 20)];
    const trig = { userId: 'X', timestamp: T };
    expect(distinctNonBotSpeakersImmediate(chron, trig, BOT)).toBe(2);
  });

  it('skips future-trigger msgs without breaking iteration', () => {
    const T = 1000;
    // Future msg at T+10 (DB-race) interleaved at end. Function must skip
    // it via continue and still count A(T-30).
    const chron = [msg('A', T - 30), msg('B', T + 10)];
    const trig = { userId: 'X', timestamp: T };
    expect(distinctNonBotSpeakersImmediate(chron, trig, BOT)).toBe(1);
  });

  it('CQ-only message does not count as speaker', () => {
    const T = 1000;
    const chron = [
      { userId: 'A', content: '[CQ:image,file=x.jpg]', rawContent: '[CQ:image,file=x.jpg]', timestamp: T - 20 },
      msg('B', T - 10),
    ];
    const trig = { userId: 'X', timestamp: T };
    expect(distinctNonBotSpeakersImmediate(chron, trig, BOT)).toBe(1);
  });

  it('5-speaker diversity cap preserved within window', () => {
    const T = 1000;
    const chron = [
      msg('A', T - 50), msg('B', T - 45), msg('C', T - 40),
      msg('D', T - 35), msg('E', T - 30), msg('F', T - 25),
    ];
    const trig = { userId: 'X', timestamp: T };
    expect(distinctNonBotSpeakersImmediate(chron, trig, BOT)).toBe(5);
  });

  it('msg with undefined timestamp treated as ts=0 (excluded by window)', () => {
    const T = 1000;
    const chron = [
      { userId: 'A', content: 'hi', rawContent: 'hi' }, // timestamp undefined
      msg('B', T - 10),
    ];
    const trig = { userId: 'X', timestamp: T };
    expect(distinctNonBotSpeakersImmediate(chron, trig, BOT)).toBe(1);
  });

  // ─── Live row 6665 reproduction (Task #4) ──────────────────────────────

  it('row 6665 — solo double-post on idle group counts only OTHER in-window speaker', () => {
    // Live row 6665: 西瓜 (trigger) double-posts at 17:52:58. Group has been
    // idle, with stale msgs from 17:35-17:49 (>180s ago). One msg from
    // userId=3246839087 happened recently within 90s.
    //
    // Pre-fix: 5-msg lookback counts ALL 4 historical speakers (西瓜, 3246839087,
    //          plus 2 others from idle window) → dSpeakers=4 → guard misfires.
    // Post-fix: window=90s + thread-break + trigger-exclusion → only 3246839087
    //           counts → dSpeakers=1 < 3 → guard fires correctly.
    const T = 1745265178; // arbitrary; offsets matter, not absolute value
    const chron = [
      msg('uA', T - 1380), // 17:35-ish
      msg('uB', T - 960),  // 17:42-ish
      msg('uC', T - 540),  // 17:49-ish
      msg('3246839087', T - 60), // within 90s window
      msg('西瓜', T - 30), // trigger sender's prior msg (excluded)
    ];
    const trig = { userId: '西瓜', timestamp: T };
    // Iterating newest→oldest: 西瓜(skip trigger), 3246839087(count), then
    // gap to T-540 = 480s > 60s → thread-break, stop.
    expect(distinctNonBotSpeakersImmediate(chron, trig, BOT)).toBe(1);
  });
});
