/**
 * R6.2 gold-label CLI — JSONL reader.
 *
 * Streams R6.1c benchmark-weak-labeled.jsonl (WeakLabeledRow records), maps each
 * to a SampleRecord with the fields the renderer needs. Dedup by sampleId
 * (first wins). Malformed lines collected for startup warning, not thrown.
 */

import { createReadStream, promises as fsp } from 'node:fs';
import { createInterface } from 'node:readline';
import type { WeakReplayLabel, ContextMessage } from '../types.js';

export interface MessageRow {
  content: string;
  rawContent: string | null;
  user: string;
  ts: number;
}

export interface SampleRecord {
  sampleId: string;
  triggerContent: string;
  triggerRawContent: string | null;
  triggerUser: string;
  triggerTs: number;
  contextBefore: MessageRow[];
  contextAfter: MessageRow[];
  weakLabel: WeakReplayLabel;
  [extra: string]: unknown;
}

export interface ReaderDiagnostics {
  malformedLineNumbers: number[];
  duplicateSampleIds: string[];
}

const malformedLog: Map<string, number[]> = new Map();
const duplicateLog: Map<string, string[]> = new Map();

/**
 * Returns diagnostics collected during the most recent readSamples() run on a path.
 * Cleared per-path on each new readSamples invocation.
 */
export function getDiagnostics(filePath: string): ReaderDiagnostics {
  return {
    malformedLineNumbers: malformedLog.get(filePath) ?? [],
    duplicateSampleIds: duplicateLog.get(filePath) ?? [],
  };
}

function mapContextMessage(m: ContextMessage & { rawContent?: unknown; raw_content?: unknown }): MessageRow {
  const raw =
    typeof m.rawContent === 'string' && m.rawContent.length > 0
      ? m.rawContent
      : typeof m.raw_content === 'string' && m.raw_content.length > 0
        ? m.raw_content
        : null;
  return { content: m.content, rawContent: raw, user: m.nickname, ts: m.timestamp };
}

function coerceSampleRecord(obj: Record<string, unknown>): SampleRecord | null {
  const id = obj.id;
  const content = obj.content;
  const nickname = obj.nickname;
  const timestamp = obj.timestamp;
  const before = obj.triggerContext;
  const after = obj.triggerContextAfter;
  const label = obj.label;

  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof content !== 'string') return null;
  if (typeof nickname !== 'string') return null;
  if (typeof timestamp !== 'number') return null;
  if (!Array.isArray(before)) return null;
  if (!Array.isArray(after)) return null;
  if (typeof label !== 'object' || label === null) return null;

  const rawContent =
    typeof obj.rawContent === 'string' && obj.rawContent.length > 0
      ? obj.rawContent
      : typeof obj.raw_content === 'string' && obj.raw_content.length > 0
        ? obj.raw_content
        : null;

  const record: SampleRecord = {
    ...obj,
    sampleId: id,
    triggerContent: content,
    triggerRawContent: rawContent,
    triggerUser: nickname,
    triggerTs: timestamp,
    contextBefore: (before as ContextMessage[]).map(mapContextMessage),
    contextAfter: (after as ContextMessage[]).map(mapContextMessage),
    weakLabel: label as WeakReplayLabel,
  };
  return record;
}

export async function* readSamples(filePath: string): AsyncGenerator<SampleRecord> {
  malformedLog.set(filePath, []);
  duplicateLog.set(filePath, []);
  const malformed = malformedLog.get(filePath)!;
  const dupes = duplicateLog.get(filePath)!;
  const seen = new Set<string>();

  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let lineNo = 0;
  try {
    for await (const line of rl) {
      lineNo++;
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        malformed.push(lineNo);
        process.stderr.write(`[reader] malformed JSON at line ${lineNo} — skipped\n`);
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        malformed.push(lineNo);
        process.stderr.write(`[reader] non-object at line ${lineNo} — skipped\n`);
        continue;
      }
      const record = coerceSampleRecord(parsed as Record<string, unknown>);
      if (!record) {
        malformed.push(lineNo);
        process.stderr.write(`[reader] missing required field at line ${lineNo} — skipped\n`);
        continue;
      }
      if (seen.has(record.sampleId)) {
        dupes.push(record.sampleId);
        continue;
      }
      seen.add(record.sampleId);
      yield record;
    }
  } finally {
    rl.close();
    stream.close();
  }
}

export async function countSamples(filePath: string): Promise<number> {
  try {
    const data = await fsp.readFile(filePath, 'utf8');
    let count = 0;
    for (const line of data.split('\n')) {
      if (line.trim().length > 0) count++;
    }
    return count;
  } catch {
    return 0;
  }
}
