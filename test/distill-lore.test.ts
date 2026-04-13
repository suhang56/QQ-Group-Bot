import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runDistillation } from '../scripts/distill-lore.js';
import { Database } from '../src/storage/db.js';
import { ClaudeClient } from '../src/ai/claude.js';
import { ClaudeApiError } from '../src/utils/errors.js';
import { initLogger } from '../src/utils/logger.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

initLogger({ level: 'silent' });

function makeFakeClaudeClient(responses: string[]): ClaudeClient {
  let callIndex = 0;
  return {
    complete: vi.fn().mockImplementation(async () => {
      const text = responses[callIndex++] ?? '默认摘要';
      return { text, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
    }),
  } as unknown as ClaudeClient;
}

function insertTestMessages(db: Database, groupId: string, count: number) {
  const base = Math.floor(Date.now() / 1000) - count * 60;
  for (let i = 0; i < count; i++) {
    db.messages.insert({
      groupId,
      userId: `u${i % 5}`,
      nickname: `User${i % 5}`,
      content: `消息内容 ${i}，这是测试群聊内容`,
      timestamp: base + i * 60,
      deleted: false,
    });
  }
}

function tempOutputPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'lore-test-')), 'out.md');
}

const BASE_ARGS = {
  chunkModel: 'claude-sonnet-4-6' as const,
  metaModel: 'claude-opus-4-6' as const,
  maxMessages: 200_000,
  resume: false,
  fresh: false,
};

describe('distill-lore: runDistillation', () => {
  let db: Database;
  let tmpDb: string;

  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lore-test-'));
    tmpDb = path.join(dir, 'test.db');
    db = new Database(tmpDb);
  });

  it('100-message corpus: single chunk, produces non-empty lore markdown', async () => {
    insertTestMessages(db, 'g1', 100);
    db.close();

    const claude = makeFakeClaudeClient(['# 群志\n## 常驻群友\nUser0 — 活跃用户\n## 梗辞典\n无']);
    const lore = await runDistillation(
      { ...BASE_ARGS, groupId: 'g1', dbPath: tmpDb, outputPath: tempOutputPath(), chunkSize: 40_000 },
      claude
    );

    expect(typeof lore).toBe('string');
    expect(lore.length).toBeGreaterThan(0);
    expect((claude.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('multi-chunk corpus: N chunks produce N+1 Claude calls (summaries + meta-synthesis)', async () => {
    insertTestMessages(db, 'g1', 300);
    db.close();

    const claude = makeFakeClaudeClient([
      '# 群志片段1\n内容A',
      '# 群志片段2\n内容B',
      '# 群志片段3\n内容C',
      '# 完整群志\n综合内容',
    ]);

    const lore = await runDistillation(
      { ...BASE_ARGS, groupId: 'g1', dbPath: tmpDb, outputPath: tempOutputPath(), chunkSize: 100 },
      claude
    );

    const calls = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls).toBe(4);
    expect(lore).toContain('完整群志');
  });

  it('Claude API error mid-chunk: saves chunks.jsonl with completed chunks and throws', async () => {
    insertTestMessages(db, 'g1', 300);
    db.close();

    let callCount = 0;
    const failingClaude = {
      complete: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 2) throw new ClaudeApiError(new Error('rate limited'));
        return { text: `# 群志片段${callCount}`, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
      }),
    } as unknown as ClaudeClient;

    const outputPath = tempOutputPath();

    await expect(
      runDistillation(
        { ...BASE_ARGS, groupId: 'g1', dbPath: tmpDb, outputPath, chunkSize: 100 },
        failingClaude
      )
    ).rejects.toThrow();

    const { existsSync, readFileSync } = await import('node:fs');
    const chunksFile = `${outputPath}.chunks.jsonl`;
    expect(existsSync(chunksFile)).toBe(true);
    const lines = readFileSync(chunksFile, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1); // chunk 0 saved before chunk 1 failed
    const rec = JSON.parse(lines[0]!);
    expect(rec.chunkIndex).toBe(0);
    expect(rec.summary.length).toBeGreaterThan(0);
  });

  it('--resume: skips already-saved chunks, only calls Claude for missing ones', async () => {
    insertTestMessages(db, 'g1', 300);
    db.close();

    const outputPath = tempOutputPath();

    // First run: fail on chunk 2 so chunks 0+1 are saved
    let callCount = 0;
    const firstClaude = {
      complete: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 3) throw new ClaudeApiError(new Error('transient'));
        return { text: `# 片段${callCount}`, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
      }),
    } as unknown as ClaudeClient;

    await expect(
      runDistillation({ ...BASE_ARGS, groupId: 'g1', dbPath: tmpDb, outputPath, chunkSize: 100 }, firstClaude)
    ).rejects.toThrow();

    // Second run with --resume: only 1 chunk call + 1 meta call expected
    const resumeClaude = makeFakeClaudeClient(['# 片段3\n内容C', '# 完整群志\n合并内容']);
    const lore = await runDistillation(
      { ...BASE_ARGS, groupId: 'g1', dbPath: tmpDb, outputPath, chunkSize: 100, resume: true },
      resumeClaude
    );

    const calls = (resumeClaude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls).toBe(2); // 1 missing chunk + 1 meta
    expect(lore).toContain('完整群志');
  });

  it('meta-synthesis retry: retries up to 3 times, writes fallback on final failure', async () => {
    insertTestMessages(db, 'g1', 200);
    db.close();

    const outputPath = tempOutputPath();
    let callCount = 0;
    const failingMeta = {
      complete: vi.fn().mockImplementation(async () => {
        callCount++;
        // First 2 calls are chunk summaries; meta calls always fail
        if (callCount > 2) throw new Error('API terminated');
        return { text: `# 片段${callCount}`, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
      }),
    } as unknown as ClaudeClient;

    await expect(
      runDistillation({ ...BASE_ARGS, groupId: 'g1', dbPath: tmpDb, outputPath, chunkSize: 100 }, failingMeta)
    ).rejects.toThrow();

    const { existsSync } = await import('node:fs');
    expect(existsSync(`${outputPath}.chunks.md`)).toBe(true);
    // 2 chunk calls + 3 meta attempts = 5 total
    expect((failingMeta.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(5);
  });

  it('empty corpus: throws with clear error message', async () => {
    db.close();
    const claude = makeFakeClaudeClient([]);

    await expect(
      runDistillation(
        { ...BASE_ARGS, groupId: 'g-empty', dbPath: tmpDb, outputPath: tempOutputPath(), chunkSize: 40_000 },
        claude
      )
    ).rejects.toThrow(/No messages found/);
  });
});
