/**
 * R6.2 gold-label CLI — keystroke to Action mapping.
 * Raw stdin in TTY mode delivers Buffers; we map the first byte only.
 */

import { GOLD_ACTS, type GoldAct, type GoldDecision } from './types.js';

export type ToggleField = 'targetOk' | 'factNeeded' | 'allowBanter' | 'allowSticker';

export type Action =
  | { type: 'decision'; value: GoldDecision }
  | { type: 'act'; value: GoldAct }
  | { type: 'toggle'; field: ToggleField }
  | { type: 'notes' }
  | { type: 'skip' }
  | { type: 'edit' }
  | { type: 'quit' }
  | { type: 'unknown'; key: string };

const ACT_BY_DIGIT: Record<string, GoldAct> = {
  '1': GOLD_ACTS[0], // direct_chat
  '2': GOLD_ACTS[1], // chime_in
  '3': GOLD_ACTS[2], // conflict_handle
  '4': GOLD_ACTS[3], // summarize
  '5': GOLD_ACTS[4], // bot_status_query
  '6': GOLD_ACTS[5], // relay
  '7': GOLD_ACTS[6], // meta_admin_status
  '8': GOLD_ACTS[7], // object_react
  '9': GOLD_ACTS[8], // silence
};

export function keyToAction(key: Buffer): Action {
  if (key.length === 0) return { type: 'unknown', key: '' };
  const first = key[0]!;
  if (first === 0x03) return { type: 'quit' }; // Ctrl+C
  const ch = String.fromCharCode(first);

  if (ch === 'r') return { type: 'decision', value: 'reply' };
  if (ch === 's') return { type: 'decision', value: 'silent' };
  if (ch === 'd') return { type: 'decision', value: 'defer' };

  const act = ACT_BY_DIGIT[ch];
  if (act) return { type: 'act', value: act };

  if (ch === 'b') return { type: 'toggle', field: 'allowSticker' };
  if (ch === 'B') return { type: 'toggle', field: 'allowBanter' };
  if (ch === 'f') return { type: 'toggle', field: 'factNeeded' };
  if (ch === 't') return { type: 'toggle', field: 'targetOk' };

  if (ch === 'n') return { type: 'notes' };
  if (ch === 'k') return { type: 'skip' };
  if (ch === 'e') return { type: 'edit' };
  if (ch === 'q') return { type: 'quit' };

  return { type: 'unknown', key: ch };
}

export const HELP_TEXT = [
  'DECISION  [r]eply  [s]ilent  [d]efer',
  'ACT       [1]direct_chat [2]chime_in [3]conflict_handle [4]summarize',
  '          [5]bot_status_query [6]relay [7]meta_admin_status [8]object_react [9]silence',
  'TOGGLES   [t]argetOk  [f]actNeeded  [b]allowSticker  [B]allowBanter',
  'OTHER     [n]otes  [k]skip  [e]dit-prev  [q]uit',
].join('\n');
