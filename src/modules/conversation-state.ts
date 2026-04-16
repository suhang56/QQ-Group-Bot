/**
 * Conversation State Tracker: per-group 15-minute sliding window that
 * tracks current topics, active jokes (repeated jargon), and participants.
 *
 * Produces a one-liner context injection for the LLM prompt:
 *   [群里最近在聊: X, Y；正活跃的梗: Z]
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('conversation-state');

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const ACTIVE_JOKE_THRESHOLD = 3; // jargon repeated >= 3 times → active joke
const MAX_TOPICS = 3;
const MAX_JOKES = 5;

// Chinese stop words to exclude from topic extraction
const STOP_WORDS = new Set([
  '的', '了', '吗', '吧', '呢', '啊', '嗯', '哦', '哈', '是', '有', '在',
  '不', '也', '都', '会', '要', '就', '还', '很', '太', '好', '可以',
  '什么', '怎么', '为什么', '这', '那', '我', '你', '他', '她', '它',
  '们', '和', '与', '或', '但', '可', '能', '到', '去', '来',
  '看', '说', '想', '知道', '觉得', '感觉', '真的', '真',
  '对', '又', '啥', '吃', '干', '做', '让', '被', '把', '给',
  '一', '二', '三', '个', '些', '只', '还是', '如果',
]);

export interface Topic {
  readonly word: string;
  readonly count: number;
}

export interface JokeRecord {
  readonly term: string;
  readonly count: number;
  readonly firstSeen: number;
}

/** Meme term passed to tick() for first-hit matching (cached at cycle boundary). */
export interface MemeTerm {
  readonly canonical: string;
  readonly variants: readonly string[];
  readonly meaning: string;
}

/** A meme-backed active joke — set on first match, no 3-hit threshold. */
export interface MemeJokeRecord {
  readonly canonical: string;
  readonly meaning: string;
  readonly count: number;
  readonly firstSeen: number;
}

export interface ConversationSnapshot {
  readonly currentTopics: ReadonlyArray<Topic>;
  readonly activeJokes: ReadonlyArray<JokeRecord>;
  readonly memeJokes: ReadonlyArray<MemeJokeRecord>;
  readonly participantCount: number;
  readonly windowStart: number;
}

interface TimestampedMessage {
  readonly content: string;
  readonly userId: string;
  readonly timestamp: number;
}

interface GroupState {
  messages: TimestampedMessage[];
  wordFreq: Map<string, number>;
  jargonFreq: Map<string, { count: number; firstSeen: number }>;
  memeJokeFreq: Map<string, { meaning: string; count: number; firstSeen: number }>;
  participants: Map<string, number>; // userId → lastActiveTs
}

