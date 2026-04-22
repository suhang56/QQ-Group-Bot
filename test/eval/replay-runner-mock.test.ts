import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runReplay } from '../../scripts/eval/replay-runner.js';
import type { ReplayerArgs } from '../../scripts/eval/replay-types.js';
import { buildSyntheticReplayDb } from '../../scripts/eval/build-synthetic-replay-db.js';
import { snapshotProdDb, assertNoProdContamination } from './helpers.js';

const REPO = path.resolve(__dirname, '../..');
const GOLD = path.join(REPO, 'test/fixtures/replay-gold-synthetic.jsonl');
const BENCH = path.join(REPO, 'test/fixtures/replay-benchmark-synthetic.jsonl');
const FIXTURE_DB = path.join(REPO, 'test/fixtures/replay-prod-db-synthetic.sqlite');

function makeArgs(outputDir: string, overrides: Partial<ReplayerArgs> = {}): ReplayerArgs {
  return {
    goldPath: GOLD,
    benchmarkPath: BENCH,
    outputDir,
    llmMode: 'mock',
    limit: null,
    prodDbPath: FIXTURE_DB,
    botQQ: '1705075399',
    groupIdForReplay: '958751334',
    perSampleTimeoutMs: 10_000,
    ...overrides,
  };
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `r6-3-${prefix}-`));
}

describe('replay-runner integration — mock mode', () => {
  beforeAll(() => {
    // Regenerate each run so tmp WAL state from prior runs doesn't leak.
    // Fixture is committed per DEV-READY §8.2; regen-on-load is idempotent.
    buildSyntheticReplayDb(FIXTURE_DB);
  });

  it('runs 2 synthetic rows → exit 0, 2 lines in replay-output.jsonl, summary.json written', async () => {
    const outDir = tmpDir('basic');
    const before = snapshotProdDb(FIXTURE_DB);
    const result = await runReplay(makeArgs(outDir));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBe(2);

    const outPath = path.join(outDir, 'replay-output.jsonl');
    const sumPath = path.join(outDir, 'summary.json');
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.existsSync(sumPath)).toBe(true);

    const lines = fs.readFileSync(outPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('sampleId');
      expect(parsed).toHaveProperty('resultKind');
      expect(parsed).toHaveProperty('violationTags');
      expect(JSON.stringify(parsed)).not.toContain('undefined');
    }

    const summary = JSON.parse(fs.readFileSync(sumPath, 'utf8'));
    expect(summary.silenceDeferCompliance.rate).toBeGreaterThanOrEqual(0);
    expect(summary.silenceDeferCompliance.rate).toBeLessThanOrEqual(1);
    // R2.5 added 4 guard-cause tags (repeated-low-info-direct-overreply,
    // self-amplified-annoyance, group-address-in-small-scene,
    // bot-not-addressee-replied). PR1 added 1 more: sticker-token-leak.
    // PR2 added 2: hard-gate-blocked + harassment-escalation.
    // PR4 added 2: persona-fabrication-blocked + persona-fabricated-in-output.
    // R2.5.1 added 2: self-centered-scope-claim + annoyed-template-consecutive.
    expect(Object.keys(summary.violationCounts).length).toBe(24);

    // Zero side effect: synthetic fixture sha256 must be unchanged.
    assertNoProdContamination(FIXTURE_DB, before);
  }, 30_000);

  it('--limit 0 → exit 0, empty jsonl, zero-row summary', async () => {
    const outDir = tmpDir('limit0');
    const result = await runReplay(makeArgs(outDir, { limit: 0 }));
    expect(result.exitCode).toBe(0);
    const outPath = path.join(outDir, 'replay-output.jsonl');
    expect(fs.existsSync(outPath)).toBe(true);
    const contents = fs.readFileSync(outPath, 'utf8');
    expect(contents).toBe('');
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
    expect(summary.totalRows).toBe(0);
    expect(summary.errorRows).toBe(0);
  }, 30_000);

  it('missing benchmark row → warn+skip, no crash', async () => {
    // Write a gold entry for a sampleId that the benchmark fixture does NOT contain.
    const orphanGold = tmpDir('orphan') + '/orphan-gold.jsonl';
    fs.writeFileSync(
      orphanGold,
      [
        JSON.stringify({
          sampleId: '958751334:9001',
          goldAct: 'silence', goldDecision: 'silent', targetOk: true,
          factNeeded: false, allowBanter: false, allowSticker: false,
          labeledAt: '2026-04-20T00:00:00Z',
        }),
        JSON.stringify({
          sampleId: '958751334:99999',  // does not exist in benchmark
          goldAct: 'direct_chat', goldDecision: 'reply', targetOk: true,
          factNeeded: false, allowBanter: true, allowSticker: false,
          labeledAt: '2026-04-20T00:00:00Z',
        }),
      ].join('\n'),
    );
    const outDir = tmpDir('orphan-out');
    const result = await runReplay(makeArgs(outDir, { goldPath: orphanGold }));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBe(1);
  }, 30_000);

  it('--llm-mode=real → exit 2 not implemented', async () => {
    const outDir = tmpDir('realmode');
    const result = await runReplay(makeArgs(outDir, { llmMode: 'real' }));
    expect(result.exitCode).toBe(2);
  });

  it('missing prod-db → exit 1', async () => {
    const outDir = tmpDir('no-db');
    const result = await runReplay(
      makeArgs(outDir, { prodDbPath: path.join(outDir, 'does-not-exist.sqlite') }),
    );
    expect(result.exitCode).toBe(1);
  });
});
