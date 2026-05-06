#!/usr/bin/env tsx
/**
 * Phase 3 replay smoke — PlannerContext.facts hydration sanity check.
 *
 * Seeds an in-memory DB with 3 learned_facts + meme_graph rows, constructs a
 * real ChatModule + SelfLearningModule + ReplyPlanner, runs 3 trigger rows,
 * and captures hasRealFactHit + plannerFactCount per row.
 *
 * Pre-Phase-3 baseline: plannerFactCount=0 on all 3 rows (facts:[] hardcode).
 * Post-Phase-3 target: plannerFactCount>=1 on all 3 rows.
 *
 * Usage (worktree-local):
 *   npx tsx scripts/replay-r9-facts.ts
 *
 * The script does NOT use the full replay-runner harness intentionally — it
 * directly instruments the planner.plan spy to capture PlannerContext.facts.
 */

import { Database } from '../src/storage/db.js';
import { ChatModule } from '../src/modules/chat.js';
import { SelfLearningModule } from '../src/modules/self-learning.js';
import { ReplyPlanner } from '../src/modules/reply-planner.js';
import type { IReplyPlanner, Directive, PlannerContext } from '../src/modules/reply-planner.js';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { defaultGroupConfig } from '../src/config.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'error' });

const BOT_QQ = 'bot-replay-r9';
const GROUP_ID = 'g-replay-r9';

function makeStubClaude(): IClaudeClient {
  return {
    async complete(_req: ClaudeRequest): Promise<ClaudeResponse> {
      return { text: '普通回复', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },
    async describeImage(): Promise<string> { return ''; },
  };
}

function makeTriggerMsg(content: string): GroupMessage {
  return {
    messageId: `m-${Date.now()}`,
    groupId: GROUP_ID,
    userId: 'u-tester',
    nickname: 'TestUser',
    role: 'member',
    content,
    rawContent: `[CQ:at,qq=${BOT_QQ}] ${content}`,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

interface RowResult {
  triggerText: string;
  hasRealFactHit: boolean;
  plannerFactCount: number;
  sampleFact: { factId: string; term: string; meaning: string } | null;
}

async function runSmoke(label: string): Promise<RowResult[]> {
  const db = new Database(':memory:');

  // Seed learned_facts rows
  const idYgfn = db.learnedFacts.insert({
    groupId: GROUP_ID,
    topic: 'user-taught:ygfn',
    fact: 'ygfn是羊宫妃那啊',
    canonicalForm: 'ygfn',
    personaForm: null,
    sourceUserId: null,
    sourceUserNickname: null,
    sourceMsgId: null,
    botReplyId: null,
    confidence: 1.0,
  });

  db.learnedFacts.insert({
    groupId: GROUP_ID,
    topic: 'user-taught:ygfn',
    fact: 'ygfn是羊宫妃那啊',
    canonicalForm: '羊宫妃那',
    personaForm: null,
    sourceUserId: null,
    sourceUserNickname: null,
    sourceMsgId: null,
    botReplyId: null,
    confidence: 1.0,
  });

  const idTakane = db.learnedFacts.insert({
    groupId: GROUP_ID,
    topic: '高松灯',
    fact: '高松灯是Tsukinomori成员之一',
    canonicalForm: '高松灯',
    personaForm: null,
    sourceUserId: null,
    sourceUserNickname: null,
    sourceMsgId: null,
    botReplyId: null,
    confidence: 1.0,
  });

  // Seed meme_graph for CJK variant bridge
  db.memeGraph.insert({
    groupId: GROUP_ID,
    canonical: '羊宫妃娜',
    variants: ['ygfn', '羊宫妃那'],
    meaning: '',
    originEvent: null,
    originMsgId: null,
    originUserId: null,
    originTs: null,
    firstSeenCount: 1,
    totalCount: 1,
    confidence: 1.0,
    status: 'active',
    embeddingVec: null,
    createdAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
  });

  // Enable chat_planner_lite_v1
  const cfg = db.groupConfig.get(GROUP_ID) ?? defaultGroupConfig(GROUP_ID);
  db.groupConfig.upsert({ ...cfg, chatPlannerLiteV1: true });

  const stubClaude = makeStubClaude();
  const selfLearning = new SelfLearningModule({
    db,
    claude: stubClaude,
    botUserId: BOT_QQ,
    embeddingService: null,
    researchEnabled: false,
  });

  const chat = new ChatModule(stubClaude, db, {
    botUserId: BOT_QQ,
    debounceMs: 0,
    chatMinScore: -999,
    selfLearning,
  });

  // Capture PlannerContext via spy
  const capturedCtxs: PlannerContext[] = [];
  const plannerSpy: IReplyPlanner = {
    plan: async (ctx: PlannerContext): Promise<Directive | null> => {
      capturedCtxs.push(ctx);
      return null;
    },
  };
  chat.setReplyPlanner(plannerSpy);

  const triggerRows = [
    { text: 'ygfn 是谁', expectedId: idYgfn },
    { text: '羊宫妃那是谁', expectedId: idYgfn },
    { text: '高松灯是谁', expectedId: idTakane },
  ];

  const results: RowResult[] = [];

  for (const row of triggerRows) {
    capturedCtxs.length = 0;
    const msg = makeTriggerMsg(row.text);
    const result = await chat.generateReply(GROUP_ID, msg, []);

    const hasRealFactHit = result.kind !== 'silent' && result.kind !== 'defer'
      ? result.meta.matchedFactIds.length > 0
      : false;

    const plannerCtx = capturedCtxs[0] ?? null;
    const plannerFactCount = plannerCtx?.facts.length ?? 0;
    const sampleFact = plannerCtx?.facts[0] ?? null;

    results.push({
      triggerText: row.text,
      hasRealFactHit,
      plannerFactCount,
      sampleFact: sampleFact ? { factId: sampleFact.factId, term: sampleFact.term, meaning: sampleFact.meaning } : null,
    });
  }

  console.log(`\n=== ${label} ===`);
  for (const r of results) {
    console.log(`  trigger: ${r.triggerText}`);
    console.log(`    hasRealFactHit: ${r.hasRealFactHit}`);
    console.log(`    plannerFactCount: ${r.plannerFactCount}`);
    if (r.sampleFact) {
      console.log(`    sample: factId=${r.sampleFact.factId} term=${r.sampleFact.term} meaning=${r.sampleFact.meaning}`);
    }
  }

  return results;
}

// Run post-Phase-3 (current code)
const postResults = await runSmoke('Post-Phase-3');

const allPass = postResults.every(r => r.plannerFactCount >= 1);
console.log(`\nA9 criterion: ${allPass ? 'PASS' : 'FAIL'} (${postResults.filter(r => r.plannerFactCount >= 1).length}/${postResults.length} rows plannerFactCount>=1)`);

if (!allPass) {
  process.exit(1);
}
