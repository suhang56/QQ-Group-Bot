import { describe, it, expect, vi } from 'vitest';
import { extractJson } from '../src/utils/json-extract.js';
import { OpportunisticHarvest } from '../src/modules/opportunistic-harvest.js';
import type { IClaudeClient } from '../src/ai/claude.js';
import type { IMessageRepository, ILearnedFactsRepository } from '../src/storage/db.js';
import type { Logger } from 'pino';

const silentLogger = {
  warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(),
} as unknown as Logger;

describe('extractJson', () => {
  it('parses a plain JSON object', () => {
    const result = extractJson<{ found: boolean }>('{"found":true}');
    expect(result).toEqual({ found: true });
  });

  it('parses a plain JSON array', () => {
    const result = extractJson<string[]>('["a","b","c"]');
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('parses a ```json fenced object', () => {
    const result = extractJson<{ violation: boolean }>('```json\n{"violation":false}\n```');
    expect(result).toEqual({ violation: false });
  });

  it('parses a ```json fenced array', () => {
    const raw = '```json\n[{"topic":"T1","fact":"事实"}]\n```';
    const result = extractJson<Array<{ topic: string; fact: string }>>(raw);
    expect(Array.isArray(result)).toBe(true);
    expect(result![0]!.topic).toBe('T1');
  });

  it('parses a ``` no-language fenced object', () => {
    const result = extractJson<{ x: number }>('```\n{"x":42}\n```');
    expect(result).toEqual({ x: 42 });
  });

  it('parses JSON followed by prose', () => {
    const raw = '{"found":true}\n\n**Reasoning:** Some explanation here.';
    const result = extractJson<{ found: boolean }>(raw);
    expect(result).toEqual({ found: true });
  });

  it('parses JSON preceded by prose', () => {
    const raw = 'Here is my answer:\n[{"term":"jtty"}]';
    const result = extractJson<Array<{ term: string }>>(raw);
    expect(Array.isArray(result)).toBe(true);
    expect(result![0]!.term).toBe('jtty');
  });

  it('parses JSON with nested objects and arrays', () => {
    const raw = '{"items":[{"a":1},{"b":2}],"meta":{"count":2}}';
    const result = extractJson<{ items: object[]; meta: { count: number } }>(raw);
    expect(result?.meta.count).toBe(2);
    expect(Array.isArray(result?.items)).toBe(true);
  });

  it('parses JSON containing a string with } inside quotes', () => {
    const raw = '{"key":"value with } inside","other":1}';
    const result = extractJson<{ key: string; other: number }>(raw);
    expect(result?.key).toBe('value with } inside');
    expect(result?.other).toBe(1);
  });

  it('returns null for malformed JSON without throwing', () => {
    expect(() => extractJson('{not valid json')).not.toThrow();
    expect(extractJson('{not valid json')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractJson('')).toBeNull();
  });
});

describe('extractJson — integration: opportunistic-harvest with fenced response', () => {
  it('inserts facts when Claude returns ```json fenced array', async () => {
    const msgs = Array.from({ length: 15 }, (_, i) => ({
      id: i, groupId: 'g1', userId: `u${i}`, nickname: `User${i}`,
      content: `msg ${i}`, rawContent: `msg ${i}`,
      timestamp: 1700000000 + i, deleted: false,
    }));
    const msgRepo = { getRecent: vi.fn().mockReturnValue(msgs) } as unknown as IMessageRepository;

    const inserted: unknown[] = [];
    const factRepo = {
      inserted,
      listActive: vi.fn().mockReturnValue([]),
      insert: vi.fn().mockImplementation((row: unknown) => { inserted.push(row); return inserted.length; }),
      markStatus: vi.fn(), clearGroup: vi.fn(), countActive: vi.fn().mockReturnValue(0),
    } as unknown as ILearnedFactsRepository;

    const fencedResponse = '```json\n[{"category":"fandom 事实","topic":"ykn","fact":"ykn = 相羽あいな，Roselia 凑友希那 CV","sourceNickname":"飞鸟","confidence":0.95}]\n```';
    const claude: IClaudeClient = {
      complete: vi.fn().mockResolvedValue({ text: fencedResponse, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    } as unknown as IClaudeClient;

    const harvest = new OpportunisticHarvest({
      messages: msgRepo, learnedFacts: factRepo, claude,
      activeGroups: ['g1'], logger: silentLogger, enabled: true,
    });

    await harvest._run();

    expect(inserted).toHaveLength(1);
    expect((inserted[0] as { fact: string }).fact).toContain('相羽あいな');
  });
});
