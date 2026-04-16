/**
 * rating-portal-memes.test.ts — Meme graph portal routes (memes-v1 P5)
 * Tests: list happy path, list empty, PATCH updates + manual_edit status,
 * PATCH invalid id -> 404, demote updates status, null memeGraphRepo -> 503
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { Database, type MemeGraphEntry } from '../../src/storage/db.js';
import { RatingPortalServer } from '../../src/server/rating-portal.js';

// ---- Helpers ----

function makeDb(): Database {
  return new Database(':memory:');
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function makeMemeEntry(overrides: Partial<Omit<MemeGraphEntry, 'id'>> & { groupId: string; canonical: string; meaning: string }): Omit<MemeGraphEntry, 'id'> {
  const now = nowSec();
  return {
    groupId: overrides.groupId,
    canonical: overrides.canonical,
    variants: overrides.variants ?? [],
    meaning: overrides.meaning,
    originEvent: overrides.originEvent ?? null,
    originMsgId: overrides.originMsgId ?? null,
    originUserId: overrides.originUserId ?? null,
    originTs: overrides.originTs ?? null,
    firstSeenCount: overrides.firstSeenCount ?? 1,
    totalCount: overrides.totalCount ?? 1,
    confidence: overrides.confidence ?? 0.5,
    status: overrides.status ?? 'active',
    embeddingVec: overrides.embeddingVec ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

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

// ---- Fixture ----

interface MemePortalFixture {
  db: Database;
  server: RatingPortalServer;
  port: number;
  host: string;
  get(path: string): Promise<{ status: number; body: string }>;
  post(path: string, body?: unknown): Promise<{ status: number; body: string }>;
  patch(path: string, body: unknown): Promise<{ status: number; body: string }>;
}

async function makePortal(opts?: { skipMemeRepo?: boolean }): Promise<MemePortalFixture> {
  const db = makeDb();
  const port = await getFreePort();
  const host = '127.0.0.1';
  const server = new RatingPortalServer(db.botReplies, 'g1', db.moderation, db.messages, db.localStickers);
  if (!opts?.skipMemeRepo) {
    server.setMemeGraphRepo(db.memeGraph);
  }
  server.start(port, host);

  const get = (path: string) => httpReq({ method: 'GET', host, port, path });
  const post = (path: string, body?: unknown) => httpReq({ method: 'POST', host, port, path, body });
  const patch = (path: string, body: unknown) => httpReq({ method: 'PATCH', host, port, path, body });

  return { db, server, port, host, get, post, patch };
}

// ---- Tests ----

describe('rating-portal /memes routes', () => {
  let fixture: MemePortalFixture;

  afterEach(() => {
    fixture?.server.stop();
  });

  // Test 1: GET /memes/:groupId — happy path with data
  it('GET /memes/:groupId returns HTML table with meme entries', async () => {
    fixture = await makePortal();
    fixture.db.memeGraph.insert(makeMemeEntry({
      groupId: 'g1',
      canonical: 'test-meme',
      variants: ['tm', 'test'],
      meaning: 'a test meme for unit testing',
      originEvent: 'someone said it first',
    }));
    fixture.db.memeGraph.insert(makeMemeEntry({
      groupId: 'g1',
      canonical: 'another-meme',
      variants: ['am'],
      meaning: 'another meme',
    }));

    const res = await fixture.get('/memes/g1');
    expect(res.status).toBe(200);
    expect(res.body).toContain('test-meme');
    expect(res.body).toContain('another-meme');
    expect(res.body).toContain('a test meme for unit testing');
    expect(res.body).toContain('2 active memes');
    expect(res.body).toContain('<table>');
  });

  // Test 2: GET /memes/:groupId — empty list
  it('GET /memes/:groupId returns empty state when no memes exist', async () => {
    fixture = await makePortal();
    const res = await fixture.get('/memes/nonexistent-group');
    expect(res.status).toBe(200);
    expect(res.body).toContain('0 active memes');
    expect(res.body).toContain('No memes found.');
  });

  // Test 3: PATCH /memes/:id — updates fields and sets manual_edit status
  it('PATCH /memes/:id updates meaning/variants and sets status to manual_edit', async () => {
    fixture = await makePortal();
    const id = fixture.db.memeGraph.insert(makeMemeEntry({
      groupId: 'g1',
      canonical: 'original',
      variants: ['orig'],
      meaning: 'original meaning',
    }));

    const res = await fixture.patch(`/memes/${id}`, {
      meaning: 'updated meaning',
      variants: ['orig', 'new-variant'],
    });
    expect(res.status).toBe(200);
    const updated = JSON.parse(res.body);
    expect(updated.meaning).toBe('updated meaning');
    expect(updated.variants).toContain('new-variant');
    expect(updated.status).toBe('manual_edit');
  });

  // Test 4: PATCH /memes/:id — invalid id returns 404
  it('PATCH /memes/:id returns 404 for non-existent meme', async () => {
    fixture = await makePortal();
    const res = await fixture.patch('/memes/99999', { meaning: 'nope' });
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('meme not found');
  });

  // Test 5: POST /memes/:id/demote — sets status to demoted
  it('POST /memes/:id/demote sets status to demoted', async () => {
    fixture = await makePortal();
    const id = fixture.db.memeGraph.insert(makeMemeEntry({
      groupId: 'g1',
      canonical: 'to-demote',
      meaning: 'will be demoted',
    }));

    const res = await fixture.post(`/memes/${id}/demote`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);

    // Verify in DB
    const meme = fixture.db.memeGraph.findById(id);
    expect(meme?.status).toBe('demoted');
  });

  // Test 6: null memeGraphRepo returns 503
  it('returns 503 when memeGraphRepo is not set', async () => {
    fixture = await makePortal({ skipMemeRepo: true });

    const getRes = await fixture.get('/memes/g1');
    expect(getRes.status).toBe(503);
    expect(JSON.parse(getRes.body).error).toBe('memeGraphRepo not available');

    const patchRes = await fixture.patch('/memes/1', { meaning: 'x' });
    expect(patchRes.status).toBe(503);

    const demoteRes = await fixture.post('/memes/1/demote');
    expect(demoteRes.status).toBe(503);
  });

  // Test 7: POST /memes/:id/demote — non-existent id returns 404
  it('POST /memes/:id/demote returns 404 for non-existent meme', async () => {
    fixture = await makePortal();
    const res = await fixture.post('/memes/99999/demote');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toBe('meme not found');
  });

  // Test 8: PATCH with invalid JSON returns 400
  it('PATCH /memes/:id with invalid JSON returns 400', async () => {
    fixture = await makePortal();
    const id = fixture.db.memeGraph.insert(makeMemeEntry({
      groupId: 'g1',
      canonical: 'test',
      meaning: 'test',
    }));

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const payload = '{not valid json!!!';
      const req = http.request(
        {
          method: 'PATCH',
          hostname: fixture.host,
          port: fixture.port,
          path: `/memes/${id}`,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
          r.on('error', reject);
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid json');
  });

  // Test 9: PATCH re-edit after manual_edit status works (adminEdit handles this)
  it('PATCH works on already manual_edit rows (re-edit)', async () => {
    fixture = await makePortal();
    const id = fixture.db.memeGraph.insert(makeMemeEntry({
      groupId: 'g1',
      canonical: 'editable',
      variants: ['e'],
      meaning: 'first meaning',
    }));

    // First edit
    await fixture.patch(`/memes/${id}`, { meaning: 'second meaning' });
    let meme = fixture.db.memeGraph.findById(id);
    expect(meme?.status).toBe('manual_edit');
    expect(meme?.meaning).toBe('second meaning');

    // Second edit (status is already manual_edit)
    const res = await fixture.patch(`/memes/${id}`, { meaning: 'third meaning' });
    expect(res.status).toBe(200);
    meme = fixture.db.memeGraph.findById(id);
    expect(meme?.meaning).toBe('third meaning');
    expect(meme?.status).toBe('manual_edit');
  });

  // Test 10: HTML escaping in meme content prevents XSS
  it('GET /memes/:groupId escapes HTML in meme fields', async () => {
    fixture = await makePortal();
    fixture.db.memeGraph.insert(makeMemeEntry({
      groupId: 'g1',
      canonical: '<script>alert("xss")</script>',
      variants: ['<b>bold</b>'],
      meaning: 'a "quoted" & <dangerous> meaning',
    }));

    const res = await fixture.get('/memes/g1');
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('<script>alert');
    expect(res.body).toContain('&lt;script&gt;');
    expect(res.body).toContain('&amp;');
  });
});
