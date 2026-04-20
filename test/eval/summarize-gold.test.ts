/**
 * R6.2.3 summarize-gold tests.
 *
 * All pure-function tests use inlined in-memory fixtures. Loader test writes
 * small tmp JSONL files and cleans up in afterEach.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { WeakLabeledRow, WeakReplayLabel, ExpectedAct } from '../../scripts/eval/types.js';
import type { GoldLabel, GoldAct, GoldDecision } from '../../scripts/eval/gold/types.js';
import {
  joinRecords,
  computeDistributions,
  computeCoverage,
  computeConfusion,
  applyFilters,
  buildReport,
  isBaitDirectSilent,
  isStickerOnNonConversational,
  isSilentDecisionNonSilenceAct,
  isRelayActWeakNotRelay,
  isFacttermNoFactReply,
  loadBenchmark,
  loadGold,
  renderJsonReport,
  renderHumanReport,
  snippet,
  type JoinedRecord,
  type FilterId,
} from '../../scripts/eval/summarize-gold.js';

// ---------- Fixture helpers ----------

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

function buildWeak(
  sampleId: string,
  category: number,
  isRelay: boolean,
  expectedAct: ExpectedAct,
  content: string,
  rawContent: string | null = null,
): WeakLabeledRow {
  return {
    id: sampleId,
    groupId: 'g1',
    messageId: 1,
    sourceMessageId: null,
    userId: 'u1',
    nickname: 'n1',
    timestamp: 0,
    content,
    rawContent,
    triggerContext: [],
    triggerContextAfter: [],
    category,
    categoryLabel: `cat${category}`,
    samplingSeed: 0,
    contentHash: 'h',
    contextHash: 'h',
    label: buildWeakLabel({ isRelay, expectedAct }),
  };
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

function joinOne(weak: WeakLabeledRow, gold: GoldLabel | null): JoinedRecord {
  return { sampleId: weak.id, weak, gold };
}

// ---------- 10.1 Distributions ----------

describe('computeDistributions', () => {
  it('sums act and decision distributions over labeled rows only', () => {
    const w1 = buildWeak('s1', 1, false, 'direct_chat', 'hi');
    const w2 = buildWeak('s2', 2, false, 'chime_in', 'yo');
    const w3 = buildWeak('s3', 3, false, 'chime_in', 'ya');
    const w4 = buildWeak('s4', 3, false, 'chime_in', 'no-gold');
    const g1 = buildGold('s1', 'direct_chat', 'reply', { factNeeded: true, allowBanter: true, allowSticker: false });
    const g2 = buildGold('s2', 'chime_in', 'silent', { factNeeded: false, allowBanter: false, allowSticker: true });
    const g3 = buildGold('s3', 'silence', 'silent', { factNeeded: false, allowBanter: true, allowSticker: false });
    const joined = joinRecords([w1, w2, w3, w4], [g1, g2, g3]);
    const d = computeDistributions(joined);
    expect(d.totalBenchmark).toBe(4);
    expect(d.totalLabeled).toBe(3);
    expect(d.totalLabeled).toBeLessThan(d.totalBenchmark);
    expect(d.goldAct).toEqual({ direct_chat: 1, chime_in: 1, silence: 1 });
    expect(d.goldDecision).toEqual({ reply: 1, silent: 2 });
    expect(d.factNeeded).toEqual({ true: 1, false: 2 });
    expect(d.allowBanter).toEqual({ true: 2, false: 1 });
    expect(d.allowSticker).toEqual({ true: 1, false: 2 });
  });
});

// ---------- 10.2 Coverage ----------

describe('computeCoverage', () => {
  function makeBenchSweep(labeledCat1: number): JoinedRecord[] {
    const joined: JoinedRecord[] = [];
    for (let c = 1; c <= 10; c++) {
      for (let k = 0; k < 25; k++) {
        const id = `c${c}-${k}`;
        const w = buildWeak(id, c, false, 'direct_chat', 'x');
        const hasGold = c === 1 && k < labeledCat1;
        joined.push({
          sampleId: id,
          weak: w,
          gold: hasGold ? buildGold(id, 'direct_chat', 'reply') : null,
        });
      }
    }
    return joined;
  }

  it('marks uncovered cats (labeled=0) red, under when below threshold, ok otherwise', () => {
    const cov = computeCoverage(makeBenchSweep(5), 20);
    expect(cov).toHaveLength(10);
    expect(cov[0]).toMatchObject({ category: 1, benchmark: 25, labeled: 5, status: 'under' });
    for (let c = 2; c <= 10; c++) {
      expect(cov[c - 1]).toMatchObject({ category: c, benchmark: 25, labeled: 0, status: 'uncovered' });
    }
  });

  it('cat 1 labeled=25 threshold=20 → ok', () => {
    const cov = computeCoverage(makeBenchSweep(25), 20);
    expect(cov[0]!.status).toBe('ok');
  });

  it('boundary: labeled=20 threshold=20 → ok, labeled=19 → under', () => {
    expect(computeCoverage(makeBenchSweep(20), 20)[0]!.status).toBe('ok');
    expect(computeCoverage(makeBenchSweep(19), 20)[0]!.status).toBe('under');
  });
});

// ---------- 10.3 Confusion ----------

describe('computeConfusion', () => {
  it('sums weakAct×goldAct pairs, omits gold=null, sorts desc', () => {
    const rows: JoinedRecord[] = [];
    for (let i = 0; i < 3; i++) {
      const w = buildWeak(`a${i}`, 5, false, 'bot_status_query', 'x');
      rows.push(joinOne(w, buildGold(`a${i}`, 'silence', 'silent')));
    }
    const w4 = buildWeak('a4', 5, false, 'bot_status_query', 'x');
    rows.push(joinOne(w4, buildGold('a4', 'direct_chat', 'reply')));
    const w5 = buildWeak('a5', 5, false, 'bot_status_query', 'x');
    rows.push(joinOne(w5, null));

    const conf = computeConfusion(rows);
    expect(conf).toHaveLength(2);
    expect(conf[0]).toEqual({ weakAct: 'bot_status_query', goldAct: 'silence', count: 3 });
    expect(conf[1]).toEqual({ weakAct: 'bot_status_query', goldAct: 'direct_chat', count: 1 });
    expect(conf.reduce((s, r) => s + r.count, 0)).toBe(4);
  });
});

// ---------- 10.4 Filter predicates (each: 1 match, 1 near-miss, null-gold=false) ----------

describe('isBaitDirectSilent', () => {
  it('match: cat=1, decision=silent', () => {
    const w = buildWeak('s1', 1, false, 'direct_chat', 'x');
    expect(isBaitDirectSilent(joinOne(w, buildGold('s1', 'silence', 'silent')))).toBe(true);
  });
  it('miss: cat=1, decision=reply', () => {
    const w = buildWeak('s1', 1, false, 'direct_chat', 'x');
    expect(isBaitDirectSilent(joinOne(w, buildGold('s1', 'direct_chat', 'reply')))).toBe(false);
  });
  it('null gold → false', () => {
    const w = buildWeak('s1', 1, false, 'direct_chat', 'x');
    expect(isBaitDirectSilent(joinOne(w, null))).toBe(false);
  });
});

describe('isStickerOnNonConversational', () => {
  it('match: allowSticker=true, goldAct=meta_admin_status', () => {
    const w = buildWeak('s1', 5, false, 'meta_admin_status', 'x');
    expect(isStickerOnNonConversational(
      joinOne(w, buildGold('s1', 'meta_admin_status', 'reply', { allowSticker: true })),
    )).toBe(true);
  });
  it('miss: allowSticker=true, goldAct=chime_in', () => {
    const w = buildWeak('s1', 5, false, 'chime_in', 'x');
    expect(isStickerOnNonConversational(
      joinOne(w, buildGold('s1', 'chime_in', 'reply', { allowSticker: true })),
    )).toBe(false);
  });
  it('null gold → false', () => {
    const w = buildWeak('s1', 5, false, 'meta_admin_status', 'x');
    expect(isStickerOnNonConversational(joinOne(w, null))).toBe(false);
  });
});

describe('isSilentDecisionNonSilenceAct', () => {
  it('match: decision=silent, act=chime_in', () => {
    const w = buildWeak('s1', 3, false, 'chime_in', 'x');
    expect(isSilentDecisionNonSilenceAct(
      joinOne(w, buildGold('s1', 'chime_in', 'silent')),
    )).toBe(true);
  });
  it('miss: decision=silent, act=silence', () => {
    const w = buildWeak('s1', 10, false, 'chime_in', 'x');
    expect(isSilentDecisionNonSilenceAct(
      joinOne(w, buildGold('s1', 'silence', 'silent')),
    )).toBe(false);
  });
  it('null gold → false', () => {
    const w = buildWeak('s1', 3, false, 'chime_in', 'x');
    expect(isSilentDecisionNonSilenceAct(joinOne(w, null))).toBe(false);
  });
});

describe('isRelayActWeakNotRelay', () => {
  it('match: goldAct=relay, weak.isRelay=false', () => {
    const w = buildWeak('s1', 9, false, 'chime_in', 'x');
    expect(isRelayActWeakNotRelay(
      joinOne(w, buildGold('s1', 'relay', 'reply')),
    )).toBe(true);
  });
  it('miss: goldAct=relay, weak.isRelay=true', () => {
    const w = buildWeak('s1', 7, true, 'relay', 'x');
    expect(isRelayActWeakNotRelay(
      joinOne(w, buildGold('s1', 'relay', 'reply')),
    )).toBe(false);
  });
  it('null gold → false', () => {
    const w = buildWeak('s1', 9, false, 'chime_in', 'x');
    expect(isRelayActWeakNotRelay(joinOne(w, null))).toBe(false);
  });
});

describe('isFacttermNoFactReply', () => {
  it('match: cat=2, factNeeded=false, decision=reply', () => {
    const w = buildWeak('s1', 2, false, 'direct_chat', 'x');
    expect(isFacttermNoFactReply(
      joinOne(w, buildGold('s1', 'direct_chat', 'reply', { factNeeded: false })),
    )).toBe(true);
  });
  it('miss: cat=2, factNeeded=true, decision=reply', () => {
    const w = buildWeak('s1', 2, false, 'direct_chat', 'x');
    expect(isFacttermNoFactReply(
      joinOne(w, buildGold('s1', 'direct_chat', 'reply', { factNeeded: true })),
    )).toBe(false);
  });
  it('null gold → false', () => {
    const w = buildWeak('s1', 2, false, 'direct_chat', 'x');
    expect(isFacttermNoFactReply(joinOne(w, null))).toBe(false);
  });
});

// ---------- 10.5 applyFilters cap ----------

describe('applyFilters', () => {
  it('caps each filter bucket at 20 hits', () => {
    const joined: JoinedRecord[] = [];
    for (let i = 0; i < 25; i++) {
      const id = `s${i}`;
      const w = buildWeak(id, 3, false, 'chime_in', 'x');
      joined.push(joinOne(w, buildGold(id, 'chime_in', 'silent')));
    }
    const hits = applyFilters(joined);
    expect(hits.silent_decision_non_silence_act).toHaveLength(20);
    expect(hits.silent_decision_non_silence_act.every(h => h.filterId === 'silent_decision_non_silence_act')).toBe(true);
  });
});

// ---------- 10.6 Rendering ----------

describe('renderJsonReport', () => {
  it('round-trips: JSON.parse(render(r)) deep-equals r', () => {
    const w1 = buildWeak('s1', 1, false, 'direct_chat', 'hello');
    const g1 = buildGold('s1', 'direct_chat', 'reply');
    const rep = buildReport(joinRecords([w1], [g1]), 20);
    expect(JSON.parse(renderJsonReport(rep))).toEqual(rep);
  });
});

describe('renderHumanReport', () => {
  const w1 = buildWeak('s1', 1, false, 'direct_chat', 'hello');
  const g1 = buildGold('s1', 'direct_chat', 'reply');
  const rep = buildReport(joinRecords([w1], [g1]), 20);

  it('no ANSI bytes when useColor=false', () => {
    expect(renderHumanReport(rep, false)).not.toMatch(/\x1b\[/);
  });

  it('contains section-header ANSI escape when useColor=true', () => {
    const out = renderHumanReport(rep, true);
    expect(out).toMatch(/\x1b\[1;37m/);
  });
});

// ---------- 10.7 Loader ----------

describe('loadGold', () => {
  const tmpFiles: string[] = [];
  afterEach(async () => {
    while (tmpFiles.length > 0) {
      const p = tmpFiles.pop()!;
      try { await fsp.unlink(p); } catch { /* ignore */ }
    }
  });

  it('skips malformed JSON + missing-required rows, warns to stderr', async () => {
    const tmp = path.join(os.tmpdir(), `gold-load-${randomUUID()}.jsonl`);
    tmpFiles.push(tmp);
    const valid = buildGold('s1', 'direct_chat', 'reply');
    const body = [
      JSON.stringify(valid),
      '{not json',
      JSON.stringify({ sampleId: 's2' }), // missing required fields
      '',
    ].join('\n');
    await fsp.writeFile(tmp, body, 'utf8');

    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const rows = await loadGold(tmp);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sampleId).toBe('s1');
      const warnings = writeSpy.mock.calls.map(c => String(c[0]));
      expect(warnings.some(w => /malformed JSON/i.test(w))).toBe(true);
      expect(warnings.some(w => /invalid row/i.test(w))).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('dedup by sampleId — last wins', async () => {
    const tmp = path.join(os.tmpdir(), `gold-dedup-${randomUUID()}.jsonl`);
    tmpFiles.push(tmp);
    const first = buildGold('s1', 'direct_chat', 'reply');
    const second = buildGold('s1', 'silence', 'silent');
    await fsp.writeFile(tmp, [JSON.stringify(first), JSON.stringify(second)].join('\n'), 'utf8');
    const rows = await loadGold(tmp);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.goldAct).toBe('silence');
    expect(rows[0]!.goldDecision).toBe('silent');
  });
});

