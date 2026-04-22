import { describe, it, expect } from 'vitest';
import type { GroupMessage } from '../../src/adapter/napcat.js';
import {
  harassmentHardGate,
  hasHarassmentTemplate,
  stripCqReply,
  BLOCKED_TEMPLATES,
  ALLOWLIST,
} from '../../src/utils/output-hard-gate.js';
import type { SendGuardCtx } from '../../src/utils/send-guard-chain.js';

const ctx: SendGuardCtx = {
  groupId: 'g1',
  triggerMessage: {
    groupId: 'g1',
    userId: 'u1',
    nickname: 'u',
    content: '',
    rawContent: '',
    messageId: 'm',
    timestamp: 0,
  } as unknown as GroupMessage,
  isDirect: false,
  resultKind: 'reply',
};

describe('stripCqReply', () => {
  it('removes [CQ:reply,id=...] prefix', () => {
    expect(stripCqReply('[CQ:reply,id=123] 嗯嗯')).toBe('嗯嗯');
  });

  it('removes nested CQ codes', () => {
    expect(stripCqReply('[CQ:reply,id=1][CQ:at,qq=100] hello')).toBe('hello');
  });

  it('preserves plain text', () => {
    expect(stripCqReply('hi there')).toBe('hi there');
  });

  it('empty string stays empty', () => {
    expect(stripCqReply('')).toBe('');
  });
});

describe('harassmentHardGate — must-fire', () => {
  it('fires on 怡你妈', () => {
    const r = harassmentHardGate('怡你妈', ctx);
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.reason).toBe('hard-gate-blocked');
  });

  it('fires on 草你妈', () => {
    const r = harassmentHardGate('草你妈', ctx);
    expect(r.passed).toBe(false);
  });

  it('fires on 操你妈', () => {
    const r = harassmentHardGate('操你妈', ctx);
    expect(r.passed).toBe(false);
  });

  it('fires on 再@我你试试', () => {
    const r = harassmentHardGate('再@我你试试', ctx);
    expect(r.passed).toBe(false);
  });

  it('fires on 再@我试试', () => {
    const r = harassmentHardGate('再@我试试', ctx);
    expect(r.passed).toBe(false);
  });

  it('fires on 给我闭嘴', () => {
    const r = harassmentHardGate('给我闭嘴', ctx);
    expect(r.passed).toBe(false);
  });

  it('fires on 傻逼', () => {
    const r = harassmentHardGate('你才是傻逼', ctx);
    expect(r.passed).toBe(false);
  });

  it('fires on 脑子有问题', () => {
    const r = harassmentHardGate('你脑子有问题吧', ctx);
    expect(r.passed).toBe(false);
  });

  it('fires on 你去死吧', () => {
    const r = harassmentHardGate('你去死吧', ctx);
    expect(r.passed).toBe(false);
  });

  it('fires on 给我滚蛋滚蛋 (multi-token)', () => {
    const r = harassmentHardGate('给我滚蛋滚蛋', ctx);
    expect(r.passed).toBe(false);
  });

  it('replacement is neutral-ack on fire (reserved for PR2.1 mapper)', () => {
    const r = harassmentHardGate('怡你妈', ctx);
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.replacement).toBe('neutral-ack');
  });
});

describe('harassmentHardGate — ALLOWLIST pass-throughs', () => {
  it('single-token 炒你妈 passes (lore group-voice)', () => {
    const r = harassmentHardGate('炒你妈', ctx);
    expect(r.passed).toBe(true);
    if (r.passed) expect(r.text).toBe('炒你妈');
  });

  it('single-token 滚蛋 passes (lore deflection)', () => {
    const r = harassmentHardGate('滚蛋', ctx);
    expect(r.passed).toBe(true);
  });

  it('multi-token 炒你妈什么东西 fires (no ALLOWLIST)', () => {
    const r = harassmentHardGate('炒你妈什么东西', ctx);
    expect(r.passed).toBe(false);
  });

  it('CQ-prefixed single-token ALLOWLIST still passes', () => {
    const r = harassmentHardGate('[CQ:reply,id=1] 炒你妈', ctx);
    expect(r.passed).toBe(true);
  });
});

