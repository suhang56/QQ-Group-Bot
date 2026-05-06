import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runReplay } from '../../scripts/eval/replay-runner.js';
import type { ReplayerArgs } from '../../scripts/eval/replay-types.js';
import { buildSyntheticReplayDb } from '../../scripts/eval/build-synthetic-replay-db.js';
import { Database } from '../../src/storage/db.js';
import { snapshotProdDb, assertNoProdContamination } from './helpers.js';

const BOT_QQ = '1705075399';
const GROUP_ID = '958751334';
const REPO = path.resolve(__dirname, '../..');

// Dedicated synthetic fixture paths — one seeded with the smoke fact, one
// empty. Filenames contain 'synthetic' so the constructChatModule tripwire
// is satisfied. Dedicated paths prevent races with sibling test files in
// vitest fork-pool.
const FIXTURE_DB_FACT = path.join(
  REPO,
  'test/fixtures/replay-prod-db-synthetic-selflearning.sqlite',
);
const FIXTURE_DB_EMPTY = path.join(
  REPO,
  'test/fixtures/replay-prod-db-synthetic-selflearning-empty.sqlite',
);

// Capture the seeded fact id at beforeAll so T-2 can assert it appears in
// matchedFactIds.
let seededFactId: number | null = null;

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `selflearning-smoke-${prefix}-`));
}

interface InlineFixturePaths {
  goldPath: string;
  benchmarkPath: string;
}

/**
 * Write a single-row gold + benchmark JSONL with a customizable trigger.
 * rawContent is constructed with a [CQ:at,qq=BOT_QQ] prefix so ChatModule's
 * direct-bypass at chat.ts:1850-1854 fires — bypasses timing-debounce and
 * reaches the selfLearning short-circuit at chat.ts:2882-2884. Without the
 * CQ-at prefix, debounce silences before retrieval ever runs. Same lesson
 * as PR #179 replay-runner-r9-smoke.test.ts:24-37.
 */
function writeInlineFixtures(
  dir: string,
  opts: { sampleId: string; messageId: number; content: string; hasKnownFactTerm: boolean; hasRealFactHit: boolean },
): InlineFixturePaths {
  const goldPath = path.join(dir, 'gold.jsonl');
  const benchmarkPath = path.join(dir, 'benchmark.jsonl');
  const rawContent = `[CQ:at,qq=${BOT_QQ}] ${opts.content}`;
  fs.writeFileSync(goldPath, JSON.stringify({
    sampleId: opts.sampleId,
    goldAct: 'direct_chat',
    goldDecision: 'reply',
    targetOk: true,
    factNeeded: opts.hasKnownFactTerm,
    allowBanter: true,
    allowSticker: false,
    labeledAt: '2026-05-05T00:00:00Z',
  }) + '\n');
  fs.writeFileSync(benchmarkPath, JSON.stringify({
    id: opts.sampleId,
    groupId: GROUP_ID,
    messageId: opts.messageId,
    sourceMessageId: `src-${opts.messageId}`,
    userId: 'U1100',
    nickname: '王五',
    timestamp: 1_713_001_000,
    content: opts.content,
    rawContent,
    triggerContext: [],
    triggerContextAfter: [],
    category: 1,
    categoryLabel: 'direct_at_bot',
    samplingSeed: 1,
    contentHash: `ch-${opts.messageId}`,
    contextHash: `cx-${opts.messageId}`,
    label: {
      expectedAct: 'direct_chat',
      expectedDecision: 'reply',
      hasKnownFactTerm: opts.hasKnownFactTerm,
      knownFactSource: opts.hasKnownFactTerm ? 'moegirl' : null,
      hasRealFactHit: opts.hasRealFactHit,
      allowPluralYou: false,
      isObjectReact: false,
      isBotStatusContext: false,
      isBurst: false,
      isRelay: false,
      isDirect: true,
      riskFlags: [],
    },
  }) + '\n');
  return { goldPath, benchmarkPath };
}

function makeArgs(outputDir: string, fixturePath: string, fixtures: InlineFixturePaths): ReplayerArgs {
  return {
    goldPath: fixtures.goldPath,
    benchmarkPath: fixtures.benchmarkPath,
    outputDir,
    llmMode: 'mock',
    limit: null,
    prodDbPath: fixturePath,
    botQQ: BOT_QQ,
    groupIdForReplay: GROUP_ID,
    perSampleTimeoutMs: 10_000,
    maxCostUsd: null,
    rateLimitRps: null,
    retryMax: null,
    maxConsecutiveErrors: null,
  };
}