describe('loadBenchmark', () => {
  const tmpFiles: string[] = [];
  afterEach(async () => {
    while (tmpFiles.length > 0) {
      const p = tmpFiles.pop()!;
      try { await fsp.unlink(p); } catch { /* ignore */ }
    }
  });

  it('skips malformed JSON + missing required keys', async () => {
    const tmp = path.join(os.tmpdir(), `bench-load-${randomUUID()}.jsonl`);
    tmpFiles.push(tmp);
    const good = buildWeak('w1', 1, false, 'direct_chat', 'hi');
    const body = [
      JSON.stringify(good),
      '{not json',
      JSON.stringify({ id: 'w2', category: 2 }), // missing label, content
      '',
    ].join('\n');
    await fsp.writeFile(tmp, body, 'utf8');

    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const rows = await loadBenchmark(tmp);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe('w1');
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ---------- 10.8 Integration ----------

describe('buildReport integration', () => {
  const tmpFiles: string[] = [];
  afterEach(async () => {
    while (tmpFiles.length > 0) {
      const p = tmpFiles.pop()!;
      try { await fsp.unlink(p); } catch { /* ignore */ }
    }
  });

  it('5-row weak + 3-row gold → counts line up, coverage len 10', async () => {
    const weakTmp = path.join(os.tmpdir(), `bench-${randomUUID()}.jsonl`);
    const goldTmp = path.join(os.tmpdir(), `gold-${randomUUID()}.jsonl`);
    tmpFiles.push(weakTmp, goldTmp);

    const weakRows = [
      buildWeak('i1', 1, false, 'direct_chat', 'a'),
      buildWeak('i2', 2, false, 'direct_chat', 'b'),
      buildWeak('i3', 3, false, 'chime_in', 'c'),
      buildWeak('i4', 9, false, 'chime_in', 'd'),
      buildWeak('i5', 10, false, 'chime_in', 'e'),
    ];
    const goldRows = [
      buildGold('i1', 'silence', 'silent'),               // hits bait_direct_silent (cat=1, decision=silent); act=silence so NOT silent_decision_non_silence_act
      buildGold('i2', 'direct_chat', 'reply'),            // hits factterm_no_fact_reply (cat=2, factNeeded=false)
      buildGold('i3', 'relay', 'reply'),                  // hits relay_act_weak_not_relay (weak.isRelay=false)
    ];
    await fsp.writeFile(weakTmp, weakRows.map(r => JSON.stringify(r)).join('\n'), 'utf8');
    await fsp.writeFile(goldTmp, goldRows.map(r => JSON.stringify(r)).join('\n'), 'utf8');

    const weak = await loadBenchmark(weakTmp);
    const gold = await loadGold(goldTmp);
    const report = buildReport(joinRecords(weak, gold), 20);

    expect(report.distributions.totalLabeled).toBe(3);
    expect(report.distributions.totalBenchmark).toBe(5);
    expect(report.coverage).toHaveLength(10);
    expect(report.suspicious.bait_direct_silent).toHaveLength(1);
    expect(report.suspicious.bait_direct_silent[0]!.sampleId).toBe('i1');
    expect(report.suspicious.silent_decision_non_silence_act).toHaveLength(0);
    expect(report.suspicious.factterm_no_fact_reply).toHaveLength(1);
    expect(report.suspicious.relay_act_weak_not_relay).toHaveLength(1);
    expect(report.suspicious.sticker_on_non_conversational).toHaveLength(0);
  });
});

// ---------- Misc helpers ----------

describe('snippet helper', () => {
  it('prefers rawContent when present', () => {
    expect(snippet('raw-text', 'content-fallback')).toBe('raw-text');
  });
  it('falls back to content when raw is null/empty', () => {
    expect(snippet(null, 'content-fallback')).toBe('content-fallback');
    expect(snippet('', 'content-fallback')).toBe('content-fallback');
  });
  it('collapses whitespace, truncates over 60 chars with ellipsis', () => {
    const long = 'a'.repeat(80);
    const out = snippet(null, long);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('\u2026')).toBe(true);
    expect(snippet(null, 'a\n\nb  c')).toBe('a b c');
  });
});

// satisfy noUnusedLocals for FilterId import
const _filterIdForTypeCheck: FilterId = 'bait_direct_silent';
void _filterIdForTypeCheck;
