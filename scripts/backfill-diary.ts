#!/usr/bin/env tsx
/**
 * backfill-diary.ts
 *
 * One-shot bootstrap of group_diary rows from existing message history.
 * Iterates daily windows oldest-first, then optionally rolls up weekly/monthly.
 *
 * CLI:
 *   BOT_QQ_ID=<id> npx tsx scripts/backfill-diary.ts \
 *     --group <group-id> \
 *     [--days 7] \
 *     [--kind daily|weekly|monthly|all] \
 *     [--model claude-sonnet-4-6[1m]] \
 *     [--dry-run]
 */

import path from 'node:path';
import { Database } from '../src/storage/db.js';
import { ClaudeClient } from '../src/ai/claude.js';
import {
  DiaryDistiller,
  yesterdayShanghaiWindow,
  prevWeekShanghaiWindow,
  prevMonthShanghaiWindow,
} from '../src/modules/diary-distiller.js';
import { REFLECTION_MODEL } from '../src/config.js';

const DAY_MS = 86_400_000;

export interface Args {
  group: string;
  days: number;
  kind: 'daily' | 'weekly' | 'monthly' | 'all';
  model: string;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    group: '',
    days: 7,
    kind: 'daily',
    model: REFLECTION_MODEL,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') {
      args.dryRun = true;
    } else if (flag === '--group') {
      args.group = argv[++i] ?? '';
    } else if (flag === '--days') {
      args.days = parseInt(argv[++i] ?? '', 10);
    } else if (flag === '--kind') {
      args.kind = (argv[++i] ?? 'daily') as Args['kind'];
    } else if (flag === '--model') {
      args.model = argv[++i] ?? REFLECTION_MODEL;
    }
  }

  if (!args.group) {
    console.error('[ERROR] --group is required');
    process.exit(2);
  }
  if (isNaN(args.days) || args.days < 1 || args.days > 30) {
    console.error('[ERROR] --days must be between 1 and 30');
    process.exit(2);
  }
  const validKinds = ['daily', 'weekly', 'monthly', 'all'];
  if (!validKinds.includes(args.kind)) {
    console.error(`[ERROR] --kind must be one of: ${validKinds.join(', ')}`);
    process.exit(2);
  }

  return args;
}

export function checkRequiredEnv(): void {
  if (!process.env['BOT_QQ_ID']) {
    console.error('[ERROR] BOT_QQ_ID env var is required');
    process.exit(1);
  }
}

export function openDatabase(dbPath: string): Database {
  try {
    return new Database(dbPath);
  } catch (err) {
    console.error(`[ERROR] Failed to open database at ${dbPath}: ${(err as Error).message}`);
    process.exit(1);
  }
}

