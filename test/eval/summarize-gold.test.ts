/**
 * R6.2.3 summarize-gold tests.
 *
 * Pure-function tests use in-memory fixtures; loader/integration tests write
 * tmp JSONL files and clean up in afterEach.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { WeakReplayLabel, ExpectedAct } from '../../scripts/eval/types.js';
import type { SampleRecord } from '../../scripts/eval/gold/reader.js';
import type { GoldLabel, GoldAct, GoldDecision } from '../../scripts/eval/gold/types.js';
import {
  loadGold,
  join,
  makeSnippet,
  renderDistributions,
  renderCoverage,
  renderDisagreement,
  renderSuspicious,
  sortDisagreementRows,
  isBaitSilent,
  isStickerOnMetaAct,
  isSilentWithNonsilenceAct,
  isRelayMismatch,
  isCat2FactDeniedReply,
  type JoinedRow,
} from '../../scripts/eval/summarize-gold.js';

// ---------- Fixtures ----------

function buildWeakLabel(overrides: Partial<WeakReplayLabel> = {}): WeakReplayLabel {
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

function buildSample(
  sampleId: string,
  category: number,
  expectedAct: ExpectedAct,
  isRelay: boolean,
  triggerContent: string,
): SampleRecord {
  return {
    sampleId,
    triggerContent,
    triggerRawContent: null,
    triggerUser: 'u',
    triggerTs: 0,
    contextBefore: [],
    contextAfter: [],
    weakLabel: buildWeakLabel({ expectedAct, isRelay }),
    category,
  } as SampleRecord;
}

function buildGold(
  sampleId: string,
  goldAct: GoldAct,
  goldDecision: GoldDecision,
  overrides: Partial<Omit<GoldLabel, 'sampleId' | 'goldAct' | 'goldDecision'>> = {},
): GoldLabel {
  return {
    sampleId,
    goldAct,
    goldDecision,
    targetOk: true,
    factNeeded: false,
    allowBanter: false,
    allowSticker: false,
    labeledAt: '2026-04-20T00:00:00.000Z',
    ...overrides,
  };
}

function buildJoined(
  sampleId: string,
  category: number,
  expectedAct: ExpectedAct,
  isRelay: boolean,
  goldAct: GoldAct,
  goldDecision: GoldDecision,
  goldOverrides: Partial<Omit<GoldLabel, 'sampleId' | 'goldAct' | 'goldDecision'>> = {},
  content = 'x',
): JoinedRow {
  const sample = buildSample(sampleId, category, expectedAct, isRelay, content);
  const gold = buildGold(sampleId, goldAct, goldDecision, goldOverrides);
  return {
    sampleId,
    sample,
    gold,
    category,
    categoryLabel: `cat${category}`,
  };
}

// ---------- 13.1 loadGold + join ----------

describe('loadGold + join', () => {
  const tmpFiles: string[] = [];
  afterEach(async () => {
    while (tmpFiles.length > 0) {
      const p = tmpFiles.pop()!;
      try { await fsp.unlink(p); } catch { /* ignore */ }
    }
  });

  it('loads valid rows, skips malformed + missing + bad-enum, dedups last-wins, warns on stderr', async () => {
    const tmp = path.join(os.tmpdir(), `gold-load-${randomUUID()}.jsonl`);
    tmpFiles.push(tmp);
    const v1 = buildGold('s1', 'direct_chat', 'reply');
    const v1dup = buildGold('s1', 'silence', 'silent');
    const malformed = '{not json';
    const missingSampleId = JSON.stringify({ goldAct: 'direct_chat', goldDecision: 'reply' });
    const badAct = JSON.stringify({ ...v1, sampleId: 'sBad', goldAct: 'not_a_real_act' });
    const body = [
      JSON.stringify(v1),
      malformed,
      missingSampleId,
      badAct,
      JSON.stringify(v1dup),
    ].join('\n');
    await fsp.writeFile(tmp, body, 'utf8');

    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const rows = await loadGold(tmp);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sampleId).toBe('s1');
      expect(rows[0]!.goldAct).toBe('silence');
      expect(rows[0]!.goldDecision).toBe('silent');
      const warnings = writeSpy.mock.calls.map(c => String(c[0]));
      expect(warnings.filter(w => /malformed JSON/i.test(w))).toHaveLength(1);
      expect(warnings.filter(w => /invalid row/i.test(w))).toHaveLength(2);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('join: inner only, orphans separate, counts set', () => {
    const bench: SampleRecord[] = [
      buildSample('a', 1, 'direct_chat', false, 'x'),
      buildSample('b', 2, 'direct_chat', false, 'x'),
      buildSample('c', 3, 'chime_in', false, 'x'),
    ];
    const gold: GoldLabel[] = [
      buildGold('a', 'direct_chat', 'reply'),
      buildGold('z1', 'chime_in', 'silent'),
      buildGold('z2', 'silence', 'silent'),
    ];
    const result = join(bench, gold);
    expect(result.joined).toHaveLength(1);
    expect(result.joined[0]!.sampleId).toBe('a');
    expect(result.joined[0]!.category).toBe(1);
    expect(result.orphanedGoldIds.sort()).toEqual(['z1', 'z2']);
    expect(result.goldTotal).toBe(3);
    expect(result.benchTotal).toBe(3);
  });
});

