import { describe, it, expect } from 'vitest';
import { pickAtFallback, classifyAtFallbackReason } from '../src/modules/fallback-pool.js';

describe('pickAtFallback — pool selection', () => {
  it('request trigger → returns a request pool string', () => {
    const r = pickAtFallback('帮我做个东西');
    expect(['不想', '不帮', '想啥呢', '做梦', '别闹', '想得美', '不干', '不不不']).toContain(r);
  });

  it('question trigger → returns a question pool string', () => {
    const r = pickAtFallback('为什么天空是蓝的');
    expect(['不知道', '不清楚', '别问我', '懒得想', '问别人', '谁知道']).toContain(r);
  });

  it('exclaim trigger → returns an exclaim pool string', () => {
    const r = pickAtFallback('哈哈好棒！');
    expect(['嗯', '哦', '好', '收到', '行吧']).toContain(r);
  });

  it('generic trigger → returns a generic pool string', () => {
    const r = pickAtFallback('来一下');
    expect(['啊?', '咋了', '啥事', '?', '怎么了', '叫我干嘛', '什么']).toContain(r);
  });

  // Edge cases
  it('empty string → generic pool', () => {
    const r = pickAtFallback('');
    expect(['啊?', '咋了', '啥事', '?', '怎么了', '叫我干嘛', '什么']).toContain(r);
  });

  it('returns a non-empty string always', () => {
    for (const text of ['帮忙', '为什么?', '牛！', 'hello', '']) {
      expect(pickAtFallback(text).length).toBeGreaterThan(0);
    }
  });

  it('question with ? → question pool', () => {
    const r = pickAtFallback('你叫什么名字?');
    expect(['不知道', '不清楚', '别问我', '懒得想', '问别人', '谁知道']).toContain(r);
  });

  it('霸凌 keyword → request pool (abuse-request classification)', () => {
    const r = pickAtFallback('霸凌那个人');
    expect(['不想', '不帮', '想啥呢', '做梦', '别闹', '想得美', '不干', '不不不']).toContain(r);
  });
});

describe('classifyAtFallbackReason', () => {
  it('request → low-comprehension-direct', () => {
    expect(classifyAtFallbackReason('帮我做个东西')).toBe('low-comprehension-direct');
  });

  it('question → low-comprehension-direct', () => {
    expect(classifyAtFallbackReason('为什么?')).toBe('low-comprehension-direct');
  });

  it('exclaim → low-comprehension-direct', () => {
    expect(classifyAtFallbackReason('哈哈！')).toBe('low-comprehension-direct');
  });

  it('generic greeting → bot-blank-needed-ack', () => {
    expect(classifyAtFallbackReason('来一下')).toBe('bot-blank-needed-ack');
  });

  it('empty string → bot-blank-needed-ack', () => {
    expect(classifyAtFallbackReason('')).toBe('bot-blank-needed-ack');
  });

  // Boundary: exactly on regex boundary
  it('single ? → question (low-comprehension-direct)', () => {
    expect(classifyAtFallbackReason('?')).toBe('low-comprehension-direct');
  });

  it('single ! → exclaim (low-comprehension-direct)', () => {
    expect(classifyAtFallbackReason('好棒！')).toBe('low-comprehension-direct');
  });
});