export class ConversationStateTracker {
  private readonly states = new Map<string, GroupState>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Periodic cleanup of stale groups
    this.pruneTimer = setInterval(() => this._pruneStaleGroups(), WINDOW_MS);
    this.pruneTimer.unref?.();
  }

  destroy(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  /**
   * Feed a new message into the tracker. Call this for every group message.
   */
  tick(
    groupId: string,
    content: string,
    userId: string,
    timestamp: number,
    knownJargon?: ReadonlyArray<string>,
    knownMemes?: ReadonlyArray<MemeTerm>,
  ): void {
    const state = this._getOrCreateState(groupId);
    const now = timestamp * 1000; // convert to ms if seconds

    // Add message
    const msg: TimestampedMessage = { content, userId, timestamp: now };
    state.messages = [...state.messages, msg];

    // Update participant
    state.participants = new Map(state.participants);
    state.participants.set(userId, now);

    // Extract words and update frequency
    const words = this._extractWords(content);
    const newWordFreq = new Map(state.wordFreq);
    for (const word of words) {
      newWordFreq.set(word, (newWordFreq.get(word) ?? 0) + 1);
    }
    state.wordFreq = newWordFreq;

    // Check jargon hits
    if (knownJargon) {
      const contentLower = content.toLowerCase();
      const newJargonFreq = new Map(state.jargonFreq);
      for (const term of knownJargon) {
        if (contentLower.includes(term.toLowerCase())) {
          const existing = newJargonFreq.get(term);
          if (existing) {
            newJargonFreq.set(term, { count: existing.count + 1, firstSeen: existing.firstSeen });
          } else {
            newJargonFreq.set(term, { count: 1, firstSeen: now });
          }
        }
      }
      state.jargonFreq = newJargonFreq;
    }

    // Scan for meme_graph matches — marks activeJoke on first hit (no 3-hit threshold)
    if (knownMemes && knownMemes.length > 0) {
      this._scanMemeMatches(content, now, state, knownMemes);
    }

    // Expire old messages outside the window
    this._expireOldMessages(groupId, now);
  }

  /**
   * Get the current conversation snapshot for a group.
   */
  getSnapshot(groupId: string): ConversationSnapshot {
    const state = this.states.get(groupId);
    if (!state) {
      return { currentTopics: [], activeJokes: [], memeJokes: [], participantCount: 0, windowStart: Date.now() };
    }

    const now = Date.now();
    this._expireOldMessages(groupId, now);

    // Top topics by frequency
    const sortedWords = [...state.wordFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_TOPICS)
      .filter(([_, count]) => count >= 2) // Only words appearing 2+ times
      .map(([word, count]) => ({ word, count }));

    // Active jokes: jargon terms that appeared >= threshold times
    const activeJokes = [...state.jargonFreq.entries()]
      .filter(([_, v]) => v.count >= ACTIVE_JOKE_THRESHOLD)
      .slice(0, MAX_JOKES)
      .map(([term, v]) => ({ term, count: v.count, firstSeen: v.firstSeen }));

    // Meme-backed jokes: always active on first hit (no threshold)
    const memeJokes: MemeJokeRecord[] = [...state.memeJokeFreq.entries()]
      .slice(0, MAX_JOKES)
      .map(([canonical, v]) => ({
        canonical,
        meaning: v.meaning,
        count: v.count,
        firstSeen: v.firstSeen,
      }));

    const windowStart = state.messages.length > 0
      ? state.messages[0]!.timestamp
      : now;

    return {
      currentTopics: sortedWords,
      activeJokes,
      memeJokes,
      participantCount: state.participants.size,
      windowStart,
    };
  }

  /**
   * Check if a term is currently an active joke in a group.
   */
  isActiveJoke(groupId: string, term: string): boolean {
    const state = this.states.get(groupId);
    if (!state) return false;
    const entry = state.jargonFreq.get(term);
    return entry !== undefined && entry.count >= ACTIVE_JOKE_THRESHOLD;
  }

  /**
   * Format the conversation state as a one-liner for prompt injection.
   * Returns empty string if no meaningful state.
   */
  formatForPrompt(groupId: string): string {
    const snap = this.getSnapshot(groupId);
    const parts: string[] = [];

    if (snap.currentTopics.length > 0) {
      parts.push(`群里最近在聊: ${snap.currentTopics.map(t => t.word).join(', ')}`);
    }
    if (snap.activeJokes.length > 0) {
      parts.push(`正活跃的梗: ${snap.activeJokes.map(j => j.term).join(', ')}`);
    }

    if (parts.length === 0) return '';
    return `[${parts.join('；')}]`;
  }

  private _getOrCreateState(groupId: string): GroupState {
    let state = this.states.get(groupId);
    if (!state) {
      state = {
        messages: [],
        wordFreq: new Map(),
        jargonFreq: new Map(),
        memeJokeFreq: new Map(),
        participants: new Map(),
      };
      this.states.set(groupId, state);
    }
    return state;
  }

  private _expireOldMessages(groupId: string, nowMs: number): void {
    const state = this.states.get(groupId);
    if (!state) return;

    const cutoff = nowMs - WINDOW_MS;
    const oldCount = state.messages.length;
    const newMessages = state.messages.filter(m => m.timestamp >= cutoff);

    if (newMessages.length === oldCount) return;

    // Rebuild frequency maps from remaining messages
    const newWordFreq = new Map<string, number>();
    const newJargonFreq = new Map<string, { count: number; firstSeen: number }>();
    const newParticipants = new Map<string, number>();

    for (const msg of newMessages) {
      // Words
      for (const word of this._extractWords(msg.content)) {
        newWordFreq.set(word, (newWordFreq.get(word) ?? 0) + 1);
      }
      // Participants
      const existing = newParticipants.get(msg.userId);
      if (!existing || msg.timestamp > existing) {
        newParticipants.set(msg.userId, msg.timestamp);
      }
    }

    // Rebuild jargon from old state but only keep entries with messages in window
    // (simplification: keep jargon freq as-is but decrement based on expired messages)
    // Actually, rebuild from scratch for correctness
    for (const msg of newMessages) {
      const contentLower = msg.content.toLowerCase();
      for (const [term, _] of state.jargonFreq) {
        if (contentLower.includes(term.toLowerCase())) {
          const existing = newJargonFreq.get(term);
          if (existing) {
            newJargonFreq.set(term, { count: existing.count + 1, firstSeen: existing.firstSeen });
          } else {
            newJargonFreq.set(term, { count: 1, firstSeen: msg.timestamp });
          }
        }
      }
    }

    // Rebuild memeJokeFreq from remaining messages using known canonicals.
    // We can only rebuild counts for terms already tracked in state — new
    // terms are added via tick(), not during expiration.
    const newMemeJokeFreq = new Map<string, { meaning: string; count: number; firstSeen: number }>();
    if (state.memeJokeFreq.size > 0) {
      for (const msg of newMessages) {
        const contentLower = msg.content.toLowerCase();
        for (const [canonical, info] of state.memeJokeFreq) {
          if (contentLower.includes(canonical.toLowerCase())) {
            const existing = newMemeJokeFreq.get(canonical);
            if (existing) {
              newMemeJokeFreq.set(canonical, {
                meaning: existing.meaning,
                count: existing.count + 1,
                firstSeen: existing.firstSeen,
              });
            } else {
              newMemeJokeFreq.set(canonical, {
                meaning: info.meaning,
                count: 1,
                firstSeen: msg.timestamp,
              });
            }
          }
        }
      }
    }

    state.messages = newMessages;
    state.wordFreq = newWordFreq;
    state.jargonFreq = newJargonFreq;
    state.memeJokeFreq = newMemeJokeFreq;
    state.participants = newParticipants;
  }

  /**
   * Scan message content against cached meme terms. On first match,
   * immediately marks memeJokeFreq (no 3-hit threshold like jargon).
   * Terms are cached at cycle boundary and passed in, not queried per-tick.
   */
  private _scanMemeMatches(
    content: string,
    nowMs: number,
    state: GroupState,
    knownMemes: ReadonlyArray<MemeTerm>,
  ): void {
    const contentLower = content.toLowerCase();
    const newMemeJokeFreq = new Map(state.memeJokeFreq);

    for (const meme of knownMemes) {
      const terms = [meme.canonical, ...meme.variants];
      const matched = terms.some(t => contentLower.includes(t.toLowerCase()));
      if (matched) {
        const existing = newMemeJokeFreq.get(meme.canonical);
        if (existing) {
          newMemeJokeFreq.set(meme.canonical, {
            meaning: existing.meaning,
            count: existing.count + 1,
            firstSeen: existing.firstSeen,
          });
        } else {
          newMemeJokeFreq.set(meme.canonical, {
            meaning: meme.meaning,
            count: 1,
            firstSeen: nowMs,
          });
        }
      }
    }
    state.memeJokeFreq = newMemeJokeFreq;
  }

  /**
   * Extract meaningful words from a message for topic tracking.
   * Uses CJK 2-gram sliding window + ASCII word extraction.
   */
  private _extractWords(content: string): string[] {
    const clean = content
      .replace(/\[CQ:[^\]]*\]/g, '')
      .trim();
    if (!clean) return [];

    const words: string[] = [];

    // Split on whitespace/punctuation
    const segments = clean.split(/[\s\p{P}]+/u).filter(Boolean);
    for (const seg of segments) {
      // ASCII words: keep if >= 3 chars
      if (/^[a-zA-Z0-9]+$/.test(seg)) {
        if (seg.length >= 3) {
          const lower = seg.toLowerCase();
          if (!STOP_WORDS.has(lower)) words.push(lower);
        }
        continue;
      }

      // CJK: sliding 2-grams
      const cjkOnly = seg.replace(/[^\u4e00-\u9fff\u3400-\u4dbf]/g, '');
      for (let i = 0; i < cjkOnly.length - 1; i++) {
        const bigram = cjkOnly.slice(i, i + 2);
        if (!STOP_WORDS.has(bigram)) {
          words.push(bigram);
        }
      }
    }

    return words;
  }

  private _pruneStaleGroups(): void {
    const now = Date.now();
    const cutoff = now - WINDOW_MS * 2; // prune groups inactive for 2x window
    for (const [groupId, state] of this.states) {
      if (state.messages.length === 0) {
        this.states.delete(groupId);
        continue;
      }
      const lastMsg = state.messages[state.messages.length - 1]!;
      if (lastMsg.timestamp < cutoff) {
        this.states.delete(groupId);
        logger.debug({ groupId }, 'Pruned stale conversation state');
      }
    }
  }
}
