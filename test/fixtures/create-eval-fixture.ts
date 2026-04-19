#!/usr/bin/env tsx
/**
 * Creates test/fixtures/eval-sample.sqlite — a small synthetic DB for R6.1 tests.
 * Run once: npx tsx test/fixtures/create-eval-fixture.ts
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, 'eval-sample.sqlite');
const schemaPath = path.join(__dirname, '../../src/storage/schema.sql');

const db = new DatabaseSync(outPath);
db.exec('PRAGMA journal_mode = DELETE;');
db.exec(readFileSync(schemaPath, 'utf8'));

const GROUP = 'test-group-001';
const BOT_QQ = '12345';
const BASE = 1700000000;

const insMsg = db.prepare(
  `INSERT OR IGNORE INTO messages (group_id, user_id, nickname, content, raw_content, timestamp, deleted, source_message_id)
   VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
);

let seq = 1;
function msg(userId: string, nick: string, content: string, raw: string, ts: number): void {
  insMsg.run(GROUP, userId, nick, content, raw, ts, `src-${seq++}`);
}

// Cat 1 — direct @bot (3 rows)
msg('u1', 'Alice', '帮我看看', `[CQ:at,qq=${BOT_QQ}]帮我看看`, BASE + 1);
msg('u2', 'Bob', '问一下', `你好[CQ:at,qq=${BOT_QQ}]`, BASE + 2);
msg('u3', 'Carol', '有人吗', `[CQ:at,qq=${BOT_QQ}]有人吗`, BASE + 3);

// Cat 2 — known-fact-term: content contains 'ykn' (fact in learned_facts)
msg('u1', 'Alice', 'ykn是谁啊', 'ykn是谁啊', BASE + 10);
msg('u2', 'Bob', '说说ykn', '说说ykn', BASE + 11);
msg('u3', 'Carol', '你知道ykn吗', '你知道ykn吗', BASE + 12);

// Cat 3 — rhetorical banter (3 rows)
msg('u1', 'Alice', '啥情况这是', '啥情况这是', BASE + 20);
msg('u2', 'Bob', '无语了哈哈哈', '无语了哈哈哈', BASE + 21);
msg('u3', 'Carol', '离谱！笑死', '离谱！笑死', BASE + 22);

// Cat 4 — image/mface (3 rows)
msg('u1', 'Alice', '', '[CQ:image,file=abc.jpg,url=x]', BASE + 30);
msg('u2', 'Bob', '', '[CQ:mface,id=99]', BASE + 31);
msg('u3', 'Carol', '哈哈', '[CQ:image,file=def.jpg]哈哈', BASE + 32);

// Cat 5 — bot status context (3 rows)
msg('u1', 'Alice', '机器人怎么了', '机器人怎么了', BASE + 40);
msg('u2', 'Bob', '禁言策略变了吗', '禁言策略变了吗', BASE + 41);
msg('u3', 'Carol', '你怎么不回', '你怎么不回', BASE + 42);

// Cat 6 — burst: 5 messages within 15 seconds (timestamps BASE+50 to BASE+54)
for (let i = 0; i < 5; i++) {
  msg(`u${i + 1}`, `User${i + 1}`, `burst ${i}`, `burst ${i}`, BASE + 50 + i);
}

// Cat 7 — relay: content = '1' or '扣1' (3 rows)
msg('u1', 'Alice', '扣1', '扣1', BASE + 60);
msg('u2', 'Bob', '扣1', '扣1', BASE + 61);
msg('u3', 'Carol', '扣1', '扣1', BASE + 62);
// also a plain '1' relay
msg('u1', 'Alice', '1', '1', BASE + 63);

// Cat 8 — conflict (3 rows matching sb / 傻逼 / 滚)
msg('u1', 'Alice', '你真sb', '你真sb', BASE + 70);
msg('u2', 'Bob', '傻逼', '傻逼', BASE + 71);
msg('u3', 'Carol', '给我滚', '给我滚', BASE + 72);

// Cat 9 — normal chime-in: 3+ distinct users in 120s window, no @, content >= 5 chars
// Need 3 users within 120s and content >= 5 chars
msg('u1', 'Alice', '今天天气真好啊', '今天天气真好啊', BASE + 80);
msg('u2', 'Bob', '是啊出去玩了', '是啊出去玩了', BASE + 81);
msg('u3', 'Carol', '我也想去啊', '我也想去啊', BASE + 82);
msg('u1', 'Alice', '下午一起去吗', '下午一起去吗', BASE + 100);
msg('u2', 'Bob', '可以啊几点', '可以啊几点', BASE + 101);
msg('u4', 'Dave', '我也要去', '我也要去', BASE + 110);

// Cat 10 — silence: short content or no following messages
// Insert some very short messages
msg('u1', 'Alice', '嗯', '嗯', BASE + 200);
msg('u2', 'Bob', '哦', '哦', BASE + 201);
msg('u3', 'Carol', '好', '好', BASE + 202);
// A message with no followup (far future timestamp so no m2.timestamp > m.timestamp within 300s)
msg('u1', 'Alice', '收到了', '收到了', BASE + 2000);

// Admin command row (should be excluded from labeled output)
msg('admin1', 'AdminUser', '/rule_add no spam', '/rule_add no spam', BASE + 300);

// learned_facts for cat2 testing
db.prepare(
  `INSERT OR IGNORE INTO learned_facts (group_id, topic, fact, confidence, status, created_at, updated_at, canonical_form)
   VALUES (?, ?, ?, 1.0, 'active', ?, ?, ?)`
).run(GROUP, 'user:ykn', 'ykn=凑友希那', BASE, BASE, 'ykn');

// Null-topic rows — must NOT crash queryCat2 (regression guard for R6.1 hotfix)
// Row with null topic but valid canonical_form: should still match via canonical_form
db.prepare(
  `INSERT OR IGNORE INTO learned_facts (group_id, topic, fact, confidence, status, created_at, updated_at, canonical_form)
   VALUES (?, NULL, ?, 1.0, 'active', ?, ?, ?)`
).run(GROUP, 'null-topic fact', BASE, BASE, 'null-topic-canonical');

// Row with both topic and canonical_form null: produces no patterns, must not crash
db.prepare(
  `INSERT OR IGNORE INTO learned_facts (group_id, topic, fact, confidence, status, created_at, updated_at, canonical_form)
   VALUES (?, NULL, ?, 1.0, 'active', ?, ?, NULL)`
).run(GROUP, 'all-null row', BASE, BASE);

db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
db.close();
console.log(`Fixture written: ${outPath} (${seq - 1} rows)`);
