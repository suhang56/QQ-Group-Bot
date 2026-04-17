import type { GroupAggregateStyle, StyleJsonData } from '../storage/db.js';

const MIN_USERS = 3;
const PHRASE_MIN_USERS = 2;
const TOPIC_MIN_USERS = 2;
const TRAIT_MIN_USERS = 2;
const TOP_PHRASES = 5;
const TOP_TOPICS = 5;
const TOP_TRAITS = 3;
const TRAIT_MIN_LEN = 2;
const TRAIT_MAX_LEN = 4;

const PUNCT_MINIMAL_RE = /少|不用|几乎不/;
const PUNCT_HEAVY_RE = /多|频繁|大量|!|！/;
const PUNCT_NORMAL_RE = /感叹/;
const EMOJI_RE = /emoji|表情|颜文字|😂|🤣/;

type Aggregate = Omit<GroupAggregateStyle, 'updatedAt'>;

/**
 * Compute a group-level aggregate from per-user style profiles.
 * Returns null when fewer than 3 users have styles (not enough signal).
 */
export function computeGroupAggregate(
  styles: Array<{ userId: string; style: StyleJsonData }>,
): Aggregate | null {
  const users = styles.filter(s => s.userId);
  if (users.length < MIN_USERS) return null;

  const topCatchphrases = rankByUserCount(
    users.map(u => ({ userId: u.userId, items: u.style.catchphrases ?? [] })),
    PHRASE_MIN_USERS,
    TOP_PHRASES,
  ).map(r => ({ phrase: r.item, userCount: r.userCount }));

  const topTopics = rankByUserCount(
    users.map(u => ({ userId: u.userId, items: u.style.topicAffinity ?? [] })),
    TOPIC_MIN_USERS,
    TOP_TOPICS,
  ).map(r => ({ topic: r.item, userCount: r.userCount }));

  const punctuationDensity = majorityPunctuation(users.map(u => u.style.punctuationStyle ?? ''));
  const emojiProneness = emojiProneness_(users.map(u => `${u.style.punctuationStyle ?? ''}${u.style.sentencePattern ?? ''}`));

  const commonSentenceTraits = rankByUserCount(
    users.map(u => ({
      userId: u.userId,
      items: extractTraitSubstrings(u.style.sentencePattern ?? ''),
    })),
    TRAIT_MIN_USERS,
    TOP_TRAITS,
  ).map(r => r.item);

  return {
    topCatchphrases,
    punctuationDensity,
    emojiProneness,
    commonSentenceTraits,
    topTopics,
    userCount: users.length,
  };
}

interface Ranked { item: string; userCount: number }

function rankByUserCount(
  rows: Array<{ userId: string; items: string[] }>,
  minUsers: number,
  topN: number,
): Ranked[] {
  const userSets = new Map<string, Set<string>>();
  for (const row of rows) {
    const seen = new Set<string>();
    for (const raw of row.items) {
      const item = typeof raw === 'string' ? raw.trim() : '';
      if (!item) continue;
      if (seen.has(item)) continue;
      seen.add(item);
      let set = userSets.get(item);
      if (!set) { set = new Set(); userSets.set(item, set); }
      set.add(row.userId);
    }
  }
  const ranked: Ranked[] = [];
  for (const [item, set] of userSets) {
    if (set.size >= minUsers) ranked.push({ item, userCount: set.size });
  }
  // Stable: userCount desc, item asc (lexicographic tiebreaker).
  ranked.sort((a, b) => {
    if (b.userCount !== a.userCount) return b.userCount - a.userCount;
    return a.item < b.item ? -1 : a.item > b.item ? 1 : 0;
  });
  return ranked.slice(0, topN);
}

function majorityPunctuation(styles: string[]): GroupAggregateStyle['punctuationDensity'] {
  const counts: Record<GroupAggregateStyle['punctuationDensity'], number> = {
    minimal: 0, light: 0, normal: 0, heavy: 0,
  };
  for (const s of styles) {
    counts[classifyPunctuation(s)]++;
  }
  // Highest count wins; ties broken by order: minimal < light < normal < heavy (deterministic).
  const order: Array<GroupAggregateStyle['punctuationDensity']> = ['minimal', 'light', 'normal', 'heavy'];
  let best: GroupAggregateStyle['punctuationDensity'] = 'light';
  let bestCount = -1;
  for (const k of order) {
    if (counts[k] > bestCount) { best = k; bestCount = counts[k]; }
  }
  return best;
}

function classifyPunctuation(s: string): GroupAggregateStyle['punctuationDensity'] {
  if (PUNCT_MINIMAL_RE.test(s)) return 'minimal';
  if (PUNCT_HEAVY_RE.test(s)) return 'heavy';
  if (PUNCT_NORMAL_RE.test(s)) return 'normal';
  return 'light';
}

function emojiProneness_(inputs: string[]): GroupAggregateStyle['emojiProneness'] {
  if (inputs.length === 0) return 'rare';
  let hits = 0;
  for (const s of inputs) if (EMOJI_RE.test(s)) hits++;
  const ratio = hits / inputs.length;
  if (ratio >= 0.5) return 'frequent';
  if (ratio >= 0.2) return 'occasional';
  return 'rare';
}

function extractTraitSubstrings(pattern: string): string[] {
  const out: string[] = [];
  if (!pattern) return out;
  const cleaned = pattern.replace(/\s+/g, '');
  if (cleaned.length < TRAIT_MIN_LEN) return out;
  const seen = new Set<string>();
  for (let len = TRAIT_MIN_LEN; len <= TRAIT_MAX_LEN; len++) {
    if (cleaned.length < len) break;
    for (let i = 0; i + len <= cleaned.length; i++) {
      const sub = cleaned.slice(i, i + len);
      if (seen.has(sub)) continue;
      seen.add(sub);
      out.push(sub);
    }
  }
  return out;
}
