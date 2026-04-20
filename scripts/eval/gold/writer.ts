/**
 * R6.2 gold-label CLI — JSONL writer.
 *
 * Append path is O(1); update-by-sampleId path is O(n) read + atomic rename.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { validateGoldLabel, type GoldLabel } from './types.js';

function serializeLabel(label: GoldLabel): string {
  const out: Record<string, unknown> = {
    sampleId: label.sampleId,
    goldAct: label.goldAct,
    goldDecision: label.goldDecision,
    targetOk: label.targetOk,
    factNeeded: label.factNeeded,
    allowBanter: label.allowBanter,
    allowSticker: label.allowSticker,
    labeledAt: label.labeledAt,
  };
  if (typeof label.notes === 'string' && label.notes.length > 0) {
    out.notes = label.notes;
  }
  return JSON.stringify(out);
}

async function ensureDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
}

export async function appendLabel(outputPath: string, label: GoldLabel): Promise<void> {
  await ensureDir(outputPath);
  await fsp.appendFile(outputPath, serializeLabel(label) + '\n', 'utf8');
}

export async function readExistingLabels(outputPath: string): Promise<Map<string, GoldLabel>> {
  const map = new Map<string, GoldLabel>();
  let data: string;
  try {
    data = await fsp.readFile(outputPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return map;
    throw err;
  }
  let lineNo = 0;
  for (const rawLine of data.split('\n')) {
    lineNo++;
    const line = rawLine.trim();
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      const label = validateGoldLabel(parsed);
      map.set(label.sampleId, label);
    } catch (err) {
      process.stderr.write(`[writer] skipping malformed line ${lineNo} in ${outputPath}: ${(err as Error).message}\n`);
    }
  }
  return map;
}

export async function updateLabel(outputPath: string, label: GoldLabel): Promise<void> {
  await ensureDir(outputPath);

  let existing = '';
  try {
    existing = await fsp.readFile(outputPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const updated: string[] = [];
  let replaced = false;
  for (const rawLine of existing.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>).sampleId === label.sampleId) {
        updated.push(serializeLabel(label));
        replaced = true;
      } else {
        updated.push(line);
      }
    } catch {
      process.stderr.write(`[writer] preserving non-JSON line during update\n`);
      updated.push(line);
    }
  }
  if (!replaced) {
    updated.push(serializeLabel(label));
  }

  const body = updated.join('\n') + '\n';
  const tmpPath = `${outputPath}.tmp`;
  await fsp.writeFile(tmpPath, body, 'utf8');
  await fsp.rename(tmpPath, outputPath);
}
