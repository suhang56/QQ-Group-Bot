#!/usr/bin/env tsx
/**
 * Offline distillation of a QQ group's chat history into a "group lore" document.
 *
 * Usage:
 *   npx tsx scripts/distill-lore.ts \
 *     --group-id 484787509 \
 *     [--db data/bot.db] \
 *     [--output data/lore/<group_id>.md] \
 *     [--model claude-opus-4-6] \
 *     [--max-messages 200000] \
 *     [--chunk-size 40000]
 *
 * Output: data/lore/<group_id>.md — a human-readable "群志" injected into the chat system prompt.
 * The file is written atomically (write to .tmp then rename) to avoid corrupting existing lore.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Database } from '../src/storage/db.js';
import { ClaudeClient } from '../src/ai/claude.js';
import type { ClaudeModel } from '../src/ai/claude.js';
import { createLogger } from '../src/utils/logger.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'info' });
const logger = createLogger('distill-lore');

// ---- CLI args ----

interface Args {
  groupId: string;
  dbPath: string;
  outputPath: string;
  /** @deprecated use chunkModel / metaModel */
  model?: ClaudeModel;
  chunkModel: ClaudeModel;
  metaModel: ClaudeModel;
  maxMessages: number;
  chunkSize: number;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let groupId = '';
  let dbPath = process.env['DB_PATH'] ?? 'data/bot.db';
  let outputPath = '';
  let chunkModel: ClaudeModel = 'claude-sonnet-4-6';
  let metaModel: ClaudeModel = 'claude-opus-4-6';
  let maxMessages = 200_000;
  let chunkSize = 40_000;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--group-id' && args[i + 1]) { groupId = args[++i]!; }
    else if (args[i] === '--db' && args[i + 1]) { dbPath = args[++i]!; }
    else if (args[i] === '--output' && args[i + 1]) { outputPath = args[++i]!; }
    else if (args[i] === '--chunk-model' && args[i + 1]) { chunkModel = args[++i]! as ClaudeModel; }
    else if (args[i] === '--meta-model' && args[i + 1]) { metaModel = args[++i]! as ClaudeModel; }
    else if (args[i] === '--model' && args[i + 1]) {
      // Legacy: --model sets both chunk and meta to same model
      const m = args[++i]! as ClaudeModel;
      chunkModel = m;
      metaModel = m;
    }
    else if (args[i] === '--max-messages' && args[i + 1]) { maxMessages = parseInt(args[++i]!, 10); }
    else if (args[i] === '--chunk-size' && args[i + 1]) { chunkSize = parseInt(args[++i]!, 10); }
  }

  if (!groupId) {
    console.error('Usage: distill-lore.ts --group-id <id> [--db <path>] [--output <path>] [--chunk-model claude-sonnet-4-6] [--meta-model claude-opus-4-6] [--max-messages 200000] [--chunk-size 40000]');
    process.exit(1);
  }

  if (!outputPath) {
    outputPath = `data/lore/${groupId}.md`;
  }

  return { groupId, dbPath, outputPath, chunkModel, metaModel, maxMessages, chunkSize };
}

// ---- Message sampling ----

interface RawMessage {
  nickname: string;
  content: string;
  timestamp: number;
}

function sampleMessages(db: Database, groupId: string, maxMessages: number): RawMessage[] {
  // Pull all messages sorted oldest-first; if over cap, take recent half + random sample of older half
  const allRecent = db.messages.getRecent(groupId, maxMessages);
  if (allRecent.length === 0) {
    throw new Error(`No messages found for group ${groupId} — cannot distill empty corpus`);
  }

  // getRecent returns newest-first; reverse to chronological
  const msgs = [...allRecent].reverse();

  if (msgs.length < maxMessages) {
    // Check if there are more beyond the cap
    const countRow = (db as unknown as { _db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } } })
      ._db.prepare('SELECT COUNT(*) as count FROM messages WHERE group_id = ? AND deleted = 0')
      .get(groupId) as { count: number };
    const total = countRow.count;

    if (total > maxMessages) {
      // Corpus is larger than we fetched — take recent 60% + random 40% of older
      const recentCount = Math.floor(maxMessages * 0.6);
      const randomCount = maxMessages - recentCount;
      const recentMsgs = db.messages.getRecent(groupId, recentCount).reverse();
      const historicalMsgs = db.messages.sampleRandomHistorical(groupId, recentCount, randomCount);
      const combined = [...historicalMsgs, ...recentMsgs].sort((a, b) => a.timestamp - b.timestamp);
      console.log(`[INFO] Corpus has ${total} messages, sampling ${combined.length} (${recentCount} recent + ${randomCount} random historical)`);
      return combined.map(m => ({ nickname: m.nickname, content: m.content, timestamp: m.timestamp }));
    }
  }

  console.log(`[INFO] Corpus: ${msgs.length} messages for group ${groupId}`);
  return msgs.map(m => ({ nickname: m.nickname, content: m.content, timestamp: m.timestamp }));
}

