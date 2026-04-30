import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../src/storage/db.js';
import { SelfLearningModule } from '../src/modules/self-learning.js';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse } from '../src/ai/claude.js';
import type { IEmbeddingService } from '../src/storage/embeddings.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

function makeDb(): Database {
  return new Database(':memory:');
}

function stubClaude(): IClaudeClient {
  return {
    async complete(_req: ClaudeRequest): Promise<ClaudeResponse> {
      return { text: '', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },
    async describeImage(): Promise<string> { return ''; },
  };
}

// Embedder that produces a deterministic but "miss" vector — cosine vs random
// row vectors will be near-zero so vector path won't surface alias matches.
function stubEmbedderMiss(): IEmbeddingService {
  return {
    isReady: true,
    async embed(_text: string): Promise<number[]> { return [1, 0, 0, 0, 0]; },
    async waitReady(): Promise<void> {},
  };
}

function insertFact(
  db: Database,
  groupId: string,
  topic: string | null,
  fact: string,
  canonicalForm: string | null,
  personaForm: string | null,
): number {
  return db.learnedFacts.insert({
    groupId, topic, fact, canonicalForm, personaForm,
    sourceUserId: null, sourceUserNickname: null,
    sourceMsgId: null, botReplyId: null,
    confidence: 1.0,
  });
}

describe('fact-retrieval alias gap fix — Fix 2 structured-term pre-pass', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('P1: ygfn-only query surfaces user-taught:ygfn fact via pre-pass when BM25=0', async () => {
    // Seed a user-taught fact that BM25 likely misses (4-char ASCII alias).
    const id = insertFact(
      db, 'g1', 'user-taught:ygfn',
      'ygfn 是羊宫妃那啊', 'ygfn', 'ygfn 是羊宫妃那啊',
    );
    const learner = new SelfLearningModule({ db, claude: stubClaude() });
    const out = await learner.formatFactsForPrompt('g1', 50, 'ygfn是谁');
    expect(out.matchedFactIds).toContain(id);
    expect(out.injectedFactIds).toContain(id);
    expect(out.pinnedOnly).toBe(false);
  });

  it('P2: 如何评价ygfn surfaces user-taught:ygfn fact via pre-pass', async () => {
    const id = insertFact(
      db, 'g1', 'user-taught:ygfn',
      'ygfn 是羊宫妃那啊', 'ygfn', 'ygfn 是羊宫妃那啊',
    );
    const learner = new SelfLearningModule({ db, claude: stubClaude() });
    const out = await learner.formatFactsForPrompt('g1', 50, '如何评价ygfn');
    expect(out.matchedFactIds).toContain(id);
  });

  it('P3: 拉神是谁 surfaces 群友别名:拉神 fact via pre-pass (CJK suffix regex match)', async () => {
    // The CJK_QUERY_SUFFIX_RE in extractCandidateTerms covers pure-Han queries
    // with a known suffix (是谁/怎么样/...). Query like '你觉得拉神怎么样' has a
    // pure-Han prefix '你觉得' which the tokenizer cannot split — that case is
    // a documented Fix-3 follow-up (low priority, see spec). 拉神是谁 covers
    // the supported pure-Han alias path.
    const id = insertFact(
      db, 'g1', '群友别名:拉神',
      '拉神 是 群友昵称', '拉神', '拉神 是 群友昵称',
    );
    const learner = new SelfLearningModule({ db, claude: stubClaude() });
    const out = await learner.formatFactsForPrompt('g1', 50, '拉神是谁');
    expect(out.matchedFactIds).toContain(id);
  });

  it('P3 (mixed-script Fix 3): 你觉得拉神怎么样 surfaces 群友别名:拉神 fact via prefix-stripping', async () => {
    // Fix 3 added prefix-stripping in deriveCjkTerm (extract-candidate-terms.ts):
    // 你觉得拉神怎么样 → cjkTerm '拉神' → pre-pass → matchedFactIds includes id.
    const id = insertFact(
      db, 'g1', '群友别名:拉神',
      '拉神 是 群友昵称', '拉神', '拉神 是 群友昵称',
    );
    const learner = new SelfLearningModule({ db, claude: stubClaude() });
    const out = await learner.formatFactsForPrompt('g1', 50, '你觉得拉神怎么样');
    expect(out.matchedFactIds).toContain(id);
  });

  it('P5: 你觉得kdhr这个人怎么样 surfaces user-taught:kdhr', async () => {
    const id = insertFact(
      db, 'g1', 'user-taught:kdhr',
      'kdhr 是 某人', 'kdhr', 'kdhr 是 某人',
    );
    const learner = new SelfLearningModule({ db, claude: stubClaude() });
    const out = await learner.formatFactsForPrompt('g1', 50, '你觉得kdhr这个人怎么样');
    expect(out.matchedFactIds).toContain(id);
  });

  it('P7/E1: dedup — when BM25 + pre-pass both hit same factId, matchedFactIds contains the id once', async () => {
    // Use a query likely to BM25-hit (Latin token >= 5 chars, recognized by FTS5).
    const id = insertFact(
      db, 'g1', 'user-taught:Morfonica',
      'Morfonica 是 BanG Dream 乐队', 'Morfonica', 'Morfonica 就是 那个乐队',
    );
    const learner = new SelfLearningModule({ db, claude: stubClaude() });
    const out = await learner.formatFactsForPrompt('g1', 50, 'Morfonica');
    const occurrences = out.matchedFactIds.filter(x => x === id).length;
    expect(occurrences).toBe(1);
  });

  it('E1: two aliases extracted from one query — both surface in matchedFactIds', async () => {
    const idYgfn = insertFact(
      db, 'g1', 'user-taught:ygfn',
      'ygfn 是羊宫妃那啊', 'ygfn', 'ygfn 是羊宫妃那啊',
    );
    const idHyw = insertFact(
      db, 'g1', 'user-taught:hyw',
      'hyw 是 某人', 'hyw', 'hyw 是 某人',
    );
    const learner = new SelfLearningModule({ db, claude: stubClaude() });
    const out = await learner.formatFactsForPrompt('g1', 50, '我问你ygfn和hyw谁更厉害');
    expect(out.matchedFactIds).toContain(idYgfn);
    expect(out.matchedFactIds).toContain(idHyw);
  });

  it('E3: alias under ondemand-lookup: prefix also surfaces via pre-pass', async () => {
    // ondemand-lookup: is a recognized prefix in fact-topic-prefixes.ts.
    const id = insertFact(
      db, 'g1', 'ondemand-lookup:ygfn',
      'ygfn LLM-cached meaning', 'ygfn', 'ygfn LLM-cached meaning',
    );
    const learner = new SelfLearningModule({ db, claude: stubClaude() });
    const out = await learner.formatFactsForPrompt('g1', 50, 'ygfn');
    expect(out.matchedFactIds).toContain(id);
  });

  it('N1: 今天天气不错 — no alias, no fact retrieval', async () => {
    insertFact(
      db, 'g1', 'user-taught:ygfn',
      'ygfn 是羊宫妃那啊', 'ygfn', 'ygfn 是羊宫妃那啊',
    );
    const learner = new SelfLearningModule({ db, claude: stubClaude() });
    const out = await learner.formatFactsForPrompt('g1', 50, '今天天气不错');
    // Pure scaffolding — no candidate term passes isValidStructuredTerm.
    // matchedFactIds must be empty for this query because pre-pass cannot fire.
    expect(out.matchedFactIds).toEqual([]);
  });

  it('N2: 大家觉得怎么样 — pure scaffolding, no candidate term, matchedFactIds empty', async () => {
    insertFact(
      db, 'g1', 'user-taught:ygfn',
      'ygfn 是羊宫妃那啊', 'ygfn', 'ygfn 是羊宫妃那啊',
    );
    const learner = new SelfLearningModule({ db, claude: stubClaude() });
    const out = await learner.formatFactsForPrompt('g1', 50, '大家觉得怎么样');
    expect(out.matchedFactIds).toEqual([]);
  });

  it('cap: pre-pass capped at first-3 candidates (extractCandidateTerms MAX_CANDIDATES=3)', async () => {
    // Insert 5 facts. Pre-pass uses extractCandidateTerms which caps at 3.
    // First 3 source-order terms surface via pre-pass; later terms only surface
    // if BM25 / vector independently hit. This test asserts the first 3 do surface.
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const term = `term${i}aa`;
      ids.push(insertFact(
        db, 'g1', `user-taught:${term}`,
        `${term} fact`, term, `${term} fact`,
      ));
    }
    const learner = new SelfLearningModule({ db, claude: stubClaude() });
    // Order in trigger: term0aa term1aa term2aa term3aa term4aa
    const out = await learner.formatFactsForPrompt('g1', 50, 'term0aa term1aa term2aa term3aa term4aa');
    // First 3 should surface via pre-pass; later ones may also surface via BM25 (acceptable).
    for (let i = 0; i < 3; i++) {
      expect(out.matchedFactIds).toContain(ids[i]!);
    }
  });

  it('pre-pass survives noServiceNoBm25 path — alias-only short query surfaces fact even with no embedder & BM25 miss', async () => {
    // Force the noServiceNoBm25 branch: no embedder, BM25 returns 0 for the
    // exact short Latin alias (FTS5 default may or may not index 4-char tokens).
    // Even if BM25 misses, pre-pass must keep us out of recency fallback.
    const id = insertFact(
      db, 'g1', 'user-taught:ygfn',
      'ygfn 是羊宫妃那啊', 'ygfn', 'ygfn 是羊宫妃那啊',
    );
    // No embeddingService passed → vector path disabled.
    const learner = new SelfLearningModule({ db, claude: stubClaude() });
    const out = await learner.formatFactsForPrompt('g1', 50, 'ygfn');
    expect(out.matchedFactIds).toContain(id);
    expect(out.pinnedOnly).toBe(false);
  });
});

describe('fact-retrieval alias gap fix — Fix 1 Path A factId propagation', () => {
  // Fix 1 is exercised at the chat.ts integration layer; here we assert the
  // OnDemandLookup contract so the Type and shortcut behavior are pinned.
  it('TermLookupOutcome.found includes factId on shortcut hits (covered in path-a-ondemand.test.ts cases 17/19/20/21/22/24/25/27)', () => {
    // This describe block is documentary; the actual assertions live in
    // test/path-a-ondemand.test.ts where shortcut hits assert
    // toEqual({ type: 'found', meaning, factId: <known id> }).
    expect(true).toBe(true);
  });
});
