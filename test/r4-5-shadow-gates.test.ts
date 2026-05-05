import { describe, it, expect } from 'vitest';
import { buildReport, type CliArgs } from '../scripts/eval/r4-5-shadow-gates.js';

interface EventRow {
  utterance_act: string | null;
  utterance_act_shadow: string | null;
  utterance_act_shadow_latency_ms: number | null;
}

const ACTS = [
  'direct_chat', 'chime_in', 'conflict_handle', 'summarize',
  'bot_status_query', 'relay', 'meta_admin_status', 'object_react',
] as const;

const ARGS: CliArgs = {
  fromSec: 0,
  toSec: 86_400,
  dbPath: ':memory:',
  goldPath: '',
  outPath: '',
  costCeiling: 20,
  latencyP99Ceiling: 800,
};

function makeHealthyRows(): EventRow[] {
  // 1000 events, 90% agreement, all 8 acts represented, latency p99 ~700ms.
  const rows: EventRow[] = [];
  // Build 100 of each act with shadow=rule (agreeing).
  for (const a of ACTS) {
    for (let i = 0; i < 100; i++) {
      rows.push({
        utterance_act: a,
        utterance_act_shadow: a,
        utterance_act_shadow_latency_ms: 600,
      });
    }
  }
  // Force 100 disagreement rows (rule=chime_in but shadow=direct_chat) to land overall at 87.5%.
  // We have 800 in agreement above, plus 100 disagreement = 900 total compared, 800 agreed → 88.9%.
  for (let i = 0; i < 100; i++) {
    rows.push({
      utterance_act: 'chime_in',
      utterance_act_shadow: 'direct_chat',
      utterance_act_shadow_latency_ms: 700,
    });
  }
  return rows;
}

const HEALTHY_GOLD = ACTS.map(a => ({ rule_based: a, gold: a }));

describe('R4.5 gate CLI buildReport', () => {
  it('case 1: healthy fixture → all_pass true', () => {
    const rows = makeHealthyRows();
    const report = buildReport(rows, HEALTHY_GOLD, ARGS);
    expect(report.gate_1_agreement.pass).toBe(true);
    expect(report.gate_2_distribution.pass).toBe(true);
    expect(report.gate_3_cost.pass).toBe(true);
    expect(report.gate_4_latency.pass).toBe(true);
    expect(report.all_pass).toBe(true);
    expect(report.gate_4_latency.p99_ms).toBeLessThanOrEqual(800);
  });

  it('case 2: failing agreement → gate_1 fails, all_pass false', () => {
    // 1000 rows, 80% agreement (below 85% threshold).
    const rows: EventRow[] = [];
    for (let i = 0; i < 800; i++) rows.push({ utterance_act: 'chime_in', utterance_act_shadow: 'chime_in', utterance_act_shadow_latency_ms: 600 });
    for (let i = 0; i < 200; i++) rows.push({ utterance_act: 'chime_in', utterance_act_shadow: 'direct_chat', utterance_act_shadow_latency_ms: 600 });
    const report = buildReport(rows, HEALTHY_GOLD, ARGS);
    expect(report.gate_1_agreement.pass).toBe(false);
    expect(report.all_pass).toBe(false);
  });

  it('case 3: empty window → all gates fail, all_pass false', () => {
    const report = buildReport([], [], ARGS);
    expect(report.gate_1_agreement.pass).toBe(false);
    expect(report.gate_2_distribution.pass).toBe(false);
    expect(report.gate_3_cost.pass).toBe(false);
    expect(report.gate_4_latency.pass).toBe(false);
    expect(report.all_pass).toBe(false);
    expect(report.n_chat_path_events).toBe(0);
  });
});