// ---------- 13.2 renderDistributions ----------

describe('renderDistributions', () => {
  it('prints all 9 acts and 3 decisions even when count is zero; matches counts', () => {
    const joined: JoinedRow[] = [
      buildJoined('a1', 1, 'direct_chat', false, 'direct_chat', 'reply', { factNeeded: true, allowBanter: true }),
      buildJoined('a2', 1, 'direct_chat', false, 'direct_chat', 'reply'),
      buildJoined('a3', 3, 'chime_in', false, 'chime_in', 'silent', { allowSticker: true }),
      buildJoined('a4', 3, 'chime_in', false, 'silence', 'silent'),
    ];
    const out = renderDistributions(joined).join('\n');
    expect(out).toContain('direct_chat        2');
    expect(out).toContain('chime_in           1');
    expect(out).toContain('silence            1');
    expect(out).toContain('conflict_handle    0');
    expect(out).toContain('summarize          0');
    expect(out).toContain('reply              2');
    expect(out).toContain('silent             2');
    expect(out).toContain('defer              0');
    expect(out).toContain('factNeeded         1 / 3');
    expect(out).toContain('allowBanter        1 / 3');
    expect(out).toContain('allowSticker       1 / 3');
  });
});

// ---------- 13.3 renderCoverage boundary ----------

describe('renderCoverage', () => {
  function sweep(counts: Record<number, number>): JoinedRow[] {
    const rows: JoinedRow[] = [];
    for (const [catStr, n] of Object.entries(counts)) {
      const c = Number(catStr);
      for (let i = 0; i < n; i++) {
        rows.push(buildJoined(`c${c}_${i}`, c, 'direct_chat', false, 'direct_chat', 'reply'));
      }
    }
    return rows;
  }

  it('marks cat<20 under, cat=0 UNCOVERED, cat>=20 ok at boundary', () => {
    const joined = sweep({ 1: 25, 2: 20, 3: 19 });
    const out = renderCoverage(joined, 0).join('\n');
    expect(out).toMatch(/cat 1.*N=\s*25\s+ok/);
    expect(out).toMatch(/cat 2.*N=\s*20\s+ok/);
    expect(out).toMatch(/cat 3.*N=\s*19\s+!! under/);
    expect(out).toMatch(/cat 7.*N=\s*0\s+!! UNCOVERED/);
    expect(out).toContain('-- total labeled=64 orphaned=0');
  });

  it('appends orphaned=<N> when passed in', () => {
    const out = renderCoverage(sweep({ 1: 1 }), 3).join('\n');
    expect(out).toContain('-- total labeled=1 orphaned=3');
  });
});

// ---------- 13.4 sortDisagreementRows ----------

describe('sortDisagreementRows', () => {
  it('count desc, then weak asc, then gold asc', () => {
    const input = [
      { weak: 'a', gold: 'b', count: 2 },
      { weak: 'a', gold: 'a', count: 5 },
      { weak: 'b', gold: 'b', count: 5 },
    ];
    const out = sortDisagreementRows(input);
    expect(out.map(r => [r.weak, r.gold, r.count])).toEqual([
      ['a', 'a', 5],
      ['b', 'b', 5],
      ['a', 'b', 2],
    ]);
  });
});

// ---------- 13.5 renderDisagreement ----------

