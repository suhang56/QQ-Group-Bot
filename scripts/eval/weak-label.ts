import type { DatabaseSync } from 'node:sqlite';
import type { SampledRow, WeakReplayLabel, WeakLabeledRow, ExpectedAct, ExpectedDecision, KnownFactSource } from './types.js';
import { collectTermsWithSource, type SourcedTerm } from './categories/cat2-known-fact-term.js';

const R4_DEPLOY_EPOCH = 1700000000; // approx R4 deploy date; rows before this may have legacy few-shot

const BOT_STATUS_KEYWORDS = [
  '禁言', '解禁', '策略', '小号', '机器人', 'bot', '屏蔽', '沉默',
  '为什么不说话', '你死了', '你怎么不回',
];
const CONFLICT_KEYWORDS = [
  '你他妈', '草你', '傻逼', '废物', '滚', '你妈', 'cnm', 'nmsl', 'sb', '蠢', '脑子有病', '找打',
];
const RELAY_SET = new Set(['1', '2', '3', '扣1', '接龙', '+1', '！', '!', '冲']);
const SUMMARIZE_RE = /总结|回顾|说说刚才/;
const QUESTION_END_RE = /[？?]$/;
const QUESTION_START_RE = /^(为什么|怎么|啥|几)/;

/** True if content starts with '/' — admin command out of benchmark scope. */
function isAdminCommand(row: SampledRow): boolean {
  return row.content.trimStart().startsWith('/');
}

function isDirect(row: SampledRow, botQQ: string): boolean {
  const raw = row.rawContent ?? row.content;
  return raw.includes(`[CQ:at,qq=${botQQ}`) || raw.includes('[CQ:reply,');
}

/**
 * R6.1c: computed independently from triggerContext — NOT from row.category.
 *
 * This must NOT rely on anything the sampler decided, so a cat7-sampled row
 * whose triggerContext doesn't actually contain echoes can legitimately
 * receive isRelay=false (precision signal for R6.2 gold labelers).
 *
 * Rules (stricter than queryCat7's sampling window):
 *   1. Fast-path: row.content in RELAY_SET → true.
 *   2. Echo-in-window: 2+ triggerContext rows with content === row.content
 *      AND whose timestamp is within 30s of row.timestamp.
 *
 * Sampler's window is 5 messages regardless of time; labeler tightens with
 * a 30s ceiling — that's where the two can legitimately disagree.
 */
function isRelayPattern(row: SampledRow): boolean {
  const trimmed = row.content.trim();
  if (RELAY_SET.has(trimmed)) return true;
  if (trimmed.length < 2) return false;

  const windowStart = row.timestamp - 30;
  const windowEnd = row.timestamp + 30;
  let echoCount = 0;
  for (const c of row.triggerContext) {
    if (c.content.trim() !== trimmed) continue;
    if (c.timestamp < windowStart || c.timestamp > windowEnd) continue;
    echoCount++;
    if (echoCount >= 2) return true;
  }
  return false;
}

function isConflictHeat(row: SampledRow): boolean {
  return CONFLICT_KEYWORDS.some(k => row.content.includes(k));
}

function isBotStatusKeywords(row: SampledRow): boolean {
  return BOT_STATUS_KEYWORDS.some(k => row.content.toLowerCase().includes(k.toLowerCase()));
}

function isSummarizeRequest(row: SampledRow): boolean {
  return SUMMARIZE_RE.test(row.content);
}

function isQuestion(row: SampledRow): boolean {
  return QUESTION_END_RE.test(row.content) || QUESTION_START_RE.test(row.content);
}

/** R6.1a: empty-content rows with a media CQ code — valid object_react candidates.
 *  R6.1b: `face` added so `[CQ:face,id=0]` + empty content is not wrongly filtered at line 121.
 *  Must stay in sync with isPureImageOrMface / queryCat4. */
