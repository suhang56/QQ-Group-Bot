#!/usr/bin/env tsx
/**
 * R6.4 — Replay runner CLI entrypoint.
 *
 * Joins gold × benchmark by sampleId, instantiates ChatModule with either a
 * mock or a real Gemini-backed Claude client and a tmp-copy of the prod DB,
 * calls generateReply, captures ChatResult, writes replay-output.jsonl +
 * summary.json. Zero src/ writes (DB tmp-copied; bot never touches prod).
 *
 * Real-mode wiring per DESIGN.md §D — see also `scripts/eval/real-llm-config.ts`.
 *
 * Lifecycle per DEV-READY §3.3.
 *
 * Exit codes:
 *   0 — success (including cost-cap halt with partial output)
 *   1 — invalid args / missing input file / GEMINI_API_KEY missing in real mode
 *   2 — --llm-mode=recorded (not implemented) OR zero rows processed
 *   3 — output write error OR zero-side-effect tripwire fired
 */

// dotenv loads .env at module-import time. Idempotent — safe even though
// `real-llm-config.ts` also imports it.
import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';

import { parseArgs } from './replay-cli-args.js';
import { MockClaudeClient } from './mock-llm.js';
import { buildTriggerFromBenchmark } from './replay-fixture-builder.js';
import { loadGold } from './summarize-gold.js';
import { readSamples } from './gold/reader.js';
import { constructChatModule, runReplayRow, aggregateSummary } from './replay-runner-core.js';
import type { SampledRow, ReplayRow } from './replay-types.js';
import type { GoldLabel } from './gold/types.js';
import type { IClaudeClient } from '../../src/ai/claude.js';
import { GeminiClient } from '../../src/ai/providers/gemini-llm.js';
import { RealClaudeClientForReplay } from '../../src/ai/real-claude-client-for-replay.js';
import { loadRealLlmConfig, type RealLlmConfig } from './real-llm-config.js';

interface MinimalSampleRecord {
  sampleId: string;
  [k: string]: unknown;
}

function recordToSampledRow(rec: MinimalSampleRecord): SampledRow | null {
  const obj = rec as unknown as Record<string, unknown>;
  const id = obj.id;
  const groupId = obj.groupId;
  const messageId = obj.messageId;
  const userId = obj.userId;
  const nickname = obj.nickname;
  const timestamp = obj.timestamp;
  const content = obj.content;
  const rawContent = obj.rawContent;
  const sourceMessageId = obj.sourceMessageId;
  const triggerContext = obj.triggerContext;
  const triggerContextAfter = obj.triggerContextAfter;
  const category = obj.category;
  const categoryLabel = obj.categoryLabel;
  const samplingSeed = obj.samplingSeed;
  const contentHash = obj.contentHash;
  const contextHash = obj.contextHash;

  if (typeof id !== 'string') return null;
  if (typeof groupId !== 'string') return null;
  if (typeof messageId !== 'number') return null;
  if (typeof userId !== 'string') return null;
  if (typeof nickname !== 'string') return null;
  if (typeof timestamp !== 'number') return null;
  if (typeof content !== 'string') return null;
  if (!Array.isArray(triggerContext)) return null;
  if (!Array.isArray(triggerContextAfter)) return null;
  if (typeof category !== 'number') return null;

  return {
    id,
    groupId,
    messageId,
    sourceMessageId: typeof sourceMessageId === 'string' ? sourceMessageId : null,
    userId,
    nickname,
    timestamp,
    content,
    rawContent: typeof rawContent === 'string' ? rawContent : null,
    triggerContext: triggerContext as SampledRow['triggerContext'],
    triggerContextAfter: triggerContextAfter as SampledRow['triggerContextAfter'],
    category,
    categoryLabel: typeof categoryLabel === 'string' ? categoryLabel : '?',
    samplingSeed: typeof samplingSeed === 'number' ? samplingSeed : 0,
    contentHash: typeof contentHash === 'string' ? contentHash : '',
    contextHash: typeof contextHash === 'string' ? contextHash : '',
  };
}

async function loadBenchmark(benchPath: string): Promise<Map<string, SampledRow>> {
  const out = new Map<string, SampledRow>();
  for await (const s of readSamples(benchPath)) {
    const row = recordToSampledRow(s as MinimalSampleRecord);
    if (row) out.set(row.id, row);
  }
  return out;
}

export interface RunResult {
  exitCode: number;
  rowsWritten: number;
  outputPath: string;
  summaryPath: string;
}

/**
 * Importable main() — CLI calls it, integration test calls it directly.
 * Takes already-parsed ReplayerArgs. Writes files, returns exit-code shape.
 */