describe('renderDisagreement', () => {
  it('emits agreement line with diag-sum / total and percentage', () => {
    const rows: JoinedRow[] = [];
    for (let i = 0; i < 6; i++) {
      rows.push(buildJoined(`d${i}`, 1, 'direct_chat', false, 'direct_chat', 'reply'));
    }
    for (let i = 0; i < 4; i++) {
      rows.push(buildJoined(`o${i}`, 3, 'chime_in', false, 'silence', 'silent'));
    }
    const out = renderDisagreement(rows).join('\n');
    expect(out).toContain('agreement = 6 / 10  (60.0%)');
  });

  it('empty joined → agreement = 0 / 0 (0.0%) with no divide-by-zero', () => {
    const out = renderDisagreement([]).join('\n');
    expect(out).toContain('agreement = 0 / 0  (0.0%)');
  });
});

// ---------- 13.6 Filter predicates ----------

describe('filter predicates', () => {
  it('isBaitSilent: match cat=1+silent, miss cat=1+reply', () => {
    expect(isBaitSilent(buildJoined('s', 1, 'direct_chat', false, 'silence', 'silent'))).toBe(true);
    expect(isBaitSilent(buildJoined('s', 1, 'direct_chat', false, 'direct_chat', 'reply'))).toBe(false);
  });
  it('isStickerOnMetaAct: match allowSticker+meta_admin_status, miss allowSticker+chime_in', () => {
    expect(isStickerOnMetaAct(
      buildJoined('s', 5, 'direct_chat', false, 'meta_admin_status', 'reply', { allowSticker: true }),
    )).toBe(true);
    expect(isStickerOnMetaAct(
      buildJoined('s', 5, 'direct_chat', false, 'chime_in', 'reply', { allowSticker: true }),
    )).toBe(false);
  });
  it('isSilentWithNonsilenceAct: match silent+chime_in, miss silent+silence', () => {
    expect(isSilentWithNonsilenceAct(
      buildJoined('s', 3, 'chime_in', false, 'chime_in', 'silent'),
    )).toBe(true);
    expect(isSilentWithNonsilenceAct(
      buildJoined('s', 3, 'chime_in', false, 'silence', 'silent'),
    )).toBe(false);
  });
  it('isRelayMismatch: match goldAct=relay+isRelay=false, miss goldAct=relay+isRelay=true', () => {
    expect(isRelayMismatch(
      buildJoined('s', 9, 'chime_in', false, 'relay', 'reply'),
    )).toBe(true);
    expect(isRelayMismatch(
      buildJoined('s', 7, 'relay', true, 'relay', 'reply'),
    )).toBe(false);
  });
  it('isCat2FactDeniedReply: match cat=2+factNeeded=false+reply, miss cat=2+factNeeded=true+reply', () => {
    expect(isCat2FactDeniedReply(
      buildJoined('s', 2, 'direct_chat', false, 'direct_chat', 'reply', { factNeeded: false }),
    )).toBe(true);
    expect(isCat2FactDeniedReply(
      buildJoined('s', 2, 'direct_chat', false, 'direct_chat', 'reply', { factNeeded: true }),
    )).toBe(false);
  });
});

// ---------- 13.7 renderSuspicious cap ----------

describe('renderSuspicious', () => {
  it('caps at 20 rows, appends +<M> more trailer, empty filters render N=0', () => {
    const joined: JoinedRow[] = [];
    for (let i = 0; i < 25; i++) {
      joined.push(buildJoined(`big${i}`, 3, 'chime_in', false, 'chime_in', 'silent'));
    }
    const out = renderSuspicious(joined);
    const text = out.join('\n');
    expect(text).toContain('[silent_with_nonsilence_act]  N=25');
    const block = text.split('[relay_mismatch]')[0]!;
    const rowLines = block.split('\n').filter(l => /^\s{2}big\d+/.test(l));
    expect(rowLines).toHaveLength(20);
    expect(text).toContain('  \u2026 +5 more');
    expect(text).toContain('[bait_silent]  N=0');
    expect(text).toContain('[sticker_on_meta_act]  N=0');
    expect(text).toContain('[relay_mismatch]  N=0');
    expect(text).toContain('[cat2_fact_denied_reply]  N=0');
  });
});

// ---------- 13.8 makeSnippet ----------

