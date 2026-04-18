#!/usr/bin/env tsx
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../src/storage/db.js';
import { ClaudeClient } from '../src/ai/claude.js';
import type { ClaudeRequest } from '../src/ai/claude.js';

export const DEFAULT_MODEL = 'claude-sonnet-4-6[1m]';
const DEFAULT_BATCH_SIZE = 20;

export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef]/.test(ch)) {
      tokens.add(ch);
    }
  }
  for (const word of text.match(/[a-zA-Z0-9]+/g) ?? []) {
    tokens.add(word.toLowerCase());
  }
  return tokens;
}

export function novelTokenCount(original: string, rewrite: string): { count: number; tokens: string[] } {
  const origTokens = tokenize(original);
  const novel = [...tokenize(rewrite)].filter(t => !origTokens.has(t));
  return { count: novel.length, tokens: novel };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });
}

export interface BackfillRow {
  id: number;
  canonical_form: string;
}

export interface LlmClient {
  complete(req: ClaudeRequest): Promise<{ text: string }>;
}

export async function runBackfill(opts: {
  internalDb: DatabaseSync;
  groupId: string;
  batchSize: number;
  dryRun: boolean;
  model: string;
  llm: LlmClient;
}): Promise<{ processed: number; written: number; skippedPoison: number; skippedMismatch: number }> {
  const { internalDb, groupId, batchSize, dryRun, model, llm } = opts;

  const rows = internalDb.prepare(`
    SELECT id, canonical_form FROM learned_facts
    WHERE group_id = ?
      AND status = 'active'
      AND canonical_form != ''
      AND (persona_form IS NULL OR persona_form = '')
  `).all(groupId) as BackfillRow[];

  const batches = chunk(rows, batchSize);
  let written = 0;
  let skippedPoison = 0;
  let skippedMismatch = 0;

  const systemPrompt = 'You are rewriting factual statements into casual Chinese groupmate voice.\nDo NOT invent new facts.\nOutput one rewrite per input line, same order.';

  for (const batch of batches) {
    const inputs = batch.map(r => r.canonical_form);
    let rewrites: string[];

    try {
      const resp = await llm.complete({
        model,
        maxTokens: 1024,
        system: [{ text: systemPrompt, cache: false }],
        messages: [{ role: 'user', content: inputs.join('\n') }],
      });
      rewrites = resp.text.split('\n').map(l => l.trim()).filter(Boolean);
    } catch (err) {
      console.warn('[SKIP-BATCH] LLM error, skipping batch:', err);
      await delay(500);
      continue;
    }

    if (rewrites.length !== batch.length) {
      console.warn(`[SKIP-BATCH] line count mismatch: expected ${batch.length}, got ${rewrites.length}`);
      skippedMismatch += batch.length;
      await delay(500);
      continue;
    }

    for (let i = 0; i < batch.length; i++) {
      const row = batch[i]!;
      const rewrite = rewrites[i]!;
      const { count, tokens } = novelTokenCount(row.canonical_form, rewrite);

      if (count > 2) {
        console.warn(`[POISON] id=${row.id} skipped — ${count} novel tokens: ${tokens.join(', ')}`);
        if (dryRun) {
          console.log(`[DRY-RUN][POISON] id=${row.id} — novel tokens: ${tokens.join(', ')}`);
        }
        skippedPoison++;
        continue;
      }

      if (dryRun) {
        console.log(`[DRY-RUN] id=${row.id} | canonical: ${row.canonical_form} | persona: ${rewrite}`);
      } else {
        internalDb.prepare('UPDATE learned_facts SET persona_form = ? WHERE id = ?').run(rewrite, row.id);
        written++;
      }
    }

    await delay(500);
  }

  return { processed: rows.length, written, skippedPoison, skippedMismatch };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const groupIdx = args.indexOf('--group');
  if (groupIdx === -1 || !args[groupIdx + 1]) {
    console.error('Error: --group <group_id> is required');
    process.exit(1);
  }
  const groupId = args[groupIdx + 1]!;

  const batchSizeIdx = args.indexOf('--batch-size');
  const batchSize = batchSizeIdx !== -1 && args[batchSizeIdx + 1]
    ? parseInt(args[batchSizeIdx + 1]!, 10)
    : DEFAULT_BATCH_SIZE;

  const dryRun = args.includes('--dry-run');

  const modelIdx = args.indexOf('--model');
  const model = modelIdx !== -1 && args[modelIdx + 1] ? args[modelIdx + 1]! : DEFAULT_MODEL;

  const db = new Database('data/bot.db');
  const internalDb = (db as any)._db as DatabaseSync;

  const candidateCount = (internalDb.prepare(`
    SELECT COUNT(*) as cnt FROM learned_facts
    WHERE group_id = ?
      AND status = 'active'
      AND canonical_form != ''
      AND (persona_form IS NULL OR persona_form = '')
  `).get(groupId) as { cnt: number }).cnt;

  console.log(`Group ${groupId}: ${candidateCount} rows to backfill${dryRun ? ' (dry-run)' : ''}`);

  if (candidateCount === 0) {
    console.log('Nothing to do.');
    return;
  }

  const llm = new ClaudeClient();
  const result = await runBackfill({ internalDb, groupId, batchSize, dryRun, model, llm });

  console.log(`Done. processed=${result.processed} written=${result.written} skippedPoison=${result.skippedPoison} skippedMismatch=${result.skippedMismatch}`);
}

// Only run when invoked directly, not when imported by tests
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
