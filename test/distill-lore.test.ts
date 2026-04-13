import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runDistillation } from '../scripts/distill-lore.js';
import { Database } from '../src/storage/db.js';
import { ClaudeClient } from '../src/ai/claude.js';
import { ClaudeApiError } from '../src/utils/errors.js';
import { initLogger } from '../src/utils/logger.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

describe('distill-lore: runDistillation', () => {
  let db: Database;
  let tmpDb: string;

  beforeEach(() => {
    // Write a real sqlite file so Database can open it
    const dir = mkdtempSync(path.join(tmpdir(), 'lore-test-'));
    tmpDb = path.join(dir, 'test.db');
    db = new Database(tmpDb);
  });

  // 5. Smoke test with 100-message synthetic corpus → produces non-empty markdown
  it('100-message corpus: single chunk, produces non-empty lore markdown', async () => {
    insertTestMessages(db, 'g1', 100);
    db.close();

    const claude = makeFakeClaudeClient(['# 群志\n## 常驻群友\nUser0 — 活跃用户\n## 梗辞典\n无']);
    const lore = await runDistillation(
      { groupId: 'g1', dbPath: tmpDb, outputPath: '/tmp/out.md', chunkModel: 'claude-sonnet-4-6', metaModel: 'claude-opus-4-6', maxMessages: 200_000, chunkSize: 40_000 },
      claude
    );

    expect(typeof lore).toBe('string');
    expect(lore.length).toBeGreaterThan(0);
    // Single chunk → chunk summary used directly (no meta-synthesis call)
    expect((claude.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  // Multi-chunk: 3 chunks → 4 Claude calls (3 summaries + 1 meta)
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
      { groupId: 'g1', dbPath: tmpDb, outputPath: '/tmp/out.md', chunkModel: 'claude-sonnet-4-6', metaModel: 'claude-opus-4-6', maxMessages: 200_000, chunkSize: 100 },
      claude
    );

    const calls = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls).toBe(4); // 3 chunk summaries + 1 meta-synthesis
    expect(lore).toContain('完整群志');
  });

  // 6. Claude API fails mid-chunk → partial progress preserved, error propagated
  it('Claude API error mid-chunk: saves partial progress and throws', async () => {
    insertTestMessages(db, 'g1', 300);
    db.close();

    let callCount = 0;
    const failingClaude = {
      complete: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          throw new ClaudeApiError(new Error('rate limited'));
        }
        return { text: `# 群志片段${callCount}`, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
      }),
    } as unknown as ClaudeClient;

    // Write partial progress to a temp path
    const partialOutputPath = path.join(mkdtempSync(path.join(tmpdir(), 'partial-')), 'out.md');

    await expect(
      runDistillation(
        { groupId: 'g1', dbPath: tmpDb, outputPath: partialOutputPath, chunkModel: 'claude-sonnet-4-6', metaModel: 'claude-opus-4-6', maxMessages: 200_000, chunkSize: 100 },
        failingClaude
      )
    ).rejects.toThrow();

    // Partial file should have been saved
    const { existsSync, readFileSync } = await import('node:fs');
    expect(existsSync(`${partialOutputPath}.partial`)).toBe(true);
    const partial = readFileSync(`${partialOutputPath}.partial`, 'utf8');
    expect(partial.length).toBeGreaterThan(0);
  });

  // Error on empty corpus
  it('empty corpus: throws with clear error message', async () => {
    db.close();
    const claude = makeFakeClaudeClient([]);

    await expect(
      runDistillation(
        { groupId: 'g-empty', dbPath: tmpDb, outputPath: '/tmp/out.md', chunkModel: 'claude-sonnet-4-6', metaModel: 'claude-opus-4-6', maxMessages: 200_000, chunkSize: 40_000 },
        claude
      )
    ).rejects.toThrow(/No messages found/);
  });
});
