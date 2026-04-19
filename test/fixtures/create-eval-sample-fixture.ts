#!/usr/bin/env tsx
/**
 * Creates a synthetic 100-row eval-sample.sqlite fixture for integration tests.
 * Run: npx tsx test/fixtures/create-eval-sample-fixture.ts
 *
 * The fixture is committed to the repo (small, no PII).
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, '../../src/storage/schema.sql');
const outPath = path.join(__dirname, 'eval-sample.sqlite');

const db = new DatabaseSync(outPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(readFileSync(schemaPath, 'utf8'));

const GROUP_ID = 'test-group-001';
const BOT_USER_ID = '99999';
const BASE_TS = 1700000000;

const insertMsg = db.prepare(
  `INSERT OR IGNORE INTO messages (group_id, user_id, nickname, content, raw_content, timestamp, deleted, source_message_id)
   VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
);

const insertFact = db.prepare(
  `INSERT OR IGNORE INTO learned_facts (group_id, topic, fact, confidence, status, created_at, updated_at, canonical_form)
   VALUES (?, ?, ?, 1.0, 'active', ?, ?, ?)`
);

const now = BASE_TS;

// Insert a known fact for 'known_fact_term' category
insertFact.run(GROUP_ID, 'user:ykn', 'ykn=凑友希那', now, now, 'ykn');

// Helper: insert a batch of messages
let msgId = 1;
function ins(userId: string, nickname: string, content: string, raw?: string, tsOffset = 0): void {
  insertMsg.run(
    GROUP_ID,
    userId,
    nickname,
    content,
    raw ?? content,
    BASE_TS + tsOffset + msgId,
    `src-${msgId}`,
  );
  msgId++;
}

// 10x silence candidates (single speaker monologue)
for (let i = 0; i < 10; i++) {
  for (let j = 0; j < 6; j++) ins('user1', 'Alice', `monologue msg ${i}-${j}`);
  ins('user1', 'Alice', `trigger silence ${i}`);
}

// 10x normal chime candidates (2+ speakers in context)
for (let i = 0; i < 10; i++) {
  for (let j = 0; j < 3; j++) ins('user1', 'Alice', `chat A ${i}-${j}`);
  for (let j = 0; j < 2; j++) ins('user2', 'Bob', `chat B ${i}-${j}`);
  ins('user2', 'Bob', `chime trigger ${i}`);
}

// 10x relay repeaters (扣1 chain)
for (let i = 0; i < 10; i++) {
  ins('user1', 'Alice', '扣1');
  ins('user2', 'Bob', '扣1');
  ins('user3', 'Carol', '扣1');
  ins('user4', 'Dave', '扣1'); // trigger
}

// 10x rhetorical banter
for (let i = 0; i < 10; i++) {
  ins('user1', 'Alice', '好吧');
  ins('user2', 'Bob', '确实确实');
  ins('user1', 'Alice', '哈哈哈哈哈哈');
}

// 10x direct_at_reply (bot @-mentioned)
for (let i = 0; i < 10; i++) {
  ins('user1', 'Alice', `你好啊`, `你好啊[CQ:at,qq=${BOT_USER_ID}]`);
  ins('user2', 'Bob', `bot help`, `[CQ:at,qq=${BOT_USER_ID}]帮我看看`);
}

// 10x image/mface
for (let i = 0; i < 10; i++) {
  ins('user1', 'Alice', '', '[CQ:image,file=abc.jpg]');
  ins('user2', 'Bob', '', '[CQ:mface,id=123]');
}

// 10x known_fact_term (uses 'ykn' which is in learned_facts)
for (let i = 0; i < 10; i++) {
  ins('user1', 'Alice', 'ykn是谁啊');
  ins('user2', 'Bob', 'ykn很厉害的');
}

// 10x conflict_heat
for (let i = 0; i < 10; i++) {
  ins('user1', 'Alice', '你真的好蠢');
  ins('user2', 'Bob', '你去死吧');
  ins('user3', 'Carol', '滚滚滚');
}

// 10x bot_status_context
for (let i = 0; i < 10; i++) {
  ins('user1', 'Alice', '机器人怎么了');
  ins('user2', 'Bob', '禁言策略改了吗');
  ins('user1', 'Alice', 'bot关了?');
}

// 10x burst_non_direct (≥5 msgs in 15s, no @bot) — same timestamp offset
for (let i = 0; i < 10; i++) {
  const tsBase = i * 100;
  for (let j = 0; j < 6; j++) {
    insertMsg.run(
      GROUP_ID,
      `user${j + 1}`,
      `User${j + 1}`,
      `burst msg ${i}-${j}`,
      `burst msg ${i}-${j}`,
      BASE_TS + tsBase + j,
      `burst-src-${i}-${j}`,
    );
  }
}

db.close();
console.log(`Fixture written to ${outPath} (${msgId - 1} messages)`);
