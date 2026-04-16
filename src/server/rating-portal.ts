import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IBotReplyRepository, ILocalStickerRepository, IModerationRepository, IMessageRepository } from '../storage/db.js';
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

/**
 * Parse a severity query param. Accepts single integer ("3") or range ("3-5").
 * Returns { min, max } on success or null if invalid.
 */
function parseSeverityParam(raw: string): { min: number; max: number } | null {
  const rangeParts = raw.split('-');
  if (rangeParts.length === 2) {
    const min = parseInt(rangeParts[0]!, 10);
    const max = parseInt(rangeParts[1]!, 10);
    if (isNaN(min) || isNaN(max) || min > max) return null;
    return { min, max };
  }
  const val = parseInt(raw, 10);
  if (isNaN(val)) return null;
  return { min: val, max: val };
}

export class RatingPortalServer {
  private readonly server = createServer((req, res) => void this._handle(req, res));

  constructor(
    private readonly repo: IBotReplyRepository,
    private readonly groupId: string,
    private readonly moderation: IModerationRepository,
    private readonly messages: IMessageRepository,
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

    // --- Moderation review routes (§13) ---

    if (req.method === 'GET' && pathname === '/mod') {
      const htmlPath = fileURLToPath(new URL('./mod-review.html', import.meta.url));
      try {
        const html = readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        // HTML not yet available (designer delivering later); return minimal placeholder
        const placeholder = '<!DOCTYPE html><html><body><table><tr><td>Moderation Review UI pending</td></tr></table></body></html>';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(placeholder);
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/mod/stats') {
      json(res, 200, this.moderation.getStats());
      return;
    }

    if (req.method === 'GET' && pathname === '/mod/list') {
      // Parse and validate query params
      const statusRaw = url.searchParams.get('status') ?? 'all';
      const validStatuses = ['all', 'unreviewed', 'approved', 'rejected'];
      if (!validStatuses.includes(statusRaw)) {
        json(res, 400, { error: `invalid param: status must be one of ${validStatuses.join('|')}` });
        return;
      }

      const severityRaw = url.searchParams.get('severity');
      let severityMin: number | undefined;
      let severityMax: number | undefined;
      if (severityRaw !== null) {
        const parsed = parseSeverityParam(severityRaw);
        if (parsed === null) {
          json(res, 400, { error: 'invalid param: severity must be an integer or N-M range' });
          return;
        }
        severityMin = parsed.min;
        severityMax = parsed.max;
      }

      const pageRaw = parseInt(url.searchParams.get('page') ?? '1', 10);
      if (isNaN(pageRaw) || pageRaw < 1) {
        json(res, 400, { error: 'invalid param: page must be >= 1' });
        return;
      }

      const limitRaw = parseInt(url.searchParams.get('limit') ?? '20', 10);
      if (isNaN(limitRaw) || limitRaw < 1 || limitRaw > 100) {
        json(res, 400, { error: 'invalid param: limit must be 1-100' });
        return;
      }

      const reviewedFilter: 0 | 1 | 2 | undefined =
        statusRaw === 'unreviewed' ? 0 :
        statusRaw === 'approved' ? 1 :
        statusRaw === 'rejected' ? 2 :
        undefined;

      // action filter: 'punished' (default) | 'all' | 'none'
      const actionRaw = url.searchParams.get('action') ?? 'punished';
      const validActions = ['punished', 'all', 'none'];
      const actionFilter = validActions.includes(actionRaw)
        ? (actionRaw as 'punished' | 'all' | 'none')
        : 'punished';

      const { records, total } = this.moderation.getForReview(
        {
          groupId: url.searchParams.get('group') ?? undefined,
          reviewed: reviewedFilter,
          severityMin,
          severityMax,
          actionFilter,
        },
        pageRaw,
        limitRaw,
      );

      json(res, 200, { records, page: pageRaw, limit: limitRaw, total });
      return;
    }

    // GET /mod/:id
    if (req.method === 'GET' && /^\/mod\/(\d+)$/.test(pathname)) {
      const id = parseInt(pathname.split('/')[2]!, 10);
      const record = this.moderation.findById(id);
      if (!record) {
        json(res, 404, { error: 'not found' });
        return;
      }
      const body: Record<string, unknown> = { record };
      if (record.appealed !== 0) {
        body['appeal'] = { appealed: record.appealed, reversed: record.reversed };
      }
      // Fetch the original message + surrounding context.
      // moderation_log.msg_id is a short NapCat ID; messages.source_message_id
      // is a long NapCat ID — they don't match. Fall back to timestamp+userId
      // proximity search within a ±10s window.
      const modTs = record.timestamp;
      const recent = this.messages.getRecent(record.groupId, 200);
      const origMsg = recent.find(m =>
        m.userId === record.userId && Math.abs(m.timestamp - modTs) <= 10
      );
      if (origMsg) {
        body['originalMessage'] = { content: origMsg.content, nickname: origMsg.nickname, userId: origMsg.userId, timestamp: origMsg.timestamp };
      }
      // Nearby messages: within 2 min of moderation timestamp
      const nearby = recent
        .filter(m => Math.abs(m.timestamp - modTs) <= 120)
        .slice(0, 10)
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(m => ({ nickname: m.nickname, content: m.content, timestamp: m.timestamp, userId: m.userId }));
      if (nearby.length > 0) {
        body['contextMessages'] = nearby;
      }
      json(res, 200, body);
      return;
    }

    // POST /mod/:id/review
    if (req.method === 'POST' && /^\/mod\/(\d+)\/review$/.test(pathname)) {
      const id = parseInt(pathname.split('/')[2]!, 10);
      let body: { verdict?: string };
      try {
        body = JSON.parse(await readBody(req)) as { verdict?: string };
      } catch {
        json(res, 400, { error: 'invalid json' });
        return;
      }
      const { verdict } = body;
      if (verdict !== 'approved' && verdict !== 'rejected') {
        json(res, 400, { error: 'verdict must be "approved" or "rejected"' });
        return;
      }
      const existing = this.moderation.findById(id);
      if (!existing) {
        json(res, 404, { error: 'not found' });
        return;
      }
      const numericVerdict: 1 | 2 = verdict === 'approved' ? 1 : 2;
      this.moderation.markReviewed(id, numericVerdict, 'admin', Math.floor(Date.now() / 1000));
      logger.info({ id, verdict }, 'moderation record reviewed');
      json(res, 200, { ok: true });
      return;
    }

    // --- Existing rating portal routes ---

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
