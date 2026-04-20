/**
 * R6.2 gold-label CLI — unit + integration tests.
 *
 * Tests are at the library level (reader / writer / session / shortcuts) —
 * the CLI entry (label-gold.ts) does TTY wiring only and is exercised via
 * injected readKey/promptNotesLine providers here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { SampledRow, WeakReplayLabel } from '../../scripts/eval/types.js';
import { appendLabel, readExistingLabels, updateLabel } from '../../scripts/eval/gold/writer.js';
import { readSamples, getDiagnostics } from '../../scripts/eval/gold/reader.js';
import { keyToAction } from '../../scripts/eval/gold/shortcuts.js';
import { runSession, sanitizeNotes, handleEdit } from '../../scripts/eval/gold/session.js';
import { validateGoldLabel, type GoldLabel } from '../../scripts/eval/gold/types.js';

// ---- Fixtures ----

function makeWeakLabel(overrides: Partial<WeakReplayLabel> = {}): WeakReplayLabel {
  return {
    expectedAct: 'direct_chat',
    expectedDecision: 'reply',
    hasKnownFactTerm: false,
    knownFactSource: null,
    hasRealFactHit: false,
    allowPluralYou: false,
    isObjectReact: false,
    isBotStatusContext: false,
    isBurst: false,
    isRelay: false,
    isDirect: true,
    riskFlags: [],
    ...overrides,
  };
}

function makeSampledRow(i: number, overrides: Partial<SampledRow> = {}): SampledRow {
  return {
    id: `group-1:${1000 + i}`,
    groupId: 'group-1',
    messageId: 1000 + i,
    sourceMessageId: null,
    userId: 'user-a',
    nickname: 'Alice',
    timestamp: 1_700_000_000 + i * 60,
    content: `sample content ${i}`,
    rawContent: null,
    triggerContext: [],
    triggerContextAfter: [],
    category: 1,
    categoryLabel: 'direct_at_bot',
    samplingSeed: 1,
    contentHash: 'a'.repeat(16),
    contextHash: 'b'.repeat(16),
    ...overrides,
  };
}

function makeWeakLabeledLine(i: number, idOverride?: string): string {
  const row = makeSampledRow(i);
  if (idOverride) row.id = idOverride;
  return JSON.stringify({ ...row, label: makeWeakLabel() });
}

async function writeJsonl(filePath: string, lines: string[]): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, lines.join('\n') + '\n', 'utf8');
}

// ---- Scripted key / notes providers ----

function scriptedKeys(sequence: string[]): () => Promise<Buffer> {
  let i = 0;
  return async () => {
    if (i >= sequence.length) {
      // Safety net: simulate `q` twice to end session rather than hanging
      return Buffer.from('q');
    }
    const s = sequence[i++]!;
    return Buffer.from(s);
  };
}

function scriptedNotes(lines: string[]): () => Promise<string> {
  let i = 0;
  return async () => {
    if (i >= lines.length) return '';
    return lines[i++]!;
  };
}

// ---- Temp dir plumbing ----

let tmp: string;

beforeEach(async () => {
  tmp = path.join(os.tmpdir(), `gold-cli-${randomUUID()}`);
  await fsp.mkdir(tmp, { recursive: true });
  // Silence stdout renders during tests
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(tmp, { recursive: true, force: true });
});

// ---- Tests ----

describe('shortcuts.keyToAction', () => {
  it('maps decision keys', () => {
    expect(keyToAction(Buffer.from('r'))).toEqual({ type: 'decision', value: 'reply' });
    expect(keyToAction(Buffer.from('s'))).toEqual({ type: 'decision', value: 'silent' });
    expect(keyToAction(Buffer.from('d'))).toEqual({ type: 'decision', value: 'defer' });
  });
  it('maps digits 1-9 to acts', () => {
    expect(keyToAction(Buffer.from('1'))).toEqual({ type: 'act', value: 'direct_chat' });
    expect(keyToAction(Buffer.from('9'))).toEqual({ type: 'act', value: 'silence' });
  });
  it('distinguishes b vs B', () => {
    expect(keyToAction(Buffer.from('b'))).toEqual({ type: 'toggle', field: 'allowSticker' });
    expect(keyToAction(Buffer.from('B'))).toEqual({ type: 'toggle', field: 'allowBanter' });
  });
  it('treats Ctrl+C as quit', () => {
    expect(keyToAction(Buffer.from([0x03]))).toEqual({ type: 'quit' });
  });
});

describe('sanitizeNotes', () => {
  it('returns undefined for empty input (TC-11)', () => {
    expect(sanitizeNotes('')).toEqual({ notes: undefined, truncated: false });
    expect(sanitizeNotes('   ')).toEqual({ notes: undefined, truncated: false });
  });
  it('truncates >500 chars (TC-12)', () => {
    const input = 'x'.repeat(600);
    const { notes, truncated } = sanitizeNotes(input);
    expect(truncated).toBe(true);
    expect(notes?.length).toBe(500);
  });
});

describe('writer + reader round-trip', () => {
  it('TC-7: appendLabel creates file and readExistingLabels round-trips', async () => {
    const out = path.join(tmp, 'gold.jsonl');
    const label: GoldLabel = {
      sampleId: 's-1',
      goldAct: 'direct_chat',
      goldDecision: 'reply',
      targetOk: true,
      factNeeded: false,
      allowBanter: false,
      allowSticker: false,
      labeledAt: new Date().toISOString(),
    };
    await appendLabel(out, label);
    const read = await readExistingLabels(out);
    expect(read.size).toBe(1);
    expect(read.get('s-1')?.goldAct).toBe('direct_chat');
  });

  it('updateLabel replaces by sampleId with no duplicates', async () => {
    const out = path.join(tmp, 'gold.jsonl');
    const base: GoldLabel = {
      sampleId: 's-1',
      goldAct: 'direct_chat',
      goldDecision: 'reply',
      targetOk: true,
      factNeeded: false,
      allowBanter: false,
      allowSticker: false,
      labeledAt: new Date().toISOString(),
    };
    await appendLabel(out, base);
    await appendLabel(out, { ...base, sampleId: 's-2', goldAct: 'chime_in' });
    await updateLabel(out, { ...base, goldAct: 'conflict_handle' });
    const read = await readExistingLabels(out);
    expect(read.size).toBe(2);
    expect(read.get('s-1')?.goldAct).toBe('conflict_handle');
    expect(read.get('s-2')?.goldAct).toBe('chime_in');
    const file = await fsp.readFile(out, 'utf8');
    // Only 2 content lines — no duplicate of s-1
    const lines = file.split('\n').filter(l => l.trim().length > 0);
    expect(lines.length).toBe(2);
  });
});

describe('reader malformed + duplicate handling', () => {
  it('TC-5: malformed line is skipped, does not crash', async () => {
    const inputPath = path.join(tmp, 'in.jsonl');
    const lines = [
      makeWeakLabeledLine(1),
      makeWeakLabeledLine(2),
      '{bad json',
      makeWeakLabeledLine(4),
      makeWeakLabeledLine(5),
    ];
    await writeJsonl(inputPath, lines);
    const collected: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for await (const s of readSamples(inputPath)) collected.push(s.sampleId);
    expect(collected.length).toBe(4);
    const diag = getDiagnostics(inputPath);
    expect(diag.malformedLineNumbers).toEqual([3]);
    stderr.mockRestore();
  });

  it('TC-8: duplicate sampleId — first wins, subsequent dropped', async () => {
    const inputPath = path.join(tmp, 'in.jsonl');
    const lines = [
      makeWeakLabeledLine(1),
      makeWeakLabeledLine(2),
      makeWeakLabeledLine(3),
      makeWeakLabeledLine(4, 'group-1:1001'), // duplicate of i=1
    ];
    await writeJsonl(inputPath, lines);
    const collected: string[] = [];
    for await (const s of readSamples(inputPath)) collected.push(s.sampleId);
    expect(collected).toEqual(['group-1:1001', 'group-1:1002', 'group-1:1003']);
    const diag = getDiagnostics(inputPath);
    expect(diag.duplicateSampleIds).toEqual(['group-1:1001']);
  });
});

describe('session — runSession', () => {
  it('TC-1: labels 5 samples (happy path)', async () => {
    const inputPath = path.join(tmp, 'in.jsonl');
    const outputPath = path.join(tmp, 'gold.jsonl');
    await writeJsonl(inputPath, [1, 2, 3, 4, 5].map(i => makeWeakLabeledLine(i)));
    const keys: string[] = [];
    for (let i = 0; i < 5; i++) keys.push('r', '1'); // decision=reply, act=direct_chat
    const stats = await runSession({
      inputPath,
      outputPath,
      readKey: scriptedKeys(keys),
      promptNotesLine: scriptedNotes([]),
      delay: async () => {},
      quitTimeoutMs: 0,
    });
    expect(stats.labeled).toBe(5);
    expect(stats.skipped).toBe(0);
    const labels = await readExistingLabels(outputPath);
    expect(labels.size).toBe(5);
    for (const label of labels.values()) {
      expect(label.goldAct).toBe('direct_chat');
      expect(label.goldDecision).toBe('reply');
      expect(() => validateGoldLabel(label)).not.toThrow();
      expect(new Date(label.labeledAt).toString()).not.toBe('Invalid Date');
    }
  });

  it('TC-2: resume — label 3, restart, label remaining 2', async () => {
    const inputPath = path.join(tmp, 'in.jsonl');
    const outputPath = path.join(tmp, 'gold.jsonl');
    await writeJsonl(inputPath, [1, 2, 3, 4, 5].map(i => makeWeakLabeledLine(i)));

    // Run 1: label 3, then quit+quit to confirm
    const run1Keys = ['r', '1', 'r', '1', 'r', '1', 'q', 'q'];
    const stats1 = await runSession({
      inputPath,
      outputPath,
      readKey: scriptedKeys(run1Keys),
      promptNotesLine: scriptedNotes([]),
      delay: async () => {},
      quitTimeoutMs: 0,
    });
    expect(stats1.labeled).toBe(3);

    // Run 2: same output file — reader skips first 3, presents 2 more
    const run2Keys = ['r', '2', 'r', '2']; // label as chime_in this time
    const stats2 = await runSession({
      inputPath,
      outputPath,
      readKey: scriptedKeys(run2Keys),
      promptNotesLine: scriptedNotes([]),
      delay: async () => {},
      quitTimeoutMs: 0,
    });
    expect(stats2.labeled).toBe(2);
    expect(stats2.totalPresented).toBe(2);

    const labels = await readExistingLabels(outputPath);
    expect(labels.size).toBe(5);
    // Verify run 1's labels are unchanged
    expect(labels.get('group-1:1001')?.goldAct).toBe('direct_chat');
    expect(labels.get('group-1:1004')?.goldAct).toBe('chime_in');
  });

  it('TC-3: skip (k) does not write the sample', async () => {
    const inputPath = path.join(tmp, 'in.jsonl');
    const outputPath = path.join(tmp, 'gold.jsonl');
    await writeJsonl(inputPath, [1, 2, 3].map(i => makeWeakLabeledLine(i)));

    // sample 1: r, 1 → saved
    // sample 2: k → skip
    // sample 3: r, 1 → saved
    const stats = await runSession({
      inputPath,
      outputPath,
      readKey: scriptedKeys(['r', '1', 'k', 'r', '1']),
      promptNotesLine: scriptedNotes([]),
      delay: async () => {},
      quitTimeoutMs: 0,
    });
    expect(stats.labeled).toBe(2);
    expect(stats.skipped).toBe(1);
    const labels = await readExistingLabels(outputPath);
    expect(labels.size).toBe(2);
    expect(labels.has('group-1:1002')).toBe(false);
  });

  it('TC-4: edit previous — overwrites by sampleId', async () => {
    const inputPath = path.join(tmp, 'in.jsonl');
    const outputPath = path.join(tmp, 'gold.jsonl');
    await writeJsonl(inputPath, [1, 2].map(i => makeWeakLabeledLine(i)));

    // sample 1: commit r+1 → direct_chat/reply
    // sample 2: e, select "1" (index into last-5 = sample 1), change act to 2 (chime_in) keeping decision=reply
    //           (act was direct_chat, pressing 2 updates → chime_in; decision already set → commits)
    //         then sample 2 still in flight: r, 1 → commit it
    const keys = ['r', '1', 'e', '1', '2', 'r', '1'];
    const stats = await runSession({
      inputPath,
      outputPath,
      readKey: scriptedKeys(keys),
      promptNotesLine: scriptedNotes([]),
      delay: async () => {},
      quitTimeoutMs: 0,
    });
    expect(stats.labeled).toBe(2);
    const labels = await readExistingLabels(outputPath);
    expect(labels.size).toBe(2);
    expect(labels.get('group-1:1001')?.goldAct).toBe('chime_in');
    expect(labels.get('group-1:1002')?.goldAct).toBe('direct_chat');
    const file = await fsp.readFile(outputPath, 'utf8');
    const lines = file.split('\n').filter(l => l.trim().length > 0);
    // No duplicate rows for sample 1
    const s1Count = lines.filter(l => l.includes('group-1:1001')).length;
    expect(s1Count).toBe(1);
  });

  it('TC-5 (session): malformed line is tolerated', async () => {
    const inputPath = path.join(tmp, 'in.jsonl');
    const outputPath = path.join(tmp, 'gold.jsonl');
    await writeJsonl(inputPath, [
      makeWeakLabeledLine(1),
      '{bad json',
      makeWeakLabeledLine(3),
    ]);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stats = await runSession({
      inputPath,
      outputPath,
      readKey: scriptedKeys(['r', '1', 'r', '1']),
      promptNotesLine: scriptedNotes([]),
      delay: async () => {},
      quitTimeoutMs: 0,
    });
    stderr.mockRestore();
    expect(stats.labeled).toBe(2);
    const labels = await readExistingLabels(outputPath);
    expect(labels.size).toBe(2);
  });

  it('TC-6: end of input — session returns stats with no error', async () => {
    const inputPath = path.join(tmp, 'in.jsonl');
    const outputPath = path.join(tmp, 'gold.jsonl');
    await writeJsonl(inputPath, [1, 2, 3].map(i => makeWeakLabeledLine(i)));
    const stats = await runSession({
      inputPath,
      outputPath,
      readKey: scriptedKeys(['r', '1', 'r', '1', 'r', '1']),
      promptNotesLine: scriptedNotes([]),
      delay: async () => {},
      quitTimeoutMs: 0,
    });
    expect(stats.labeled).toBe(3);
    expect(stats.skipped).toBe(0);
    expect(stats.totalPresented).toBe(3);
  });

  it('TC-9: edit on first sample with empty history is a no-op', async () => {
    const inputPath = path.join(tmp, 'in.jsonl');
    const outputPath = path.join(tmp, 'gold.jsonl');
    await writeJsonl(inputPath, [1, 2].map(i => makeWeakLabeledLine(i)));
    // sample 1: press e (no history), then r, 1 → commit
    // sample 2: r, 1 → commit
    const stats = await runSession({
      inputPath,
      outputPath,
      readKey: scriptedKeys(['e', 'r', '1', 'r', '1']),
      promptNotesLine: scriptedNotes([]),
      delay: async () => {},
      quitTimeoutMs: 0,
    });
    expect(stats.labeled).toBe(2);
  });

  it('TC-9 (direct): handleEdit with empty history returns false', async () => {
    const result = await handleEdit(
      [],
      new Map(),
      path.join(tmp, 'gold.jsonl'),
      scriptedKeys([]),
      scriptedNotes([]),
      () => new Date(),
      new Map(),
    );
    expect(result).toBe(false);
  });

  it('TC-10: --limit caps presentation', async () => {
    const inputPath = path.join(tmp, 'in.jsonl');
    const outputPath = path.join(tmp, 'gold.jsonl');
    await writeJsonl(inputPath, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => makeWeakLabeledLine(i)));
    const stats = await runSession({
      inputPath,
      outputPath,
      limit: 3,
      readKey: scriptedKeys(['r', '1', 'r', '1', 'r', '1']),
      promptNotesLine: scriptedNotes([]),
      delay: async () => {},
      quitTimeoutMs: 0,
    });
    expect(stats.totalPresented).toBe(3);
    expect(stats.labeled).toBe(3);
  });

  it('TC-11: empty notes input leaves state.notes undefined', async () => {
    const inputPath = path.join(tmp, 'in.jsonl');
    const outputPath = path.join(tmp, 'gold.jsonl');
    await writeJsonl(inputPath, [makeWeakLabeledLine(1)]);
    const stats = await runSession({
      inputPath,
      outputPath,
      readKey: scriptedKeys(['n', 'r', '1']),
      promptNotesLine: scriptedNotes(['']),
      delay: async () => {},
    });
    expect(stats.labeled).toBe(1);
    const labels = await readExistingLabels(outputPath);
    const first = [...labels.values()][0]!;
    expect(first.notes).toBeUndefined();
  });

  it('TC-12: notes >500 chars are truncated', async () => {
    const inputPath = path.join(tmp, 'in.jsonl');
    const outputPath = path.join(tmp, 'gold.jsonl');
    await writeJsonl(inputPath, [makeWeakLabeledLine(1)]);
    const long = 'x'.repeat(600);
    const stats = await runSession({
      inputPath,
      outputPath,
      readKey: scriptedKeys(['n', 'r', '1']),
      promptNotesLine: scriptedNotes([long]),
      delay: async () => {},
    });
    expect(stats.labeled).toBe(1);
    const labels = await readExistingLabels(outputPath);
    const first = [...labels.values()][0]!;
    expect(first.notes?.length).toBe(500);
  });
});
