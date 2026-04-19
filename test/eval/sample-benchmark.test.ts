/**
 * R6.1 eval sampling — integration tests.
 *
 * File named sample-benchmark.test.ts so vitest picks it up
 * (vitest.config.ts excludes *.integration.test.ts).
 *
 * Uses test/fixtures/eval-sample.sqlite — synthetic committed fixture.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SampledRow, WeakLabeledRow, SummaryJson } from '../../scripts/eval/types.js';
import { runSampling } from '../../scripts/eval/sample-benchmark.js';
import { seededRand, seededSample } from '../../scripts/eval/seed.js';
import { applyWeakLabel } from '../../scripts/eval/weak-label.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '../fixtures/eval-sample.sqlite');
const OUT_DIR = path.join(__dirname, '../fixtures/_eval-out-tmp');
const GROUP = 'test-group-001';
const BOT_QQ = '12345';

beforeAll(() => {
  expect(existsSync(FIXTURE), `Missing fixture — run: npx tsx test/fixtures/create-eval-fixture.ts`).toBe(true);
});

afterAll(() => {
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
});

// ---- Helper: run sampling against fixture ----
async function sample(seed: number, target: number) {
  return runSampling({
    dbPath: FIXTURE,
    groupId: GROUP,
    botQQ: BOT_QQ,
    seed,
    perCategoryTarget: target,
    outputDir: OUT_DIR,
  });
}

// ---- Test 1: per-category counts ----
describe('sample-benchmark integration', () => {
  it('produces correct per-category counts (target=3)', async () => {
    const { rawRows, exitCode } = await sample(1, 3);
    expect(exitCode).toBe(0);
    expect(rawRows.length).toBeGreaterThan(0);

    // Categories with >=3 fixture rows should hit target
    const countByCat = new Map<number, number>();
    for (const r of rawRows) countByCat.set(r.category, (countByCat.get(r.category) ?? 0) + 1);

    // Cat 1,2,3,4,5,7 all have 3+ exclusive rows in fixture
    for (const cat of [1, 2, 4, 5, 7]) {
      expect(countByCat.get(cat) ?? 0, `cat ${cat} should have 3 rows`).toBe(3);
    }
    // Cat 8 has 3 fixture rows but one overlaps with cat10 (length <=4), so >=2
    expect(countByCat.get(8) ?? 0, 'cat 8 should have at least 2 rows').toBeGreaterThanOrEqual(2);
  });

  // ---- Test 2: deterministic ----
  it('is deterministic: same seed → same output hash', async () => {
    const { rawRows: rows1 } = await sample(42, 3);
    const { rawRows: rows2 } = await sample(42, 3);

    const hash1 = createHash('sha256')
      .update(rows1.map(r => r.id).join(','))
      .digest('hex');
    const hash2 = createHash('sha256')
      .update(rows2.map(r => r.id).join(','))
      .digest('hex');

    expect(hash1).toBe(hash2);
  });

  // ---- Test 3: summary.json populated ----
  it('summary.json is populated', async () => {
    const { exitCode } = await sample(1, 3);
    expect(exitCode).toBe(0);

    const summary: SummaryJson = JSON.parse(readFileSync(path.join(OUT_DIR, 'summary.json'), 'utf8'));
    expect(summary.totalSampled).toBeGreaterThan(0);
    expect(summary.categories).toHaveLength(10);
    expect(summary.duplicateRate).toBeGreaterThanOrEqual(0);
    expect(summary.duplicateRate).toBeLessThanOrEqual(1);
    expect(typeof summary.seed).toBe('number');
    expect(typeof summary.generatedAt).toBe('number');
  });

  // ---- Test 4: WeakReplayLabel for cat1 ----
  it('WeakReplayLabel fields correct for cat1 (direct @bot)', async () => {
    const { rawRows } = await sample(1, 3);
    const cat1 = rawRows.filter(r => r.category === 1);
    expect(cat1.length).toBeGreaterThan(0);

    const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
    for (const row of cat1) {
      const labeled = applyWeakLabel(row, db, BOT_QQ);
      expect(labeled).not.toBeNull();
      expect(labeled!.label.isDirect).toBe(true);
      expect(labeled!.label.expectedAct).toBe('direct_chat');
      expect(labeled!.label.expectedDecision).toBe('reply');
    }
    db.close();
  });

  // ---- Test 5: WeakReplayLabel for cat7 relay ----
  it('WeakReplayLabel fields correct for cat7 (relay)', async () => {
    const { rawRows } = await sample(1, 3);
    const cat7 = rawRows.filter(r => r.category === 7);
    expect(cat7.length).toBeGreaterThan(0);

    const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
    for (const row of cat7) {
      const labeled = applyWeakLabel(row, db, BOT_QQ);
      expect(labeled).not.toBeNull();
      expect(labeled!.label.isRelay).toBe(true);
      expect(labeled!.label.expectedAct).toBe('relay');
      expect(labeled!.label.expectedDecision).toBe('reply');
    }
    db.close();
  });

  // ---- Test 6: hasRealFactHit === hasKnownFactTerm ----
  it('hasRealFactHit equals hasKnownFactTerm for all rows (R6.1 scope)', async () => {
    const { rawRows } = await sample(1, 3);
    const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
    for (const row of rawRows) {
      const labeled = applyWeakLabel(row, db, BOT_QQ);
      if (!labeled) continue;
      expect(labeled.label.hasRealFactHit).toBe(labeled.label.hasKnownFactTerm);
    }
    db.close();
  });

  // ---- Test 7: admin command rows excluded ----
  it('admin command rows are excluded from labeled output', async () => {
    const { rawRows } = await sample(1, 5);
    const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);

    // The fixture has a '/rule_add ...' message; it should be filtered from labeled output
    const allLabeled = rawRows
      .map(r => applyWeakLabel(r, db, BOT_QQ))
      .filter(Boolean);

    for (const row of allLabeled) {
      expect(row!.content.trimStart().startsWith('/')).toBe(false);
    }
    db.close();
  });

  // ---- Test 8: empty DB → exit code 2 ----
  it('empty fixture DB → exitCode=2, no output files written', async () => {
    const emptyDb = path.join(__dirname, '../fixtures/_empty-eval.sqlite');
    const emptyOut = path.join(__dirname, '../fixtures/_empty-eval-out');
    try {
      // Create a minimal valid DB with schema but no rows
      const db = new DatabaseSync(emptyDb);
      const schema = readFileSync(path.join(__dirname, '../../src/storage/schema.sql'), 'utf8');
      db.exec(schema);
      db.close();

      const { exitCode } = await runSampling({
        dbPath: emptyDb,
        groupId: 'nonexistent-group',
        botQQ: BOT_QQ,
        seed: 1,
        perCategoryTarget: 3,
        outputDir: emptyOut,
      });
      expect(exitCode).toBe(2);
      expect(existsSync(path.join(emptyOut, 'benchmark-raw.jsonl'))).toBe(false);
    } finally {
      if (existsSync(emptyDb)) rmSync(emptyDb);
      if (existsSync(emptyOut)) rmSync(emptyOut, { recursive: true, force: true });
    }
  });

  // ---- Test 9: category with 0 qualifying rows in summary ----
  it('category with 0 qualifying rows → sampled:0, gap=target in summary', async () => {
    const { exitCode } = await sample(1, 3);
    expect(exitCode).toBe(0);
    const summary: SummaryJson = JSON.parse(readFileSync(path.join(OUT_DIR, 'summary.json'), 'utf8'));
    for (const c of summary.categories) {
      expect(c.gap).toBe(c.target - c.sampled);
      expect(c.sampled).toBeGreaterThanOrEqual(0);
    }
  });

  // ---- Test 10: multi-category-match risk flag ----
  it('row matching 2+ predicates has multi-category-match in riskFlags', async () => {
    const { rawRows } = await sample(1, 5);
    const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);

    // cat5 bot-status rows that also mention '@bot' would hit both cat1+cat5
    // Manually craft a row that matches relay + conflict
    const syntheticRow: SampledRow = {
      id: 'test:9999',
      groupId: GROUP,
      messageId: 9999,
      sourceMessageId: null,
      userId: 'u1',
      nickname: 'Alice',
      timestamp: 1700000000,
      content: '扣1',
      rawContent: `[CQ:at,qq=${BOT_QQ}]扣1`,
      triggerContext: [
        { id: 1, userId: 'u2', nickname: 'B', content: '扣1', timestamp: 1699999990 },
        { id: 2, userId: 'u3', nickname: 'C', content: '扣1', timestamp: 1699999991 },
      ],
      triggerContextAfter: [],
      category: 7,
      categoryLabel: 'relay',
      samplingSeed: 1,
      contentHash: '0000',
    };

    const labeled = applyWeakLabel(syntheticRow, db, BOT_QQ);
    expect(labeled).not.toBeNull();
    // isDirect is true (has @bot), isRelay is true → multi-category-match
    expect(labeled!.label.riskFlags).toContain('multi-category-match');
    db.close();
  });

  // ---- Test 11: seed=0 is valid ----
  it('seed=0 is valid and produces output', async () => {
    const { rawRows, exitCode } = await sample(0, 2);
    expect(exitCode).toBe(0);
    expect(rawRows.length).toBeGreaterThan(0);
  });

  // ---- Seed unit tests ----
  describe('seededRand', () => {
    it('always returns value in [0, 1)', () => {
      for (const id of [0, 1, 999, 99999, -1]) {
        const r = seededRand(42, id);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThan(1);
      }
    });

    it('same seed+id is deterministic', () => {
      expect(seededRand(42, 100)).toBe(seededRand(42, 100));
    });

    it('different ids produce different values', () => {
      expect(seededRand(42, 1)).not.toBe(seededRand(42, 2));
    });

    it('seed=0 is valid (not treated as falsy)', () => {
      const r = seededRand(0, 1);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
    });
  });

  describe('seededSample', () => {
    it('returns at most target items', () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({ messageId: i, val: i }));
      expect(seededSample(rows, 42, 5)).toHaveLength(5);
    });

    it('returns all items when target >= length', () => {
      const rows = Array.from({ length: 3 }, (_, i) => ({ messageId: i, val: i }));
      expect(seededSample(rows, 42, 10)).toHaveLength(3);
    });

    it('is deterministic', () => {
      const rows = Array.from({ length: 20 }, (_, i) => ({ messageId: i, val: i }));
      const a = seededSample(rows, 42, 5).map(r => r.messageId);
      const b = seededSample(rows, 42, 5).map(r => r.messageId);
      expect(a).toEqual(b);
    });

    it('different seeds produce different order', () => {
      const rows = Array.from({ length: 20 }, (_, i) => ({ messageId: i, val: i }));
      const a = seededSample(rows, 1, 10).map(r => r.messageId);
      const b = seededSample(rows, 2, 10).map(r => r.messageId);
      expect(a).not.toEqual(b);
    });

    it('seed=0 produces valid sample', () => {
      const rows = Array.from({ length: 5 }, (_, i) => ({ messageId: i, val: i }));
      expect(seededSample(rows, 0, 3)).toHaveLength(3);
    });
  });
});