export function shanghaiDateLabel(startSec: number): string {
  const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;
  const d = new Date(startSec * 1000 + SHANGHAI_OFFSET_MS);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function buildDayWindows(
  days: number,
  nowMs: number = Date.now(),
): Array<{ startSec: number; endSec: number; label: string }> {
  const result = [];
  for (let offset = days; offset >= 1; offset--) {
    const { startSec, endSec } = yesterdayShanghaiWindow(nowMs - (offset - 1) * DAY_MS);
    const label = shanghaiDateLabel(startSec);
    result.push({ startSec, endSec, label });
  }
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runDaily(
  distiller: DiaryDistiller,
  db: Database,
  args: Args,
  windows: Array<{ startSec: number; endSec: number; label: string }>,
): Promise<void> {
  for (const { startSec, endSec, label } of windows) {
    const existing = db.groupDiary.findByPeriod(args.group, 'daily', startSec, endSec);
    if (existing.length > 0) {
      console.log(`[SKIP] ${label} daily already exists`);
      continue;
    }
    const t0 = Date.now();
    try {
      // startSec is midnight Shanghai UTC; add one day so yesterdayShanghaiWindow(nowMs) resolves back to this window
      const nowMs = (startSec + 86_400) * 1000;
      const result = await distiller.generateDaily(args.group, nowMs);
      if (result === 0) {
        console.log(`[SKIP] ${label} daily — no messages or LLM refused`);
      } else {
        console.log(`[OK]   ${label} daily generated (${Date.now() - t0}ms)`);
      }
    } catch (err) {
      console.log(`[FAIL] ${label} daily: ${(err as Error).message}`);
    }
    await delay(500);
  }
}

export async function runWeekly(
  distiller: DiaryDistiller,
  db: Database,
  args: Args,
): Promise<void> {
  const { startSec, endSec } = prevWeekShanghaiWindow(Date.now());
  const existing = db.groupDiary.findByPeriod(args.group, 'weekly', startSec, endSec);
  if (existing.length > 0) {
    console.log(`[SKIP] week ${shanghaiDateLabel(startSec)}-${shanghaiDateLabel(endSec)} weekly already exists`);
    return;
  }
  const dailies = db.groupDiary.findByPeriod(args.group, 'daily', startSec, endSec);
  if (dailies.length < 7) {
    console.log(`[WARN] week ${shanghaiDateLabel(startSec)}: only ${dailies.length}/7 daily rows — skipping weekly rollup`);
    return;
  }
  console.log(`[WARN] generateWeekly will delete ${dailies.length} daily rows for week ${shanghaiDateLabel(startSec)}-${shanghaiDateLabel(endSec)} — this is expected behavior`);
  try {
    const result = await distiller.generateWeekly(args.group, Date.now());
    if (result > 0) {
      console.log(`[OK]   week ${shanghaiDateLabel(startSec)}-${shanghaiDateLabel(endSec)} weekly generated — ${dailies.length} daily rows deleted`);
    } else {
      console.log(`[SKIP] week ${shanghaiDateLabel(startSec)}-${shanghaiDateLabel(endSec)} weekly — LLM refused or no data`);
    }
  } catch (err) {
    console.log(`[FAIL] weekly: ${(err as Error).message}`);
  }
}

export async function runMonthly(
  distiller: DiaryDistiller,
  db: Database,
  args: Args,
): Promise<void> {
  const { startSec, endSec } = prevMonthShanghaiWindow(Date.now());
  const existing = db.groupDiary.findByPeriod(args.group, 'monthly', startSec, endSec);
  if (existing.length > 0) {
    console.log(`[SKIP] month ${shanghaiDateLabel(startSec)}-${shanghaiDateLabel(endSec)} monthly already exists`);
    return;
  }
  const weeklies = db.groupDiary.findByPeriod(args.group, 'weekly', startSec, endSec);
  if (weeklies.length === 0) {
    console.log(`[WARN] month ${shanghaiDateLabel(startSec)}: no weekly rows found — skipping monthly rollup`);
    return;
  }
  console.log(`[WARN] generateMonthly will delete ${weeklies.length} weekly rows for month ${shanghaiDateLabel(startSec)}-${shanghaiDateLabel(endSec)} — this is expected behavior`);
  try {
    const result = await distiller.generateMonthly(args.group, Date.now());
    if (result > 0) {
      console.log(`[OK]   month ${shanghaiDateLabel(startSec)}-${shanghaiDateLabel(endSec)} monthly generated — ${weeklies.length} weekly rows deleted`);
    } else {
      console.log(`[SKIP] month ${shanghaiDateLabel(startSec)}-${shanghaiDateLabel(endSec)} monthly — LLM refused or no data`);
    }
  } catch (err) {
    console.log(`[FAIL] monthly: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  checkRequiredEnv();

  const dbPath = process.env['DB_PATH']
    ? path.resolve(process.env['DB_PATH'])
    : path.resolve('D:/QQ-Group-Bot/data/bot.db');
  console.log(`[INFO] DB path: ${dbPath}`);

  const db = openDatabase(dbPath);
  try {
    const claude = new ClaudeClient();
    const botUserId = process.env['BOT_QQ_ID']!;
    const distiller = new DiaryDistiller({
      claude,
      messages: db.messages,
      groupDiary: db.groupDiary,
      botUserId,
      model: args.model,
    });
    const windows = buildDayWindows(args.days);

    if (args.dryRun) {
      for (const w of windows) {
        const existing = db.groupDiary.findByPeriod(args.group, 'daily', w.startSec, w.endSec);
        console.log(`[DRY]  ${w.label} daily would generate (window ${w.startSec}-${w.endSec}, ${existing.length} existing rows)`);
      }
      return;
    }

    if (args.kind === 'daily' || args.kind === 'all') await runDaily(distiller, db, args, windows);
    if (args.kind === 'weekly' || args.kind === 'all') await runWeekly(distiller, db, args);
    if (args.kind === 'monthly' || args.kind === 'all') await runMonthly(distiller, db, args);
  } finally {
    db.close();
  }
  process.exit(0);
}

// Only run when executed directly, not when imported by tests
const isMain = process.argv[1]?.endsWith('backfill-diary.ts') ||
  process.argv[1]?.endsWith('backfill-diary.js');
if (isMain) void main();
