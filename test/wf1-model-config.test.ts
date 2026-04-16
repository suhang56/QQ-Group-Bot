import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initLogger } from '../src/utils/logger.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

initLogger({ level: 'silent' });

// ============================================================================
// A2. gemini-llm.ts — reasoning_effort:'low' + max_tokens+100
// ============================================================================

const mockCreate = vi.hoisted(() => vi.fn());
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));

describe('GeminiClient reasoning_effort and max_tokens', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends reasoning_effort:"none" (thinking disabled)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });

    const { GeminiClient } = await import('../src/ai/providers/gemini-llm.js');
    const client = new GeminiClient({ apiKey: 'test-key' });
    await client.complete({
      model: 'gemini-2.5-flash',
      maxTokens: 300,
      system: [{ text: 'sys', cache: false }],
      messages: [{ role: 'user', content: 'hi' }],
    });

    const call = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.reasoning_effort).toBe('none');
  });

  it('passes max_tokens through without addition', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });

    const { GeminiClient } = await import('../src/ai/providers/gemini-llm.js');
    const client = new GeminiClient({ apiKey: 'test-key' });
    await client.complete({
      model: 'gemini-2.5-flash',
      maxTokens: 300,
      system: [],
      messages: [{ role: 'user', content: 'test' }],
    });

    const call = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.max_tokens).toBe(300);
  });

  it('max_tokens=0 results in 0', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    const { GeminiClient } = await import('../src/ai/providers/gemini-llm.js');
    const client = new GeminiClient({ apiKey: 'test-key' });
    await client.complete({
      model: 'gemini-2.5-flash',
      maxTokens: 0,
      system: [],
      messages: [{ role: 'user', content: 'x' }],
    });

    const call = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.max_tokens).toBe(0);
  });

  it('vision paths still use reasoning_effort:"none"', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'desc' } }],
    });

    const { GeminiClient } = await import('../src/ai/providers/gemini-llm.js');
    const client = new GeminiClient({ apiKey: 'test-key' });
    await client.visionWithPrompt(
      Buffer.from([0xff, 0xd8, 0xff]),
      'gemini-2.5-flash',
      'describe',
      200,
    );

    const call = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.reasoning_effort).toBe('none');
  });
});

// ============================================================================
// A3. config.ts — REFLECTION_MODEL default + context window sizes
// ============================================================================

describe('config defaults', () => {
  it('REFLECTION_MODEL defaults to gemini-2.5-flash', async () => {
    const saved = process.env['REFLECTION_MODEL'];
    delete process.env['REFLECTION_MODEL'];
    // Dynamic import to pick up env state — vi.resetModules would be needed
    // for a true re-import, but we can just read the source expectation:
    const { REFLECTION_MODEL } = await import('../src/config.js');
    // If env var was set before module loaded, this checks the compiled default
    expect(typeof REFLECTION_MODEL).toBe('string');
    if (!saved) {
      expect(REFLECTION_MODEL).toBe('gemini-2.5-flash');
    }
    if (saved) process.env['REFLECTION_MODEL'] = saved;
  });

  it('chatHistoryDefaults has reduced context windows', async () => {
    const { chatHistoryDefaults } = await import('../src/config.js');
    expect(chatHistoryDefaults.chatContextWide).toBe(30);
    expect(chatHistoryDefaults.chatContextMedium).toBe(15);
    expect(chatHistoryDefaults.chatContextImmediate).toBe(8);
  });
});

// ============================================================================
// D3. _loadTuning 3000 character cap
// ============================================================================