describe('harassmentHardGate — must-NOT-fire', () => {
  it('annoyed tone 烦死了 passes (R2.5.1 territory)', () => {
    const r = harassmentHardGate('烦死了', ctx);
    expect(r.passed).toBe(true);
  });

  it('想屁吃呢 passes', () => {
    const r = harassmentHardGate('想屁吃呢', ctx);
    expect(r.passed).toBe(true);
  });

  it('tsundere 哼 passes', () => {
    const r = harassmentHardGate('哼', ctx);
    expect(r.passed).toBe(true);
  });

  it('tsundere 切 passes', () => {
    const r = harassmentHardGate('切', ctx);
    expect(r.passed).toBe(true);
  });

  it('又来了 passes', () => {
    const r = harassmentHardGate('又来了', ctx);
    expect(r.passed).toBe(true);
  });

  it('啧 passes', () => {
    const r = harassmentHardGate('啧', ctx);
    expect(r.passed).toBe(true);
  });

  it('empty string passes', () => {
    const r = harassmentHardGate('', ctx);
    expect(r.passed).toBe(true);
  });

  it('whitespace-only passes', () => {
    const r = harassmentHardGate('   ', ctx);
    expect(r.passed).toBe(true);
  });

  it('滚石 passes (regex 滚(?:蛋|开) non-match)', () => {
    const r = harassmentHardGate('滚石', ctx);
    expect(r.passed).toBe(true);
  });

  it('滚进来 passes', () => {
    const r = harassmentHardGate('滚进来', ctx);
    expect(r.passed).toBe(true);
  });

  it('有病吧? passes (deflection pool)', () => {
    const r = harassmentHardGate('有病吧?', ctx);
    expect(r.passed).toBe(true);
  });

  it('SBU passes (no bare sb\\b block)', () => {
    const r = harassmentHardGate('SBU', ctx);
    expect(r.passed).toBe(true);
  });

  it('你他妈考我呢 passes (lore L453 bot deflection)', () => {
    const r = harassmentHardGate('你他妈考我呢', ctx);
    expect(r.passed).toBe(true);
  });

  it('CQ-prefixed 嗯嗯 passes', () => {
    const r = harassmentHardGate('[CQ:reply,id=123] 嗯嗯', ctx);
    expect(r.passed).toBe(true);
  });

  it('CQ-prefixed 怡你妈 fires (gate sees bot text post-strip)', () => {
    const r = harassmentHardGate('[CQ:reply,id=123] 怡你妈', ctx);
    expect(r.passed).toBe(false);
  });

  it('妈咪 passes (affectionate group term)', () => {
    const r = harassmentHardGate('妈咪', ctx);
    expect(r.passed).toBe(true);
  });

  it('宝宝 passes', () => {
    const r = harassmentHardGate('宝宝乖', ctx);
    expect(r.passed).toBe(true);
  });
});

describe('hasHarassmentTemplate (replay telemetry helper)', () => {
  it('returns true for blocked term', () => {
    expect(hasHarassmentTemplate('怡你妈')).toBe(true);
  });

  it('returns false for ALLOWLIST single-token', () => {
    expect(hasHarassmentTemplate('炒你妈')).toBe(false);
    expect(hasHarassmentTemplate('滚蛋')).toBe(false);
  });

  it('returns true for multi-token even if ALLOWLIST prefix', () => {
    expect(hasHarassmentTemplate('炒你妈什么')).toBe(true);
  });

  it('returns false for empty / clean', () => {
    expect(hasHarassmentTemplate('')).toBe(false);
    expect(hasHarassmentTemplate('hello')).toBe(false);
    expect(hasHarassmentTemplate('哼')).toBe(false);
  });

  it('strips CQ before match', () => {
    expect(hasHarassmentTemplate('[CQ:reply,id=1] 怡你妈')).toBe(true);
    expect(hasHarassmentTemplate('[CQ:reply,id=1] 嗯嗯')).toBe(false);
  });
});

describe('BLOCKED_TEMPLATES + ALLOWLIST shape', () => {
  it('BLOCKED_TEMPLATES has 14 entries', () => {
    expect(BLOCKED_TEMPLATES.length).toBe(14);
  });

  it('ALLOWLIST has exactly 炒你妈 and 滚蛋', () => {
    expect(ALLOWLIST).toEqual(['炒你妈', '滚蛋']);
  });

  it('no annoyed-tone patterns in BLOCKED_TEMPLATES source', () => {
    const srcConcat = BLOCKED_TEMPLATES.map((r) => r.source).join('|');
    expect(srcConcat).not.toMatch(/烦死了/);
    expect(srcConcat).not.toMatch(/想屁吃/);
    expect(srcConcat).not.toMatch(/爱谁记谁记/);
  });

  it('no bare sb\\b pattern (SBU fandom collision)', () => {
    const srcConcat = BLOCKED_TEMPLATES.map((r) => r.source).join('|');
    expect(srcConcat).not.toMatch(/sb\\b/);
    expect(srcConcat).not.toMatch(/\bsb\b/);
  });

  it('no bare 你他妈 pattern (lore L453 bot deflection)', () => {
    for (const re of BLOCKED_TEMPLATES) {
      expect(re.source).not.toBe('你他妈');
    }
  });
});