describe('replay-runner — selfLearning smoke (T-2 / T-2b / T-2c)', () => {
  beforeAll(() => {
    // Fact-seeded fixture
    buildSyntheticReplayDb(FIXTURE_DB_FACT);
    const dbWithFact = new Database(FIXTURE_DB_FACT);
    const inserted = dbWithFact.learnedFacts.insertOrSupersede({
      groupId: GROUP_ID,
      topic: 'moegirl:高松灯',
      fact: '高松灯 = MyGO!!!!! 主唱',
      canonicalForm: '高松灯',
      personaForm: null,
      sourceUserId: null,
      sourceUserNickname: 'moegirl-seed',
      sourceMsgId: null,
      botReplyId: null,
      confidence: 0.95,
      status: 'active',
    });
    seededFactId = inserted.newId;
    try {
      (dbWithFact as unknown as { rawDb?: { close?: () => void } }).rawDb?.close?.();
    } catch { /* ignore */ }

    // Empty-DB fixture (no fact insert; just buildSyntheticReplayDb's 2
    // baseline messages, zero facts).
    buildSyntheticReplayDb(FIXTURE_DB_EMPTY);
  });

  it('T-2: wired + DB-has-fact + matching trigger -> matchedFactIds populated', async () => {
    const outDir = tmpDir('t2');
    const fixtures = writeInlineFixtures(outDir, {
      sampleId: '958751334:9100',
      messageId: 9100,
      content: '高松灯是谁',
      hasKnownFactTerm: true,
      hasRealFactHit: true,
    });
    const before = snapshotProdDb(FIXTURE_DB_FACT);
    const result = await runReplay(makeArgs(outDir, FIXTURE_DB_FACT, fixtures));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBeGreaterThan(0);

    const lines = fs.readFileSync(path.join(outDir, 'replay-output.jsonl'), 'utf8')
      .trim().split('\n').filter(l => l.length > 0);
    const replyRows = lines
      .map(l => JSON.parse(l))
      .filter(r => r.resultKind === 'reply');
    expect(replyRows.length).toBeGreaterThan(0);

    const withMatched = replyRows.filter(r => Array.isArray(r.matchedFactIds) && r.matchedFactIds.length > 0);
    expect(withMatched.length).toBeGreaterThan(0);
    expect(seededFactId).not.toBeNull();
    expect(withMatched[0].matchedFactIds).toContain(seededFactId);

    assertNoProdContamination(FIXTURE_DB_FACT, before);
  }, 30_000);

  it('T-2b (edge): wired + DB-has-fact + non-fact trigger -> matchedFactIds === []', async () => {
    const outDir = tmpDir('t2b');
    const fixtures = writeInlineFixtures(outDir, {
      sampleId: '958751334:9101',
      messageId: 9101,
      content: '随便聊聊',
      hasKnownFactTerm: false,
      hasRealFactHit: false,
    });
    const before = snapshotProdDb(FIXTURE_DB_FACT);
    const result = await runReplay(makeArgs(outDir, FIXTURE_DB_FACT, fixtures));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBeGreaterThan(0);

    const lines = fs.readFileSync(path.join(outDir, 'replay-output.jsonl'), 'utf8')
      .trim().split('\n').filter(l => l.length > 0);
    const replyRows = lines
      .map(l => JSON.parse(l))
      .filter(r => r.resultKind === 'reply');
    expect(replyRows.length).toBeGreaterThan(0);

    // Non-fact trigger: no entity match. matchedFactIds should be empty for
    // every reply row. (injectedFactIds may be non-empty via pinned-newest /
    // recency populating with the seeded 高松灯 row — that's fine.)
    for (const row of replyRows) {
      expect(Array.isArray(row.matchedFactIds)).toBe(true);
      expect(row.matchedFactIds).toEqual([]);
    }

    assertNoProdContamination(FIXTURE_DB_FACT, before);
  }, 30_000);

  it('T-2c (edge, silent-noop guard): wired + EMPTY DB + matching trigger -> matchedFactIds === [] AND injectedFactIds === []', async () => {
    const outDir = tmpDir('t2c');
    const fixtures = writeInlineFixtures(outDir, {
      sampleId: '958751334:9102',
      messageId: 9102,
      content: '高松灯是谁',
      hasKnownFactTerm: true,
      hasRealFactHit: false,
    });
    const before = snapshotProdDb(FIXTURE_DB_EMPTY);
    const result = await runReplay(makeArgs(outDir, FIXTURE_DB_EMPTY, fixtures));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBeGreaterThan(0);

    const lines = fs.readFileSync(path.join(outDir, 'replay-output.jsonl'), 'utf8')
      .trim().split('\n').filter(l => l.length > 0);
    const replyRows = lines
      .map(l => JSON.parse(l))
      .filter(r => r.resultKind === 'reply');
    expect(replyRows.length).toBeGreaterThan(0);

    // Empty-DB + matching trigger: retrieval RAN (selfLearning is wired) but
    // returned nothing because there are no facts. This is the silent-noop
    // FINGERPRINT but here it's CORRECT behavior. T-2 + T-2c together rule
    // out the pre-fix universal-empty bug: T-2 proves non-empty achievable,
    // T-2c proves empty-when-truly-empty achievable.
    for (const row of replyRows) {
      expect(Array.isArray(row.matchedFactIds)).toBe(true);
      expect(row.matchedFactIds).toEqual([]);
      expect(Array.isArray(row.injectedFactIds)).toBe(true);
      expect(row.injectedFactIds).toEqual([]);
    }

    assertNoProdContamination(FIXTURE_DB_EMPTY, before);
  }, 30_000);
});
