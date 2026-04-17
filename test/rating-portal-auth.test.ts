/**
 * rating-portal-auth.test.ts — UR-C #1 admin hardening.
 * Covers: X-Admin-Token enforcement, CORS allow-list, Origin-CSRF defense,
 * dev-mode fallthrough when token unset.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { Database } from '../src/storage/db.js';
import { RatingPortalServer } from '../src/server/rating-portal.js';

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

interface HttpResult { status: number; body: string; headers: http.IncomingHttpHeaders }

function httpReq(opts: {
  method: string;
  host: string;
  port: number;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      { method: opts.method, hostname: opts.host, port: opts.port, path: opts.path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

interface Fixture {
  db: Database;
  server: RatingPortalServer;
  port: number;
  req(method: string, path: string, headers?: Record<string, string>, body?: unknown): Promise<HttpResult>;
  stop(): Promise<void>;
}

async function makePortal(authOpts?: {
  adminToken?: string;
  allowedOrigins?: string[];
}): Promise<Fixture> {
  const db = new Database(':memory:');
  const port = await getFreePort();
  const host = '127.0.0.1';
  const server = new RatingPortalServer(
    db.botReplies, 'g1', db.moderation, db.messages, db.localStickers, authOpts,
  );
  server.start(port, host);
  // wait briefly for listen
  await new Promise<void>(r => setTimeout(r, 20));
  return {
    db,
    server,
    port,
    req: (method, path, headers, body) => httpReq({ method, host, port, path, headers, body }),
    stop: async () => {
      server.stop();
      db.close();
    },
  };
}

describe('rating-portal auth (UR-C #1)', () => {
  let f: Fixture;
  afterEach(async () => { await f?.stop(); });

  describe('with RATING_PORTAL_TOKEN set', () => {
    beforeEach(async () => {
      f = await makePortal({ adminToken: 'secret123', allowedOrigins: ['http://localhost:4000'] });
    });

    it('401 when no X-Admin-Token on GET /mod/stats', async () => {
      const r = await f.req('GET', '/mod/stats');
      expect(r.status).toBe(401);
    });

    it('401 when wrong X-Admin-Token on GET /mod/stats', async () => {
      const r = await f.req('GET', '/mod/stats', { 'X-Admin-Token': 'wrong' });
      expect(r.status).toBe(401);
    });

    it('200 when correct X-Admin-Token on GET /mod/stats', async () => {
      const r = await f.req('GET', '/mod/stats', { 'X-Admin-Token': 'secret123' });
      expect(r.status).toBe(200);
    });

    it('401 when no token on POST /mod/:id/review (mutating)', async () => {
      const r = await f.req('POST', '/mod/999/review', {}, { verdict: 'approved' });
      expect(r.status).toBe(401);
    });

    it('401 when no token on PATCH /memes/:id', async () => {
      const r = await f.req('PATCH', '/memes/1', {}, { canonical: 'foo' });
      expect(r.status).toBe(401);
    });

    it('401 when no token on POST /memes/:id/demote', async () => {
      const r = await f.req('POST', '/memes/1/demote', {}, {});
      expect(r.status).toBe(401);
    });

    it('401 when no token on POST /api/replies/:id/rate', async () => {
      const r = await f.req('POST', '/api/replies/1/rate', {}, { rating: 5 });
      expect(r.status).toBe(401);
    });

    it('OPTIONS preflight responds 204 without token check', async () => {
      const r = await f.req('OPTIONS', '/mod/stats', { Origin: 'http://localhost:4000' });
      expect(r.status).toBe(204);
    });

    it('OPTIONS preflight sends Access-Control-Allow-Headers with X-Admin-Token', async () => {
      const r = await f.req('OPTIONS', '/mod/stats', { Origin: 'http://localhost:4000' });
      expect(String(r.headers['access-control-allow-headers'] ?? '')).toContain('X-Admin-Token');
    });
  });

  describe('CORS / Origin allow-list', () => {
    beforeEach(async () => {
      f = await makePortal({ adminToken: 'secret123', allowedOrigins: ['http://localhost:4000'] });
    });

    it('echoes Allow-Origin when Origin in whitelist', async () => {
      const r = await f.req('GET', '/mod/stats', {
        'X-Admin-Token': 'secret123',
        Origin: 'http://localhost:4000',
      });
      expect(r.headers['access-control-allow-origin']).toBe('http://localhost:4000');
      expect(r.headers['vary']).toContain('Origin');
    });

    it('does NOT echo Allow-Origin when Origin is off-list', async () => {
      const r = await f.req('GET', '/mod/stats', {
        'X-Admin-Token': 'secret123',
        Origin: 'http://evil.example',
      });
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('rejects cross-origin POST with 403 (CSRF defense)', async () => {
      const r = await f.req('POST', '/mod/999/review', {
        'X-Admin-Token': 'secret123',
        Origin: 'http://evil.example',
      }, { verdict: 'approved' });
      expect(r.status).toBe(403);
    });

    it('allows POST with matching Origin', async () => {
      // 404 expected because id 999 doesn't exist — we're asserting auth+CORS+origin
      // all pass and we reached route handling.
      const r = await f.req('POST', '/mod/999/review', {
        'X-Admin-Token': 'secret123',
        Origin: 'http://localhost:4000',
      }, { verdict: 'approved' });
      expect(r.status).toBe(404); // reached handler
    });

    it('POST with no Origin header succeeds (non-browser client)', async () => {
      const r = await f.req('POST', '/mod/999/review', {
        'X-Admin-Token': 'secret123',
      }, { verdict: 'approved' });
      expect(r.status).toBe(404); // reached handler
    });
  });

  describe('dev-mode fallthrough (no token configured)', () => {
    beforeEach(async () => {
      f = await makePortal({ allowedOrigins: ['http://localhost:4000'] });
    });

    it('200 on GET /mod/stats without token', async () => {
      const r = await f.req('GET', '/mod/stats');
      expect(r.status).toBe(200);
    });

    it('but Origin rule still enforced on POST', async () => {
      const r = await f.req('POST', '/mod/999/review', {
        Origin: 'http://evil.example',
      }, { verdict: 'approved' });
      expect(r.status).toBe(403);
    });
  });

  describe('wildcard origin ("*")', () => {
    beforeEach(async () => {
      f = await makePortal({ adminToken: 'secret123', allowedOrigins: ['*'] });
    });

    it('sets ACAO=*', async () => {
      const r = await f.req('GET', '/mod/stats', {
        'X-Admin-Token': 'secret123',
        Origin: 'http://anywhere.example',
      });
      expect(r.headers['access-control-allow-origin']).toBe('*');
    });

    it('skips Origin CSRF check on POST', async () => {
      const r = await f.req('POST', '/mod/999/review', {
        'X-Admin-Token': 'secret123',
        Origin: 'http://anywhere.example',
      }, { verdict: 'approved' });
      expect(r.status).toBe(404); // reached handler
    });
  });
});
