import { describe, it, expect } from 'vitest';
import {
  entityGuard,
  isQaReportTone,
  qaReportRegenHint,
  hasCoreferenceSelfReference,
} from '../../src/utils/sentinel.js';

// ============================================================
// Entity Guard
// ============================================================
describe('entityGuard', () => {
  it('returns null for clean output', () => {
    expect(entityGuard('今天天气不错')).toBeNull();
    expect(entityGuard('Roselia 最棒了')).toBeNull();
    expect(entityGuard('我喜欢友希那')).toBeNull();
    expect(entityGuard('HHW 的歌也不错啊')).toBeNull();
  });

  it('catches "谁喜欢X啊" disparagement', () => {
    expect(entityGuard('谁喜欢HHW啊')).not.toBeNull();
    expect(entityGuard('谁听Roselia啊')).not.toBeNull();
    expect(entityGuard('谁喜欢友希那啊')).not.toBeNull();
    expect(entityGuard('谁推mygo啊')).not.toBeNull();
  });

  it('catches "X真难听" disparagement', () => {
    expect(entityGuard('Roselia真难听')).not.toBeNull();
    expect(entityGuard('HHW真垃圾')).not.toBeNull();
    expect(entityGuard('友希那真烂')).not.toBeNull();
    expect(entityGuard('MyGO太难听')).not.toBeNull();
  });

  it('catches "讨厌X" disparagement', () => {
    expect(entityGuard('讨厌Roselia')).not.toBeNull();
    expect(entityGuard('烦HHW')).not.toBeNull();
  });

  it('catches case-insensitive matches', () => {
    expect(entityGuard('谁喜欢hhw啊')).not.toBeNull();
    expect(entityGuard('谁喜欢HHW啊')).not.toBeNull();
    expect(entityGuard('roselia真难听')).not.toBeNull();
  });

  it('returns a fallback string from the pool', () => {
    const result = entityGuard('谁喜欢HHW啊');
    expect(result).not.toBeNull();
    // Fallback must be one of the known options
    expect(['各有各的粉', '我不说这个', '嗯', '']).toContain(result);
  });

  it('does not false-positive on neutral mentions', () => {
    expect(entityGuard('友希那今天唱得好')).toBeNull();
    expect(entityGuard('HHW 的新歌出了')).toBeNull();
    expect(entityGuard('我在听 Roselia')).toBeNull();
    expect(entityGuard('mygo 春日影好好听')).toBeNull();
  });

  it('does not trigger on empty string', () => {
    expect(entityGuard('')).toBeNull();
  });

  it('catches compound disparagement patterns', () => {
    expect(entityGuard('Ave Mujica不行')).not.toBeNull();
    expect(entityGuard('母鸡卡辣鸡')).not.toBeNull();
    expect(entityGuard('纱夜废物')).not.toBeNull();
  });

  it('catches 蝶/魔莉菇 aliases for Morfonica', () => {
    expect(entityGuard('谁喜欢蝶啊')).not.toBeNull();
    expect(entityGuard('魔莉菇真垃圾')).not.toBeNull();
  });
});

// ============================================================
// QA-Report Detector
// ============================================================
describe('isQaReportTone', () => {
  it('returns false for short casual replies', () => {
    expect(isQaReportTone('哈哈')).toBe(false);
    expect(isQaReportTone('草')).toBe(false);
    expect(isQaReportTone('确实')).toBe(false);
    expect(isQaReportTone('?')).toBe(false);
  });

  it('returns false for empty/whitespace', () => {
    expect(isQaReportTone('')).toBe(false);
    expect(isQaReportTone('   ')).toBe(false);
  });

  it('flags declarative >20 chars with 是 and ending in 吗？', () => {
    expect(isQaReportTone('Roselia是日本BanG Dream系列中的一个虚构乐队吗？')).toBe(true);
    expect(isQaReportTone('凑友希那是Roselia的主唱你应该知道吗?')).toBe(true);
  });

  it('does not flag short messages even with 是 and 吗', () => {
    expect(isQaReportTone('是这样吗？')).toBe(false);  // <= 20 chars
  });

  it('flags "我刚" + 反问 pattern', () => {
    expect(isQaReportTone('我刚不是在说西瓜吗?')).toBe(true);
    expect(isQaReportTone('我刚说了什么来着？')).toBe(true);
  });

  it('flags "刚才我" + 反问 pattern', () => {
    expect(isQaReportTone('刚才我不是解释过了吗？')).toBe(true);
  });

  it('flags "我不是说过" + 反问', () => {
    expect(isQaReportTone('我不是说过了吗？为什么还问？')).toBe(true);
  });

  it('does not flag "我刚" without 反问', () => {
    expect(isQaReportTone('我刚吃完饭')).toBe(false);
  });

  it('flags encyclopedic "X是Y的Z" pattern >20 chars', () => {
    expect(isQaReportTone('凑友希那是Roselia的主唱和领队负责作词作曲')).toBe(true);
  });

  it('does not flag "X是Y的Z" with exclamation/question', () => {
    // Questions are OK -- they are not declarative encyclopedia
    expect(isQaReportTone('凑友希那是Roselia的主唱吧你应该知道这个？')).toBe(false);
  });

  it('does not flag casual chat even if >20 chars', () => {
    expect(isQaReportTone('笑死我了今天到底发生了什么哈哈哈哈哈哈哈哈')).toBe(false);
  });
});

