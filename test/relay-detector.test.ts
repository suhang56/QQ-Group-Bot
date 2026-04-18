import { describe, it, expect } from 'vitest';
import { detectRelay } from '../src/modules/relay-detector.js';
import type { Message } from '../src/storage/db.js';

let _id = 0;
function makeMsg(userId: string, content: string): Message {
  return {
    id: ++_id,
    groupId: 'g1',
    userId,
    nickname: userId,
    content,
    rawContent: content,
    timestamp: Date.now(),
    deleted: false,
  };
}

const BOT = 'bot-id';

describe('detectRelay', () => {
  it('1: 3-echo hit returns echo', () => {
    const msgs = [makeMsg('u1', '帅'), makeMsg('u2', '帅'), makeMsg('u3', '帅')];
    expect(detectRelay(msgs, BOT)).toEqual({ kind: 'echo', content: '帅', chainLength: 3 });
  });

  it('2: 2-echo miss returns null', () => {
    const msgs = [makeMsg('u1', '帅'), makeMsg('u2', '帅')];
    expect(detectRelay(msgs, BOT)).toBeNull();
  });

  it('3: echo too long (5 chars) returns null', () => {
    const msgs = [makeMsg('u1', '帅帅帅帅帅'), makeMsg('u2', '帅帅帅帅帅'), makeMsg('u3', '帅帅帅帅帅')];
    expect(detectRelay(msgs, BOT)).toBeNull();
  });

  it('4: mixed content returns null', () => {
    const msgs = [makeMsg('u1', '帅'), makeMsg('u2', '草'), makeMsg('u3', '帅')];
    expect(detectRelay(msgs, BOT)).toBeNull();
  });

  it('5: bot message excluded — only 2 peer msgs -> null', () => {
    const msgs = [makeMsg(BOT, '帅'), makeMsg('u1', '帅'), makeMsg('u2', '帅')];
    expect(detectRelay(msgs, BOT)).toBeNull();
  });

  it('6: trailing ! stripped before compare — still matches', () => {
    const msgs = [makeMsg('u1', '帅'), makeMsg('u2', '帅'), makeMsg('u3', '帅!')];
    const result = detectRelay(msgs, BOT);
    expect(result).toEqual({ kind: 'echo', content: '帅', chainLength: 3 });
  });

  it('7: vote detect with +1', () => {
    const msgs = [makeMsg('u1', '+1'), makeMsg('u2', '+1'), makeMsg('u3', '+1')];
    expect(detectRelay(msgs, BOT)).toEqual({ kind: 'vote', content: '+1', chainLength: 3 });
  });

  it('8: claim detect with 抢', () => {
    const msgs = [makeMsg('u1', '抢'), makeMsg('u2', '抢'), makeMsg('u3', '抢')];
    expect(detectRelay(msgs, BOT)).toEqual({ kind: 'claim', content: '抢', chainLength: 3 });
  });

  it('9: 3-char non-claim echo chain fires as echo', () => {
    // "来了吗" is 3 chars, not vote/claim, but should echo (len <= 4)
    const msgs = [makeMsg('u1', '来了吗'), makeMsg('u2', '来了吗'), makeMsg('u3', '来了吗')];
    expect(detectRelay(msgs, BOT)).toEqual({ kind: 'echo', content: '来了吗', chainLength: 3 });
  });

  it('10: empty array returns null', () => {
    expect(detectRelay([], BOT)).toBeNull();
  });

  it('11: full-width +1 vote — raw form preserved in output', () => {
    const msgs = [makeMsg('u1', '+１'), makeMsg('u2', '+１'), makeMsg('u3', '+１')];
    const result = detectRelay(msgs, BOT);
    expect(result).toEqual({ kind: 'vote', content: '+１', chainLength: 3 });
  });
});
