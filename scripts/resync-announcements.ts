#!/usr/bin/env tsx
/**
 * One-shot re-sync of all stored group announcements.
 * Re-parses every row in group_announcements via Claude with the current prompt,
 * then replaces all announcement-sourced rules in the rules table.
 *
 * Usage:
 *   npx tsx scripts/resync-announcements.ts [--db data/bot.db] [--dry-run]
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { ClaudeClient } from '../src/ai/claude.js';
import { _isRealRule } from '../src/modules/announcement-sync.js';
import { initLogger, createLogger } from '../src/utils/logger.js';

initLogger({ level: 'info' });
const logger = createLogger('resync-announcements');

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dbPath = args[args.indexOf('--db') + 1] ?? 'data/bot.db';
const dryRun = args.includes('--dry-run');

// ── Helpers ─────────────────────────────────────────────────────────────────

async function parseRules(claude: ClaudeClient, content: string): Promise<string[]> {
  const response = await claude.complete({
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 1000,
    system: [{ text: '你是一个群规提取助手。', cache: true }],
    messages: [{
      role: 'user',
      content: `从以下公告提取群规。每条规则一行，简短陈述。\n如果公告中完全没有群规（例如活动通知、抢票信息），只输出一行：NONE\n禁止输出任何解释、meta 注释、"该公告不含群规"之类的文字。\n\n${content}`,
    }],
  });

  const raw = response.text.trim();
  if (raw === 'NONE' || raw === '') return [];
  return raw.split('\n').map(l => l.trim()).filter(l => _isRealRule(l));
}

// ── Main ─────────────────────────────────────────────────────────────────────

const db = new DatabaseSync(path.resolve(dbPath));
const claude = new ClaudeClient();

interface AnnRow {
  id: number;
  group_id: string;
  notice_id: string;
  content: string;
}

const announcements = db.prepare('SELECT id, group_id, notice_id, content FROM group_announcements ORDER BY group_id, id').all() as unknown as AnnRow[];

logger.info({ total: announcements.length, dryRun }, 'Starting announcement re-sync');

let noticesProcessed = 0;
let rulesInserted = 0;

// Group by group_id
const byGroup = new Map<string, AnnRow[]>();
for (const ann of announcements) {
  const list = byGroup.get(ann.group_id) ?? [];
  list.push(ann);
  byGroup.set(ann.group_id, list);
}

for (const [groupId, notices] of byGroup) {
  logger.info({ groupId, count: notices.length }, 'Processing group');

  const allRules: string[] = [];

  for (const notice of notices) {
    let rules: string[];
    try {
      rules = await parseRules(claude, notice.content);
    } catch (err) {
      logger.warn({ err, noticeId: notice.notice_id }, 'Claude failed — skipping notice');
      rules = [];
    }

    logger.info({ noticeId: notice.notice_id, ruleCount: rules.length }, 'Parsed notice');

    if (!dryRun) {
      db.prepare('UPDATE group_announcements SET parsed_rules = ? WHERE id = ?')
        .run(JSON.stringify(rules), notice.id);
    }

    for (const r of rules) allRules.push(r);
    noticesProcessed++;
  }

  if (!dryRun) {
    db.prepare("DELETE FROM rules WHERE group_id = ? AND source = 'announcement'").run(groupId);

    for (const ruleText of allRules) {
      db.prepare(
        "INSERT INTO rules (group_id, content, type, source) VALUES (?, ?, 'positive', 'announcement')"
      ).run(groupId, ruleText);
      rulesInserted++;
    }
  } else {
    rulesInserted += allRules.length;
  }

  logger.info({ groupId, ruleCount: allRules.length }, 'Group done');
}

db.close();

const dryTag = dryRun ? ' [DRY RUN]' : '';
console.log(`\nDone${dryTag}: ${noticesProcessed} notices processed, ${rulesInserted} rules inserted.`);