describe('makeSnippet', () => {
  it('short text passes through', () => {
    expect(makeSnippet('hello world')).toBe('hello world');
  });
  it('long text truncated to 60 chars ending with ellipsis', () => {
    const out = makeSnippet('a'.repeat(100));
    expect(out).toHaveLength(60);
    expect(out.endsWith('\u2026')).toBe(true);
  });
  it('newlines map to ⏎', () => {
    expect(makeSnippet('line1\nline2')).toBe('line1\u23celine2');
  });
  it('CQ segments stripped, leading/trailing space trimmed', () => {
    expect(makeSnippet('[CQ:image,file=x] caption')).toBe('caption');
  });
  it('multi-CQ + inner whitespace collapsed', () => {
    expect(makeSnippet('hi   [CQ:face,id=1]  there')).toBe('hi there');
  });
});

// ---------- 13.9 Integration ----------

describe('integration end-to-end', () => {
  const tmpFiles: string[] = [];
  afterEach(async () => {
    while (tmpFiles.length > 0) {
      const p = tmpFiles.pop()!;
      try { await fsp.unlink(p); } catch { /* ignore */ }
    }
  });

  it('10 bench + 8 gold (2 orphans) + 1 malformed line → rows=6/8 orphaned=2, sections present', async () => {
    const benchTmp = path.join(os.tmpdir(), `bench-${randomUUID()}.jsonl`);
    const goldTmp = path.join(os.tmpdir(), `gold-${randomUUID()}.jsonl`);
    tmpFiles.push(benchTmp, goldTmp);

    const benchRows: unknown[] = [];
    const expectedActs: ExpectedAct[] = [
      'direct_chat', 'direct_chat', 'chime_in', 'chime_in', 'relay',
      'direct_chat', 'chime_in', 'chime_in', 'direct_chat', 'direct_chat',
    ];
    const cats = [1, 2, 3, 7, 7, 1, 9, 3, 1, 1];
    for (let i = 0; i < 10; i++) {
      benchRows.push({
        id: `b${i}`,
        groupId: 'g',
        messageId: i,
        sourceMessageId: null,
        userId: 'u',
        nickname: 'n',
        timestamp: 0,
        content: `msg-${i}`,
        rawContent: null,
        triggerContext: [],
        triggerContextAfter: [],
        category: cats[i],
        categoryLabel: `cat${cats[i]}`,
        samplingSeed: 42,
        contentHash: 'h',
        contextHash: 'h',
        label: buildWeakLabel({ expectedAct: expectedActs[i]!, isRelay: cats[i] === 7 }),
      });
    }

    const goldRows = [
      buildGold('b0', 'silence', 'silent'),
      buildGold('b1', 'direct_chat', 'reply', { factNeeded: false }),
      buildGold('b2', 'chime_in', 'silent'),
      buildGold('b3', 'relay', 'reply'),
      buildGold('b4', 'relay', 'reply'),
      buildGold('b5', 'silence', 'silent'),
      buildGold('orph1', 'chime_in', 'silent'),
      buildGold('orph2', 'direct_chat', 'reply'),
    ];

    await fsp.writeFile(benchTmp, benchRows.map(r => JSON.stringify(r)).join('\n'), 'utf8');
    await fsp.writeFile(
      goldTmp,
      [...goldRows.map(r => JSON.stringify(r)), '{not json'].join('\n'),
      'utf8',
    );

    const { readSamples } = await import('../../scripts/eval/gold/reader.js');
    const bench: SampleRecord[] = [];
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      for await (const s of readSamples(benchTmp)) bench.push(s);
      const gold = await loadGold(goldTmp);
      const result = join(bench, gold);
      expect(result.joined).toHaveLength(6);
      expect(result.orphanedGoldIds.sort()).toEqual(['orph1', 'orph2']);
      expect(result.goldTotal).toBe(8);
      expect(result.benchTotal).toBe(10);

      const sections = [
        renderDistributions(result.joined),
        renderCoverage(result.joined, result.orphanedGoldIds.length),
        renderDisagreement(result.joined),
        renderSuspicious(result.joined),
      ];
      const combined = sections.map(s => s.join('\n')).join('\n');
      expect(combined).toContain('SECTION 1 — DISTRIBUTIONS');
      expect(combined).toContain('SECTION 2 — COVERAGE MATRIX');
      expect(combined).toContain('SECTION 3 — WEAK vs GOLD DISAGREEMENT');
      expect(combined).toContain('SECTION 4 — SUSPICIOUS ROWS');
      expect(combined).toContain('orphaned=2');
      // b0 and b5 are cat=1+decision=silent → bait_silent fires for both.
      expect(combined).toMatch(/\[bait_silent\]\s+N=2/);
    } finally {
      writeSpy.mockRestore();
    }
  });
});