function isEmptyBecauseMediaOnly(row: SampledRow): boolean {
  const content = row.content ?? '';
  if (content.trim() !== '') return false;
  const raw = row.rawContent ?? '';
  return /\[CQ:(?:image|mface|face|video|record)[^\]]*\]/.test(raw);
}

function isPureImageOrMface(row: SampledRow): boolean {
  const raw = row.rawContent ?? row.content;
  if (!/\[CQ:(?:image|mface|face)[^\]]*\]/.test(raw)) return false;
  const stripped = raw.replace(/\[CQ:[^\]]*\]/g, '').trim();
  return stripped.length === 0;
}

function isImageWithShortCaption(row: SampledRow): boolean {
  const raw = row.rawContent ?? row.content;
  if (!/\[CQ:(?:image|mface|face)[^\]]*\]/.test(raw)) return false;
  const stripped = raw.replace(/\[CQ:[^\]]*\]/g, '').trim();
  return stripped.length >= 1 && stripped.length <= 12 && !isQuestion(row);
}

function isReplyWorthy(row: SampledRow): boolean {
  const speakers = new Set(row.triggerContext.map(c => c.userId));
  if (speakers.size >= 2) return true;
  if (row.content.length >= 10) return true;
  return false;
}

function isBurstWindow(row: SampledRow): boolean {
  const windowStart = row.timestamp - 15;
  const windowEnd = row.timestamp + 15;
  const nearby = row.triggerContext.filter(c => c.timestamp >= windowStart && c.timestamp <= windowEnd);
  return nearby.length >= 4;
}

/**
 * R6.1c: aligned with queryCat2's sampling semantics.
 *
 * Cat2 samples rows via `content LIKE '%term%'` (substring) across 7 recall
 * sources. Previously findKnownFactSource used extractTokens + equality,
 * which broke on unsegmented CJK (`'接龙说是'` stayed one token and never
 * matched stored `'接龙'`). Result: ~100% of cat2 rows had
 * hasKnownFactTerm=false on real DB.
 *
 * New rule: load the same Sourced term list queryCat2 fetches, sort by
 * priority, scan `row.content` via `includes(term)`, short-circuit on first
 * hit. Guarantees sampler/labeler see the same row set.
 *
 * Priority: topic > canonical > persona > fact > meme > jargon > phrase.
 */

// Cache of priority-sorted term lists, keyed by groupId. The DatabaseSync is
// bound per sampling run so cache is naturally bounded by unique group count.
const termCache = new WeakMap<DatabaseSync, Map<string, SourcedTerm[]>>();

const SOURCE_RANK: Record<Exclude<KnownFactSource, null>, number> = {
  topic: 0, canonical: 1, persona: 2, fact: 3, meme: 4, jargon: 5, phrase: 6,
};

function getSortedTerms(db: DatabaseSync, groupId: string): SourcedTerm[] {
  let perDb = termCache.get(db);
  if (!perDb) {
    perDb = new Map();
    termCache.set(db, perDb);
  }
  const cached = perDb.get(groupId);
  if (cached) return cached;
  const terms = collectTermsWithSource(db, groupId);
  // Prefer longer terms first within the same source rank, so '接龙说是'
  // beats '接龙' when both would hit (more specific match wins).
  terms.sort((a, b) => {
    const ra = SOURCE_RANK[a.source];
    const rb = SOURCE_RANK[b.source];
    if (ra !== rb) return ra - rb;
    return b.term.length - a.term.length;
  });
  perDb.set(groupId, terms);
  return terms;
}

function findKnownFactSource(db: DatabaseSync, groupId: string, content: string): KnownFactSource {
  if (!content) return null;
  const terms = getSortedTerms(db, groupId);
  for (const { term, source } of terms) {
    // Sentence-length facts pollute substring matching; match queryCat2's
    // validTerm filter (term.length <= 50).
    if (term.length > 50) continue;
    if (term.length < 1) continue;
    if (content.includes(term)) return source;
  }
  return null;
}

