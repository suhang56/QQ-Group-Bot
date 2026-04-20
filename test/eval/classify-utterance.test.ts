import { describe, it, expect } from 'vitest';
import { classifyUtterance } from '../../scripts/eval/classify-utterance.js';
import type { ChatResult } from '../../src/utils/chat-result.js';

const baseMeta = {
  decisionPath: 'normal' as const,
};

function reply(text: string): ChatResult {
  return {
    kind: 'reply',
    text,
    meta: {
      ...baseMeta,
      evasive: false,
      injectedFactIds: [],
      matchedFactIds: [],
      usedVoiceCount: 0,
      usedFactHint: false,
    },
    reasonCode: 'ok',
  };
}

describe('classifyUtterance', () => {
  it('silent → none', () => {
    const r: ChatResult = { kind: 'silent', meta: baseMeta, reasonCode: 'guard' };
    expect(classifyUtterance(r)).toBe('none');
  });

  it('defer → none', () => {
    const r: ChatResult = {
      kind: 'defer', untilSec: 0, targetMsgId: 'x',
      meta: baseMeta, reasonCode: 'cooldown',
    };
    expect(classifyUtterance(r)).toBe('none');
  });

  it('sticker → object_react', () => {
    const r: ChatResult = {
      kind: 'sticker', cqCode: '[CQ:face,id=1]',
      meta: { ...baseMeta, key: 'k' }, reasonCode: 'ok',
    };
    expect(classifyUtterance(r)).toBe('object_react');
  });

  it('fallback → unknown', () => {
    const r: ChatResult = {
      kind: 'fallback', text: '嗯', meta: baseMeta, reasonCode: 'pure-at',
    };
    expect(classifyUtterance(r)).toBe('unknown');
  });

  it('reply meta_admin_status → meta_admin_status', () => {
    expect(classifyUtterance(reply('禁言他'))).toBe('meta_admin_status');
  });

  it('reply relay token → relay', () => {
    expect(classifyUtterance(reply('接 1'))).toBe('relay');
  });

  it('reply bot_status stem → bot_status_query', () => {
    expect(classifyUtterance(reply('我今天还没'))).toBe('bot_status_query');
  });

  it('reply neutral → unknown', () => {
    expect(classifyUtterance(reply('好的'))).toBe('unknown');
  });

  it('strips [mock:...] sentinel before matching', () => {
    expect(classifyUtterance(reply('[mock:deadbeef] 禁言他'))).toBe('meta_admin_status');
  });

  // Negative relay-boundary tests — reviewer HIGH finding on `\+1` branch
  it('reply "+1 好" → unknown (not relay; trailing content)', () => {
    expect(classifyUtterance(reply('+1 好'))).toBe('unknown');
  });

  it('reply "+1看过" → unknown (not relay; no boundary)', () => {
    expect(classifyUtterance(reply('+1看过'))).toBe('unknown');
  });

  it('reply "收到了" → unknown (not relay; trailing content)', () => {
    expect(classifyUtterance(reply('收到了'))).toBe('unknown');
  });

  it('reply "+1" alone → relay (bare token)', () => {
    expect(classifyUtterance(reply('+1'))).toBe('relay');
  });

  it('reply "收到" alone → relay', () => {
    expect(classifyUtterance(reply('收到'))).toBe('relay');
  });
});