// ---- Chunking ----

function chunkMessages(msgs: RawMessage[], chunkSize: number): RawMessage[][] {
  const chunks: RawMessage[][] = [];
  for (let i = 0; i < msgs.length; i += chunkSize) {
    chunks.push(msgs.slice(i, i + chunkSize));
  }
  return chunks;
}

function formatMessagesBlock(msgs: RawMessage[]): string {
  return msgs.map(m => `${m.nickname}: ${m.content}`).join('\n');
}

// ---- Prompts ----

function chunkSummaryPrompt(groupId: string, msgsBlock: string): string {
  return `以下是QQ群 "${groupId}" 的一段聊天记录（按时间顺序）。请提炼出这段对话反映的：

1. 活跃群友档案：提到过的每个人的说话风格、身份线索、和其他人的关系
2. 群内梗/黑话/内部词汇：只有这个群才用的词，解释含义和出处
3. 常聊话题：反复讨论的主题
4. 群文化氛围：整体语气、调侃风格、禁忌话题

用中文输出，条理清晰的 markdown。不要总结对话内容本身，提炼的是关于"这个群是什么样的群"的信息。

聊天记录：
${msgsBlock}`;
}

function metaSynthesisPrompt(chunkSummaries: string[]): string {
  const joined = chunkSummaries.map((s, i) => `## 片段 ${i + 1}\n${s}`).join('\n\n---\n\n');
  return `以下是对同一个QQ群的多段聊天记录的提炼结果。请合并成一份完整的"群志"。

格式要求：

# [群名/群号] · 群志

## 常驻群友
（按活跃度排列，每人一段：昵称、说话风格、身份背景、和群友的关系）

## 梗/黑话辞典
（每条：词条 — 含义 — 典型用法示例）

## 常聊话题
（列出主要话题领域）

## 群文化
（整体氛围描述）

---
合并原则：去重、补充互相印证的信息、保留最具体的细节。若多段都提到同一个梗或人，合并成一条更完整的条目。

各段提炼结果：

${joined}`;
}

// ---- Token estimation (rough: ~4 chars per token for Chinese) ----

// Agent SDK subscription mode caps at ~200k; leave headroom for system prompt + output
const MAX_CONTEXT_TOKENS = 150_000;
const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ---- Main pipeline ----

