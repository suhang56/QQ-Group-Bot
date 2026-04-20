/**
 * R6.2 gold-label CLI — session runner.
 *
 * The session is decoupled from real stdin: callers pass `readKey`,
 * `promptNotesLine`, and `delay` providers. The CLI entry wires these to
 * raw-mode stdin; tests wire them to a scripted queue.
 */

import { readSamples, getDiagnostics, type SampleRecord } from './reader.js';
import { appendLabel, readExistingLabels, updateLabel } from './writer.js';
import { keyToAction, type Action } from './shortcuts.js';
import {
  renderSample,
  renderEditMenu,
  renderConfirmation,
  renderSummary,
  renderWarning,
  renderQuitConfirm,
  defaultLabelState,
  type LabelState,
  type Progress,
  type SessionStats,
} from './renderer.js';
import { NOTES_MAX_LEN, type GoldAct, type GoldLabel } from './types.js';

export interface SessionOpts {
  inputPath: string;
  outputPath: string;
  limit?: number;
  total?: number;
  readKey: () => Promise<Buffer>;
  promptNotesLine: () => Promise<string>;
  delay?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** ms for quit-double-press timeout; set to 0 to disable (tests). Default 3000. */
  quitTimeoutMs?: number;
  /** R6.2.2: bot QQ used to render CQ:at,qq=<botQQ> as [@bot] in display. null = no @bot coercion. */
  botQQ?: string | null;
}

const defaultDelay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function buildLabel(
  sampleId: string,
  state: LabelState,
  now: Date,
  existingNotes?: string,
): GoldLabel {
  // State invariant: caller guarantees goldAct + goldDecision set.
  if (!state.goldAct || !state.goldDecision) {
    throw new Error('buildLabel requires goldAct + goldDecision');
  }
  const notes = typeof state.notes === 'string' && state.notes.length > 0
    ? state.notes
    : existingNotes;
  const label: GoldLabel = {
    sampleId,
    goldAct: state.goldAct,
    goldDecision: state.goldDecision,
    targetOk: state.targetOk,
    factNeeded: state.factNeeded,
    allowBanter: state.allowBanter,
    allowSticker: state.allowSticker,
    labeledAt: now.toISOString(),
  };
  if (typeof notes === 'string' && notes.length > 0) {
    label.notes = notes;
  }
  return label;
}

export function sanitizeNotes(raw: string): { notes: string | undefined; truncated: boolean } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { notes: undefined, truncated: false };
  if (trimmed.length > NOTES_MAX_LEN) {
    return { notes: trimmed.slice(0, NOTES_MAX_LEN), truncated: true };
  }
  return { notes: trimmed, truncated: false };
}

async function handleNotes(state: LabelState, promptNotesLine: () => Promise<string>): Promise<void> {
  const raw = await promptNotesLine();
  const { notes, truncated } = sanitizeNotes(raw);
  state.notes = notes;
  if (truncated) {
    renderWarning(`notes truncated to ${NOTES_MAX_LEN} chars`);
  }
}

export interface EditSelection {
  index: number; // 0-based within the supplied history slice
}

export async function handleEdit(
  history: GoldLabel[],
  sampleMap: Map<string, SampleRecord>,
  outputPath: string,
  readKey: () => Promise<Buffer>,
  promptNotesLine: () => Promise<string>,
  now: () => Date,
  existingLabels: Map<string, GoldLabel>,
  botQQ: string | null = null,
): Promise<boolean> {
  if (history.length === 0) {
    renderWarning('(no previous labels — nothing to edit)');
    return false;
  }
  const slice = history.slice(-5);
  renderEditMenu(slice);
  const key = await readKey();
  const ch = String.fromCharCode(key[0] ?? 0);
  const idx = Number.parseInt(ch, 10);
  if (!Number.isFinite(idx) || idx < 1 || idx > slice.length) {
    return false;
  }
  const chosen = slice[idx - 1]!;
  const sample = sampleMap.get(chosen.sampleId);
  if (!sample) {
    renderWarning(`(no cached sample record for ${chosen.sampleId} — cannot edit)`);
    return false;
  }

  const state: LabelState = {
    goldAct: chosen.goldAct,
    goldDecision: chosen.goldDecision,
    targetOk: chosen.targetOk,
    factNeeded: chosen.factNeeded,
    allowBanter: chosen.allowBanter,
    allowSticker: chosen.allowSticker,
    notes: chosen.notes,
  };
  const progress: Progress = { current: 0, total: 0, labeled: existingLabels.size, skipped: 0 };
  renderSample(sample, state, progress, botQQ);

  while (true) {
    const k = await readKey();
    const action = keyToAction(k);
    if (action.type === 'decision') state.goldDecision = action.value;
    else if (action.type === 'act') state.goldAct = action.value;
    else if (action.type === 'toggle') state[action.field] = !state[action.field];
    else if (action.type === 'notes') await handleNotes(state, promptNotesLine);
    else if (action.type === 'skip' || action.type === 'quit') return false;
    else if (action.type === 'unknown') {
      renderWarning(`unknown key: ${action.key}`);
      continue;
    }
    renderSample(sample, state, progress, botQQ);
    if (state.goldAct && state.goldDecision) {
      const updated = buildLabel(chosen.sampleId, state, now());
      await updateLabel(outputPath, updated);
      const pos = history.findIndex(h => h.sampleId === updated.sampleId);
      if (pos >= 0) history[pos] = updated;
      existingLabels.set(updated.sampleId, updated);
      renderConfirmation(updated);
      return true;
    }
  }
}

