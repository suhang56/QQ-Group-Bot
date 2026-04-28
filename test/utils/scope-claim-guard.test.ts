import { describe, it, expect } from 'vitest';
import {
  hasPluralYouScopeClaim,
  hasSelfCenteredScopeClaim,
  prevBotTurnAddressed,
  botIsInCurrentThread,
  PLURAL_YOU_PATTERNS,
  SELF_CENTERED_SCOPE_CLAIM_PATTERNS,
} from '../../src/utils/scope-claim-guard.js';

const BOT = '1705075399';

describe('hasPluralYouScopeClaim — Group A plural-you', () => {
  it('fires: 你们事真多', () => expect(hasPluralYouScopeClaim('你们事真多')).toBe(true));
  it('fires: 你们别烦 (hostile variant, whole-line)', () =>
    expect(hasPluralYouScopeClaim('你们别烦!')).toBe(true));
  it('fires: 你们别闹', () => expect(hasPluralYouScopeClaim('你们别闹！')).toBe(true));
  it('fires: 你们别吵', () => expect(hasPluralYouScopeClaim('你们别吵')).toBe(true));
  it('fires: 你们都在说啥啊', () => expect(hasPluralYouScopeClaim('你们都在说啥啊')).toBe(true));
  it('fires: 你们 事 真 多 (whitespace compact)', () =>
    expect(hasPluralYouScopeClaim('你们 事 真 多')).toBe(true));
  it('fires: CJK-wrapped with CQ prefix', () =>
    expect(hasPluralYouScopeClaim('[CQ:at,qq=1] 你们事真多')).toBe(true));
  it('fires: 你们几个又', () => expect(hasPluralYouScopeClaim('你们几个又来了')).toBe(true));
  it('fires: 有病吧你们', () => expect(hasPluralYouScopeClaim('有病吧你们')).toBe(true));
  it('fires: 你们怎么又', () => expect(hasPluralYouScopeClaim('你们怎么又这样')).toBe(true));

  it('does NOT fire: 你们好多人啊讨论音乐呢 (no pattern anchor match)', () =>
    expect(hasPluralYouScopeClaim('你们好多人啊讨论音乐呢')).toBe(false));
  it('does NOT fire: 你们好 (greeting)', () =>
    expect(hasPluralYouScopeClaim('你们好')).toBe(false));
  it('does NOT fire: 我们事真多 (first-person not plural-you)', () =>
    expect(hasPluralYouScopeClaim('我们事真多')).toBe(false));
  it('does NOT fire: empty', () => expect(hasPluralYouScopeClaim('')).toBe(false));
  it('does NOT fire: whitespace-only', () => expect(hasPluralYouScopeClaim('   ')).toBe(false));
  it('does NOT fire: 你们别烦他 (not whole-line — has 3rd party)', () =>
    expect(hasPluralYouScopeClaim('你们别烦他')).toBe(false));
  it('does NOT fire: CQ-only payload', () =>
    expect(hasPluralYouScopeClaim('[CQ:image,file=x.jpg]')).toBe(false));
});

