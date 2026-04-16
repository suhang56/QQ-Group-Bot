import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IBotReplyRepository, ILocalStickerRepository, IModerationRepository, IMessageRepository, IMemeGraphRepo } from '../storage/db.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('rating-portal');

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
  private memeGraphRepo: IMemeGraphRepo | null = null;

  constructor(
    private readonly repo: IBotReplyRepository,
    private readonly groupId: string,
    private readonly moderation: IModerationRepository,
    private readonly messages: IMessageRepository,
    private readonly localStickers?: ILocalStickerRepository,
  ) {}

  setMemeGraphRepo(repo: IMemeGraphRepo): void {
    this.memeGraphRepo = repo;
  }

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
      // Original message: prefer originalContent stored at assessment time;
      // fall back to timestamp-based lookup for legacy records.
      const modTs = record.timestamp;
      if (record.originalContent) {
        body['originalMessage'] = { content: record.originalContent, userId: record.userId, timestamp: record.timestamp, nickname: null };
      } else {
        const origMsg = this.messages.findNearTimestamp(record.groupId, record.userId, modTs, 120);
        if (origMsg) {
          body['originalMessage'] = { content: origMsg.content, nickname: origMsg.nickname, userId: origMsg.userId, timestamp: origMsg.timestamp };
        }
      }
      // Nearby context: all messages in the group within ±2 min of the moderation event
      const nearby = this.messages.getAroundTimestamp(record.groupId, modTs, 120, 10);
      if (nearby.length > 0) {
        body['contextMessages'] = nearby.map(m => ({
          nickname: m.nickname, content: m.content, timestamp: m.timestamp, userId: m.userId,
        }));
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
      const existing = this.repo.getById(id);
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

    // --- Meme graph routes (memes-v1 P5) ---

    // GET /memes/:groupId — list meme_graph entries as HTML table
    if (req.method === 'GET' && /^\/memes\/([^/]+)$/.test(pathname)) {
      if (!this.memeGraphRepo) {
        json(res, 503, { error: 'memeGraphRepo not available' });
        return;
      }
      const groupId = decodeURIComponent(pathname.split('/')[2]!);
      const memes = this.memeGraphRepo.listActive(groupId, 200);

      const rows = memes.map(m => {
        const variants = m.variants.slice(0, 5).join(', ');
        const origin = m.originEvent ? esc(m.originEvent.slice(0, 80)) : '';
        const ts = new Date(m.updatedAt * 1000).toLocaleString('zh-CN');
        return `<tr>
          <td>${m.id}</td>
          <td>${esc(m.canonical)}</td>
          <td>${esc(variants)}</td>
          <td>${esc(m.meaning)}</td>
          <td title="${esc(m.originEvent ?? '')}">${origin}</td>
          <td>${m.totalCount}</td>
          <td>${m.confidence.toFixed(2)}</td>
          <td>${esc(m.status)}</td>
          <td>${ts}</td>
          <td>
            <button onclick="editMeme(${m.id})">Edit</button>
            <button onclick="demoteMeme(${m.id})">Demote</button>
          </td>
        </tr>`;
      }).join('\n');

      const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meme Graph - ${esc(groupId)}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e0e0e0; padding: 24px; }
h1 { font-size: 18px; font-weight: 600; color: #fff; margin-bottom: 16px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 8px 10px; border: 1px solid #333; text-align: left; }
th { background: #1a1a1a; color: #aaa; text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em; }
tr:hover { background: #1a1a1a; }
button { background: #1e1e1e; border: 1px solid #444; color: #e0e0e0; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; margin: 0 2px; }
button:hover { background: #2a2a2a; }
.empty { text-align: center; padding: 60px; color: #555; }
.stat { font-size: 13px; color: #888; margin-bottom: 12px; }
</style>
</head>
<body>
<h1>Meme Graph: ${esc(groupId)}</h1>
<div class="stat">${memes.length} active memes</div>
${memes.length === 0 ? '<div class="empty">No memes found.</div>' : `<table>
<thead><tr>
  <th>ID</th><th>Canonical</th><th>Variants</th><th>Meaning</th>
  <th>Origin</th><th>Count</th><th>Confidence</th><th>Status</th>
  <th>Updated</th><th>Actions</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>`}
<script>
async function editMeme(id) {
  const canonical = prompt('New canonical (leave blank to skip):');
  const variants = prompt('New variants (comma-separated, leave blank to skip):');
  const meaning = prompt('New meaning (leave blank to skip):');
  const body = {};
  if (canonical) body.canonical = canonical;
  if (variants) body.variants = variants.split(',').map(v => v.trim()).filter(Boolean);
  if (meaning) body.meaning = meaning;
  if (Object.keys(body).length === 0) return;
  const res = await fetch('/memes/' + id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) location.reload();
  else alert('Error: ' + (await res.text()));
}
async function demoteMeme(id) {
  if (!confirm('Demote this meme?')) return;
  const res = await fetch('/memes/' + id + '/demote', { method: 'POST' });
  if (res.ok) location.reload();
  else alert('Error: ' + (await res.text()));
}
</script>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // PATCH /memes/:id — partial update canonical/variants/meaning + set status='manual_edit'
    if (req.method === 'PATCH' && /^\/memes\/(\d+)$/.test(pathname)) {
      if (!this.memeGraphRepo) {
        json(res, 503, { error: 'memeGraphRepo not available' });
        return;
      }
      const id = parseInt(pathname.split('/')[2]!, 10);
      const existing = this.memeGraphRepo.findById(id);
      if (!existing) {
        json(res, 404, { error: 'meme not found' });
        return;
      }
      let body: { canonical?: string; variants?: string[]; meaning?: string };
      try {
        body = JSON.parse(await readBody(req)) as { canonical?: string; variants?: string[]; meaning?: string };
      } catch {
        json(res, 400, { error: 'invalid json' });
        return;
      }
      this.memeGraphRepo.adminEdit(id, body);
      const updated = this.memeGraphRepo.findById(id);
      logger.info({ id, changes: Object.keys(body) }, 'meme manually edited');
      json(res, 200, updated);
      return;
    }

    // POST /memes/:id/demote — set status='demoted'
    if (req.method === 'POST' && /^\/memes\/(\d+)\/demote$/.test(pathname)) {
      if (!this.memeGraphRepo) {
        json(res, 503, { error: 'memeGraphRepo not available' });
        return;
      }
      const id = parseInt(pathname.split('/')[2]!, 10);
      const existing = this.memeGraphRepo.findById(id);
      if (!existing) {
        json(res, 404, { error: 'meme not found' });
        return;
      }
      this.memeGraphRepo.update(id, { status: 'demoted' });
      logger.info({ id }, 'meme demoted');
      json(res, 200, { ok: true });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }
}