export async function runDistillation(args: Args, claude: ClaudeClient): Promise<string> {
  const db = new Database(args.dbPath);

  const msgs = sampleMessages(db, args.groupId, args.maxMessages);

  // Halve chunk size until a sample chunk fits within context budget
  let effectiveChunkSize = args.chunkSize;
  while (effectiveChunkSize > 1) {
    const sampleChunk = formatMessagesBlock(msgs.slice(0, effectiveChunkSize));
    const sampleTokens = estimateTokens(sampleChunk);
    if (sampleTokens <= MAX_CONTEXT_TOKENS * 0.7) break;
    const next = Math.floor(effectiveChunkSize / 2);
    console.warn(`[WARN] Chunk of ${effectiveChunkSize} msgs ~${sampleTokens} tokens; halving to ${next}`);
    effectiveChunkSize = next;
  }
  if (effectiveChunkSize !== args.chunkSize) {
    console.log(`[INFO] Effective chunk size after auto-shrink: ${effectiveChunkSize} messages`);
  }

  const chunks = chunkMessages(msgs, effectiveChunkSize);
  const totalChunks = chunks.length;
  console.log(`[INFO] Split into ${totalChunks} chunk(s) of up to ${effectiveChunkSize} messages each`);

  // Round 1 — chunk summaries
  const chunkSummaries: string[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const msgsBlock = formatMessagesBlock(chunk);
    const promptTokens = estimateTokens(msgsBlock);

    if (promptTokens > MAX_CONTEXT_TOKENS) {
      console.warn(`[WARN] Chunk ${i + 1} estimated ${promptTokens} tokens — exceeds context limit, skipping`);
      continue;
    }

    console.log(`[INFO] chunk ${i + 1}/${totalChunks} — ${chunk.length} messages (~${promptTokens} estimated tokens)`);

    try {
      const response = await claude.complete({
        model: args.chunkModel,
        maxTokens: 4000,
        system: [{ text: '你是一个群聊分析助手，任务是提炼群聊记录的文化特征，输出结构化中文 markdown。', cache: true }],
        messages: [{ role: 'user', content: chunkSummaryPrompt(args.groupId, msgsBlock) }],
      });

      chunkSummaries.push(response.text);
      totalInputTokens += response.inputTokens;
      totalOutputTokens += response.outputTokens;
      console.log(`[INFO] chunk ${i + 1}/${totalChunks} done — input=${response.inputTokens} output=${response.outputTokens}`);
    } catch (err) {
      // Save progress so far before re-throwing
      if (chunkSummaries.length > 0) {
        const partial = chunkSummaries.join('\n\n---\n\n');
        const partialPath = `${args.outputPath}.partial`;
        writeFileSync(partialPath, partial, 'utf8');
        console.error(`[ERROR] Claude API error on chunk ${i + 1}. Partial progress saved to ${partialPath}`);
      }
      throw err;
    }
  }

  if (chunkSummaries.length === 0) {
    throw new Error('All chunks failed — no summaries produced');
  }

  // Round 2 — meta-synthesis (skip if only one chunk)
  let finalLore: string;
  if (chunkSummaries.length === 1) {
    console.log('[INFO] Single chunk — skipping meta-synthesis, using chunk summary directly');
    finalLore = chunkSummaries[0]!;
  } else {
    console.log(`[INFO] meta-synthesis of ${chunkSummaries.length} chunk summaries...`);
    const metaPrompt = metaSynthesisPrompt(chunkSummaries);
    const metaTokens = estimateTokens(metaPrompt);
    console.log(`[INFO] meta-synthesis prompt ~${metaTokens} estimated tokens`);

    const metaResponse = await claude.complete({
      model: args.metaModel,
      maxTokens: 8000,
      system: [{ text: '你是一个群聊分析助手，任务是将多段群聊分析合并成一份完整准确的群志，输出结构化中文 markdown。', cache: true }],
      messages: [{ role: 'user', content: metaPrompt }],
    });

    finalLore = metaResponse.text;
    totalInputTokens += metaResponse.inputTokens;
    totalOutputTokens += metaResponse.outputTokens;
    console.log(`[INFO] meta-synthesis done — input=${metaResponse.inputTokens} output=${metaResponse.outputTokens}`);
  }

  db.close();

  console.log(`[INFO] Total tokens used — input=${totalInputTokens} output=${totalOutputTokens}`);
  return finalLore;
}

// ---- File write (atomic) ----

function writeLoreAtomic(outputPath: string, content: string): void {
  const dir = path.dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${outputPath}.tmp`;
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, outputPath);

  const sizeKb = (content.length / 1024).toFixed(1);
  console.log(`[DONE] Lore written to ${outputPath} (${sizeKb} KB)`);
}

// ---- Entry point ----

async function main() {
  const args = parseArgs(process.argv);
  const claude = new ClaudeClient();

  console.log(`[INFO] Group: ${args.groupId}`);
  console.log(`[INFO] DB: ${args.dbPath}`);
  console.log(`[INFO] Output: ${args.outputPath}`);
  console.log(`[INFO] Chunk model: ${args.chunkModel}, Meta model: ${args.metaModel}`);
  console.log(`[INFO] Max messages: ${args.maxMessages}, Chunk size: ${args.chunkSize}`);

  const lore = await runDistillation(args, claude);
  writeLoreAtomic(args.outputPath, lore);
}

const isMain = process.argv[1]?.endsWith('distill-lore.ts') ||
               process.argv[1]?.endsWith('distill-lore.js');
if (isMain) {
  main().catch(err => {
    console.error('[FATAL]', err);
    process.exit(1);
  });
}