function detectRiskFlags(row: SampledRow, matchedCategories: number[]): string[] {
  const flags: string[] = [];
  if (row.timestamp < R4_DEPLOY_EPOCH) flags.push('legacy-few-shot-possible');
  const atTargets = [...(row.rawContent ?? row.content).matchAll(/\[CQ:at,qq=(\d+)/g)];
  if (atTargets.length > 1) flags.push('ambiguous-target');
  if (matchedCategories.length > 1) flags.push('multi-category-match');
  if (row.triggerContext.length < 3) flags.push('short-context');
  return flags;
}

export function applyWeakLabel(
  row: SampledRow,
  db: DatabaseSync,
  botQQ: string,
): WeakLabeledRow | null {
  if (isAdminCommand(row)) return null;
  if (row.content.trim() === '' && !isEmptyBecauseMediaOnly(row)) return null;

  const knownFactSource = findKnownFactSource(db, row.groupId, row.content);
  const knownFact = knownFactSource !== null;
  const direct = isDirect(row, botQQ);
  const relay = isRelayPattern(row);
  const conflict = isConflictHeat(row);
  const botStatus = isBotStatusKeywords(row);
  const burst = isBurstWindow(row);
  const pureImage = isPureImageOrMface(row);
  const imageCaption = isImageWithShortCaption(row);
  // R6.1a: empty-with-media rows are valid object_react; empty-without-media are bad samples
  const emptyMediaOnly = isEmptyBecauseMediaOnly(row);
  const pluralYou = (row.rawContent ?? row.content).includes('你们');

  // Track which categories would match (for multi-category-match flag)
  const matchedCategories: number[] = [];
  if (direct) matchedCategories.push(1);
  if (relay) matchedCategories.push(7);
  if (conflict) matchedCategories.push(8);
  if (botStatus) matchedCategories.push(5);
  if (pureImage || imageCaption) matchedCategories.push(4);

  const riskFlags = detectRiskFlags(row, matchedCategories);

  let expectedAct: ExpectedAct;
  let expectedDecision: ExpectedDecision;

  // Step 2: relay
  if (relay) {
    expectedAct = 'relay';
    expectedDecision = 'reply';
  }
  // Step 3: conflict
  else if (conflict) {
    expectedAct = 'conflict_handle';
    expectedDecision = 'reply';
  }
  // Step 4: summarize + long context
  else if (isSummarizeRequest(row) && row.triggerContext.length >= 20) {
    expectedAct = 'summarize';
    expectedDecision = 'reply';
  }
  // Step 5a: bot status + direct
  else if (botStatus && direct) {
    expectedAct = 'bot_status_query';
    expectedDecision = 'reply';
  }
  // Step 5b: bot status + not direct
  else if (botStatus) {
    expectedAct = 'meta_admin_status';
    expectedDecision = 'defer';
  }
  // Step 6: image/mface (no known fact)
  else if ((pureImage || (imageCaption && !isQuestion(row))) && !knownFact) {
    expectedAct = 'object_react';
    expectedDecision = 'reply';
  }
  // Step 7: direct
  else if (direct) {
    expectedAct = 'direct_chat';
    expectedDecision = 'reply';
  }
  // Step 8: reply-worthy
  else if (isReplyWorthy(row)) {
    expectedAct = 'chime_in';
    expectedDecision = 'reply';
  }
  // Step 9: silence
  else {
    expectedAct = 'chime_in';
    expectedDecision = 'silent';
  }

  const label: WeakReplayLabel = {
    expectedAct,
    expectedDecision,
    hasKnownFactTerm: knownFact,
    knownFactSource,
    hasRealFactHit: knownFact,
    allowPluralYou: pluralYou,
    // R6.1a: emptyMediaOnly rows are valid object_react; empty-without-media get false here
    isObjectReact: pureImage || imageCaption || emptyMediaOnly,
    isBotStatusContext: botStatus,
    isBurst: burst,
    isRelay: relay,
    isDirect: direct,
    riskFlags,
  };

  return { ...row, label };
}
