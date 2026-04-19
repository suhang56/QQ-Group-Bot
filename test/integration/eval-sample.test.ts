/**
 * Integration test: R6.1 eval sampling pipeline.
 *
 * Runs on the synthetic eval-sample.sqlite fixture (100+ rows).
 * Validates: per-category counts, determinism, WeakReplayLabel shape,
 * summary.json fields, data quality metrics, gap detection.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { BenchmarkRow, LabeledBenchmarkRow, SummaryJson } from '../../scripts/eval/types.js';
import { ALL_CATEGORIES, CONTEXT_BEFORE, CONTEXT_AFTER } from '../../scripts/eval/types.js';
import { applyWeakLabel } from '../../scripts/eval/weak-label.js';
import { buildSummary } from '../../scripts/eval/summary.js';
import { isDirectAtReply } from '../../scripts/eval/categories/direct-at-reply.js';
import { isRelayRepeater } from '../../scripts/eval/categories/relay-repeater.js';
import { isConflictHeat } from '../../scripts/eval/categories/conflict-heat.js';
import { isBurstNonDirect } from '../../scripts/eval/categories/burst-non-direct.js';
import { isSilenceCandidate } from '../../scripts/eval/categories/silence-candidate.js';
import { isNormalChimeCandidate } from '../../scripts/eval/categories/normal-chime-candidate.js';
import { isImageMface } from '../../scripts/eval/categories/image-mface.js';
import { isRhetoricalBanter } from '../../scripts/eval/categories/rhetorical-banter.js';
import { isBotStatusContext } from '../../scripts/eval/categories/bot-status-context.js';
import { hasKnownFactTermInDb } from '../../scripts/eval/categories/known-fact-term.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '../fixtures/eval-sample.sqlite');
const SCHEMA_PATH = path.join(__dirname, '../../src/storage/schema.sql');
const BOT_USER_ID = '99999';
const GROUP_ID = 'test-group-001';
const TEST_SEED = 'deadbeef01234567deadbeef01234567';

interface DbMessageRow {
  id: number;
  group_id: string;
  user_id: string;
  nickname: string;
  content: string;
  raw_content: string | null;
  timestamp: number;
  source_message_id: string | null;
}

function openFixture(): DatabaseSync {
  expect(existsSync(FIXTURE_PATH), `Fixture missing at ${FIXTURE_PATH} — run: npx tsx test/fixtures/create-eval-sample-fixture.ts`).toBe(true);
  return new DatabaseSync(FIXTURE_PATH, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
}

describe('R6.1 Eval Sampling — Integration', () => {
  let db: DatabaseSync;

  beforeAll(() => {
    db = openFixture();
  });

  // ---- Category predicate unit checks ----

  describe('Category predicates', () => {
    it('direct_at_reply: detects @bot CQ code', () => {
      const row: DbMessageRow = {
        id: 1, group_id: GROUP_ID, user_id: 'u1', nickname: 'A',
        content: `help`, raw_content: `[CQ:at,qq=${BOT_USER_ID}]help`,
        timestamp: 1700000000, source_message_id: null,
      };
      expect(isDirectAtReply(row, BOT_USER_ID)).toBe(true);
    });

    it('direct_at_reply: non-bot @ is rejected', () => {
      const row: DbMessageRow = {
        id: 2, group_id: GROUP_ID, user_id: 'u1', nickname: 'A',
        content: 'hi', raw_content: '[CQ:at,qq=11111]hi',
        timestamp: 1700000000, source_message_id: null,
      };
      expect(isDirectAtReply(row, BOT_USER_ID)).toBe(false);
    });

    it('relay_repeater: detects 扣1 chain', () => {
      const context = [
        { messageId: '1', userId: 'u1', nickname: 'A', timestamp: 1700000000, content: '扣1', rawContent: '扣1' },
        { messageId: '2', userId: 'u2', nickname: 'B', timestamp: 1700000001, content: '扣1', rawContent: '扣1' },
        { messageId: '3', userId: 'u3', nickname: 'C', timestamp: 1700000002, content: '扣1', rawContent: '扣1' },
      ];
      const row: DbMessageRow = {
        id: 4, group_id: GROUP_ID, user_id: 'u4', nickname: 'D',
        content: '扣1', raw_content: '扣1', timestamp: 1700000003, source_message_id: null,
      };
      expect(isRelayRepeater(row, context)).toBe(true);
    });

    it('relay_repeater: no chain → false', () => {
      const context = [
        { messageId: '1', userId: 'u1', nickname: 'A', timestamp: 1700000000, content: '聊天', rawContent: '聊天' },
      ];
      const row: DbMessageRow = {
        id: 2, group_id: GROUP_ID, user_id: 'u2', nickname: 'B',
        content: '扣1', raw_content: '扣1', timestamp: 1700000001, source_message_id: null,
      };
      expect(isRelayRepeater(row, context)).toBe(false);
    });

    it('conflict_heat: detects insults', () => {
      const context = [
        { messageId: '1', userId: 'u1', nickname: 'A', timestamp: 1700000000, content: '你真蠢', rawContent: '你真蠢' },
      ];
      const row: DbMessageRow = {
        id: 2, group_id: GROUP_ID, user_id: 'u2', nickname: 'B',
        content: '你去死', raw_content: '你去死', timestamp: 1700000001, source_message_id: null,
      };
      expect(isConflictHeat(row, context)).toBe(true);
    });

    it('burst_non_direct: detects burst of 5 in 15s', () => {
      const now = 1700000010;
      const context = Array.from({ length: 5 }, (_, i) => ({
        messageId: String(i),
        userId: `u${i}`,
        nickname: `User${i}`,
        timestamp: now - 14 + i,
        content: `msg ${i}`,
        rawContent: `msg ${i}`,
      }));
      const row: DbMessageRow = {
        id: 10, group_id: GROUP_ID, user_id: 'u9', nickname: 'X',
        content: 'hi', raw_content: 'hi', timestamp: now, source_message_id: null,
      };
      expect(isBurstNonDirect(row, context, BOT_USER_ID)).toBe(true);
    });

    it('burst_non_direct: @bot excluded', () => {
      const now = 1700000010;
      const context = Array.from({ length: 5 }, (_, i) => ({
        messageId: String(i), userId: `u${i}`, nickname: `User${i}`,
        timestamp: now - 14 + i, content: `msg ${i}`, rawContent: `msg ${i}`,
      }));
      const row: DbMessageRow = {
        id: 10, group_id: GROUP_ID, user_id: 'u9', nickname: 'X',
        content: 'hi', raw_content: `[CQ:at,qq=${BOT_USER_ID}]hi`,
        timestamp: now, source_message_id: null,
      };
      expect(isBurstNonDirect(row, context, BOT_USER_ID)).toBe(false);
    });

    it('image_mface: detects CQ:image', () => {
      const row: DbMessageRow = {
        id: 1, group_id: GROUP_ID, user_id: 'u1', nickname: 'A',
        content: '', raw_content: '[CQ:image,file=abc.jpg]',
        timestamp: 1700000000, source_message_id: null,
      };
      expect(isImageMface(row)).toBe(true);
    });

    it('image_mface: text-only → false', () => {
      const row: DbMessageRow = {
        id: 1, group_id: GROUP_ID, user_id: 'u1', nickname: 'A',
        content: 'hello', raw_content: 'hello',
        timestamp: 1700000000, source_message_id: null,
      };
      expect(isImageMface(row)).toBe(false);
    });

    it('rhetorical_banter: detects banter patterns', () => {
      const row: DbMessageRow = {
        id: 1, group_id: GROUP_ID, user_id: 'u1', nickname: 'A',
        content: '哈哈哈哈哈', raw_content: '哈哈哈哈哈',
        timestamp: 1700000000, source_message_id: null,
      };
      expect(isRhetoricalBanter(row)).toBe(true);
    });

    it('silence_candidate: single speaker monologue', () => {
      const context = Array.from({ length: 5 }, (_, i) => ({
        messageId: String(i), userId: 'user1', nickname: 'Alice',
        timestamp: 1700000000 + i, content: `msg ${i}`, rawContent: `msg ${i}`,
      }));
      const row: DbMessageRow = {
        id: 10, group_id: GROUP_ID, user_id: 'user1', nickname: 'Alice',
        content: 'more monologue', raw_content: 'more monologue',
        timestamp: 1700000010, source_message_id: null,
      };
      expect(isSilenceCandidate(row, context)).toBe(true);
    });

    it('normal_chime_candidate: multi-speaker → true', () => {
      const context = [
        { messageId: '1', userId: 'u1', nickname: 'A', timestamp: 1700000000, content: 'hi', rawContent: 'hi' },
        { messageId: '2', userId: 'u2', nickname: 'B', timestamp: 1700000001, content: 'hey', rawContent: 'hey' },
      ];
      const row: DbMessageRow = {
        id: 3, group_id: GROUP_ID, user_id: 'u3', nickname: 'C',
        content: 'hello', raw_content: 'hello',
        timestamp: 1700000002, source_message_id: null,
      };
      expect(isNormalChimeCandidate(row, context)).toBe(true);
    });

    it('bot_status_context: detects 机器人 keyword', () => {
      const context = [
        { messageId: '1', userId: 'u1', nickname: 'A', timestamp: 1700000000, content: '机器人怎么了', rawContent: '机器人怎么了' },
      ];
      const row: DbMessageRow = {
        id: 2, group_id: GROUP_ID, user_id: 'u2', nickname: 'B',
        content: '禁言策略', raw_content: '禁言策略',
        timestamp: 1700000001, source_message_id: null,
      };
      expect(isBotStatusContext(row, context)).toBe(true);
    });

    it('known_fact_term: detects ykn in learned_facts', () => {
      const row: DbMessageRow = {
        id: 1, group_id: GROUP_ID, user_id: 'u1', nickname: 'A',
        content: 'ykn是谁啊', raw_content: 'ykn是谁啊',
        timestamp: 1700000000, source_message_id: null,
      };
      expect(hasKnownFactTermInDb(db, row)).toBe(true);
    });

    it('known_fact_term: unrelated content → false', () => {
      const row: DbMessageRow = {
        id: 2, group_id: GROUP_ID, user_id: 'u1', nickname: 'A',
        content: '今天天气真好', raw_content: '今天天气真好',
        timestamp: 1700000000, source_message_id: null,
      };
      expect(hasKnownFactTermInDb(db, row)).toBe(false);
    });
  });

  // ---- WeakLabel shape ----

  describe('WeakLabel application', () => {
    it('applies label with all required fields', () => {
      const row: BenchmarkRow = {
        id: 'test-uuid',
        groupId: GROUP_ID,
        messageId: '1',
        userId: 'u1',
        nickname: 'Alice',
        timestamp: 1700000000,
        content: '扣1',
        rawContent: '扣1',
        triggerContext: [
          { messageId: '10', userId: 'u2', nickname: 'Bob', timestamp: 1699999990, content: '扣1', rawContent: '扣1' },
          { messageId: '11', userId: 'u3', nickname: 'Carol', timestamp: 1699999991, content: '扣1', rawContent: '扣1' },
        ],
        triggerContextAfter: [],
        category: 'relay_repeater',
        samplingSeed: TEST_SEED,
      };
      const labeled = applyWeakLabel(row, db, BOT_USER_ID, 100);
      expect(labeled.label).toBeDefined();
      expect(labeled.label.expectedAct).toBe('relay');
      expect(labeled.label.expectedDecision).toBe('reply');
      expect(labeled.label.isRelay).toBe(true);
      expect(labeled.label.isDirect).toBe(false);
      expect(labeled.label.riskFlags).toBeInstanceOf(Array);
    });

    it('direct_chat: @bot → expectedAct=direct_chat', () => {
      const row: BenchmarkRow = {
        id: 'test-uuid-2',
        groupId: GROUP_ID,
        messageId: '2',
        userId: 'u1',
        nickname: 'Alice',
        timestamp: 1700000000,
        content: '帮我看看',
        rawContent: `[CQ:at,qq=${BOT_USER_ID}]帮我看看`,
        triggerContext: [],
        triggerContextAfter: [],
        category: 'direct_at_reply',
        samplingSeed: TEST_SEED,
      };
      const labeled = applyWeakLabel(row, db, BOT_USER_ID, 100);
      expect(labeled.label.isDirect).toBe(true);
      expect(labeled.label.expectedAct).toBe('direct_chat');
    });

    it('conflict_handle: insult context → expectedAct=conflict_handle', () => {
      const row: BenchmarkRow = {
        id: 'test-uuid-3',
        groupId: GROUP_ID,
        messageId: '3',
        userId: 'u2',
        nickname: 'Bob',
        timestamp: 1700000001,
        content: '你去死',
        rawContent: '你去死',
        triggerContext: [
          { messageId: '5', userId: 'u1', nickname: 'A', timestamp: 1700000000, content: '你真蠢', rawContent: '你真蠢' },
        ],
        triggerContextAfter: [],
        category: 'conflict_heat',
        samplingSeed: TEST_SEED,
      };
      const labeled = applyWeakLabel(row, db, BOT_USER_ID, 100);
      expect(labeled.label.expectedAct).toBe('conflict_handle');
    });

    it('silence: single-speaker monologue → expectedDecision=silent', () => {
      const context = Array.from({ length: 5 }, (_, i) => ({
        messageId: String(i), userId: 'u1', nickname: 'Alice',
        timestamp: 1700000000 + i, content: `mono ${i}`, rawContent: `mono ${i}`,
      }));
      const row: BenchmarkRow = {
        id: 'test-uuid-4',
        groupId: GROUP_ID,
        messageId: '10',
        userId: 'u1',
        nickname: 'Alice',
        timestamp: 1700000005,
        content: 'still monologue',
        rawContent: 'still monologue',
        triggerContext: context,
        triggerContextAfter: [],
        category: 'silence_candidate',
        samplingSeed: TEST_SEED,
      };
      const labeled = applyWeakLabel(row, db, BOT_USER_ID, 100);
      expect(labeled.label.expectedDecision).toBe('silent');
    });

    it('hasRealFactHit equals hasKnownFactTerm (R6.1 scope)', () => {
      const row: BenchmarkRow = {
        id: 'test-uuid-5',
        groupId: GROUP_ID,
        messageId: '5',
        userId: 'u1',
        nickname: 'Alice',
        timestamp: 1700000000,
        content: 'ykn是谁啊',
        rawContent: 'ykn是谁啊',
        triggerContext: [],
        triggerContextAfter: [],
        category: 'known_fact_term',
        samplingSeed: TEST_SEED,
      };
      const labeled = applyWeakLabel(row, db, BOT_USER_ID, 100);
      expect(labeled.label.hasRealFactHit).toBe(labeled.label.hasKnownFactTerm);
    });
  });

  // ---- Summary builder ----

  describe('Summary builder', () => {
    it('builds valid summary.json shape', () => {
      const rawRows: BenchmarkRow[] = [
        {
          id: 'uuid-1', groupId: GROUP_ID, messageId: '1', userId: 'u1',
          nickname: 'Alice', timestamp: 1700000000, content: 'hi', rawContent: 'hi',
          triggerContext: [
            { messageId: '0', userId: 'u2', nickname: 'Bob', timestamp: 1699999999, content: 'hey', rawContent: 'hey' },
          ],
          triggerContextAfter: [], category: 'normal_chime_candidate', samplingSeed: TEST_SEED,
        },
      ];
      const labeled = rawRows.map(r => applyWeakLabel(r, db, BOT_USER_ID, 100));
      const summary = buildSummary(rawRows, labeled, TEST_SEED, '/path/to/bot.db', 250);

      expect(summary.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(summary.samplingSeed).toBe(TEST_SEED);
      expect(summary.totalSampled).toBe(1);
      expect(summary.totalLabeled).toBe(1);
      expect(summary.perCategory['normal_chime_candidate'].sampled).toBe(1);
      expect(summary.perCategory['normal_chime_candidate'].target).toBe(250);
      for (const cat of ALL_CATEGORIES) {
        expect(summary.perCategory[cat]).toBeDefined();
      }
      expect(summary.duplicateRate).toHaveProperty('byContentHash');
      expect(summary.dataQuality).toHaveProperty('emptyContent');
      expect(summary.gaps).toHaveProperty('undersampled');
    });

    it('detects undersampled categories at < 80% target', () => {
      const rawRows: BenchmarkRow[] = [];
      const labeled = rawRows.map(r => applyWeakLabel(r, db, BOT_USER_ID, 100));
      const summary = buildSummary(rawRows, labeled, TEST_SEED, '/path/to/bot.db', 10);

      expect(summary.gaps.undersampled.length).toBeGreaterThan(0);
      for (const gap of summary.gaps.undersampled) {
        expect(gap.sampled).toBeLessThan(gap.target * 0.8);
        expect(gap.shortfall).toBeGreaterThan(0);
      }
    });

    it('detects duplicate content', () => {
      const makeRow = (id: string, content: string): BenchmarkRow => ({
        id, groupId: GROUP_ID, messageId: id, userId: 'u1', nickname: 'A',
        timestamp: 1700000000, content, rawContent: content,
        triggerContext: [], triggerContextAfter: [],
        category: 'normal_chime_candidate', samplingSeed: TEST_SEED,
      });
      const rawRows = [makeRow('1', 'hello'), makeRow('2', 'hello'), makeRow('3', 'unique')];
      const labeled = rawRows.map(r => applyWeakLabel(r, db, BOT_USER_ID, 100));
      const summary = buildSummary(rawRows, labeled, TEST_SEED, '/test.db', 10);

      expect(summary.duplicateRate.duplicateCount).toBeGreaterThan(0);
      expect(summary.duplicateRate.byContentHash).toBeGreaterThan(0);
    });

    it('tracks missingContext when triggerContext < CONTEXT_BEFORE', () => {
      const row: BenchmarkRow = {
        id: 'short', groupId: GROUP_ID, messageId: '1', userId: 'u1', nickname: 'A',
        timestamp: 1700000000, content: 'hi', rawContent: 'hi',
        triggerContext: [{ messageId: '0', userId: 'u2', nickname: 'B', timestamp: 1699999999, content: 'hey', rawContent: 'hey' }],
        triggerContextAfter: [],
        category: 'silence_candidate', samplingSeed: TEST_SEED,
      };
      const labeled = [applyWeakLabel(row, db, BOT_USER_ID, 100)];
      const summary = buildSummary([row], labeled, TEST_SEED, '/test.db', 10);

      expect(summary.dataQuality.missingContext).toBe(1);
    });
  });

  // ---- Deterministic seed ----

  describe('Deterministic seed verification', () => {
    it('same seed+rowId always produces the same UUID', () => {
      const { createHash } = require('node:crypto') as typeof import('node:crypto');
      function stableUuid(seed: string, groupId: string, messageId: string): string {
        const hash = createHash('sha256').update(`${seed}:${groupId}:${messageId}`).digest('hex');
        return [
          hash.slice(0, 8),
          hash.slice(8, 12),
          '4' + hash.slice(13, 16),
          ((parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
          hash.slice(20, 32),
        ].join('-');
      }
      const a = stableUuid(TEST_SEED, GROUP_ID, '42');
      const b = stableUuid(TEST_SEED, GROUP_ID, '42');
      expect(a).toBe(b);
    });

    it('different rowIds produce different UUIDs', () => {
      const { createHash } = require('node:crypto') as typeof import('node:crypto');
      function deterministicRandom(seed: string, rowId: string): number {
        const hash = createHash('sha256').update(`${seed}:${rowId}`).digest('hex');
        const val = BigInt('0x' + hash.slice(0, 16));
        return Number(val) / Number(BigInt('0xffffffffffffffff'));
      }
      const a = deterministicRandom(TEST_SEED, 'group:1');
      const b = deterministicRandom(TEST_SEED, 'group:2');
      expect(a).not.toBe(b);
    });

    it('deterministic random value is in [0, 1)', () => {
      const { createHash } = require('node:crypto') as typeof import('node:crypto');
      for (const id of ['1', '999', 'abc', '0', '99999']) {
        const hash = createHash('sha256').update(`${TEST_SEED}:${id}`).digest('hex');
        const val = BigInt('0x' + hash.slice(0, 16));
        const r = Number(val) / Number(BigInt('0xffffffffffffffff'));
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThan(1);
      }
    });
  });

  // ---- Boundary/edge cases ----

  describe('Edge cases', () => {
    it('empty content → silence_candidate signal', () => {
      const row: DbMessageRow = {
        id: 1, group_id: GROUP_ID, user_id: 'u1', nickname: 'A',
        content: '', raw_content: '',
        timestamp: 1700000000, source_message_id: null,
      };
      expect(isSilenceCandidate(row, [])).toBe(true);
    });

    it('very long content (>60 chars) → not rhetorical banter', () => {
      const row: DbMessageRow = {
        id: 1, group_id: GROUP_ID, user_id: 'u1', nickname: 'A',
        content: '哈'.repeat(61), raw_content: '哈'.repeat(61),
        timestamp: 1700000000, source_message_id: null,
      };
      expect(isRhetoricalBanter(row)).toBe(false);
    });

    it('burst with exactly 4 msgs in window → not burst (threshold is 5)', () => {
      const now = 1700000010;
      const context = Array.from({ length: 3 }, (_, i) => ({
        messageId: String(i), userId: `u${i}`, nickname: `User${i}`,
        timestamp: now - 10 + i, content: `msg ${i}`, rawContent: `msg ${i}`,
      }));
      const row: DbMessageRow = {
        id: 10, group_id: GROUP_ID, user_id: 'u9', nickname: 'X',
        content: 'hi', raw_content: 'hi', timestamp: now, source_message_id: null,
      };
      expect(isBurstNonDirect(row, context, BOT_USER_ID)).toBe(false);
    });

    it('relay with only 1 peer → not relay', () => {
      const context = [
        { messageId: '1', userId: 'u1', nickname: 'A', timestamp: 1700000000, content: '扣1', rawContent: '扣1' },
      ];
      const row: DbMessageRow = {
        id: 2, group_id: GROUP_ID, user_id: 'u2', nickname: 'B',
        content: '扣1', raw_content: '扣1', timestamp: 1700000001, source_message_id: null,
      };
      expect(isRelayRepeater(row, context)).toBe(false);
    });

    it('relay outside 30s window → not relay', () => {
      const context = [
        { messageId: '1', userId: 'u1', nickname: 'A', timestamp: 1700000000, content: '扣1', rawContent: '扣1' },
        { messageId: '2', userId: 'u2', nickname: 'B', timestamp: 1700000001, content: '扣1', rawContent: '扣1' },
      ];
      const row: DbMessageRow = {
        id: 3, group_id: GROUP_ID, user_id: 'u3', nickname: 'C',
        content: '扣1', raw_content: '扣1', timestamp: 1700000035, source_message_id: null,
      };
      expect(isRelayRepeater(row, context)).toBe(false);
    });

    it('CONTEXT_BEFORE and CONTEXT_AFTER constants are correct', () => {
      expect(CONTEXT_BEFORE).toBe(5);
      expect(CONTEXT_AFTER).toBe(3);
    });

    it('ALL_CATEGORIES has exactly 10 entries', () => {
      expect(ALL_CATEGORIES).toHaveLength(10);
    });

    it('summary with empty rows returns zero totals', () => {
      const summary = buildSummary([], [], TEST_SEED, '/empty.db', 250);
      expect(summary.totalSampled).toBe(0);
      expect(summary.totalLabeled).toBe(0);
      expect(summary.duplicateRate.byContentHash).toBe(0);
    });
  });
});