export async function runReplay(args: ReturnType<typeof parseArgs>): Promise<RunResult> {
  if (args.llmMode === 'recorded') {
    process.stderr.write(`--llm-mode=recorded not implemented; use mock or real.\n`);
    return { exitCode: 2, rowsWritten: 0, outputPath: '', summaryPath: '' };
  }

  if (!fs.existsSync(args.goldPath)) {
    process.stderr.write(`Gold file not found: ${args.goldPath}\n`);
    return { exitCode: 1, rowsWritten: 0, outputPath: '', summaryPath: '' };
  }
  if (!fs.existsSync(args.benchmarkPath)) {
    process.stderr.write(`Benchmark file not found: ${args.benchmarkPath}\n`);
    return { exitCode: 1, rowsWritten: 0, outputPath: '', summaryPath: '' };
  }
  if (!fs.existsSync(args.prodDbPath)) {
    process.stderr.write(`Prod DB not found: ${args.prodDbPath}\n`);
    return { exitCode: 1, rowsWritten: 0, outputPath: '', summaryPath: '' };
  }

  fs.mkdirSync(args.outputDir, { recursive: true });
  const tmpDir = path.join(args.outputDir, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const tmpDb = path.join(tmpDir, `replay-${process.pid}-${Date.now()}.db`);
  fs.copyFileSync(args.prodDbPath, tmpDb);
  if (!tmpDb.includes('.tmp') && !tmpDb.includes('synthetic')) {
    process.stderr.write(`zero-side-effect tripwire: refusing to open ${tmpDb}\n`);
    return { exitCode: 3, rowsWritten: 0, outputPath: '', summaryPath: '' };
  }

  const cleanupPaths: string[] = [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`, `${tmpDb}-journal`];
  const cleanup = (): void => {
    for (const p of cleanupPaths) {
      try { fs.rmSync(p, { force: true }); } catch { /* best-effort */ }
    }
  };
  process.on('exit', cleanup);

  const outputPath = path.join(args.outputDir, 'replay-output.jsonl');
  const summaryPath = path.join(args.outputDir, 'summary.json');

  try {
    if (args.prodDbPath.includes('synthetic')) {
      process.stderr.write(
        '[smoke] synthetic fixture DB; recent-history context will be sparse. ' +
        'For full-fidelity baseline use owner-runner runbook (docs/eval/replay-runner.md §Smoke vs full-baseline).\n',
      );
    }

    process.stderr.write(
      `replay-runner: gold=${args.goldPath} benchmark=${args.benchmarkPath} ` +
      `output=${args.outputDir} limit=${args.limit ?? 'all'} timeout=${args.perSampleTimeoutMs}ms\n`,
    );

    process.stderr.write(`loading gold+benchmark ... `);
    const gold = await loadGold(args.goldPath);
    const benchmarkMap = await loadBenchmark(args.benchmarkPath);
    const goldByKey = new Map<string, GoldLabel>();
    for (const g of gold) goldByKey.set(g.sampleId, g);
    process.stderr.write(`gold=${gold.length} benchmark=${benchmarkMap.size}\n`);

    let llmClient: IClaudeClient;
    let realClient: RealClaudeClientForReplay | null = null;
    let realCfg: RealLlmConfig | null = null;
    let mockClaude: MockClaudeClient | null = null;
    if (args.llmMode === 'mock') {
      mockClaude = new MockClaudeClient();
      llmClient = mockClaude;
    } else {
      // 'real' — 'recorded' was already rejected above with exit 2.
      const cfgOverrides: { maxCostUsd?: number; rateLimitRps?: number; retryMax?: number } = {};
      if (args.maxCostUsd != null) cfgOverrides.maxCostUsd = args.maxCostUsd;
      if (args.rateLimitRps != null) cfgOverrides.rateLimitRps = args.rateLimitRps;
      if (args.retryMax != null) cfgOverrides.retryMax = args.retryMax;
      realCfg = loadRealLlmConfig(cfgOverrides);
      const inner = new GeminiClient({
        apiKey: realCfg.apiKey,
        timeoutMs: realCfg.perCallTimeoutMs,
      });
      realClient = new RealClaudeClientForReplay(inner, realCfg);
      llmClient = realClient;
      process.stderr.write(
        `[real-llm] cost cap=$${realCfg.maxCostUsd.toFixed(4)} ` +
        `perCallTimeout=${realCfg.perCallTimeoutMs}ms ` +
        `rps=${realCfg.rateLimitRps} retryMax=${realCfg.retryMax}\n`,
      );
    }
    const { chat, db } = constructChatModule({
      tmpDbPath: tmpDb,
      botQQ: args.botQQ,
      mockClaude: llmClient,
    });

    let writeStream: fs.WriteStream;
    try {
      writeStream = fs.createWriteStream(outputPath, { encoding: 'utf8' });
    } catch (err) {
      process.stderr.write(`Cannot open output file: ${String(err)}\n`);
      return { exitCode: 3, rowsWritten: 0, outputPath, summaryPath };
    }

    const rows: ReplayRow[] = [];
    let processed = 0;
    let errors = 0;
    let halted = false;
    const t0 = Date.now();
    const cap = args.limit === null ? gold.length : Math.min(gold.length, args.limit);

    try {
      for (const g of gold) {
        if (processed >= cap) break;
        // r6.4 — primary halt point for cost cap. Defense-in-depth: complete()
        // also throws CostCapError, but ChatModule's catch only swallows
        // ClaudeApiError; CostCapError would propagate up through generateReply
        // → runReplayRow.catch and yield a kind:'error' row. Pre-checking here
        // keeps partial output clean (no error rows just from cap-hit).
        if (realClient && realCfg && realClient.getStats().totalCostUsd >= realCfg.maxCostUsd) {
          process.stderr.write(`[real-llm] cost cap reached — halting run\n`);
          halted = true;
          break;
        }
        const bench = benchmarkMap.get(g.sampleId);
        if (!bench) {
          process.stderr.write(`[skip] no benchmark row for gold sampleId=${g.sampleId}\n`);
          continue;
        }
        const fixture = buildTriggerFromBenchmark(bench, args.groupIdForReplay);
        const row = await runReplayRow({
          chat,
          groupId: fixture.groupId,
          triggerMessage: fixture.triggerMessage,
          recentMessages: fixture.recentMessages,
          gold: g,
          category: bench.category,
          perSampleTimeoutMs: args.perSampleTimeoutMs,
          realClient,
        });
        rows.push(row);
        writeStream.write(JSON.stringify(row) + '\n');
        processed++;
        if (row.resultKind === 'error') errors++;
        if (processed % 20 === 0) {
          const sdCount = rows.filter(
            r => (r.goldDecision === 'silent' || r.goldDecision === 'defer') && r.resultKind !== 'error',
          ).length;
          const sdOk = rows.filter(
            r =>
              (r.goldDecision === 'silent' || r.goldDecision === 'defer') &&
              (r.resultKind === 'silent' || r.resultKind === 'defer'),
          ).length;
          const compliance = sdCount === 0 ? 0 : sdOk / sdCount;
          process.stderr.write(
            `processed ${processed}/${cap} (err=${errors}) compliance=${compliance.toFixed(4)}\n`,
          );
        }
      }
    } finally {
      await new Promise<void>(resolve => {
        writeStream.end(() => resolve());
      });
      try { chat.destroy(); } catch { /* idempotent */ }
      try { (db as unknown as { rawDb?: { close?: () => void } }).rawDb?.close?.(); } catch { /* ignore */ }
    }

    if (processed === 0 && args.limit !== 0) {
      process.stderr.write(`zero rows processed — check sampleId join or --limit\n`);
    }

    if (realClient) {
      const stats = realClient.getStats();
      process.stderr.write(
        `[real-llm] totalInputTokens=${stats.totalInputTokens} ` +
        `totalOutputTokens=${stats.totalOutputTokens} ` +
        `totalCostUsd=$${stats.totalCostUsd.toFixed(4)} ` +
        `llmErrors=${stats.errorCount} halted=${halted}\n`,
      );
    }

    const summary = aggregateSummary({
      rows,
      goldByKey,
      llmMode: args.llmMode,
      goldPath: args.goldPath,
      benchmarkPath: args.benchmarkPath,
      llmStats: realClient?.getStats() ?? null,
      halted,
    });

    try {
      fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    } catch (err) {
      process.stderr.write(`Cannot write summary.json: ${String(err)}\n`);
      return { exitCode: 3, rowsWritten: processed, outputPath, summaryPath };
    }

    const elapsedMs = Date.now() - t0;
    const llmCallSummary = mockClaude
      ? `mockClaudeCalls=${mockClaude.callCount}`
      : `realCalls=(see [real-llm] line)`;
    process.stderr.write(
      `DONE rows=${processed} errors=${errors} elapsed=${(elapsedMs / 1000).toFixed(2)}s ` +
      `compliance=${summary.silenceDeferCompliance.rate} ` +
      `${llmCallSummary}\n`,
    );
    process.stderr.write(`output=${outputPath}\nsummary=${summaryPath}\n`);

    return {
      // r6.4 — intentional halt (cost cap) is success-with-partial, exit 0.
      // Zero rows is only an error if the cause is sampleId-join failure or
      // --limit not at fault, not when halt fired before the first row.
      exitCode: processed === 0 && args.limit !== 0 && !halted ? 2 : 0,
      rowsWritten: processed,
      outputPath,
      summaryPath,
    };
  } finally {
    // Run cleanup synchronously now, then drop the 'exit' handler so repeated
    // runReplay invocations (e.g. the integration test) don't accumulate.
    cleanup();
    process.off('exit', cleanup);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const res = await runReplay(args);
  process.exit(res.exitCode);
}

const arg1 = process.argv[1] ?? '';
const isMain = arg1.endsWith('replay-runner.ts') || arg1.endsWith('replay-runner.js');
if (isMain) {
  main().catch(err => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
