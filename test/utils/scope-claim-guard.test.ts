import { describe, it, expect } from 'vitest';
import {
  hasPluralYouScopeClaim,
  hasSelfCenteredScopeClaim,
  prevBotTurnAddressed,
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
