import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IBotReplyRepository, ILocalStickerRepository } from '../storage/db.js';
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

/** Extract sticker keys (sha256 hashes or mface:pkg:id) from a bot reply string. */
function extractStickerKeys(botReply: string): string[] {
  const keys: string[] = [];
  // image sticker: file=file:///.../<hash>.<ext>
  for (const m of botReply.matchAll(/\[CQ:image,file=file:\/\/\/[^,\]]*\/([a-f0-9]{16})\.[a-z]+/g)) {
    keys.push(m[1]!);
  }
  // mface sticker: package_id=X,emoji_id=Y
  for (const m of botReply.matchAll(/\[CQ:mface,([^\]]+)\]/g)) {
    const attrs = Object.fromEntries(m[1]!.split(',').map(p => { const [k, ...v] = p.split('='); return [k, v.join('=')] as [string, string]; }));
    const pkg = attrs['package_id'] ?? attrs['pkg'] ?? '';
    const id = attrs['emoji_id'] ?? attrs['id'] ?? '';
    if (pkg && id) keys.push(`mface:${pkg}:${id}`);
  }
  return keys;
}

export class RatingPortalServer {
  private readonly server = createServer((req, res) => void this._handle(req, res));

  constructor(
    private readonly repo: IBotReplyRepository,
    private readonly groupId: string,
    private readonly localStickers?: ILocalStickerRepository,
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
      // Fetch the reply before updating so we can read botReply for sticker feedback
      const existing = this.repo.getRecent(this.groupId, 500).find(r => r.id === id);
      this.repo.rate(id, rating, body.comment ?? null, Math.floor(Date.now() / 1000));
      // Feedback loop: update sticker usage scores if reply contained stickers
      if (existing && this.localStickers) {
        const keys = extractStickerKeys(existing.botReply);
        const positive = rating >= 4;
        const negative = rating <= 2;
        for (const key of keys) {
          if (positive) this.localStickers.recordUsage(this.groupId, key, true);
          else if (negative) this.localStickers.recordUsage(this.groupId, key, false);
        }
      }
      json(res, 200, { ok: true });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }
}
