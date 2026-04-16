import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConversationStateTracker, type MemeTerm } from '../../src/modules/conversation-state.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

const MEME_HYW: MemeTerm = {
  canonical: '何意味',
  variants: ['hyw', 'mmhyw', 'ohnmmhyw'],
  meaning: '表示困惑或不解',
};

const MEME_ZHIXIE: MemeTerm = {
  canonical: '智械危机',
  variants: ['智械危机', '我草智械危机'],
  meaning: 'bot 说了太像人的话',
};

describe('ConversationStateTracker meme_graph matching', () => {
  let tracker: ConversationStateTracker;
  const now = Math.floor(Date.now() / 1000);

  beforeEach(() => {
    tracker = new ConversationStateTracker();
  });

  afterEach(() => {
    tracker.destroy();
  });

  it('marks memeJoke on first hit via canonical match', () => {
    tracker.tick('g1', '何意味这是什么', 'u1', now, undefined, [MEME_HYW]);

    const snap = tracker.getSnapshot('g1');
    expect(snap.memeJokes.length).toBe(1);
    expect(snap.memeJokes[0]!.canonical).toBe('何意味');
    expect(snap.memeJokes[0]!.meaning).toBe('表示困惑或不解');
    expect(snap.memeJokes[0]!.count).toBe(1);
  });

  it('marks memeJoke on first hit via variant match', () => {
    tracker.tick('g1', 'hyw是什么意思', 'u1', now, undefined, [MEME_HYW]);

    const snap = tracker.getSnapshot('g1');
    expect(snap.memeJokes.length).toBe(1);
    expect(snap.memeJokes[0]!.canonical).toBe('何意味');
  });

  it('increments memeJoke count on multiple hits', () => {
    tracker.tick('g1', 'hyw!', 'u1', now, undefined, [MEME_HYW]);
    tracker.tick('g1', '又是hyw', 'u2', now + 1, undefined, [MEME_HYW]);

    const snap = tracker.getSnapshot('g1');
    expect(snap.memeJokes[0]!.count).toBe(2);
  });

  it('does NOT require 3 hits for meme-backed jokes (unlike jargon)', () => {
    tracker.tick('g1', 'hyw来了', 'u1', now, undefined, [MEME_HYW]);

    const snap = tracker.getSnapshot('g1');
    // memeJokes should have it after just 1 hit
    expect(snap.memeJokes.length).toBe(1);
    // but activeJokes (regular jargon path) should NOT have it
    expect(snap.activeJokes.length).toBe(0);
  });

  it('matches case-insensitively', () => {
    tracker.tick('g1', 'HYW来了', 'u1', now, undefined, [MEME_HYW]);

    const snap = tracker.getSnapshot('g1');
    expect(snap.memeJokes.length).toBe(1);
  });

  it('skips meme scanning when no knownMemes passed', () => {
    tracker.tick('g1', 'hyw', 'u1', now);

    const snap = tracker.getSnapshot('g1');
    expect(snap.memeJokes.length).toBe(0);
  });

  it('skips meme scanning when knownMemes is empty', () => {
    tracker.tick('g1', 'hyw', 'u1', now, undefined, []);

    const snap = tracker.getSnapshot('g1');
    expect(snap.memeJokes.length).toBe(0);
  });

  it('matches multiple memes in same message', () => {
    tracker.tick('g1', 'hyw 我草智械危机', 'u1', now, undefined, [MEME_HYW, MEME_ZHIXIE]);

    const snap = tracker.getSnapshot('g1');
    expect(snap.memeJokes.length).toBe(2);
    const canonicals = snap.memeJokes.map(j => j.canonical).sort();
    expect(canonicals).toEqual(['何意味', '智械危机']);
  });

  it('returns empty memeJokes for unknown group', () => {
    const snap = tracker.getSnapshot('unknown');
    expect(snap.memeJokes).toEqual([]);
  });

  it('does not match when message does not contain meme terms', () => {
    tracker.tick('g1', '今天天气真好', 'u1', now, undefined, [MEME_HYW]);

    const snap = tracker.getSnapshot('g1');
    expect(snap.memeJokes.length).toBe(0);
  });
});
