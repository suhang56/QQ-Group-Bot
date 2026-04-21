import { describe, it, expect } from 'vitest';
import { IDENTITY_PROBE } from '../../src/modules/chat.js';

describe('IDENTITY_PROBE — PR4 extended triggers (age/gender/height/weight/address/real-name)', () => {
  const match = (s: string) => IDENTITY_PROBE.test(s);

  describe('must match (true)', () => {
    it.each([
      '你几岁',
      '你多大',
      '你多少岁',
      '你年龄',
      '你是男是女',
      '你男的女的',
      '你是不是男',
      '你是不是女',
      '你多高',
      '你身高',
      '你多重',
      '你体重',
      '你住哪',
      '你住在哪',
      '你真名',
      '你本名',
      '你叫啥',
    ])('matches %s', (s) => {
      expect(match(s)).toBe(true);
    });
  });

  describe('must NOT match (false — 3rd-person / named / chatter)', () => {
    it.each([
      '她几岁',
      '拉普兰德身高多少',
      '我住在哪里来着',
      '他住哪',
      '今天天气不错',
    ])('does not match %s', (s) => {
      expect(match(s)).toBe(false);
    });
  });
});
