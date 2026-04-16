import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConversationStateTracker } from '../../src/modules/conversation-state.js';
import type { IMemeGraphRepository, MemeGraph } from '../../src/storage/db.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

function makeMemeGraphRepo(entries: MemeGraph[]): IMemeGraphRepository {
  return {
    findSimilarActive(groupId: string, _emb: number[], _threshold: number, limit: number): MemeGraph[] {
      return entries.filter(e => e.groupId === groupId && e.status === 'active').slice(0, limit);
    },
    listActive(groupId: string, limit: number): MemeGraph[] {
      return entries.filter(e => e.groupId === groupId && e.status === 'active').slice(0, limit);
    },
  } as unknown as IMemeGraphRepository;
}

const ts = Math.floor(Date.now() / 1000);

const MEME_HYW: MemeGraph = {
  id: 1, groupId: 'g1', canonical: '何意味',
  variants: ['hyw', 'mmhyw', 'ohnmmhyw'],
  meaning: '表示困惑或不解',
  originEvent: null, originMsgId: null, originUserId: null, originTs: null,
  firstSeenCount: null, totalCount: 5, confidence: 0.6,
  status: 'active', embedding: null,
  createdAt: ts, updatedAt: ts,
};

const MEME_ZHIXIE: MemeGraph = {
  id: 2, groupId: 'g1', canonical: '智械危机',
  variants: ['智械危机', '我草智械危机'],
  meaning: 'bot 说了太像人的话',
  originEvent: null, originMsgId: null, originUserId: null, originTs: null,
  firstSeenCount: null, totalCount: 3, confidence: 0.5,
  status: 'active', embedding: null,
  createdAt: ts, updatedAt: ts,
};

describe('ConversationStateTracker meme_graph matching', () => {
  let tracker: ConversationStateTracker;
  const now = Math.floor(Date.now() / 1000);
  const originalEnv = process.env['MEMES_V1_DISABLED'];

  beforeEach(() => {
    tracker = new ConversationStateTracker();
    delete process.env['MEMES_V1_DISABLED'];
  });

  afterEach(() => {
    tracker.destroy();
    if (originalEnv !== undefined) {
      process.env['MEMES_V1_DISABLED'] = originalEnv;
    } else {
      delete process.env['MEMES_V1_DISABLED'];
    }
  });

  it('marks memeJoke on first hit via canonical match', () => {
    tracker.setMemeGraphRepo(makeMemeGraphRepo([MEME_HYW]));
    tracker.tick('g1', '何意味这是什么', 'u1', now);

    const snap = tracker.getSnapshot('g1');
    expect(snap.memeJokes.length).toBe(1);
    expect(snap.memeJokes[0]!.canonical).toBe('何意味');
    expect(snap.memeJokes[0]!.meaning).toBe('表示困惑或不解');
    expect(snap.memeJokes[0]!.count).toBe(1);
  });

  it('marks memeJoke on first hit via variant match', () => {
    tracker.setMemeGraphRepo(makeMemeGraphRepo([MEME_HYW]));
    tracker.tick('g1', 'hyw是什么意思', 'u1', now);

    const snap = tracker.getSnapshot('g1');
    expect(snap.memeJokes.length).toBe(1);
    expect(snap.memeJokes[0]!.canonical).toBe('何意味');
  });

  it('increments memeJoke count on multiple hits', () => {
    tracker.setMemeGraphRepo(makeMemeGraphRepo([MEME_HYW]));
    tracker.tick('g1', 'hyw!', 'u1', now);
    tracker.tick('g1', '又是hyw', 'u2', now + 1);

    const snap = tracker.getSnapshot('g1');
    expect(snap.memeJokes[0]!.count).toBe(2);
  });

  it('does NOT require 3 hits for meme-backed jokes (unlike jargon)', () => {
    // Regular jargon needs 3 hits to become active
    tracker.setMemeGraphRepo(makeMemeGraphRepo([MEME_HYW]));
    tracker.tick('g1', 'hyw来了', 'u1', now);

    const snap = tracker.getSnapshot('g1');
    // memeJokes should have it after just 1 hit
    expect(snap.memeJokes.length).toBe(1);
    // but activeJokes (regular jargon path) should NOT have it
    expect(snap.activeJokes.length).toBe(0);
  });

  it('matches case-insensitively', () => {
    tracker.setMemeGraphRepo(makeMemeGraphRepo([MEME_HYW]));
    tracker.tick('g1', 'HYW来了', 'u1', now);

    const snap = tracker.getSnapshot('g1');
    expect(snap.memeJokes.length).toBe(1);
  });

  it('skips meme scanning when MEMES_V1_DISABLED=1', () => {
    process.env['MEMES_V1_DISABLED'] = '1';
    tracker.setMemeGraphRepo(makeMemeGraphRepo([MEME_HYW]));
    tracker.tick('g1', 'hyw', 'u1', now);

    const snap = tracker.getSnapshot('g1');
    expect(snap.memeJokes.length).toBe(0);
  });

  it('skips meme scanning when memeGraphRepo not set', () => {
    // do NOT call setMemeGraphRepo
    tracker.tick('g1', 'hyw', 'u1', now);

    const snap = tracker.getSnapshot('g1');
    expect(snap.memeJokes.length).toBe(0);
  });

  it('matches multiple memes in same message', () => {
    tracker.setMemeGraphRepo(makeMemeGraphRepo([MEME_HYW, MEME_ZHIXIE]));
    tracker.tick('g1', 'hyw 我草智械危机', 'u1', now);

    const snap = tracker.getSnapshot('g1');
    expect(snap.memeJokes.length).toBe(2);
    const canonicals = snap.memeJokes.map(j => j.canonical).sort();
    expect(canonicals).toEqual(['何意味', '智械危机']);
  });

  it('returns empty memeJokes for unknown group', () => {
    const snap = tracker.getSnapshot('unknown');
    expect(snap.memeJokes).toEqual([]);
  });

  it('does not match memes from different groups', () => {
    const otherGroupMeme: MemeGraph = { ...MEME_HYW, groupId: 'g2' };
    tracker.setMemeGraphRepo(makeMemeGraphRepo([otherGroupMeme]));
    tracker.tick('g1', 'hyw', 'u1', now);

    const snap = tracker.getSnapshot('g1');
    expect(snap.memeJokes.length).toBe(0);
  });
});
