import { describe, it, expect } from 'vitest';
import { hasCoreferenceSelfReference } from '../../src/utils/sentinel.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

describe('hasCoreferenceSelfReference', () => {
  it('positive: bot says "我刚在说西瓜" with currentSpeaker="西瓜"', () => {
    expect(hasCoreferenceSelfReference('我刚在说西瓜', ['西瓜'])).toBe(true);
  });

  it('negative: bot says "我刚在说西瓜" with currentSpeaker="羊宫妃那"', () => {
    expect(hasCoreferenceSelfReference('我刚在说西瓜', ['羊宫妃那'])).toBe(false);
  });

  it('negative: bot says "西瓜好甜" with currentSpeaker="西瓜" (not self-ref pattern)', () => {
    // "西瓜好甜" does not contain any coreference verb like "在说"/"在聊"
    expect(hasCoreferenceSelfReference('西瓜好甜', ['西瓜'])).toBe(false);
  });

  it('edge: empty nickname array returns false', () => {
    expect(hasCoreferenceSelfReference('我刚在说西瓜', [])).toBe(false);
  });

  it('edge: empty string nickname in array returns false', () => {
    expect(hasCoreferenceSelfReference('我刚在说西瓜', [''])).toBe(false);
  });

  it('edge: output without coreference verb returns false', () => {
    // No "在说"/"在聊"/"在讨论"/"说的是"/"提到" verb
    expect(hasCoreferenceSelfReference('西瓜今天来了吗', ['西瓜'])).toBe(false);
    expect(hasCoreferenceSelfReference('我觉得西瓜很好', ['西瓜'])).toBe(false);
  });

  it('edge: empty output returns false', () => {
    expect(hasCoreferenceSelfReference('', ['西瓜'])).toBe(false);
  });

  it('edge: whitespace-only output returns false', () => {
    expect(hasCoreferenceSelfReference('   ', ['西瓜'])).toBe(false);
  });

  it('positive: "在聊X" pattern', () => {
    expect(hasCoreferenceSelfReference('你们在聊小明吗', ['小明'])).toBe(true);
  });

  it('positive: "提到X" pattern', () => {
    expect(hasCoreferenceSelfReference('我刚提到小明', ['小明'])).toBe(true);
  });

  it('positive: "在讨论X" pattern', () => {
    expect(hasCoreferenceSelfReference('大家在讨论西瓜', ['西瓜'])).toBe(true);
  });

  it('positive: "说的是X" pattern', () => {
    expect(hasCoreferenceSelfReference('说的是西瓜吧', ['西瓜'])).toBe(true);
  });

  it('negative: nickname not in output at all', () => {
    expect(hasCoreferenceSelfReference('在说什么呢', ['西瓜'])).toBe(false);
  });

  it('positive: multiple nicknames, second one matches', () => {
    expect(hasCoreferenceSelfReference('我在聊小号', ['大号', '小号'])).toBe(true);
  });
});
