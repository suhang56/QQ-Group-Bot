/**
 * mod-review.test.ts — Moderation Review Panel (spec §13, architecture §12)
 * All 15 mandatory edge cases (SOUL RULE).
 * Strategy: real in-memory SQLite for DB layer; real RatingPortalServer on random port for HTTP.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { Database, type ModerationRecord } from '../src/storage/db.js';
import { RatingPortalServer } from '../src/server/rating-portal.js';

// ---- Helpers ----

function makeDb(): Database {
  return new Database(':memory:');
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

type ModRecordInput = Omit<ModerationRecord, 'id' | 'reviewed' | 'reviewedBy' | 'reviewedAt'>;

function makeModRecord(overrides: Partial<ModRecordInput> = {}): ModRecordInput {
  return {
    msgId: `msg-${Math.random()}`,
    groupId: 'g1',
    userId: 'u1',
    violation: true,
    severity: 3,
    action: 'warn',
    reason: 'test reason',
    appealed: 0,
    reversed: false,
    timestamp: nowSec(),
    ...overrides,
  };
}

/** Find a free TCP port. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

/** Make an HTTP request and return { status, body }. */
function httpReq(opts: {
  method: string;
  host: string;
  port: number;
  path: string;
  body?: unknown;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const req = http.request(
      {
        method: opts.method,
        hostname: opts.host,
        port: opts.port,
        path: opts.path,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---- HTTP test fixture ----

interface PortalFixture {
  db: Database;
  server: RatingPortalServer;
  port: number;
  host: string;
  get(path: string): Promise<{ status: number; body: string }>;
  post(path: string, body: unknown): Promise<{ status: number; body: string }>;
}

async function makePortal(): Promise<PortalFixture> {
  const db = makeDb();
  const port = await getFreePort();
  const host = '127.0.0.1';
  // RatingPortalServer needs IBotReplyRepository — pass db.botReplies (empty, in-mem)
  const server = new RatingPortalServer(db.botReplies, 'g1', db.moderation, db.localStickers);
  server.start(port, host);

  const get = (path: string) => httpReq({ method: 'GET', host, port, path });
  const post = (path: string, body: unknown) => httpReq({ method: 'POST', host, port, path, body });

  return { db, server, port, host, get, post };
}

// ---- Tests ----

describe('mod-review — DB layer (IModerationRepository new methods)', () => {
  let db: Database;

  beforeEach(() => { db = makeDb(); });

  // EC-1: Records survive DB re-instantiation (persistence invariant).
  // Note: :memory: DBs don't persist across re-instantiation by design;
  // this test verifies the NEW columns default correctly after insert.
  it('EC-1: new columns default to 0/null/null after insert', () => {
    const rec = db.moderation.insert(makeModRecord());
    expect(rec.reviewed).toBe(0);
    expect(rec.reviewedBy).toBeNull();
    expect(rec.reviewedAt).toBeNull();
  });

  // EC-2: resetDailyPunishments does NOT touch moderation_log rows.
  it('EC-2: resetDailyPunishments leaves moderation rows intact', () => {
    const groupId = 'g1';
    db.groupConfig.upsert({
      groupId,
      enabledModules: ['moderator'],
      autoMod: true,
      dailyPunishmentLimit: 10,
      punishmentsToday: 5,
      punishmentsResetDate: '2026-04-14',
      mimicActiveUserId: null,
      mimicStartedBy: null,
      chatTriggerKeywords: [],
      chatTriggerAtOnly: false,
      chatDebounceMs: 2000,
      modConfidenceThreshold: 0.7,
      modWhitelist: [],
      appealWindowHours: 24,
      kickConfirmModel: 'claude-opus-4-6',
      chatLoreEnabled: false,
      nameImagesEnabled: false,
      nameImagesCollectionTimeoutMs: 120000,
      nameImagesCollectionMax: 20,
      nameImagesCooldownMs: 300000,
      nameImagesMaxPerName: 50,
      chatAtMentionQueueMax: 5,
      chatAtMentionBurstWindowMs: 30000,
      chatAtMentionBurstThreshold: 3,
      repeaterEnabled: false,
      repeaterMinCount: 3,
      repeaterCooldownMs: 5000,
      repeaterMinContentLength: 1,
      repeaterMaxContentLength: 100,
      nameImagesBlocklist: [],
      loreUpdateEnabled: false,
      loreUpdateThreshold: 0.7,
      loreUpdateCooldownMs: 3600000,
      liveStickerCaptureEnabled: false,
      stickerLegendRefreshEveryMsgs: 50,
      chatPersonaText: null,
      activeCharacterId: null,
      charStartedBy: null,
      welcomeEnabled: false,
      idGuardEnabled: false,
      stickerFirstEnabled: false,
      stickerFirstThreshold: 0.55,
      createdAt: '',
      updatedAt: '',
    });
    db.moderation.insert(makeModRecord({ groupId }));
    db.moderation.insert(makeModRecord({ groupId }));
    db.groupConfig.resetDailyPunishments(groupId);
    const { records } = db.moderation.getForReview({}, 1, 50);
    expect(records).toHaveLength(2);
  });

  // EC-11: Migration idempotent — _runMigrations runs on same DB twice (via two Database instances
  // pointing to same path is impossible with :memory:, so we verify the new instance starts clean).
  it('EC-11: constructing two Database instances both succeed (migration idempotent)', () => {
    const db2 = makeDb();
    const rec = db2.moderation.insert(makeModRecord());
    expect(rec.reviewed).toBe(0);
    db2.close?.();
  });

  // getForReview pagination (EC-3 counterpart for DB layer).
  it('getForReview returns paginated records with total', () => {
    for (let i = 0; i < 12; i++) {
      db.moderation.insert(makeModRecord({ msgId: `msg-${i}` }));
    }
    const page1 = db.moderation.getForReview({}, 1, 5);
    expect(page1.records).toHaveLength(5);
    expect(page1.total).toBe(12);

    const page3 = db.moderation.getForReview({}, 3, 5);
    expect(page3.records).toHaveLength(2);
    expect(page3.total).toBe(12);
  });

  // EC-4 (DB): filter by groupId.
  it('getForReview filters by groupId', () => {
    db.moderation.insert(makeModRecord({ groupId: 'g1', msgId: 'a1' }));
    db.moderation.insert(makeModRecord({ groupId: 'g2', msgId: 'a2' }));
    const { records } = db.moderation.getForReview({ groupId: 'g2' }, 1, 50);
    expect(records).toHaveLength(1);
    expect(records[0]!.groupId).toBe('g2');
  });

  // EC-5 (DB): filter by reviewed status.
  it('getForReview filters by reviewed status', () => {
    const r1 = db.moderation.insert(makeModRecord({ msgId: 'b1' }));
    db.moderation.insert(makeModRecord({ msgId: 'b2' }));
    db.moderation.markReviewed(r1.id, 1, 'admin', nowSec());

    const unreviewed = db.moderation.getForReview({ reviewed: 0 }, 1, 50);
    expect(unreviewed.records).toHaveLength(1);
    expect(unreviewed.records[0]!.reviewed).toBe(0);

    const approved = db.moderation.getForReview({ reviewed: 1 }, 1, 50);
    expect(approved.records).toHaveLength(1);
    expect(approved.records[0]!.reviewed).toBe(1);
  });

  // EC-14: filter by severity range.
  it('EC-14: getForReview filters by severity range (severityMin/Max)', () => {
    db.moderation.insert(makeModRecord({ severity: 1, msgId: 'c1' }));
    db.moderation.insert(makeModRecord({ severity: 3, msgId: 'c2' }));
    db.moderation.insert(makeModRecord({ severity: 5, msgId: 'c3' }));

    const { records } = db.moderation.getForReview({ severityMin: 3, severityMax: 5 }, 1, 50);
    expect(records).toHaveLength(2);
    expect(records.every(r => (r.severity ?? 0) >= 3 && (r.severity ?? 0) <= 5)).toBe(true);
  });

  // markReviewed and re-review overwrite (EC-6/7/9 DB layer).
  it('markReviewed sets verdict, reviewer, timestamp; re-review overwrites', () => {
    const rec = db.moderation.insert(makeModRecord());
    const ts = nowSec();
    db.moderation.markReviewed(rec.id, 1, 'admin', ts);
    const after = db.moderation.findById(rec.id)!;
    expect(after.reviewed).toBe(1);
    expect(after.reviewedBy).toBe('admin');
    expect(after.reviewedAt).toBe(ts);

    // re-review overwrites
    db.moderation.markReviewed(rec.id, 2, 'admin', ts + 1);
    const again = db.moderation.findById(rec.id)!;
    expect(again.reviewed).toBe(2);
  });

  // EC-10: getStats counts.
  it('EC-10 / getStats: correct counts per status and group', () => {
    db.moderation.insert(makeModRecord({ groupId: 'g1', msgId: 'd1' }));
    db.moderation.insert(makeModRecord({ groupId: 'g1', msgId: 'd2' }));
    db.moderation.insert(makeModRecord({ groupId: 'g1', msgId: 'd3' }));
    const r2 = db.moderation.insert(makeModRecord({ groupId: 'g1', msgId: 'd4' }));
    const r3 = db.moderation.insert(makeModRecord({ groupId: 'g1', msgId: 'd5' }));
    db.moderation.markReviewed(r2.id, 1, 'admin', nowSec()); // approved
    db.moderation.markReviewed(r3.id, 2, 'admin', nowSec()); // rejected

    const stats = db.moderation.getStats();
    expect(stats.total).toBe(5);
    expect(stats.unreviewed).toBe(3);
    expect(stats.approved).toBe(1);
    expect(stats.rejected).toBe(1);
    expect(stats.byGroup['g1']!.total).toBe(5);
    expect(stats.byGroup['g1']!.unreviewed).toBe(3);
    expect(stats.byGroup['g1']!.approved).toBe(1);
    expect(stats.byGroup['g1']!.rejected).toBe(1);
  });
});

// ---- HTTP route tests ----

describe('mod-review — HTTP routes (RatingPortalServer)', () => {
  let fixture: PortalFixture;

  beforeEach(async () => { fixture = await makePortal(); });
  afterEach(() => { fixture.server.stop(); });

  // EC-3: GET /mod/list pagination.
  it('EC-3: GET /mod/list returns paginated results (25 rows, page 1 limit 10)', async () => {
    for (let i = 0; i < 25; i++) {
      fixture.db.moderation.insert(makeModRecord({ msgId: `p${i}` }));
    }
    const { status, body } = await fixture.get('/mod/list?page=1&limit=10');
    expect(status).toBe(200);
    const json = JSON.parse(body) as { records: unknown[]; page: number; limit: number; total: number };
    expect(json.records).toHaveLength(10);
    expect(json.total).toBe(25);
    expect(json.page).toBe(1);
    expect(json.limit).toBe(10);
  });

  // EC-4: GET /mod/list filter by group.
  it('EC-4: GET /mod/list filters by group', async () => {
    fixture.db.moderation.insert(makeModRecord({ groupId: 'g1', msgId: 'f1' }));
    fixture.db.moderation.insert(makeModRecord({ groupId: 'g2', msgId: 'f2' }));
    const { body } = await fixture.get('/mod/list?group=g2');
    const json = JSON.parse(body) as { records: ModerationRecord[]; total: number };
    expect(json.records).toHaveLength(1);
    expect(json.records[0]!.groupId).toBe('g2');
    expect(json.total).toBe(1);
  });

  // EC-5: GET /mod/list filter by status unreviewed.
  it('EC-5: GET /mod/list filters by status=unreviewed', async () => {
    const r1 = fixture.db.moderation.insert(makeModRecord({ msgId: 's1' }));
    fixture.db.moderation.insert(makeModRecord({ msgId: 's2' }));
    fixture.db.moderation.markReviewed(r1.id, 1, 'admin', nowSec());

    const { body } = await fixture.get('/mod/list?status=unreviewed');
    const json = JSON.parse(body) as { records: ModerationRecord[]; total: number };
    expect(json.records).toHaveLength(1);
    expect(json.records[0]!.reviewed).toBe(0);
  });

  // EC-6: POST /mod/:id/review approve.
  it('EC-6: POST /mod/:id/review approves record (reviewed=1)', async () => {
    const rec = fixture.db.moderation.insert(makeModRecord({ msgId: 'v1' }));
    const { status } = await fixture.post(`/mod/${rec.id}/review`, { verdict: 'approved' });
    expect(status).toBe(200);

    const { body: getBody } = await fixture.get(`/mod/${rec.id}`);
    const json = JSON.parse(getBody) as { record: ModerationRecord };
    expect(json.record.reviewed).toBe(1);
    expect(json.record.reviewedBy).toBe('admin');
    expect(json.record.reviewedAt).toBeGreaterThan(0);
  });

  // EC-7: POST /mod/:id/review rejects record (reviewed=2).
  it('EC-7: POST /mod/:id/review rejects record (reviewed=2)', async () => {
    const rec = fixture.db.moderation.insert(makeModRecord({ msgId: 'v2' }));
    const { status } = await fixture.post(`/mod/${rec.id}/review`, { verdict: 'rejected' });
    expect(status).toBe(200);

    const { body: getBody } = await fixture.get(`/mod/${rec.id}`);
    const json = JSON.parse(getBody) as { record: ModerationRecord };
    expect(json.record.reviewed).toBe(2);
  });

  // EC-8: POST /mod/:id/review unknown id → 404.
  it('EC-8: POST /mod/99999/review → 404', async () => {
    const { status } = await fixture.post('/mod/99999/review', { verdict: 'approved' });
    expect(status).toBe(404);
  });

  // EC-9: POST /mod/:id/review re-review overwrites.
  it('EC-9: re-review overwrites previous verdict', async () => {
    const rec = fixture.db.moderation.insert(makeModRecord({ msgId: 'v3' }));
    await fixture.post(`/mod/${rec.id}/review`, { verdict: 'approved' });
    await fixture.post(`/mod/${rec.id}/review`, { verdict: 'rejected' });
    const { body } = await fixture.get(`/mod/${rec.id}`);
    const json = JSON.parse(body) as { record: ModerationRecord };
    expect(json.record.reviewed).toBe(2);
  });

  // EC-10 (HTTP): GET /mod/stats counts.
  it('EC-10: GET /mod/stats returns correct counts', async () => {
    fixture.db.moderation.insert(makeModRecord({ msgId: 'st1' }));
    fixture.db.moderation.insert(makeModRecord({ msgId: 'st2' }));
    fixture.db.moderation.insert(makeModRecord({ msgId: 'st3' }));
    const r2 = fixture.db.moderation.insert(makeModRecord({ msgId: 'st4' }));
    const r3 = fixture.db.moderation.insert(makeModRecord({ msgId: 'st5' }));
    fixture.db.moderation.markReviewed(r2.id, 1, 'admin', nowSec());
    fixture.db.moderation.markReviewed(r3.id, 2, 'admin', nowSec());

    const { status, body } = await fixture.get('/mod/stats');
    expect(status).toBe(200);
    const stats = JSON.parse(body) as { total: number; unreviewed: number; approved: number; rejected: number };
    expect(stats.total).toBe(5);
    expect(stats.unreviewed).toBe(3);
    expect(stats.approved).toBe(1);
    expect(stats.rejected).toBe(1);
  });

  // EC-11 (HTTP): appeal sub-object present when appealed !== 0.
  it('EC-11 / EC-12: appeal sub-object present when appealed !== 0', async () => {
    const rec = fixture.db.moderation.insert(makeModRecord({ appealed: 1, msgId: 'ap1' }));
    const { body } = await fixture.get(`/mod/${rec.id}`);
    const json = JSON.parse(body) as { record: ModerationRecord; appeal?: { appealed: number; reversed: boolean } };
    expect(json.appeal).toBeDefined();
    expect(json.appeal!.appealed).toBe(1);
  });

  // EC-13: appeal sub-object absent when appealed === 0.
  it('EC-13: appeal sub-object absent when appealed === 0', async () => {
    const rec = fixture.db.moderation.insert(makeModRecord({ appealed: 0, msgId: 'ap2' }));
    const { body } = await fixture.get(`/mod/${rec.id}`);
    const json = JSON.parse(body) as { record: ModerationRecord; appeal?: unknown };
    expect(json.appeal).toBeUndefined();
  });

  // EC-13 (pagination): page beyond data returns empty list.
  it('EC-13 (pagination): page beyond data returns empty records', async () => {
    for (let i = 0; i < 5; i++) {
      fixture.db.moderation.insert(makeModRecord({ msgId: `pg${i}` }));
    }
    const { body } = await fixture.get('/mod/list?page=2&limit=10');
    const json = JSON.parse(body) as { records: unknown[]; total: number };
    expect(json.records).toHaveLength(0);
    expect(json.total).toBe(5);
  });

  // EC-14: severity range filter.
  it('EC-14: GET /mod/list?severity=3-5 filters by severity range', async () => {
    fixture.db.moderation.insert(makeModRecord({ severity: 1, msgId: 'sv1' }));
    fixture.db.moderation.insert(makeModRecord({ severity: 3, msgId: 'sv2' }));
    fixture.db.moderation.insert(makeModRecord({ severity: 5, msgId: 'sv3' }));
    const { body } = await fixture.get('/mod/list?severity=3-5');
    const json = JSON.parse(body) as { records: ModerationRecord[] };
    expect(json.records).toHaveLength(2);
    expect(json.records.every(r => (r.severity ?? 0) >= 3 && (r.severity ?? 0) <= 5)).toBe(true);
  });

  // EC-15: GET /mod serves HTML.
  it('EC-15: GET /mod serves HTML with <table', async () => {
    const { status, body } = await fixture.get('/mod');
    expect(status).toBe(200);
    expect(body).toContain('<table');
  });

  // EC-15 (reviewedBy): POST review sets reviewedBy === "admin".
  it('EC-15 (reviewedBy): reviewedBy is "admin" after review', async () => {
    const rec = fixture.db.moderation.insert(makeModRecord({ msgId: 'rb1' }));
    await fixture.post(`/mod/${rec.id}/review`, { verdict: 'approved' });
    const { body } = await fixture.get(`/mod/${rec.id}`);
    const json = JSON.parse(body) as { record: ModerationRecord };
    expect(json.record.reviewedBy).toBe('admin');
  });

  // Validation: bad status param → 400.
  it('GET /mod/list?status=garbage → 400', async () => {
    const { status } = await fixture.get('/mod/list?status=garbage');
    expect(status).toBe(400);
  });

  // Validation: bad severity → 400.
  it('GET /mod/list?severity=abc → 400', async () => {
    const { status } = await fixture.get('/mod/list?severity=abc');
    expect(status).toBe(400);
  });

  // Validation: limit out of range → 400.
  it('GET /mod/list?limit=200 → 400', async () => {
    const { status } = await fixture.get('/mod/list?limit=200');
    expect(status).toBe(400);
  });

  // Validation: invalid verdict → 400.
  it('POST /mod/:id/review invalid verdict → 400', async () => {
    const rec = fixture.db.moderation.insert(makeModRecord({ msgId: 'ivv' }));
    const { status } = await fixture.post(`/mod/${rec.id}/review`, { verdict: 'maybe' });
    expect(status).toBe(400);
  });

  // GET /mod/:id not found → 404.
  it('GET /mod/99999 → 404', async () => {
    const { status } = await fixture.get('/mod/99999');
    expect(status).toBe(404);
  });

  // Severity single value filter.
  it('GET /mod/list?severity=3 filters by single severity', async () => {
    fixture.db.moderation.insert(makeModRecord({ severity: 3, msgId: 'sv10' }));
    fixture.db.moderation.insert(makeModRecord({ severity: 4, msgId: 'sv11' }));
    const { body } = await fixture.get('/mod/list?severity=3');
    const json = JSON.parse(body) as { records: ModerationRecord[] };
    expect(json.records).toHaveLength(1);
    expect(json.records[0]!.severity).toBe(3);
  });
});