describe('hasSelfCenteredScopeClaim — Group B self-centered', () => {
  it('fires: 又来了', () => expect(hasSelfCenteredScopeClaim('又来了')).toBe(true));
  it('fires: 又开始了啊～ (trailing particle + wave)', () =>
    expect(hasSelfCenteredScopeClaim('又开始了啊～')).toBe(true));
  it('fires: 有完没完', () => expect(hasSelfCenteredScopeClaim('有完没完')).toBe(true));
  it('fires: 又来搞我', () => expect(hasSelfCenteredScopeClaim('又来搞我')).toBe(true));
  it('fires: 又在搞我', () => expect(hasSelfCenteredScopeClaim('又在搞我')).toBe(true));
  it('fires: 还来', () => expect(hasSelfCenteredScopeClaim('还来')).toBe(true));
  it('fires: 又一次', () => expect(hasSelfCenteredScopeClaim('又一次')).toBe(true));
  it('fires: 又来了！(exclamation)', () =>
    expect(hasSelfCenteredScopeClaim('又来了！')).toBe(true));
  it('fires: 又来了。(period)', () => expect(hasSelfCenteredScopeClaim('又来了。')).toBe(true));
  it('fires: [CQ:at,qq=1] 又来了 (stripCQ)', () =>
    expect(hasSelfCenteredScopeClaim('[CQ:at,qq=1] 又来了')).toBe(true));

  // MUST-NOT-FIRE
  it('does NOT fire: 又开始了在讨论音乐 (embed — anchor fails)', () =>
    expect(hasSelfCenteredScopeClaim('又开始了在讨论音乐')).toBe(false));
  it('does NOT fire: empty', () => expect(hasSelfCenteredScopeClaim('')).toBe(false));
  it('does NOT fire: whitespace', () => expect(hasSelfCenteredScopeClaim('   ')).toBe(false));
  it('does NOT fire: 我又来了 (prefix breaks anchor)', () =>
    expect(hasSelfCenteredScopeClaim('我又来了')).toBe(false));
  it('does NOT fire: 又来了又开始了 (two-token concat fails single-token anchor)', () =>
    expect(hasSelfCenteredScopeClaim('又来了又开始了')).toBe(false));
  it('does NOT fire: 烦死了 (not in family)', () =>
    expect(hasSelfCenteredScopeClaim('烦死了')).toBe(false));
  it('does NOT fire: non-string', () =>
    // @ts-expect-error intentional bad input
    expect(hasSelfCenteredScopeClaim(null)).toBe(false));

  // ── PIVOT — tail-plural-you variants (04-23/04-24 archived) ──
  describe('tail-plural-you Group B variants', () => {
    // Archived live samples — must FIRE (the bug fix)
    it('fires: 又来了你们 (04-24 18:46/22:21 archived)', () =>
      expect(hasSelfCenteredScopeClaim('又来了你们')).toBe(true));
    it('fires: 又来这套是吧你们 (04-23 18:57/19:01 archived)', () =>
      expect(hasSelfCenteredScopeClaim('又来这套是吧你们')).toBe(true));
    it('fires: 又怎么了你们 (04-23 19:55 archived)', () =>
      expect(hasSelfCenteredScopeClaim('又怎么了你们')).toBe(true));

    // New tail variants of existing triggers
    it('fires: 又开始了你们', () =>
      expect(hasSelfCenteredScopeClaim('又开始了你们')).toBe(true));
    it('fires: 又来搞我你们', () =>
      expect(hasSelfCenteredScopeClaim('又来搞我你们')).toBe(true));
    it('fires: 又来了大家', () =>
      expect(hasSelfCenteredScopeClaim('又来了大家')).toBe(true));
    it('fires: 又来了你俩', () =>
      expect(hasSelfCenteredScopeClaim('又来了你俩')).toBe(true));
    it('fires: 又来了你们啊! (addressee + particle + punct)', () =>
      expect(hasSelfCenteredScopeClaim('又来了你们啊!')).toBe(true));

    // 是吧 modal slot (universal for all triggers)
    it('fires: 又来这套是吧 (modal alone, no addressee)', () =>
      expect(hasSelfCenteredScopeClaim('又来这套是吧')).toBe(true));
    it('fires: 又来了是吧 (universal modal slot)', () =>
      expect(hasSelfCenteredScopeClaim('又来了是吧')).toBe(true));
    it('fires: 又怎么了是吧你们 (modal + addressee chain)', () =>
      expect(hasSelfCenteredScopeClaim('又怎么了是吧你们')).toBe(true));

    // Bare new triggers
    it('fires: 又来这套 (bare new trigger)', () =>
      expect(hasSelfCenteredScopeClaim('又来这套')).toBe(true));
    it('fires: 又怎么了 (bare new trigger)', () =>
      expect(hasSelfCenteredScopeClaim('又怎么了')).toBe(true));

    // Must-NOT-fire — long sentences / wrong prefix / wrong tail
    it('does NOT fire: 又来了你们好吗? (long sentence — 好吗 not in particle set)', () =>
      expect(hasSelfCenteredScopeClaim('又来了你们好吗?')).toBe(false));
    it('does NOT fire: 又来了你们这群人 (tail continuation)', () =>
      expect(hasSelfCenteredScopeClaim('又来了你们这群人')).toBe(false));
    it('does NOT fire: 你们又来了 (Group A territory — 你们 prefix not Group B)', () =>
      expect(hasSelfCenteredScopeClaim('你们又来了')).toBe(false));
    it('does NOT fire: 又来了你们都 (`都` not in particle set)', () =>
      expect(hasSelfCenteredScopeClaim('又来了你们都')).toBe(false));
    it('does NOT fire: 又来这套吗 (`吗` not modal nor particle)', () =>
      expect(hasSelfCenteredScopeClaim('又来这套吗')).toBe(false));
    it('does NOT fire: 又怎么了啊太烦了 (multi-clause)', () =>
      expect(hasSelfCenteredScopeClaim('又怎么了啊太烦了')).toBe(false));
  });
});

