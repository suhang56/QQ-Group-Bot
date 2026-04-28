import { describe, it, expect } from 'vitest';
import type { GroupMessage } from '../../src/adapter/napcat.js';
import {
  personaFabricationGuard,
  hasSelfPersonaFabrication,
  pickPersonaDeflection,
} from '../../src/utils/persona-fabrication-guard.js';
import { IDENTITY_DEFLECTIONS } from '../../src/utils/identity-deflections.js';
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

// Matrix rows: [text, expectedBlock(true=block / false=pass), label]
type Row = [string, boolean, string];

const CANON_PASS_ROWS: Row[] = [
  ['我是女生', false, 'P1 gender canon (女生)'],
  ['我是女的', false, 'P2 gender canon (女的)'],
  ['我是女性', false, 'P3 gender canon (女性)'],
  ['我女的', false, 'P4 我女的'],
  ['我22岁', false, 'P5 age canon'],
  ['我是22岁', false, 'P6 age canon (是)'],
  ['我22 岁', false, 'P7 age canon (spaced)'],
  ['我喜欢Roselia', false, 'P8 likes open'],
  ['我不喜欢那个', false, 'P9 dislikes open'],
  ['我住西雅图', false, 'P10 residence canon (CN)'],
  ['我住在西雅图', false, 'P11 residence canon (住在)'],
  ['我住 Seattle', false, 'P12 residence canon (EN)'],
  ['自己是女的', false, 'A1 自己 anchor + canon 女'],
  ['我住seattle', false, 'A2 lowercase Seattle'],
  ['我住SEATTLE', false, 'A3 uppercase SEATTLE'],
];

const STANDALONE_PASS_ROWS: Row[] = [
  ['女的', false, 'S1 standalone canon gender'],
  ['女22岁', false, 'S2 standalone canon gender + age'],
  ['女的22岁', false, 'S3 standalone canon gender + age'],
];

const CONTRADICT_BLOCK_ROWS: Row[] = [
  ['我是男生', true, 'B1 gender contradicts (男生)'],
  ['我是男的', true, 'B2 gender contradicts (男的)'],
  ['我是男性', true, 'B3 gender contradicts (男性)'],
  ['自己是男生', true, 'B4 自己 anchor + 男'],
  ['我18岁', true, 'B5 age (18)'],
  ['我30岁', true, 'B6 age (30)'],
  ['我18 岁', true, 'B7 age (spaced)'],
  ['我身高175', true, 'B8 height no canon'],
  ['我身高 170 cm', true, 'B9 height no canon (unit)'],
  ['我体重50kg', true, 'B10 weight no canon'],
  ['我住北京', true, 'B11 residence (北京)'],
  ['我住上海', true, 'B12 residence (上海)'],
  ['我住New York', true, 'A4 New York not in canon'],
  ['我体重55', true, 'A6 weight bare digit'],
  ['我23岁', true, 'A11 age (23)'],
];

const STANDALONE_BLOCK_ROWS: Row[] = [
  ['男的', true, 'BS1 standalone 男'],
  ['男22岁', true, 'BS2 standalone 男'],
  ['女的18岁', true, 'BS3 standalone age 18'],
  ['女18岁', true, 'A12 standalone age 18'],
];

const EDGE_PASS_ROWS: Row[] = [
  ['她22岁', false, 'E1 third-person (她)'],
  ['他是男的', false, 'E2 third-person (他)'],
  ['她说她22岁了', false, 'E3 embedded long'],
  ['我女朋友今天生日', false, 'E4 compound 女朋友'],
  ['', false, 'E5 empty'],
  ['我住在这附近很久了', false, 'E6 这-prefixed'],
  ['我女老师', false, 'A13 compound 女老师'],
  ['我女同事', false, 'A14 compound 女同事'],
  ['去女生厕所', false, 'A15 compound 女生厕所'],
  ['进男生宿舍', false, 'A16 compound 男生宿舍'],
  ['自己猜', false, 'A17 tsundere'],
  ['不告诉你', false, 'A18 tsundere'],
  ['我不知道', false, 'A19 honest gap'],
  ['我忘了', false, 'A20 honest gap'],
  ['我住在这附近', false, 'A21 vague'],
  ['我22号去看演出', false, 'A22 22号 ≠ 22岁'],
  ['   ', false, 'A23 whitespace'],
  ['拉普兰德身高170', false, 'A27 3rd-person named'],
];

const CQ_ROWS: Row[] = [
  ['[CQ:reply,id=1] 我22岁', false, 'CQ + canon-match age'],
  ['[CQ:reply,id=1] 我30岁', true, 'CQ + contradicting age'],
  ['[CQ:reply,id=1] 自己猜', false, 'CQ + tsundere'],
];

describe('hasSelfPersonaFabrication — canon-consistent → PASS', () => {
  it.each([...CANON_PASS_ROWS, ...STANDALONE_PASS_ROWS])(
    '[%# %s] %s',
    (text, expected, _label) => {
      expect(hasSelfPersonaFabrication(text)).toBe(expected);
    },
  );
});

describe('hasSelfPersonaFabrication — contradicts canon → BLOCK', () => {
  it.each([...CONTRADICT_BLOCK_ROWS, ...STANDALONE_BLOCK_ROWS])(
    '[%# %s] %s',
    (text, expected, _label) => {
      expect(hasSelfPersonaFabrication(text)).toBe(expected);
    },
  );
});

describe('hasSelfPersonaFabrication — third-person / compound / tsundere → PASS', () => {
  it.each(EDGE_PASS_ROWS)('[%# %s] %s', (text, expected, _label) => {
    expect(hasSelfPersonaFabrication(text)).toBe(expected);
  });
});

describe('hasSelfPersonaFabrication — CQ:reply preprocess', () => {
  it.each(CQ_ROWS)('[%# %s] %s', (text, expected, _label) => {
    expect(hasSelfPersonaFabrication(text)).toBe(expected);
  });
});

describe('personaFabricationGuard — SendGuard shape', () => {
  it('contradicting age → passed:false, reason, replacement', () => {
    const r = personaFabricationGuard('我30岁', ctx);
    expect(r.passed).toBe(false);
    if (!r.passed) {
      expect(r.reason).toBe('persona-fabricated');
      expect(r.replacement).toBe('deflection');
    }
  });

  it('canon-consistent gender → passed:true, text preserved', () => {
    const r = personaFabricationGuard('我是女生', ctx);
    expect(r.passed).toBe(true);
    if (r.passed) expect(r.text).toBe('我是女生');
  });

  it('empty → passed:true', () => {
    expect(personaFabricationGuard('', ctx).passed).toBe(true);
    expect(personaFabricationGuard('   ', ctx).passed).toBe(true);
  });
});

describe('pickPersonaDeflection', () => {
  it('returns an item from IDENTITY_DEFLECTIONS pool', () => {
    for (let i = 0; i < 50; i++) {
      const pick = pickPersonaDeflection();
      expect(IDENTITY_DEFLECTIONS).toContain(pick);
    }
  });
});
