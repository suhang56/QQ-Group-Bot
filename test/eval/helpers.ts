/**
 * Test helpers for R6.3 replay runner integration tests.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface ProdDbSnapshot {
  size: number;
  mtimeMs: number;
  sha256: string;
}

export function snapshotProdDb(prodDbPath: string): ProdDbSnapshot {
  const stat = fs.statSync(prodDbPath);
  const buf = fs.readFileSync(prodDbPath);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return { size: stat.size, mtimeMs: stat.mtimeMs, sha256 };
}

export function assertNoProdContamination(
  prodDbPath: string,
  before: ProdDbSnapshot,
): void {
  const after = snapshotProdDb(prodDbPath);
  if (after.sha256 !== before.sha256) {
    throw new Error(
      `prod DB sha256 changed: before=${before.sha256.slice(0, 16)}... after=${after.sha256.slice(0, 16)}...`,
    );
  }
  if (after.size !== before.size) {
    throw new Error(`prod DB size changed: before=${before.size} after=${after.size}`);
  }
}

export function assertNoWritesOutsideReplayDir(expectedOutputDir: string): void {
  const resolved = path.resolve(expectedOutputDir);
  if (!resolved.includes('eval') && !resolved.includes('replay')) {
    throw new Error(
      `expected output dir under data/eval/replay or similar; got ${resolved}`,
    );
  }
}
