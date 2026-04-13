import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IBotReplyRepository } from '../storage/db.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('rating-portal');

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export class RatingPortalServer {
  private readonly server = createServer((req, res) => void this._handle(req, res));

  constructor(
    private readonly repo: IBotReplyRepository,
    private readonly groupId: string,
  ) {}

  start(port = 4000, host = '127.0.0.1'): void {
    this.server.listen(port, host, () => {
      logger.info({ port, host }, 'rating portal listening');
    });
  }

  stop(): void {
    this.server.close();
  }

  private async _handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const { pathname } = url;

    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'GET' && pathname === '/') {
      const htmlPath = fileURLToPath(new URL('./rating-portal.html', import.meta.url));
      try {
        const html = readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end('UI not found');
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/replies') {
      const mode = url.searchParams.get('mode') ?? 'unrated';
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
      const replies = mode === 'unrated'
        ? this.repo.getUnrated(this.groupId, limit)
        : this.repo.getRecent(this.groupId, limit);
      json(res, 200, replies);
      return;
    }

    if (req.method === 'POST' && /^\/api\/replies\/(\d+)\/rate$/.test(pathname)) {
      const id = parseInt(pathname.split('/')[3]!, 10);
      let body: { rating?: number; comment?: string };
      try {
        body = JSON.parse(await readBody(req)) as { rating?: number; comment?: string };
      } catch {
        json(res, 400, { error: 'invalid json' });
        return;
      }
      const rating = body.rating;
      if (rating === undefined || ![1, 2, 3, 4, 5].includes(rating)) {
        json(res, 400, { error: 'rating must be 1-5' });
        return;
      }
      this.repo.rate(id, rating, body.comment ?? null, Math.floor(Date.now() / 1000));
      json(res, 200, { ok: true });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }
}