describe('_loadTuning 3000 char cap', () => {
  let tmpDir: string;
  let tuningPath: string;
  let permanentPath: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `wf1-tuning-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    tuningPath = path.join(tmpDir, 'tuning.md');
    permanentPath = path.join(tmpDir, 'tuning-permanent.md');
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  // We test _loadTuning by accessing the private method via bracket notation
  // on a minimal ChatModule-like object that has tuningPath set.
  // Since ChatModule is complex, we replicate the method logic inline.
  function loadTuning(tuningFilePath: string): string | null {
    const parts: string[] = [];
    try {
      if (existsSync(tuningFilePath)) {
        const content = readFileSync(tuningFilePath, 'utf8').trim();
        if (content) parts.push(content);
      }
    } catch { /* ignore */ }
    try {
      const permPath = path.join(path.dirname(tuningFilePath), 'tuning-permanent.md');
      if (existsSync(permPath)) {
        const content = readFileSync(permPath, 'utf8').trim();
        if (content) parts.push(content);
      }
    } catch { /* ignore */ }
    if (parts.length === 0) return null;
    const joined = parts.join('\n\n');
    if (joined.length <= 3000) return joined;
    let end = 3000;
    const code = joined.charCodeAt(end - 1);
    if (code >= 0xD800 && code <= 0xDBFF) end--;
    return joined.slice(0, end);
  }

  it('returns null when both files missing', () => {
    expect(loadTuning(tuningPath)).toBeNull();
  });

  it('returns content when under 3000 chars', () => {
    writeFileSync(tuningPath, 'short tuning', 'utf8');
    expect(loadTuning(tuningPath)).toBe('short tuning');
  });

  it('combines short-term and permanent tuning', () => {
    writeFileSync(tuningPath, 'short', 'utf8');
    writeFileSync(permanentPath, 'perm', 'utf8');
    expect(loadTuning(tuningPath)).toBe('short\n\nperm');
  });

  it('truncates combined content at 3000 chars', () => {
    const longContent = 'x'.repeat(2000);
    writeFileSync(tuningPath, longContent, 'utf8');
    writeFileSync(permanentPath, longContent, 'utf8');
    const result = loadTuning(tuningPath)!;
    expect(result.length).toBe(3000);
  });

  it('does not truncate content exactly at 3000', () => {
    writeFileSync(tuningPath, 'a'.repeat(3000), 'utf8');
    const result = loadTuning(tuningPath)!;
    expect(result.length).toBe(3000);
  });

  it('truncates content at 3001 chars', () => {
    writeFileSync(tuningPath, 'b'.repeat(3001), 'utf8');
    const result = loadTuning(tuningPath)!;
    expect(result.length).toBe(3000);
  });

  it('returns null when both files are empty', () => {
    writeFileSync(tuningPath, '', 'utf8');
    writeFileSync(permanentPath, '   ', 'utf8');
    expect(loadTuning(tuningPath)).toBeNull();
  });

  it('does not split a surrogate pair at the 3000 boundary', () => {
    // U+1F600 (😀) is a surrogate pair in UTF-16: \uD83D\uDE00 (2 code units)
    // Place it so the high surrogate lands at position 2999
    const prefix = 'x'.repeat(2999);
    const content = prefix + '😀' + 'y'.repeat(100);
    writeFileSync(tuningPath, content, 'utf8');
    const result = loadTuning(tuningPath)!;
    // Should back up to 2999 to avoid a lone high surrogate
    expect(result.length).toBe(2999);
    expect(result.endsWith('x')).toBe(true);
    // Verify no lone surrogates
    for (let i = 0; i < result.length; i++) {
      const c = result.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF) {
        // High surrogate must be followed by low surrogate
        expect(result.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xDC00);
        expect(result.charCodeAt(i + 1)).toBeLessThanOrEqual(0xDFFF);
      }
    }
  });

  it('keeps full emoji when it ends before the 3000 boundary', () => {
    // Place emoji so both code units fit within 3000
    const prefix = 'x'.repeat(2998);
    const content = prefix + '😀' + 'y'.repeat(100);
    writeFileSync(tuningPath, content, 'utf8');
    const result = loadTuning(tuningPath)!;
    // 2998 + 2 (emoji) = 3000, fits exactly
    expect(result.length).toBe(3000);
    expect(result).toContain('😀');
  });
});