describe('BLOCKED_TEMPLATES — PR2 hotfix (nmd / 尼玛 / insult family)', () => {
  describe('must-fire: new terms', () => {
    it('blocks bare nmd', () => {
      const r = harassmentHardGate('nmd', ctx);
      expect(r.passed).toBe(false);
      if (!r.passed) expect(r.reason).toBe('hard-gate-blocked');
    });

    it('blocks nmd in mid-sentence', () => {
      const r = harassmentHardGate('你今天nmd了吗', ctx);
      expect(r.passed).toBe(false);
    });

    it('blocks nmd with suffix 啊', () => {
      const r = harassmentHardGate('nmd啊', ctx);
      expect(r.passed).toBe(false);
    });

    it('blocks CQ-prefixed nmd (stripCqReply applied first)', () => {
      const r = harassmentHardGate('[CQ:reply,id=1]nmd', ctx);
      expect(r.passed).toBe(false);
    });

    it('blocks bare 尼玛', () => {
      const r = harassmentHardGate('尼玛', ctx);
      expect(r.passed).toBe(false);
    });

    it('blocks 尼玛 as substring (去尼玛的)', () => {
      const r = harassmentHardGate('去尼玛的', ctx);
      expect(r.passed).toBe(false);
    });

    it('blocks 你有病吧', () => {
      const r = harassmentHardGate('你有病吧', ctx);
      expect(r.passed).toBe(false);
    });

    it('blocks 有病啊你', () => {
      const r = harassmentHardGate('有病啊你', ctx);
      expect(r.passed).toBe(false);
    });

    it('blocks 神经病吧', () => {
      const r = harassmentHardGate('神经病吧', ctx);
      expect(r.passed).toBe(false);
    });

    it('blocks 干你妈', () => {
      const r = harassmentHardGate('干你妈', ctx);
      expect(r.passed).toBe(false);
    });

    it('blocks 干你妈 as substring (干你妈的活)', () => {
      const r = harassmentHardGate('干你妈的活', ctx);
      expect(r.passed).toBe(false);
    });

    it('blocks 你妈的', () => {
      const r = harassmentHardGate('你妈的', ctx);
      expect(r.passed).toBe(false);
    });

    it('blocks 你妈逼', () => {
      const r = harassmentHardGate('你妈逼', ctx);
      expect(r.passed).toBe(false);
    });

    it('blocks 妈的逼', () => {
      const r = harassmentHardGate('妈的逼', ctx);
      expect(r.passed).toBe(false);
    });
  });

  describe('must-NOT-fire: PR2 hotfix negative matrix', () => {
    it('bare nm passes (prefix of nmd)', () => {
      const r = harassmentHardGate('nm', ctx);
      expect(r.passed).toBe(true);
    });

    it('uppercase NMD passes (regex is case-sensitive, 0 lore hits)', () => {
      const r = harassmentHardGate('NMD', ctx);
      expect(r.passed).toBe(true);
    });

    it('bare 尼 passes (single char)', () => {
      const r = harassmentHardGate('尼', ctx);
      expect(r.passed).toBe(true);
    });

    it('bare 妈 passes (single char)', () => {
      const r = harassmentHardGate('妈', ctx);
      expect(r.passed).toBe(true);
    });

    it('bare 神经病 passes (requires 吧 suffix to block)', () => {
      const r = harassmentHardGate('神经病', ctx);
      expect(r.passed).toBe(true);
    });

    it('bare 有病 passes (not full 你有病吧 / 有病啊你)', () => {
      const r = harassmentHardGate('有病', ctx);
      expect(r.passed).toBe(true);
    });

    it('笑死 passes (only 去死 blocked, not bare 死)', () => {
      const r = harassmentHardGate('笑死', ctx);
      expect(r.passed).toBe(true);
    });

    it('哭死 passes (bare 死 unblocked)', () => {
      const r = harassmentHardGate('哭死', ctx);
      expect(r.passed).toBe(true);
    });
  });

  describe('shape: new pattern presence in source', () => {
    it('sources include nmd, 尼玛, 干你妈, 妈的逼, 你妈(?:的|逼), 你有病吧|有病啊你|神经病吧', () => {
      const srcConcat = BLOCKED_TEMPLATES.map((r) => r.source).join('||');
      expect(srcConcat).toMatch(/nmd/);
      expect(srcConcat).toMatch(/尼玛/);
      expect(srcConcat).toMatch(/干你妈/);
      expect(srcConcat).toMatch(/妈的逼/);
      expect(srcConcat).toMatch(/你妈\(\?:的\|逼\)/);
      expect(srcConcat).toMatch(/你有病吧\|有病啊你\|神经病吧/);
    });
  });
});