describe('Group A ∩ Group B = ∅ (independence invariant)', () => {
  it('PLURAL_YOU_PATTERNS and SELF_CENTERED_SCOPE_CLAIM_PATTERNS have no string in common', () => {
    // Reviewer SC4 invariant: verify neither predicate fires on the other's
    // must-fire samples. If a future refactor merges the two, this breaks.
    const pluralSamples = ['你们事真多', '你们别烦!', '你们几个又来了', '你们都在说啥啊'];
    const selfSamples = ['又来了', '又开始了', '有完没完', '又来搞我'];
    for (const s of pluralSamples) {
      expect(hasSelfCenteredScopeClaim(s)).toBe(false);
    }
    for (const s of selfSamples) {
      expect(hasPluralYouScopeClaim(s)).toBe(false);
    }
    expect(PLURAL_YOU_PATTERNS.length).toBeGreaterThan(0);
    expect(SELF_CENTERED_SCOPE_CLAIM_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe('prevBotTurnAddressed', () => {
  it('returns true when last 2 msgs before bot prev turn contain CQ:at-bot', () => {
    const hist = [
      { userId: 'u1', content: `[CQ:at,qq=${BOT}] 你怎么看`, rawContent: `[CQ:at,qq=${BOT}] 你怎么看` },
      { userId: 'u2', content: '别装了', rawContent: '别装了' },
      { userId: BOT, content: '装什么', rawContent: '装什么', messageId: 'bot-1' },
      { userId: 'u3', content: '又说装', rawContent: '又说装' },
    ];
    expect(prevBotTurnAddressed(hist, BOT)).toBe(true);
  });

  it('returns true when CQ:reply,id=<bot-msg-id> in window', () => {
    const hist = [
      { userId: BOT, content: 'hi', rawContent: 'hi', messageId: '123' },
      { userId: 'u1', content: '[CQ:reply,id=123] 回复你', rawContent: '[CQ:reply,id=123] 回复你' },
      { userId: 'u2', content: '对啊', rawContent: '对啊' },
      { userId: BOT, content: '嗯', rawContent: '嗯', messageId: '456' },
    ];
    expect(prevBotTurnAddressed(hist, BOT)).toBe(true);
  });

  it('returns false when history empty (cold-start safe)', () =>
    expect(prevBotTurnAddressed([], BOT)).toBe(false));

  it('returns false when history has no bot turn', () => {
    const hist = [
      { userId: 'u1', content: 'a', rawContent: 'a' },
      { userId: 'u2', content: 'b', rawContent: 'b' },
    ];
    expect(prevBotTurnAddressed(hist, BOT)).toBe(false);
  });

  it('returns false when bot has turn but window msgs lack CQ:at or CQ:reply-to-bot', () => {
    const hist = [
      { userId: 'u1', content: '今天天气不错', rawContent: '今天天气不错' },
      { userId: 'u2', content: '是啊', rawContent: '是啊' },
      { userId: BOT, content: '嗯', rawContent: '嗯', messageId: 'bot-X' },
      { userId: 'u3', content: '无关评论', rawContent: '无关评论' },
    ];
    expect(prevBotTurnAddressed(hist, BOT)).toBe(false);
  });

  it('returns false when bot-id is empty string', () => {
    const hist = [{ userId: 'u1', content: '[CQ:at,qq=] hi', rawContent: '[CQ:at,qq=] hi' }];
    expect(prevBotTurnAddressed(hist, '')).toBe(false);
  });

  it('returns false when bot was the very first message (no window before)', () => {
    const hist = [
      { userId: BOT, content: 'hi', rawContent: 'hi', messageId: '1' },
      { userId: 'u1', content: 'ok', rawContent: 'ok' },
    ];
    expect(prevBotTurnAddressed(hist, BOT)).toBe(false);
  });

  it('CQ:reply with ID not matching any bot msg → false (ignore stale reply targets)', () => {
    const hist = [
      { userId: BOT, content: 'hi', rawContent: 'hi', messageId: '100' },
      { userId: 'u1', content: '[CQ:reply,id=999] 回谁', rawContent: '[CQ:reply,id=999] 回谁' },
      { userId: BOT, content: '嗯', rawContent: '嗯', messageId: '200' },
    ];
    expect(prevBotTurnAddressed(hist, BOT)).toBe(false);
  });

  it('CQ:at with extra attrs: `[CQ:at,qq=X,name=Y]` still matches', () => {
    const hist = [
      { userId: 'u1', content: `[CQ:at,qq=${BOT},name=bot] 问一个问题`, rawContent: `[CQ:at,qq=${BOT},name=bot] 问一个问题` },
      { userId: BOT, content: 'x', rawContent: 'x', messageId: 'm' },
    ];
    expect(prevBotTurnAddressed(hist, BOT)).toBe(true);
  });

  it('does NOT match CQ:at for a different qq that has bot-id as prefix', () => {
    // bot='170', msg has [CQ:at,qq=170500] which is a different user
    const hist = [
      { userId: 'u1', content: `[CQ:at,qq=170500] hey`, rawContent: `[CQ:at,qq=170500] hey` },
      { userId: '170', content: 'x', rawContent: 'x', messageId: 'm' },
    ];
    expect(prevBotTurnAddressed(hist, '170')).toBe(false);
  });

  it('window only looks at the 2 msgs immediately before bot turn (not further back)', () => {
    const hist = [
      { userId: 'u0', content: `[CQ:at,qq=${BOT}] far back`, rawContent: `[CQ:at,qq=${BOT}] far back` },
      { userId: 'u1', content: '填充1', rawContent: '填充1' },
      { userId: 'u2', content: '填充2', rawContent: '填充2' },
      { userId: BOT, content: 'reply', rawContent: 'reply', messageId: 'bot-1' },
    ];
    expect(prevBotTurnAddressed(hist, BOT)).toBe(false);
  });
});

// ── R2.5.1-annex (C) — botIsInCurrentThread ────────────────────────────────
describe('botIsInCurrentThread — Group B 4th condition', () => {
  const NOW = 1_700_000_000_000;
  const FUTURE = NOW + 60_000;
  const PAST = NOW - 60_000;

  // ── Sub-condition (a): recent direct-address window (last 3 non-bot turns) ──
  it('row 1 — (a) turn 2 has @bot → true', () => {
    const trig = { content: '又来了' };
    const hist = [
      { userId: 'u1', content: 'hello' },
      { userId: 'u2', content: `[CQ:at,qq=${BOT}] hi bot` },
      { userId: 'u3', content: 'unrelated' },
    ];
    expect(botIsInCurrentThread(trig, hist, undefined, BOT, NOW)).toBe(true);
  });

  it('row 2 — (a) turn 1 has reply-to-bot → true', () => {
    const trig = { content: '又来了' };
    const hist = [
      { userId: BOT, content: 'I said something', messageId: '777' },
      { userId: 'u1', content: '[CQ:reply,id=777] thanks' },
    ];
    expect(botIsInCurrentThread(trig, hist, undefined, BOT, NOW)).toBe(true);
  });

  it('row 3 — (a) none in last 3 have @bot/reply → false', () => {
    const trig = { content: '又来了' };
    const hist = [
      { userId: 'u1', content: 'hi' },
      { userId: 'u2', content: 'yo' },
      { userId: 'u3', content: 'sup' },
    ];
    expect(botIsInCurrentThread(trig, hist, undefined, BOT, NOW)).toBe(false);
  });

  // ── Sub-condition (b): engaged-topic overlap ──
  it('row 4 — (b) topic valid, real overlap → true', () => {
    const trig = { content: '我在听 ai music' };
    const hist = [{ userId: 'u1', content: 'random' }];
    const topic = { tokens: new Set(['ai', 'music', 'live']), until: FUTURE, msgCount: 1 };
    expect(botIsInCurrentThread(trig, hist, topic, BOT, NOW)).toBe(true);
  });

  it('row 5 — (b) topic expired → false', () => {
    const trig = { content: '我在听 ai music' };
    const hist = [{ userId: 'u1', content: 'random' }];
    const topic = { tokens: new Set(['ai', 'music']), until: PAST, msgCount: 1 };
    expect(botIsInCurrentThread(trig, hist, topic, BOT, NOW)).toBe(false);
  });

  it('row 6 — (b) only function-word overlap → false', () => {
    const trig = { content: '还有呢' };
    const hist = [{ userId: 'u1', content: 'random' }];
    const topic = { tokens: new Set(['还有', '呢', 'live']), until: FUTURE, msgCount: 1 };
    expect(botIsInCurrentThread(trig, hist, topic, BOT, NOW)).toBe(false);
  });

  it('row 7 — (b) entry undefined → false', () => {
    const trig = { content: 'live music啊' };
    const hist = [{ userId: 'u1', content: 'random' }];
    expect(botIsInCurrentThread(trig, hist, undefined, BOT, NOW)).toBe(false);
  });

  // ── Sub-condition (c): reply-chain walk ──
  it('row 8 — (c) 1-hop direct reply to bot → true', () => {
    const trig = { content: '[CQ:reply,id=900] 又来了' };
    const hist = [
      { userId: BOT, content: 'bot said this', messageId: '900' },
      { userId: 'u1', content: 'unrelated' },
    ];
    expect(botIsInCurrentThread(trig, hist, undefined, BOT, NOW)).toBe(true);
  });

  it('row 9 — (c) 3-hop chain → bot → true', () => {
    // trigger → 200 (u2) → 201 (u1) → 300 (bot)
    const trig = { content: '[CQ:reply,id=200] start' };
    const hist = [
      { userId: BOT, content: 'bot msg', messageId: '300' },
      { userId: 'u1', content: '[CQ:reply,id=300] hop3target', messageId: '201' },
      { userId: 'u2', content: '[CQ:reply,id=201] hop2target', messageId: '200' },
    ];
    expect(botIsInCurrentThread(trig, hist, undefined, BOT, NOW)).toBe(true);
  });

  it('row 10 — (c) 4-hop chain exceeds 3 → false', () => {
    // F1: u1's reply-to-bot id=400 must lie OUTSIDE last 3 non-bot turns,
    // else sub-condition (a) fires. Filler turns push u1 out.
    const trig = { content: '[CQ:reply,id=100] start' };
    const hist = [
      { userId: BOT, content: 'bot msg', messageId: '400' },
      { userId: 'u1', content: '[CQ:reply,id=400] hop4target', messageId: '300' },
      { userId: 'fillerA', content: 'noise A' },
      { userId: 'fillerB', content: 'noise B' },
      { userId: 'u2', content: '[CQ:reply,id=300] hop3target', messageId: '200' },
      { userId: 'u3', content: '[CQ:reply,id=200] hop2target', messageId: '100' },
    ];
    expect(botIsInCurrentThread(trig, hist, undefined, BOT, NOW)).toBe(false);
  });

  it('row 11 — (c) chain terminates at non-bot → false', () => {
    const trig = { content: '[CQ:reply,id=500] x' };
    const hist = [
      { userId: 'uA', content: 'no reply tag', messageId: '450' },
      { userId: 'uB', content: '[CQ:reply,id=450] mid', messageId: '500' },
    ];
    expect(botIsInCurrentThread(trig, hist, undefined, BOT, NOW)).toBe(false);
  });

  // ── Combined ──
  it('row 12 — all sub-conditions false → false', () => {
    const trig = { content: '又来了' };
    const hist = [
      { userId: 'u1', content: 'hi' },
      { userId: 'u2', content: 'yo' },
    ];
    expect(botIsInCurrentThread(trig, hist, undefined, BOT, NOW)).toBe(false);
  });

  it('row 13 — (a) false (b) false (c) true → short-circuit true', () => {
    const trig = { content: '[CQ:reply,id=900] 又来了' };
    const hist = [
      { userId: BOT, content: 'bot msg', messageId: '900' },
      { userId: 'u1', content: 'sup' },
      { userId: 'u2', content: 'sup2' },
    ];
    expect(botIsInCurrentThread(trig, hist, undefined, BOT, NOW)).toBe(true);
  });

  it('row 14 — only (b) true → short-circuit true', () => {
    const trig = { content: 'ai太好用了你们知道吗' };
    const hist = [
      { userId: 'u1', content: 'totally unrelated' },
      { userId: 'u2', content: 'still unrelated' },
    ];
    const topic = { tokens: new Set(['ai', '好用']), until: FUTURE, msgCount: 1 };
    expect(botIsInCurrentThread(trig, hist, topic, BOT, NOW)).toBe(true);
  });

  // ── SF (Should-Fire — predicate returns false; Group B fires) ──
  it('SF-1 — pure spectator, no signals → false', () => {
    const trig = { content: '又来了' };
    const hist = [
      { userId: 'u1', content: 'hi' },
      { userId: 'u2', content: 'yo' },
      { userId: 'u3', content: 'sup' },
    ];
    expect(botIsInCurrentThread(trig, hist, undefined, BOT, NOW)).toBe(false);
  });

  it('SF-2 — engagedTopic expired, no @bot, no chain → false', () => {
    const trig = { content: 'live啊' };
    const hist = [{ userId: 'u1', content: 'random' }];
    const topic = { tokens: new Set(['live']), until: PAST, msgCount: 0 };
    expect(botIsInCurrentThread(trig, hist, topic, BOT, NOW)).toBe(false);
  });

  it('SF-3 — 4-hop reply chain, no @bot in (a) window → false', () => {
    // F1 applied: filler turns shield (a).
    const trig = { content: '[CQ:reply,id=100] start' };
    const hist = [
      { userId: BOT, content: 'bot msg', messageId: '400' },
      { userId: 'u1', content: '[CQ:reply,id=400] hop4', messageId: '300' },
      { userId: 'fillerA', content: 'noise A' },
      { userId: 'fillerB', content: 'noise B' },
      { userId: 'u2', content: '[CQ:reply,id=300] hop3', messageId: '200' },
      { userId: 'u3', content: '[CQ:reply,id=200] hop2', messageId: '100' },
    ];
    expect(botIsInCurrentThread(trig, hist, undefined, BOT, NOW)).toBe(false);
  });

  it('SF-4 — only function-word overlap, no @bot/chain → false', () => {
    const trig = { content: '还有呢' };
    const hist = [{ userId: 'u1', content: 'random' }];
    const topic = { tokens: new Set(['还有', '呢']), until: FUTURE, msgCount: 1 };
    expect(botIsInCurrentThread(trig, hist, topic, BOT, NOW)).toBe(false);
  });

  it('SF-5 — engagedTopic undefined; @bot only at 4th-from-end turn (outside window) → false', () => {
    const trig = { content: '又来了' };
    const hist = [
      { userId: 'u0', content: `[CQ:at,qq=${BOT}] you there?` }, // 4th non-bot turn from end
      { userId: 'u1', content: 'turn3' },
      { userId: 'u2', content: 'turn2' },
      { userId: 'u3', content: 'turn1' },
    ];
    expect(botIsInCurrentThread(trig, hist, undefined, BOT, NOW)).toBe(false);
  });

  it('SF-6 — 4-hop to bot, no other signals → false', () => {
    // F1 applied: filler turns shield (a).
    const trig = { content: '[CQ:reply,id=100] start' };
    const hist = [
      { userId: BOT, content: 'bot msg', messageId: '400' },
      { userId: 'u1', content: '[CQ:reply,id=400] hop4', messageId: '300' },
      { userId: 'fillerA', content: 'noise A' },
      { userId: 'fillerB', content: 'noise B' },
      { userId: 'u2', content: '[CQ:reply,id=300] hop3', messageId: '200' },
      { userId: 'u3', content: '[CQ:reply,id=200] hop2', messageId: '100' },
    ];
    expect(botIsInCurrentThread(trig, hist, undefined, BOT, NOW)).toBe(false);
  });

  // ── MNF (Must-Not-Fire — predicate returns true; Group B suppressed) ──
  it('MNF-1 — @bot in last 3, innocuous text → true', () => {
    const trig = { content: '又来了' };
    const hist = [
      { userId: 'u1', content: 'turn3' },
      { userId: 'u2', content: `[CQ:at,qq=${BOT}] sup bot` },
      { userId: 'u3', content: 'turn1' },
    ];
    expect(botIsInCurrentThread(trig, hist, undefined, BOT, NOW)).toBe(true);
  });

  it('MNF-2 — engagedTopic active, real content overlap → true', () => {
    const trig = { content: 'ai太好用了你们知道吗' };
    const hist = [{ userId: 'u1', content: 'r' }];
    const topic = { tokens: new Set(['ai']), until: FUTURE, msgCount: 1 };
    expect(botIsInCurrentThread(trig, hist, topic, BOT, NOW)).toBe(true);
  });

  it('MNF-3 — direct reply to bot (1-hop) → true', () => {
    const trig = { content: '[CQ:reply,id=900] 又来了' };
    const hist = [{ userId: BOT, content: 'bot msg', messageId: '900' }];
    expect(botIsInCurrentThread(trig, hist, undefined, BOT, NOW)).toBe(true);
  });

  it('MNF-4 — 3-hop reply to bot → true', () => {
    const trig = { content: '[CQ:reply,id=200] start' };
    const hist = [
      { userId: BOT, content: 'bot msg', messageId: '300' },
      { userId: 'u1', content: '[CQ:reply,id=300] hop3target', messageId: '201' },
      { userId: 'u2', content: '[CQ:reply,id=201] hop2target', messageId: '200' },
    ];
    expect(botIsInCurrentThread(trig, hist, undefined, BOT, NOW)).toBe(true);
  });

  it('MNF-5 — @bot at exactly 3rd non-bot turn from end → true', () => {
    const trig = { content: '又来了' };
    const hist = [
      { userId: 'u0', content: 'older' },                      // outside window
      { userId: 'u1', content: `[CQ:at,qq=${BOT}] hi` },        // 3rd from end (boundary)
      { userId: 'u2', content: 'turn2' },
      { userId: 'u3', content: 'turn1' },
    ];
    expect(botIsInCurrentThread(trig, hist, undefined, BOT, NOW)).toBe(true);
  });

  it('MNF-6 — engagedTopic valid, separated English token overlap → true', () => {
    // F2 applied: 'live' must be a separated segment to be tokenized as 'live'.
    const trig = { content: '我也在听 live 哦' };
    const hist = [{ userId: 'u1', content: 'random' }];
    const topic = { tokens: new Set(['live', 'music']), until: FUTURE, msgCount: 5 };
    expect(botIsInCurrentThread(trig, hist, topic, BOT, NOW)).toBe(true);
  });
});
