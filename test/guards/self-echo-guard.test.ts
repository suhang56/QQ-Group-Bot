import { describe, it, expect } from 'vitest';
import {
  SelfEchoGuard,
  isSelfAmplifiedAnnoyance,
  type BotEmotiveEntry,
} from '../../src/modules/guards/self-echo-guard.js';

describe('SelfEchoGuard — store', () => {
  it('getRecent on unseen group → []', () => {
    const g = new SelfEchoGuard();
    expect(g.getRecent('g1', 100)).toEqual([]);
  });

  it('record + getRecent round-trip', () => {
    const g = new SelfEchoGuard();
    g.record('g1', '烦死了', 100);
    g.record('g1', '累', 101);
    const out = g.getRecent('g1', 101);
    expect(out).toEqual([
      { text: '烦死了', ts: 100 },
      { text: '累', ts: 101 },
    ]);
  });

  it('prune-on-read drops entries older than 5min window', () => {
    const g = new SelfEchoGuard();
    g.record('g1', 'a', 100);
    g.record('g1', 'b', 101);
    g.record('g1', 'c', 102);
    // Advance clock to 500 (all entries aged out past 300s window)
    const out = g.getRecent('g1', 500);
    expect(out).toEqual([]);
  });

  it('prune-on-read keeps entries still inside window', () => {
    const g = new SelfEchoGuard();
    g.record('g1', 'old', 100);
    g.record('g1', 'mid', 300);
    g.record('g1', 'fresh', 410);
    // nowSec = 410 → old (ts=100, age=310s) expires; mid (ts=300, age=110) stays
    const out = g.getRecent('g1', 410);
    expect(out.map(e => e.text)).toEqual(['mid', 'fresh']);
  });

  it('bounded history per group — 5 records trimmed to last 3', () => {
    const g = new SelfEchoGuard();
    g.record('g1', 'a', 100);
    g.record('g1', 'b', 101);
    g.record('g1', 'c', 102);
    g.record('g1', 'd', 103);
    g.record('g1', 'e', 104);
    const out = g.getRecent('g1', 104);
    expect(out.map(e => e.text)).toEqual(['c', 'd', 'e']);
  });

  it('per-group isolation — different groupId kept separate', () => {
    const g = new SelfEchoGuard();
    g.record('g1', 'a', 100);
    g.record('g2', 'X', 100);
    expect(g.getRecent('g1', 100).map(e => e.text)).toEqual(['a']);
    expect(g.getRecent('g2', 100).map(e => e.text)).toEqual(['X']);
  });

  it('BoundedMap capacity — capacity 2, 3 groups → oldest evicted', () => {
    const g = new SelfEchoGuard(2);
    g.record('g1', 'a', 100);
    g.record('g2', 'b', 101);
    g.record('g3', 'c', 102);
    expect(g.getRecent('g1', 102)).toEqual([]);
    expect(g.getRecent('g3', 102).map(e => e.text)).toEqual(['c']);
  });
});

describe('isSelfAmplifiedAnnoyance — predicate', () => {
  const mkH = (texts: string[]): BotEmotiveEntry[] =>
    texts.map((text, i) => ({ text, ts: 100 + i }));

  it('empty history → false', () => {
    expect(isSelfAmplifiedAnnoyance('烦死', [], '')).toBe(false);
  });

  it('candidate has no stem → false regardless of history', () => {
    const hist = mkH(['烦', '累', '气']);
    expect(isSelfAmplifiedAnnoyance('哈哈', hist, '')).toBe(false);
  });

  it('fewer than 2 stems in last-3 history → false', () => {
    const hist = mkH(['烦', '好的', '谢谢']);
    expect(isSelfAmplifiedAnnoyance('累死了', hist, '')).toBe(false);
  });

  it('2 of last-3 contain stem + candidate has stem → true', () => {
    const hist = mkH(['烦', '好的', '累死了']);
    expect(isSelfAmplifiedAnnoyance('气死我了', hist, '')).toBe(true);
  });

  it('3 of 3 stems → true', () => {
    const hist = mkH(['烦', '累', '气']);
    expect(isSelfAmplifiedAnnoyance('崩了', hist, '')).toBe(true);
  });

  it('echo exemption (AQ1) — candidate substring of user trigger → false', () => {
    const hist = mkH(['烦', '累', '气']);
    expect(isSelfAmplifiedAnnoyance('累', hist, '我今天累死了')).toBe(false);
  });

  it('echo exemption — 3-char prefix of candidate matches user → false', () => {
    const hist = mkH(['烦', '累', '气']);
    // candidate = '累死了啊', prefix '累死了' is in user → exempt
    expect(isSelfAmplifiedAnnoyance('累死了啊', hist, '我今天累死了')).toBe(false);
  });

  it('no echo exemption — candidate stem appears in user but candidate itself does not overlap substring → true', () => {
    const hist = mkH(['烦', '累', '气']);
    // candidate = '气炸了', user = '我累' → no substring overlap, prefix '气炸了' not in user
    expect(isSelfAmplifiedAnnoyance('气炸了', hist, '我累')).toBe(true);
  });

  it('allowlist bypass — candidate 笑死 → false even if 笑 appears in history', () => {
    // 笑 not in EMOTIVE_STEMS, so regex would not match anyway — but verify
    // explicit allowlist guard prevents future regression.
    const hist = mkH(['笑死', '笑死我', '笑死']);
    expect(isSelfAmplifiedAnnoyance('笑死', hist, '')).toBe(false);
  });

  it('candidate with leading/trailing whitespace → trimmed before check', () => {
    const hist = mkH(['烦', '累', '气']);
    expect(isSelfAmplifiedAnnoyance('  崩了  ', hist, '')).toBe(true);
  });

  it('empty candidate → false', () => {
    const hist = mkH(['烦', '累', '气']);
    expect(isSelfAmplifiedAnnoyance('', hist, '')).toBe(false);
    expect(isSelfAmplifiedAnnoyance('   ', hist, '')).toBe(false);
  });

  it('history of 5 entries — only last 3 counted', () => {
    // first 2 have stems, last 3 do NOT → should NOT fire
    const hist = mkH(['烦', '累', '好的', '谢谢', '嗯']);
    expect(isSelfAmplifiedAnnoyance('气', hist, '')).toBe(false);
  });

  it('user trigger empty, history hits threshold + candidate has stem → true', () => {
    const hist = mkH(['烦死', '累']);
    expect(isSelfAmplifiedAnnoyance('气', hist, '')).toBe(true);
  });

  it('CJK unbroken emotive candidate vs emotive history → true', () => {
    const hist = mkH(['烦烦烦', '累累', '好']);
    expect(isSelfAmplifiedAnnoyance('气气气', hist, '')).toBe(true);
  });
});
