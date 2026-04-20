/**
 * R6.2 gold-label CLI — terminal renderer.
 *
 * All output goes to process.stdout except final stats (also echoed to stderr).
 */

import type { SampleRecord } from './reader.js';
import type { GoldAct, GoldDecision, GoldLabel } from './types.js';
import { HELP_TEXT } from './shortcuts.js';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  boldYellow: '\x1b[1;33m',
  boldRed: '\x1b[1;31m',
  boldGreen: '\x1b[1;32m',
  green: '\x1b[32m',
  dimGray: '\x1b[2;37m',
};

export interface LabelState {
  goldAct?: GoldAct;
  goldDecision?: GoldDecision;
  targetOk: boolean;
  factNeeded: boolean;
  allowBanter: boolean;
  allowSticker: boolean;
  notes?: string;
}

export interface Progress {
  current: number;
  total: number;
  labeled: number;
  skipped: number;
}

export interface SessionStats {
  labeled: number;
  skipped: number;
  totalPresented: number;
  actDist: Partial<Record<GoldAct, number>>;
  outputPath: string;
}

export function defaultLabelState(): LabelState {
  return {
    targetOk: true,
    factNeeded: false,
    allowBanter: false,
    allowSticker: false,
  };
}

const SEP_EQ = '='.repeat(80);
const SEP_DASH = '-'.repeat(80);

function ts(ts: number): string {
  const d = new Date(ts * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export function renderSample(sample: SampleRecord, state: LabelState, progress: Progress): void {
  const lines: string[] = [];
  lines.push('\x1b[2J\x1b[H');
  lines.push(SEP_EQ);
  lines.push(
    ` Labeled: ${progress.labeled}/${progress.total} | Skipped: ${progress.skipped} | sampleId: ${sample.sampleId}`,
  );
  lines.push(SEP_EQ);

  lines.push(` ${C.dim}CONTEXT (${sample.contextBefore.length} prior):${C.reset}`);
  for (const m of sample.contextBefore) {
    lines.push(`   ${C.dim}${ts(m.ts)}${C.reset}  ${m.user.padEnd(12)} ${truncate(m.rawContent ?? m.content, 60)}`);
  }
  lines.push('');
  lines.push(
    ` ${C.boldYellow}>>>  ${ts(sample.triggerTs)}  ${sample.triggerUser.padEnd(12)} ${truncate(sample.triggerRawContent ?? sample.triggerContent, 60)}  <<<${C.reset}`,
  );
  lines.push('');
  lines.push(` ${C.dim}AFTER (${sample.contextAfter.length}):${C.reset}`);
  for (const m of sample.contextAfter) {
    lines.push(`   ${C.dim}${ts(m.ts)}${C.reset}  ${m.user.padEnd(12)} ${truncate(m.rawContent ?? m.content, 60)}`);
  }
  lines.push(SEP_DASH);

  const weak = sample.weakLabel;
  const cat = typeof sample.categoryLabel === 'string' ? sample.categoryLabel : '?';
  const risk = Array.isArray(weak.riskFlags) ? weak.riskFlags.join(',') : '';
  lines.push(' WEAK LABEL:');
  lines.push(`   ${C.cyan}category:${C.reset}          ${cat}`);
  lines.push(`   expectedAct:       ${weak.expectedAct}`);
  lines.push(`   expectedDecision:  ${weak.expectedDecision}`);
  lines.push(`   hasKnownFactTerm:  ${weak.hasKnownFactTerm}`);
  lines.push(`   ${C.boldRed}riskFlags:${C.reset}         ${risk}`);
  lines.push(SEP_DASH);

  const actDisplay = state.goldAct ? `${C.boldGreen}${state.goldAct}${C.reset}` : `${C.dim}[not set]${C.reset}`;
  const decDisplay = state.goldDecision
    ? `${C.boldGreen}${state.goldDecision}${C.reset}`
    : `${C.dim}[not set]${C.reset}`;
  lines.push(' CURRENT GOLD:');
  lines.push(`   goldAct:      ${actDisplay}      goldDecision: ${decDisplay}`);
  lines.push(`   targetOk:     ${state.targetOk} [t]       factNeeded:   ${state.factNeeded} [f]`);
  lines.push(`   allowSticker: ${state.allowSticker} [b]       allowBanter:  ${state.allowBanter} [B]`);
  const noteDisp = typeof state.notes === 'string' && state.notes.length > 0 ? state.notes : `${C.dim}(none)${C.reset}`;
  lines.push(`   notes:        ${noteDisp}`);
  lines.push(SEP_DASH);
  lines.push(HELP_TEXT);
  lines.push(SEP_EQ);

  process.stdout.write(lines.join('\n') + '\n');
}

export function renderEditMenu(history: GoldLabel[]): void {
  const lines: string[] = [];
  lines.push('\x1b[2J\x1b[H');
  lines.push(SEP_EQ);
  lines.push(' EDIT PREVIOUS — select one of the last 5 labels:');
  lines.push(SEP_EQ);
  history.forEach((label, idx) => {
    lines.push(
      ` [${idx + 1}] ${label.sampleId}  ${label.goldAct}/${label.goldDecision}  ${C.dim}(${label.labeledAt})${C.reset}`,
    );
  });
  if (history.length === 0) {
    lines.push(` ${C.dim}(no previous labels)${C.reset}`);
  }
  lines.push(SEP_EQ);
  lines.push(' Press 1–5 to pick, or any other key to cancel.');
  process.stdout.write(lines.join('\n') + '\n');
}

export function renderConfirmation(label: GoldLabel): void {
  process.stdout.write(
    `\n ${C.boldGreen}✓ saved${C.reset} ${label.sampleId} — ${label.goldAct}/${label.goldDecision}\n`,
  );
}

export function renderSummary(stats: SessionStats): void {
  const lines: string[] = [];
  lines.push('\x1b[2J\x1b[H');
  lines.push(SEP_EQ);
  lines.push(' SESSION SUMMARY');
  lines.push(SEP_EQ);
  lines.push(`   output:           ${stats.outputPath}`);
  lines.push(`   total presented:  ${stats.totalPresented}`);
  lines.push(`   labeled:          ${stats.labeled}`);
  lines.push(`   skipped:          ${stats.skipped}`);
  lines.push('   act distribution:');
  for (const [act, count] of Object.entries(stats.actDist)) {
    lines.push(`     ${act.padEnd(20)} ${count}`);
  }
  lines.push(SEP_EQ);
  const body = lines.join('\n') + '\n';
  process.stdout.write(body);
  process.stderr.write(`[summary] labeled=${stats.labeled} skipped=${stats.skipped} total=${stats.totalPresented}\n`);
}

export function renderWarning(msg: string): void {
  process.stdout.write(` ${C.dimGray}${msg}${C.reset}\n`);
}

export function renderQuitConfirm(labeled: number, currentIncomplete: boolean): void {
  const warn = currentIncomplete ? ` ${C.boldRed}(current sample has unsaved partial state)${C.reset}` : '';
  process.stdout.write(
    `\n ${C.boldYellow}Quit?${C.reset} Press ${C.bold}q${C.reset} again to confirm (3s timeout). Labeled so far: ${labeled}${warn}\n`,
  );
}
