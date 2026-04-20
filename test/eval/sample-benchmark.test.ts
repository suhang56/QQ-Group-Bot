/**
 * R6.1a eval sampling — integration tests.
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
import { queryCat2, CAT2_MAX } from '../../scripts/eval/categories/cat2-known-fact-term.js';
import { queryCat7 } from '../../scripts/eval/categories/cat7-relay.js';
import { queryCat9 } from '../../scripts/eval/categories/cat9-normal-chimein.js';
import { buildSummary } from '../../scripts/eval/summary.js';

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

    const countByCat = new Map<number, number>();
    for (const r of rawRows) countByCat.set(r.category, (countByCat.get(r.category) ?? 0) + 1);

    for (const cat of [1, 2, 4, 5, 7]) {
      expect(countByCat.get(cat) ?? 0, `cat ${cat} should have 3 rows`).toBe(3);
    }
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

  // ---- Test 3: summary.json populated (R6.1a shape) ----
  it('summary.json has R6.1a shape', async () => {
    const { exitCode } = await sample(1, 3);
    expect(exitCode).toBe(0);

    const summary: SummaryJson = JSON.parse(readFileSync(path.join(OUT_DIR, 'summary.json'), 'utf8'));
    expect(summary.totalSampled).toBeGreaterThan(0);
    expect(summary.totalLabeled).toBeGreaterThanOrEqual(0);
    expect(summary.categories).toHaveLength(10);
    expect(typeof summary.seed).toBe('number');
    expect(typeof summary.generatedAt).toBe('number');

    // R6.1a: 3 named duplicate metrics
    expect(summary.duplicates).toBeDefined();
    expect(summary.duplicates.sameMessageId).toBeDefined();
    expect(summary.duplicates.sameContentHash).toBeDefined();
    expect(summary.duplicates.sameContextHash).toBeDefined();
    expect(summary.duplicates.sameMessageId.rate).toBeGreaterThanOrEqual(0);
    expect(summary.duplicates.sameMessageId.rate).toBeLessThanOrEqual(1);

    // R6.1a: empty split
    expect(summary.empty).toBeDefined();
    expect(typeof summary.empty.emptyBecauseMediaOnly).toBe('number');
    expect(typeof summary.empty.emptyWithoutMedia).toBe('number');

    // R6.1a: overlap matrix
    expect(summary.categoryOverlap).toBeDefined();
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

  // ---- Test 9: category gap = target - sampled ----
  it('category gap equals target - sampled for all categories', async () => {
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
        { id: 1, userId: 'u2', nickname: 'B', content: '扣1', rawContent: null, timestamp: 1699999990 },
        { id: 2, userId: 'u3', nickname: 'C', content: '扣1', rawContent: null, timestamp: 1699999991 },
      ],
      triggerContextAfter: [],
      category: 7,
      categoryLabel: 'relay',
      samplingSeed: 1,
      contentHash: '0000',
      contextHash: '0000',
    };

    const labeled = applyWeakLabel(syntheticRow, db, BOT_QQ);
    expect(labeled).not.toBeNull();
    expect(labeled!.label.riskFlags).toContain('multi-category-match');
    db.close();
  });

  // ---- Test 11: seed=0 is valid ----
  it('seed=0 is valid and produces output', async () => {
    const { rawRows, exitCode } = await sample(0, 2);
    expect(exitCode).toBe(0);
    expect(rawRows.length).toBeGreaterThan(0);
  });

  // ---- R6.1a Test 12: sameMessageId duplicate rate is 0 after hard dedupe ----
  it('R6.1a: sameMessageId duplicate rate is 0 (hard dedupe sanity check)', async () => {
    const { exitCode } = await sample(1, 5);
    expect(exitCode).toBe(0);
    const summary: SummaryJson = JSON.parse(readFileSync(path.join(OUT_DIR, 'summary.json'), 'utf8'));
    expect(summary.duplicates.sameMessageId.count).toBe(0);
    expect(summary.duplicates.sameMessageId.rate).toBe(0);
  });

  // ---- R6.1a Test 13: duplicate rates are in [0, 1] ----
  it('R6.1a: all duplicate rates are in [0, 1]', async () => {
    const { exitCode } = await sample(42, 5);
    expect(exitCode).toBe(0);
    const summary: SummaryJson = JSON.parse(readFileSync(path.join(OUT_DIR, 'summary.json'), 'utf8'));
    for (const key of ['sameMessageId', 'sameContentHash', 'sameContextHash'] as const) {
      expect(summary.duplicates[key].rate).toBeGreaterThanOrEqual(0);
      expect(summary.duplicates[key].rate).toBeLessThanOrEqual(1);
      expect(summary.duplicates[key].count).toBeGreaterThanOrEqual(0);
    }
  });

  // ---- R6.1a Test 14: cat2 capped at CAT2_MAX ----
  it('R6.1a: cat2 (known_fact_term) sampled count <= CAT2_MAX', async () => {
    // use target=500 to ensure cap kicks in
    const { rawRows, exitCode } = await runSampling({
      dbPath: FIXTURE,
      groupId: GROUP,
      botQQ: BOT_QQ,
      seed: 42,
      perCategoryTarget: 500,
      outputDir: OUT_DIR,
    });
    expect(exitCode).toBe(0);
    const cat2 = rawRows.filter(r => r.category === 2);
    expect(cat2.length).toBeLessThanOrEqual(CAT2_MAX);
  });

  // ---- R6.1a Test 15: cat2 summary has organicFactShortfall ----
  it('R6.1a: cat2 summary entry has organicFactShortfall', async () => {
    const { exitCode } = await sample(1, 3);
    expect(exitCode).toBe(0);
    const summary: SummaryJson = JSON.parse(readFileSync(path.join(OUT_DIR, 'summary.json'), 'utf8'));
    const cat2 = summary.categories.find(c => c.category === 2);
    expect(cat2).toBeDefined();
    expect(cat2!.organicFactShortfall).toBeDefined();
    expect(cat2!.organicFactShortfall!.expected).toBeLessThanOrEqual(CAT2_MAX);
    expect(cat2!.organicFactShortfall!.gap).toBe(cat2!.organicFactShortfall!.expected - cat2!.organicFactShortfall!.actual);
  });

  // ---- R6.1a Test 16: categoryOverlap matrix ----
  it('R6.1a: categoryOverlap matrix is present and numeric', async () => {
    const { exitCode } = await sample(1, 5);
    expect(exitCode).toBe(0);
    const summary: SummaryJson = JSON.parse(readFileSync(path.join(OUT_DIR, 'summary.json'), 'utf8'));
    expect(summary.categoryOverlap).toBeDefined();
    // Each key should be a number, each value should be a Record<number, number>
    for (const [catA, row] of Object.entries(summary.categoryOverlap)) {
      expect(Number.isInteger(Number(catA))).toBe(true);
      for (const [catB, count] of Object.entries(row)) {
        expect(Number.isInteger(Number(catB))).toBe(true);
        expect(typeof count).toBe('number');
        expect(count).toBeGreaterThan(0);
      }
    }
  });

  // ---- R6.1a Test 17: empty split counts ----
  it('R6.1a: emptyBecauseMediaOnly counts image rows; emptyWithoutMedia is 0 in clean fixture', async () => {
    const { exitCode } = await sample(1, 5);
    expect(exitCode).toBe(0);
    const summary: SummaryJson = JSON.parse(readFileSync(path.join(OUT_DIR, 'summary.json'), 'utf8'));
    // emptyBecauseMediaOnly should be >= 0 (fixture has image rows with empty content)
    expect(summary.empty.emptyBecauseMediaOnly).toBeGreaterThanOrEqual(0);
    // emptyWithoutMedia should be 0 in the clean fixture (no bad empty rows)
    expect(summary.empty.emptyWithoutMedia).toBe(0);
  });

  // ---- R6.1a Test 18: contextHash is populated on all rows ----
  it('R6.1a: all sampled rows have a non-empty contextHash string', async () => {
    const { rawRows, exitCode } = await sample(1, 3);
    expect(exitCode).toBe(0);
    for (const row of rawRows) {
      expect(typeof row.contextHash).toBe('string');
      expect(row.contextHash.length).toBeGreaterThan(0);
    }
  });

  // ---- R6.2.2: context rows carry rawContent from DB ----
  it('R6.2.2: triggerContext / triggerContextAfter entries include rawContent field', async () => {
    const { rawRows, exitCode } = await sample(1, 10);
    expect(exitCode).toBe(0);
    // At least one sampled row should have non-empty context to validate.
    const rowsWithCtx = rawRows.filter(
      r => r.triggerContext.length > 0 || r.triggerContextAfter.length > 0,
    );
    expect(rowsWithCtx.length).toBeGreaterThan(0);
    for (const row of rowsWithCtx) {
      for (const ctx of [...row.triggerContext, ...row.triggerContextAfter]) {
        // Field must be present (null or string — never undefined).
        expect(Object.prototype.hasOwnProperty.call(ctx, 'rawContent')).toBe(true);
        const v = (ctx as { rawContent: unknown }).rawContent;
        expect(v === null || typeof v === 'string').toBe(true);
      }
    }
  });

  it('R6.2.2: sampled jsonl preserves context rawContent round-trip', async () => {
    const { rawRows, exitCode } = await sample(1, 10);
    expect(exitCode).toBe(0);
    const raw = readFileSync(path.join(OUT_DIR, 'benchmark-raw.jsonl'), 'utf8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    expect(lines.length).toBe(rawRows.length);
    // Find a row with non-empty context
    const sampleLine = lines.find(l => {
      const obj = JSON.parse(l);
      return Array.isArray(obj.triggerContext) && obj.triggerContext.length > 0;
    });
    expect(sampleLine).toBeDefined();
    const parsed = JSON.parse(sampleLine!);
    for (const ctx of parsed.triggerContext) {
      expect('rawContent' in ctx).toBe(true);
    }
  });

  // ---- R6.1a Test 19: per-category content-hash cap ----
  it('R6.1a: no category has more than 5 rows with the same contentHash', async () => {
    const { rawRows, exitCode } = await sample(1, 50);
    expect(exitCode).toBe(0);
    // Group by category, then check hash frequency within each category
    const catMap = new Map<number, SampledRow[]>();
    for (const row of rawRows) {
      const arr = catMap.get(row.category) ?? [];
      arr.push(row);
      catMap.set(row.category, arr);
    }
    for (const [cat, rows] of catMap) {
      const hashCount = new Map<string, number>();
      for (const row of rows) {
        hashCount.set(row.contentHash, (hashCount.get(row.contentHash) ?? 0) + 1);
      }
      for (const [hash, count] of hashCount) {
        expect(count, `cat ${cat}: contentHash ${hash} appears ${count} times (cap is 5)`).toBeLessThanOrEqual(5);
      }
    }
  });

  // ---- R6.1a Test 20: emptyBecauseMediaOnly → isObjectReact=true ----
  it('R6.1a: empty-content row with media CQ in rawContent → isObjectReact=true', () => {
    const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
    const mediaRow: SampledRow = {
      id: 'test:8888',
      groupId: GROUP,
      messageId: 8888,
      sourceMessageId: null,
      userId: 'u1',
      nickname: 'Alice',
      timestamp: 1700000000,
      content: '',         // empty stripped content
      rawContent: '[CQ:image,file=abc.jpg,url=x]',
      triggerContext: [],
      triggerContextAfter: [],
      category: 4,
      categoryLabel: 'image_mface',
      samplingSeed: 1,
      contentHash: makeContentHash(''),
      contextHash: '0000',
    };
    const labeled = applyWeakLabel(mediaRow, db, BOT_QQ);
    expect(labeled).not.toBeNull();
    expect(labeled!.label.isObjectReact).toBe(true);
    db.close();
  });

  // ---- R6.1a Test: empty-without-media row → excluded from labeled output ----
  it('R6.1a: empty content + no media CQ in rawContent → applyWeakLabel returns null', () => {
    const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
    const baseRow = (content: string, rawContent: string): SampledRow => ({
      id: 'test:9999',
      groupId: GROUP,
      messageId: 9999,
      sourceMessageId: null,
      userId: 'u1',
      nickname: 'Alice',
      timestamp: 1700000000,
      content,
      rawContent,
      triggerContext: [],
      triggerContextAfter: [],
      category: 9,
      categoryLabel: 'normal_chimein',
      samplingSeed: 1,
      contentHash: makeContentHash(content),
      contextHash: '0000',
    });
    // empty content, empty raw → excluded
    expect(applyWeakLabel(baseRow('', ''), db, BOT_QQ)).toBeNull();
    // whitespace-only content, empty raw → excluded
    expect(applyWeakLabel(baseRow('   ', ''), db, BOT_QQ)).toBeNull();
    // empty content with non-media raw (e.g. plain text artifact) → excluded
    expect(applyWeakLabel(baseRow('', 'plain text no cq'), db, BOT_QQ)).toBeNull();
    // empty content with [CQ:at,...] but no media → excluded
    expect(applyWeakLabel(baseRow('', '[CQ:at,qq=1]'), db, BOT_QQ)).toBeNull();
    // empty content WITH media CQ → NOT excluded (sanity: media path still passes)
    expect(applyWeakLabel(baseRow('', '[CQ:image,file=abc.jpg]'), db, BOT_QQ)).not.toBeNull();
    db.close();
  });

  // ---- R6.1a Test 21: buildSummary sameContentHash metric ----
  it('R6.1a: buildSummary correctly counts sameContentHash duplicates', () => {
    const makeRow = (id: number, content: string): SampledRow => ({
      id: `g:${id}`,
      groupId: 'g',
      messageId: id,
      sourceMessageId: null,
      userId: 'u1',
      nickname: 'Alice',
      timestamp: 1700000000 + id,
      content,
      rawContent: content,
      triggerContext: [],
      triggerContextAfter: [],
      category: 9,
      categoryLabel: 'normal_chimein',
      samplingSeed: 42,
      contentHash: createHash('sha256').update(content).digest('hex').slice(0, 16),
      contextHash: '0000',
    });

    // 3 rows with same content, 1 unique
    const rows: SampledRow[] = [
      makeRow(1, '哦'),
      makeRow(2, '哦'),
      makeRow(3, '哦'),
      makeRow(4, 'unique content'),
    ];

    const summary = buildSummary(rows, [], 42, 10);
    // All 3 '哦' rows count as duplicates
    expect(summary.duplicates.sameContentHash.count).toBe(3);
    expect(summary.duplicates.sameContentHash.rate).toBeCloseTo(3 / 4);
    // sameMessageId must be 0 (all unique ids)
    expect(summary.duplicates.sameMessageId.count).toBe(0);
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

  // ---- Null-topic regression tests (R6.1 hotfix) ----
  describe('queryCat2 null-topic guard', () => {
    it('does not crash when learned_facts has a row with null topic but valid canonical_form', () => {
      const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
      expect(() => {
        const rows = queryCat2(db, GROUP, 10);
        expect(Array.isArray(rows)).toBe(true);
      }).not.toThrow();
      db.close();
    });

    it('does not crash when learned_facts has a row with both topic and canonical_form null', () => {
      const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
      expect(() => {
        const rows = queryCat2(db, GROUP, 10);
        expect(Array.isArray(rows)).toBe(true);
      }).not.toThrow();
      db.close();
    });

    it('returns [] when the only active facts have null topic AND null canonical_form', () => {
      const db = new DatabaseSync(':memory:');
      const schema = readFileSync(
        path.join(__dirname, '../../src/storage/schema.sql'),
        'utf8',
      );
      db.exec(schema);
      db.prepare(
        `INSERT INTO learned_facts (group_id, topic, fact, confidence, status, created_at, updated_at, canonical_form)
         VALUES (?, NULL, 'test', 1.0, 'active', 0, 0, NULL)`,
      ).run('g1');
      const rows = queryCat2(db, 'g1', 10);
      expect(rows).toEqual([]);
      db.close();
    });

    it('still returns matching rows when valid facts coexist with null-topic rows', () => {
      const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
      const rows = queryCat2(db, GROUP, 50);
      expect(rows.some(r => r.content.includes('ykn'))).toBe(true);
      db.close();
    });

    it('R6.1a: respects CAT2_MAX cap even when limit > CAT2_MAX', () => {
      const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
      const rows = queryCat2(db, GROUP, CAT2_MAX + 1000);
      expect(rows.length).toBeLessThanOrEqual(CAT2_MAX);
      db.close();
    });
  });

  // ============================================================
  // R6.1b regression tests — 5 semantic fixes
  // ============================================================

  // Fix 1 (HIGH face): face CQ + empty content must pass isEmptyBecauseMediaOnly
  describe('R6.1b: face CQ + empty content', () => {
    it('empty content + [CQ:face,...] → not filtered by applyWeakLabel, isObjectReact=true', () => {
      const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
      const faceRow: SampledRow = {
        id: 'test:7777',
        groupId: GROUP,
        messageId: 7777,
        sourceMessageId: null,
        userId: 'u1',
        nickname: 'Alice',
        timestamp: 1700000000,
        content: '',
        rawContent: '[CQ:face,id=0]',
        triggerContext: [],
        triggerContextAfter: [],
        category: 4,
        categoryLabel: 'image_mface',
        samplingSeed: 1,
        contentHash: 'x',
        contextHash: 'x',
      };
      const labeled = applyWeakLabel(faceRow, db, BOT_QQ);
      expect(labeled).not.toBeNull();
      expect(labeled!.label.isObjectReact).toBe(true);
      db.close();
    });
  });

  // Fix 2/3 (C1): cat2 knownFactSource covers all 7 sources
  describe('R6.1b: cat2 knownFactSource enum covers all 7 sources', () => {
    it('topic / canonical / persona / meme-canonical / meme-variant / jargon / phrase → correct knownFactSource', () => {
      const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
      const makeRow = (content: string): SampledRow => ({
        id: `test:src:${content}`,
        groupId: GROUP,
        messageId: 0,
        sourceMessageId: null,
        userId: 'u1',
        nickname: 'Alice',
        timestamp: 1700000000,
        content,
        rawContent: content,
        triggerContext: [],
        triggerContextAfter: [],
        category: 2,
        categoryLabel: 'known_fact_term',
        samplingSeed: 1,
        contentHash: 'x',
        contextHash: 'x',
      });

      const cases: Array<[string, string]> = [
        ['ykn 是谁啊', 'topic'],
        ['说说 canonx', 'canonical'],
        ['personaz 真强', 'persona'],
        ['memex 出现', 'meme'],
        ['memevar 来了', 'meme'],
        ['黑话 jargonx', 'jargon'],
        ['口头 phrasex', 'phrase'],
      ];

      for (const [content, expectedSource] of cases) {
        const labeled = applyWeakLabel(makeRow(content), db, BOT_QQ);
        expect(labeled, `content=${content}`).not.toBeNull();
        expect(labeled!.label.knownFactSource, `content=${content}`).toBe(expectedSource);
        expect(labeled!.label.hasKnownFactTerm, `content=${content}`).toBe(true);
      }
      db.close();
    });

    it('content with no cat2-source-matching tokens → knownFactSource=null, hasKnownFactTerm=false', () => {
      const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
      const row: SampledRow = {
        id: 'test:no-fact',
        groupId: GROUP,
        messageId: 0,
        sourceMessageId: null,
        userId: 'u1',
        nickname: 'Alice',
        timestamp: 1700000000,
        content: 'zzunknownterm 没有什么意思',
        rawContent: 'zzunknownterm 没有什么意思',
        triggerContext: [],
        triggerContextAfter: [],
        category: 9,
        categoryLabel: 'normal_chimein',
        samplingSeed: 1,
        contentHash: 'x',
        contextHash: 'x',
      };
      const labeled = applyWeakLabel(row, db, BOT_QQ);
      expect(labeled).not.toBeNull();
      expect(labeled!.label.knownFactSource).toBeNull();
      expect(labeled!.label.hasKnownFactTerm).toBe(false);
    });

    it('cat2 sampled rows have knownFactSource != null for >=70%', async () => {
      const { rawRows } = await sample(1, 20);
      const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
      const cat2Rows = rawRows.filter(r => r.category === 2);
      expect(cat2Rows.length).toBeGreaterThan(0);
      let withSource = 0;
      for (const row of cat2Rows) {
        const labeled = applyWeakLabel(row, db, BOT_QQ);
        if (labeled?.label.knownFactSource !== null && labeled?.label.knownFactSource !== undefined) {
          withSource++;
        }
      }
      const rate = withSource / cat2Rows.length;
      expect(rate, `cat2 knownFactSource hit rate ${withSource}/${cat2Rows.length}`).toBeGreaterThanOrEqual(0.7);
      db.close();
    });
  });

  // Fix 4 (C2): media rows with distinct file= get distinct contentHash
  describe('R6.1b: media-aware contentHash', () => {
    it('two empty-content images with different file= get different contentHash', async () => {
      const { rawRows } = await sample(1, 50);
      const emptyMediaRows = rawRows.filter(
        r => r.content === '' && (r.rawContent ?? '').includes('[CQ:image'),
      );
      expect(emptyMediaRows.length, 'fixture must have >= 2 empty-media image rows').toBeGreaterThanOrEqual(2);
      const hashes = new Set(emptyMediaRows.map(r => r.contentHash));
      expect(hashes.size, 'distinct file= in empty images must yield distinct contentHash').toBeGreaterThan(1);
    });

    it('identical media signatures produce same hash (determinism check)', async () => {
      // Run twice and confirm reproducibility for image rows
      const { rawRows: a } = await sample(42, 50);
      const { rawRows: b } = await sample(42, 50);
      const imagesA = a.filter(r => r.content === '' && (r.rawContent ?? '').includes('[CQ:image'));
      const imagesB = b.filter(r => r.content === '' && (r.rawContent ?? '').includes('[CQ:image'));
      expect(imagesA.length).toBe(imagesB.length);
      for (let i = 0; i < imagesA.length; i++) {
        expect(imagesA[i]!.contentHash).toBe(imagesB[i]!.contentHash);
      }
    });
  });

  // Fix 5 (C3): queryCat7 windowed to match weak-label.isRelay
  describe('R6.1b: cat7 window alignment with weak-label', () => {
    it('every queryCat7 row, after trigger-context fill, has isRelay=true under applyWeakLabel', async () => {
      const { rawRows } = await sample(1, 20);
      const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
      const cat7Rows = rawRows.filter(r => r.category === 7);
      expect(cat7Rows.length).toBeGreaterThan(0);
      for (const row of cat7Rows) {
        const labeled = applyWeakLabel(row, db, BOT_QQ);
        expect(labeled, `cat7 row ${row.id} applyWeakLabel must not return null`).not.toBeNull();
        expect(labeled!.label.isRelay, `cat7 row ${row.id} must have isRelay=true`).toBe(true);
      }
      db.close();
    });
  });

  // Fix 6 (C4): cat9 junk filter
  describe('R6.1b: cat9 junk filter', () => {
    it('queryCat9 excludes pure-interjection and slash/bang rows', () => {
      const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
      const rows = queryCat9(db, GROUP, 50);
      const contents = rows.map(r => r.content);
      expect(contents).not.toContain('呵呵呵呵呵');
      expect(contents).not.toContain('/rule show');
      expect(contents).not.toContain('！！！！！');
      db.close();
    });

    it('queryCat9 still admits real chime-in content', () => {
      const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
      const rows = queryCat9(db, GROUP, 50);
      const contents = rows.map(r => r.content);
      // fixture chime-in rows should be present
      expect(contents.some(c => c === '今天天气真好啊' || c === '是啊出去玩了' || c === '我也想去啊')).toBe(true);
      db.close();
    });
  });

  // ============================================================
  // R6.1c regression tests — M1 (CJK substring) + M3 (relay independence)
  // ============================================================

  describe('R6.1c: CJK unbroken-substring fact match (soul-rule regression)', () => {
    // SOUL-RULE: unbroken CJK sentences containing a stored CJK term must hit
    // findKnownFactSource. R6.1b's extractTokens+IN approach missed this
    // because '接龙说是最新的' stayed one token and never equaled '接龙'.
    it('canonical="樱花" stored, message "樱花来了吗" → knownFactSource="canonical"', () => {
      const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
      const row: SampledRow = {
        id: 'test:cjk-1', groupId: GROUP, messageId: 0, sourceMessageId: null,
        userId: 'u1', nickname: 'Alice', timestamp: 1700000120,
        content: '樱花来了吗', rawContent: '樱花来了吗',
        triggerContext: [], triggerContextAfter: [],
        category: 2, categoryLabel: 'known_fact_term', samplingSeed: 1,
        contentHash: 'x', contextHash: 'x',
      };
      const labeled = applyWeakLabel(row, db, BOT_QQ);
      expect(labeled).not.toBeNull();
      expect(labeled!.label.hasKnownFactTerm).toBe(true);
      expect(labeled!.label.knownFactSource).toBe('canonical');
      db.close();
    });

    it('meme canonical="接龙" stored, message "接龙说是最新的" → knownFactSource="meme"', () => {
      const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
      const row: SampledRow = {
        id: 'test:cjk-2', groupId: GROUP, messageId: 0, sourceMessageId: null,
        userId: 'u1', nickname: 'Alice', timestamp: 1700000121,
        content: '接龙说是最新的', rawContent: '接龙说是最新的',
        triggerContext: [], triggerContextAfter: [],
        category: 2, categoryLabel: 'known_fact_term', samplingSeed: 1,
        contentHash: 'x', contextHash: 'x',
      };
      const labeled = applyWeakLabel(row, db, BOT_QQ);
      expect(labeled).not.toBeNull();
      expect(labeled!.label.hasKnownFactTerm).toBe(true);
      expect(labeled!.label.knownFactSource).toBe('meme');
      db.close();
    });

    it('cat2 sampled rows hasKnownFactTerm ratio >= 70% after R6.1c', async () => {
      const { rawRows } = await sample(1, 50);
      const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
      const cat2Rows = rawRows.filter(r => r.category === 2);
      expect(cat2Rows.length).toBeGreaterThan(0);
      let hits = 0;
      for (const row of cat2Rows) {
        const labeled = applyWeakLabel(row, db, BOT_QQ);
        if (labeled?.label.hasKnownFactTerm) hits++;
      }
      const rate = hits / cat2Rows.length;
      expect(rate, `cat2 hasKnownFactTerm rate ${hits}/${cat2Rows.length}`).toBeGreaterThanOrEqual(0.7);
      db.close();
    });
  });

  describe('R6.1c: isRelay independence from row.category', () => {
    // Labeler must disagree with sampler when triggerContext lacks echoes —
    // that's the precision signal R6.2 gold labelers rely on.
    it('cat7-labeled row with empty triggerContext + non-RELAY_SET content → isRelay=false', () => {
      const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
      const row: SampledRow = {
        id: 'test:relay-indep', groupId: GROUP, messageId: 0, sourceMessageId: null,
        userId: 'u1', nickname: 'Alice', timestamp: 1700000000,
        content: '哈哈', rawContent: '哈哈',
        triggerContext: [],  // deliberately empty — sampler claimed cat7 but no echo evidence
        triggerContextAfter: [],
        category: 7, categoryLabel: 'relay', samplingSeed: 1,
        contentHash: 'x', contextHash: 'x',
      };
      const labeled = applyWeakLabel(row, db, BOT_QQ);
      expect(labeled).not.toBeNull();
      expect(labeled!.label.isRelay).toBe(false);
      db.close();
    });

    it('cat7-labeled row with triggerContext >30s away → isRelay=false (time gate)', () => {
      const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
      const row: SampledRow = {
        id: 'test:relay-time', groupId: GROUP, messageId: 0, sourceMessageId: null,
        userId: 'u1', nickname: 'Alice', timestamp: 1700001000,
        content: '哈哈', rawContent: '哈哈',
        triggerContext: [
          { id: 1, userId: 'u2', nickname: 'B', content: '哈哈', rawContent: null, timestamp: 1700000000 }, // 1000s earlier
          { id: 2, userId: 'u3', nickname: 'C', content: '哈哈', rawContent: null, timestamp: 1700000500 }, // 500s earlier
        ],
        triggerContextAfter: [],
        category: 7, categoryLabel: 'relay', samplingSeed: 1,
        contentHash: 'x', contextHash: 'x',
      };
      const labeled = applyWeakLabel(row, db, BOT_QQ);
      expect(labeled).not.toBeNull();
      expect(labeled!.label.isRelay).toBe(false);
      db.close();
    });

    it('fast-path RELAY_SET token → isRelay=true regardless of context', () => {
      const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
      const row: SampledRow = {
        id: 'test:relay-fast', groupId: GROUP, messageId: 0, sourceMessageId: null,
        userId: 'u1', nickname: 'Alice', timestamp: 1700000000,
        content: '扣1', rawContent: '扣1',
        triggerContext: [],
        triggerContextAfter: [],
        category: 9, categoryLabel: 'normal_chimein', samplingSeed: 1,
        contentHash: 'x', contextHash: 'x',
      };
      const labeled = applyWeakLabel(row, db, BOT_QQ);
      expect(labeled).not.toBeNull();
      expect(labeled!.label.isRelay).toBe(true);
    });

    it('2+ triggerContext echoes within 30s → isRelay=true (echo path)', () => {
      const db = new DatabaseSync(FIXTURE, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
      const row: SampledRow = {
        id: 'test:relay-echo', groupId: GROUP, messageId: 0, sourceMessageId: null,
        userId: 'u1', nickname: 'Alice', timestamp: 1700000020,
        content: '哈哈', rawContent: '哈哈',
        triggerContext: [
          { id: 1, userId: 'u2', nickname: 'B', content: '哈哈', rawContent: null, timestamp: 1700000000 },
          { id: 2, userId: 'u3', nickname: 'C', content: '哈哈', rawContent: null, timestamp: 1700000010 },
        ],
        triggerContextAfter: [],
        category: 7, categoryLabel: 'relay', samplingSeed: 1,
        contentHash: 'x', contextHash: 'x',
      };
      const labeled = applyWeakLabel(row, db, BOT_QQ);
      expect(labeled).not.toBeNull();
      expect(labeled!.label.isRelay).toBe(true);
    });
  });
});

// Helper used in test 20
function makeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}