describe('qaReportRegenHint', () => {
  it('returns hint string when flagged', () => {
    const hint = qaReportRegenHint('Roselia是日本BanG Dream系列中的一个虚构乐队吗？');
    expect(hint).not.toBeNull();
    expect(hint).toContain('QA');
  });

  it('returns null when clean', () => {
    expect(qaReportRegenHint('草')).toBeNull();
    expect(qaReportRegenHint('笑死')).toBeNull();
  });
});

// ============================================================
// Coreference Guard
// ============================================================
describe('hasCoreferenceSelfReference', () => {
  it('returns false for clean output', () => {
    expect(hasCoreferenceSelfReference('今天天气不错', ['西瓜'])).toBe(false);
    expect(hasCoreferenceSelfReference('哈哈哈', ['西瓜'])).toBe(false);
  });

  it('returns false for empty output', () => {
    expect(hasCoreferenceSelfReference('', ['西瓜'])).toBe(false);
    expect(hasCoreferenceSelfReference('   ', ['西瓜'])).toBe(false);
  });

  it('returns false for empty nicknames array', () => {
    expect(hasCoreferenceSelfReference('在说西瓜', [])).toBe(false);
  });

  it('detects "在说X" pattern (the exact Case 3 bad case)', () => {
    expect(hasCoreferenceSelfReference('我刚不是在说西瓜吗', ['西瓜'])).toBe(true);
  });

  it('detects "在聊X" pattern', () => {
    expect(hasCoreferenceSelfReference('不是在聊kisa吗', ['kisa'])).toBe(true);
  });

  it('detects "在讨论X" pattern', () => {
    expect(hasCoreferenceSelfReference('在讨论常山的事', ['常山'])).toBe(true);
  });

  it('detects "说的是X" pattern', () => {
    expect(hasCoreferenceSelfReference('说的是飞鸟啊', ['飞鸟'])).toBe(true);
  });

  it('detects "提到X" pattern', () => {
    expect(hasCoreferenceSelfReference('刚才提到西瓜了', ['西瓜'])).toBe(true);
  });

  it('does not trigger on unrelated mentions of the name', () => {
    // The name appears but not in a coreference frame
    expect(hasCoreferenceSelfReference('西瓜你好啊', ['西瓜'])).toBe(false);
    expect(hasCoreferenceSelfReference('问一下西瓜', ['西瓜'])).toBe(false);
  });

  it('handles multiple nicknames', () => {
    expect(hasCoreferenceSelfReference(
      '不是在说NEU第一rui厨吗',
      ['NEU第一rui厨', '西瓜'],
    )).toBe(true);
  });

  it('handles regex-special characters in nicknames', () => {
    // Nickname with special regex chars should be escaped
    expect(hasCoreferenceSelfReference(
      '在说test(123)吗',
      ['test(123)'],
    )).toBe(true);
  });

  it('handles empty/null nicknames in the array gracefully', () => {
    expect(hasCoreferenceSelfReference('在说西瓜', ['', '西瓜'])).toBe(true);
    expect(hasCoreferenceSelfReference('哈哈', ['', ''])).toBe(false);
  });

  it('detects "不是在说X" pattern', () => {
    expect(hasCoreferenceSelfReference('不是在说西瓜吗', ['西瓜'])).toBe(true);
  });

  it('case insensitive for English nicknames', () => {
    expect(hasCoreferenceSelfReference('在说Kisa', ['kisa'])).toBe(true);
  });
});
