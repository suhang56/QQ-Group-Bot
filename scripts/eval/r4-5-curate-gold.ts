#!/usr/bin/env tsx
/**
 * R4.5 gold curator — emits a TODO-fill JSONL by sampling chat_decision_events
 * by stratum and joining messages for trigger_content + recent5.
 *
 * Output: data/eval/gold/r4-5-utterance-act-gold-200.jsonl with `gold: null`
 * on every row. Human edits each row to set the final label, then re-runs
 * the gates CLI.
 *
 * Stratum SQL per DESIGN §10.3:
 *   chime_in (80), direct_chat (30), meta_admin_status (25), relay (15),
 *   bot_status_query (10), oversample-image (20), oversample-conflict (10),
 *   oversample-summary (10).
 */

import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

interface EventRow {
  id: number;
  group_id: string;
  trigger_msg_id: string | null;
  trigger_user_id: string | null;
  utterance_act: string | null;
  captured_at_sec: number;
}

interface MessageRow {
  user_id: string;
  content: string;
  timestamp: number;
}

interface GoldRow {
  event_id: number;
  group_id: string;
  trigger_msg_id: string | null;
  trigger_user_id: string | null;
  trigger_content: string;
  recent5: Array<{ user_id: string; content: string }>;
  rule_based: string;
  gold: string | null;
  captured_at_sec: number;
  stratum: string;
  notes?: string;
}

interface Stratum {
  name: string;
  n: number;
  whereExtra: string;
}

const STRATA: Stratum[] = [
  { name: 'chime_in', n: 80, whereExtra: `utterance_act = 'chime_in'` },
  { name: 'direct_chat', n: 30, whereExtra: `utterance_act = 'direct_chat'` },
  { name: 'meta_admin_status', n: 25, whereExtra: `utterance_act = 'meta_admin_status'` },
  { name: 'relay', n: 15, whereExtra: `utterance_act = 'relay'` },
  { name: 'bot_status_query', n: 10, whereExtra: `utterance_act = 'bot_status_query'` },
];

interface OversampleStratum {
  name: string;
  n: number;
  triggerLike: string[];
}

const OVERSAMPLE: OversampleStratum[] = [
  { name: 'oversample_image', n: 20, triggerLike: ['%[CQ:image,%', '%[CQ:mface,%'] },
  { name: 'oversample_conflict', n: 10, triggerLike: ['%吵%', '%怼%', '%杠%', '%撕%'] },
  { name: 'oversample_summary', n: 10, triggerLike: ['%前情%', '%复盘%', '%啥情况%', '%总结%'] },
];

function sampleStratum(db: DatabaseSync, stratum: Stratum): EventRow[] {
  const sql = `
    SELECT id, group_id, trigger_msg_id, trigger_user_id, utterance_act, captured_at_sec
      FROM chat_decision_events
     WHERE captured_at_sec >= unixepoch('2026-04-15')
       AND utterance_act IS NOT NULL
       AND ${stratum.whereExtra}
     ORDER BY RANDOM()
     LIMIT ?
  `;
  return db.prepare(sql).all(stratum.n) as unknown as EventRow[];
}

function sampleOversample(db: DatabaseSync, ov: OversampleStratum): EventRow[] {
  // Join messages on trigger_msg_id for content LIKE filter.
  const placeholders = ov.triggerLike.map(() => 'm.content LIKE ?').join(' OR ');
  const sql = `
    SELECT e.id, e.group_id, e.trigger_msg_id, e.trigger_user_id, e.utterance_act, e.captured_at_sec
      FROM chat_decision_events e
      JOIN messages m ON m.source_message_id = e.trigger_msg_id
     WHERE e.captured_at_sec >= unixepoch('2026-04-15')
       AND e.utterance_act = 'chime_in'
       AND (${placeholders})
     ORDER BY RANDOM()
     LIMIT ?
  `;
  return db.prepare(sql).all(...ov.triggerLike, ov.n) as unknown as EventRow[];
}

function loadTriggerContent(db: DatabaseSync, triggerMsgId: string | null): string {
  if (triggerMsgId === null) return '';
  const row = db.prepare(`SELECT content FROM messages WHERE source_message_id = ?`).get(triggerMsgId) as { content?: string } | undefined;
  return row?.content ?? '';
}

function loadRecent5(db: DatabaseSync, groupId: string, beforeSec: number): Array<{ user_id: string; content: string }> {
  const rows = db.prepare(`
    SELECT user_id, content, timestamp
      FROM messages
     WHERE group_id = ? AND timestamp < ? AND deleted = 0
     ORDER BY timestamp DESC
     LIMIT 5
  `).all(groupId, beforeSec) as unknown as MessageRow[];
  return rows.reverse().map(r => ({ user_id: r.user_id, content: r.content }));
}

export function curate(dbPath: string, outPath: string): GoldRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const out: GoldRow[] = [];
  try {
    for (const s of STRATA) {
      for (const e of sampleStratum(db, s)) {
        out.push({
          event_id: e.id,
          group_id: e.group_id,
          trigger_msg_id: e.trigger_msg_id,
          trigger_user_id: e.trigger_user_id,
          trigger_content: loadTriggerContent(db, e.trigger_msg_id),
          recent5: loadRecent5(db, e.group_id, e.captured_at_sec),
          rule_based: e.utterance_act ?? '',
          gold: null,
          captured_at_sec: e.captured_at_sec,
          stratum: s.name,
        });
      }
    }
    for (const ov of OVERSAMPLE) {
      for (const e of sampleOversample(db, ov)) {
        out.push({
          event_id: e.id,
          group_id: e.group_id,
          trigger_msg_id: e.trigger_msg_id,
          trigger_user_id: e.trigger_user_id,
          trigger_content: loadTriggerContent(db, e.trigger_msg_id),
          recent5: loadRecent5(db, e.group_id, e.captured_at_sec),
          rule_based: e.utterance_act ?? '',
          gold: null,
          captured_at_sec: e.captured_at_sec,
          stratum: ov.name,
        });
      }
    }
  } finally {
    db.close();
  }
  mkdirSync(dirname(outPath), { recursive: true });
  const lines = out.map(r => JSON.stringify(r)).join('\n');
  writeFileSync(outPath, lines + '\n', 'utf-8');
  return out;
}

const isDirectExec = (() => {
  const argv1 = process.argv[1];
  if (typeof argv1 !== 'string') return false;
  return argv1.includes('r4-5-curate-gold');
})();

if (isDirectExec) {
  const dbPath = process.argv[2] ?? 'data/bot.db';
  const outPath = process.argv[3] ?? 'data/eval/gold/r4-5-utterance-act-gold-200.jsonl';
  const rows = curate(dbPath, outPath);
  process.stdout.write(`curated ${rows.length} rows → ${outPath}\n`);
}