const TIMEOUT_SENTINEL = Symbol('quit-timeout');

async function handleQuit(
  state: LabelState,
  readKey: () => Promise<Buffer>,
  quitTimeoutMs: number,
  labeled: number,
): Promise<boolean> {
  const incomplete = !!(state.goldAct || state.goldDecision);
  renderQuitConfirm(labeled, incomplete);
  if (quitTimeoutMs <= 0) {
    // Tests / explicit disable: wait for keypress, no timeout.
    const key = await readKey();
    return keyToAction(key).type === 'quit';
  }
  const timeoutP = new Promise<typeof TIMEOUT_SENTINEL>(resolve => {
    const t = setTimeout(() => resolve(TIMEOUT_SENTINEL), quitTimeoutMs);
    t.unref?.();
  });
  const result = await Promise.race([readKey(), timeoutP]);
  if (result === TIMEOUT_SENTINEL) return false;
  return keyToAction(result).type === 'quit';
}

export async function runSession(opts: SessionOpts): Promise<SessionStats> {
  const delay = opts.delay ?? defaultDelay;
  const now = opts.now ?? (() => new Date());
  const quitTimeoutMs = typeof opts.quitTimeoutMs === 'number' ? opts.quitTimeoutMs : 3000;
  const botQQ = opts.botQQ ?? null;

  const existingLabels = await readExistingLabels(opts.outputPath);
  const history: GoldLabel[] = [...existingLabels.values()];
  const sampleMap = new Map<string, SampleRecord>();

  const stats: SessionStats = {
    labeled: 0,
    skipped: 0,
    totalPresented: 0,
    actDist: {},
    outputPath: opts.outputPath,
  };

  const diag = () => getDiagnostics(opts.inputPath);
  const diagAtStart = diag();
  if (diagAtStart.malformedLineNumbers.length > 0) {
    renderWarning(`malformed input lines (prior run): ${diagAtStart.malformedLineNumbers.join(',')}`);
  }

  let quit = false;

  outer: for await (const sample of readSamples(opts.inputPath)) {
    sampleMap.set(sample.sampleId, sample);
    if (existingLabels.has(sample.sampleId)) continue;
    if (typeof opts.limit === 'number' && stats.totalPresented >= opts.limit) break;
    stats.totalPresented++;

    const state: LabelState = defaultLabelState();
    const totalForProgress = typeof opts.total === 'number'
      ? opts.total
      : typeof opts.limit === 'number' ? opts.limit : 0;
    const progress: Progress = {
      current: stats.totalPresented,
      total: totalForProgress,
      labeled: stats.labeled,
      skipped: stats.skipped,
    };
    renderSample(sample, state, progress, botQQ);

    // Inner key loop for this sample
    // Exits when: committed (act+decision both set), skipped, or quit confirmed.
    while (true) {
      const key = await opts.readKey();
      const action: Action = keyToAction(key);

      if (action.type === 'decision') {
        state.goldDecision = action.value;
      } else if (action.type === 'act') {
        state.goldAct = action.value;
      } else if (action.type === 'toggle') {
        state[action.field] = !state[action.field];
      } else if (action.type === 'notes') {
        await handleNotes(state, opts.promptNotesLine);
      } else if (action.type === 'skip') {
        stats.skipped++;
        break;
      } else if (action.type === 'edit') {
        await handleEdit(
          history,
          sampleMap,
          opts.outputPath,
          opts.readKey,
          opts.promptNotesLine,
          now,
          existingLabels,
          botQQ,
        );
      } else if (action.type === 'quit') {
        const confirmed = await handleQuit(state, opts.readKey, quitTimeoutMs, stats.labeled);
        if (confirmed) { quit = true; break; }
      } else {
        renderWarning(`unknown key: ${action.key}`);
      }

      if (quit) break outer;

      renderSample(sample, state, {
        ...progress,
        labeled: stats.labeled,
        skipped: stats.skipped,
      }, botQQ);

      if (state.goldAct && state.goldDecision) {
        const label = buildLabel(sample.sampleId, state, now());
        await appendLabel(opts.outputPath, label);
        history.push(label);
        existingLabels.set(label.sampleId, label);
        stats.labeled++;
        stats.actDist[label.goldAct as GoldAct] = (stats.actDist[label.goldAct as GoldAct] ?? 0) + 1;
        renderConfirmation(label);
        await delay(10);
        break;
      }
    }

    if (quit) break;
  }

  renderSummary(stats);
  return stats;
}
