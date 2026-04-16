import { createHash } from 'node:crypto';
import { parse as parseHtml } from 'node-html-parser';
import { createLogger } from '../utils/logger.js';
import type { IBandoriLiveRepository, BandoriLiveRow } from '../storage/db.js';

const logger = createLogger('bandori-live');

export interface BandoriLiveScraperOptions {
  enabled?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  sourceUrl?: string;
  requestTimeoutMs?: number;
}

export const BANDORI_LIVE_KEYWORDS: string[] = [
  // Event/show language (zh/ja/en)
  'live', 'ライブ', '演唱会', '公演', '演出', '场', '会场', '场馆',
  '活动', '活動', 'イベント', 'event', 'fes', '音乐祭', '音樂祭',
  '巡演', '巡回', 'ツアー', 'tour', '周年', '周年庆', '排期', '日程',
  '票', 'チケット', 'ticket', '单独ライブ',
  // Canonical band names
  'Roselia', "MyGO!!!!!", 'MyGO', 'Ave Mujica', "Poppin'Party", 'Afterglow',
  'Hello Happy World!', 'Hello, Happy World!', 'Pastel Palettes', 'Morfonica',
  'RAISE A SUILEN', 'CRYCHIC',
  // Shortforms (lowercase because matching is .toLowerCase())
  'ppp', 'popipa', 'ras', 'mygo', 'mjk', 'mujica', 'hhw', 'hhp',
  'pasupare', 'morfo', 'ag',
  // Chinese/Japanese band name variants
  '波普派对', '余晖', '彩色调色板', '彩帕', '玫瑰利亚',
  'ロゼリア', 'アヴェムジカ', 'モルフォニカ', 'マイゴ', 'パスパレ', 'ハロハピ',
];

export function _hasBandoriLiveKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return BANDORI_LIVE_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

// ---------------------------------------------------------------
// Date parsing helpers
// ---------------------------------------------------------------

/**
 * Convert various date formats → "2026-07-18".
 * Supported:
 *   "2026.07.18" / "2026/07/18" / "2026-07-18" (ISO-ish)
 *   "2026年7月18日" / "2026年7月18日(土)" (Japanese, actually used by bang-dream.com)
 * Returns null if unparseable.
 */
function _normDate(raw: string): string | null {
  const trimmed = raw.trim();
  // Japanese format: 2026年7月18日 (may be followed by (曜日) weekday suffix)
  const ja = trimmed.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (ja) return `${ja[1]}-${ja[2]!.padStart(2, '0')}-${ja[3]!.padStart(2, '0')}`;
  // ISO-ish: 2026.07.18 / 2026/07/18 / 2026-07-18
  const iso = trimmed.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2]!.padStart(2, '0')}-${iso[3]!.padStart(2, '0')}`;
  return null;
}

/**
 * Parse a date string into { startDate, endDate }.
 * Supports:
 *   "2026.07.18〜2026.07.19"  (ISO range, full)
 *   "2026年9月22日(火・祝)"   (Japanese single, bang-dream.com format)
 *   "2026年8月29日(土)・30日(日)"  (Japanese range where end reuses start's year/month)
 *   "2026.07.18" / "2026年10月5日"  (single)
 *   "" or unparseable → both null (logs E043)
 */
function _parseDateRange(raw: string): { startDate: string | null; endDate: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { startDate: null, endDate: null };

  // Japanese range shorthand: "2026年8月29日(土)・30日(日)" — second date omits 年/月
  const jaRange = trimmed.match(/(\d{4})年(\d{1,2})月(\d{1,2})日(?:\([^)]*\))?\s*[・〜~ー～]\s*(\d{1,2})日/);
  if (jaRange) {
    const y = jaRange[1]!;
    const mo = jaRange[2]!.padStart(2, '0');
    const d1 = jaRange[3]!.padStart(2, '0');
    const d2 = jaRange[4]!.padStart(2, '0');
    return { startDate: `${y}-${mo}-${d1}`, endDate: `${y}-${mo}-${d2}` };
  }

  // ISO or long-form range: "2026.07.18〜2026.07.19" (two full dates)
  const sep = trimmed.match(/[〜~ー～]/);
  if (sep) {
    const parts = trimmed.split(/[〜~ー～]/);
    const start = _normDate(parts[0] ?? '');
    const end = _normDate(parts[1] ?? '');
    if (start) return { startDate: start, endDate: end };
  }

  // Single date (ISO or Japanese with optional (曜日) suffix)
  const single = _normDate(trimmed);
  if (!single) {
    logger.warn({ raw }, 'E043: bandori date parse failed');
    return { startDate: null, endDate: null };
  }
  return { startDate: single, endDate: null };
}

// ---------------------------------------------------------------
// eventKey / rawHash helpers
// ---------------------------------------------------------------

function _makeEventKey(detailUrl: string | null, title: string): string {
  return createHash('sha256')
    .update(detailUrl ?? title)
    .digest('hex')
    .slice(0, 16);
}

function _makeRawHash(fields: {
  title: string;
  startDate: string | null;
  endDate: string | null;
  venue: string | null;
  city: string | null;
  bands: string[];
  ticketInfoText: string | null;
}): string {
  // Sort bands for determinism (EC-19)
  const canonical = JSON.stringify({
    title: fields.title,
    startDate: fields.startDate,
    endDate: fields.endDate,
    venue: fields.venue,
    city: fields.city,
    bands: fields.bands.slice().sort(),
    ticketInfoText: fields.ticketInfoText,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------
// HTML Parser
// ---------------------------------------------------------------

interface ParsedEvent {
  title: string;
  startDate: string | null;
  endDate: string | null;
  venue: string | null;
  city: string | null;
  bands: string[];
  detailUrl: string | null;
  ticketInfoText: string | null;
  eventKey: string;
  rawHash: string;
}

export function _parseEvents(html: string): ParsedEvent[] {
  try {
    const root = parseHtml(html);
    // Remove noise elements before parsing
    root.querySelectorAll('script, style, nav, footer, header').forEach(el => el.remove());

    // Real selector from https://bang-dream.com/events/ (verified 2026-04-15).
    // Fallback selector `.event-card` is kept for synthetic test fixtures.
    const cards = root.querySelectorAll(
      'article.p-live-event-list__item, article.event-card, div.event-card, .event-item, li.event-card'
    );
    if (cards.length === 0) return [];

    const results: ParsedEvent[] = [];
    for (const card of cards) {
      // Title: real site uses .p-live-event-list__item-title; fallback for fixtures
      const titleEl = card.querySelector(
        '.p-live-event-list__item-title, .event-title, h2, h3, .title'
      );
      const title = titleEl?.text.trim() ?? '';
      if (!title) continue;

      // Date: real site has h2.date label + <p> sibling inside .p-live-event-list__item-description.
      // Use the <p> children of the description block — first <p> is the date.
      let rawDate = '';
      const descEl = card.querySelector('.p-live-event-list__item-description');
      if (descEl) {
        const ps = descEl.querySelectorAll('p');
        if (ps.length > 0) rawDate = ps[0]?.text.trim() ?? '';
      }
      if (!rawDate) {
        // Fallback for fixture structure: direct .event-date / .date / time element
        const dateEl = card.querySelector('.event-date, .date, time');
        rawDate = dateEl?.text.trim() ?? '';
      }
      const { startDate, endDate } = _parseDateRange(rawDate);

      // Venue: second <p> in description block; or fallback .event-venue
      let venue: string | null = null;
      if (descEl) {
        const ps = descEl.querySelectorAll('p');
        if (ps.length >= 2) venue = ps[1]?.text.trim() || null;
      }
      if (!venue) {
        const venueEl = card.querySelector('.event-venue, .venue');
        venue = venueEl?.text.trim() || null;
      }

      // City: real site doesn't have a separate city field in the card; use fallback
      const cityEl = card.querySelector('.event-city, .city');
      const city = cityEl?.text.trim() || null;

      // Bands: real site has multiple <span class="p-live-event-list__item-artist-item">
      let bands: string[] = [];
      const bandSpans = card.querySelectorAll('.p-live-event-list__item-artist-item');
      if (bandSpans.length > 0) {
        bands = bandSpans.map(s => s.text.trim()).filter(Boolean);
      } else {
        const bandsEl = card.querySelector('.event-bands, .bands, .artist');
        const bandsRaw = bandsEl?.text.trim() ?? '';
        bands = bandsRaw ? bandsRaw.split(/[,、·・\/]/).map(b => b.trim()).filter(Boolean) : [];
      }

      const ticketEl = card.querySelector('.event-ticket, .ticket, .ticket-info');
      const ticketInfoText = ticketEl?.text.trim() || null;

      // Link: real site's a.p-live-event-list__item-link OR legacy a.event-detail-link
      const linkEl = card.querySelector(
        'a.p-live-event-list__item-link, a.event-detail-link, a[href*="/events/"]'
      );
      const rawHref = linkEl?.getAttribute('href') ?? null;
      const detailUrl = rawHref
        ? (rawHref.startsWith('http') ? rawHref : `https://bang-dream.com${rawHref}`)
        : null;

      const eventKey = _makeEventKey(detailUrl, title);
      const rawHash = _makeRawHash({ title, startDate, endDate, venue, city, bands, ticketInfoText });

      results.push({ title, startDate, endDate, venue, city, bands, detailUrl, ticketInfoText, eventKey, rawHash });
    }
    return results;
  } catch (err) {
    logger.warn({ err }, 'E042: bandori HTML parse threw');
    return [];
  }
}

// ---------------------------------------------------------------
// Context block formatter
// ---------------------------------------------------------------

export function _formatLiveBlock(events: BandoriLiveRow[]): string {
  const lines = events.map(e => {
    const dateStr = e.startDate
      ? (e.endDate && e.endDate !== e.startDate ? `${e.startDate} ~ ${e.endDate}` : e.startDate)
      : '日程未定';
    const bandsStr = e.bands.length > 0 ? e.bands.join(' / ') : '未知乐队';
    const venueStr = [e.venue, e.city].filter(Boolean).join('・') || '场馆未定';
    const ticketStr = e.ticketInfoText ? `（${e.ticketInfoText.slice(0, 40)}）` : '';
    return `- ${e.title}｜${dateStr}｜${bandsStr}｜${venueStr}${ticketStr}`;
  });
  const guidance = `（这是从武士道官方抓取的**当前真实** Live 排期，不是假数据。用户的消息里提到了 live/公演/活动/乐队名这类词，所以这个块被主动注入。

**如何使用这个块（硬性规则）**：
- 如果用户在问 live 信息（"最近有什么 live"/"ppp 什么时候演出"/"ras 在哪开"），你 **必须**用上面的数据直接给出答复：提具体活动名、日期、场地、乐队。不要说"看看"/"不知道"/"让我查"/"我去找找"—— 你**已经有数据了**，就在上面。
- 回复要自然，像粉丝聊天，但要有**具体内容**：至少一个活动名 + 日期。不要只说感想不给事实。
- 不要把上面当成列表原样复读，融入语气：比如 "有啊 X 月 X 号 Roselia 在 XX"/"下个月 ppp 有 XX" 这种口吻。
- 如果数据里没有用户问的那个乐队，直接说"最近没看到 X 的"即可，不要瞎编。
- 如果用户只是顺嘴提了 live（比如在聊别的话题时一句带过），可以不硬塞这个块的内容，但也不要说"看看"这种。

**禁区**：
- 禁止说"看看有没有"/"不知道"/"我去查"/"还没看到"/"让我搜一下" —— 你不是搜索引擎助手，你**已经有数据了**。
- 禁止反问用户"你想看哪个"/"你说哪个团" —— 数据就在上面，你自己挑一个答。`;
  return `【近期 BanG Dream! Live 信息（${events.length} 条，来自武士道官方）】\n${lines.join('\n')}\n${guidance}`;
}

// ---------------------------------------------------------------
// Scraper class
// ---------------------------------------------------------------

export class BandoriLiveScraper {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly sourceUrl: string;
  private readonly requestTimeoutMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly repo: IBandoriLiveRepository,
    options: BandoriLiveScraperOptions = {},
  ) {
    this.enabled = options.enabled ?? true;
    this.intervalMs = options.intervalMs ?? 86_400_000;
    this.initialDelayMs = options.initialDelayMs ?? 60_000;
    this.sourceUrl = options.sourceUrl ?? 'https://bang-dream.com/events/';
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  start(): void {
    if (!this.enabled) {
      logger.info('bandori-live scraper disabled (BANDORI_SCRAPE_ENABLED=false)');
      return;
    }
    this.timer = setTimeout(() => void this._runAndSchedule(), this.initialDelayMs);
    this.timer.unref?.();
    logger.info({ intervalMs: this.intervalMs, initialDelayMs: this.initialDelayMs }, 'bandori-live scraper started');
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async _runAndSchedule(): Promise<void> {
    try {
      const n = await this.scrape();
      logger.info({ eventsUpserted: n }, 'bandori-live scrape complete');
    } catch (err) {
      logger.error({ err }, 'bandori-live scrape failed');
    }
    this.timer = setTimeout(() => void this._runAndSchedule(), this.intervalMs);
    this.timer.unref?.();
  }

  async scrape(): Promise<number> {
    let html: string;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      let resp: Response;
      try {
        resp = await fetch(this.sourceUrl, {
          signal: controller.signal,
          headers: { 'User-Agent': 'BanGDreamFanBot/1.0 (QQ group assistant; non-commercial)' },
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!resp.ok) {
        logger.warn({ status: resp.status, url: this.sourceUrl }, 'E041: bandori HTTP error');
        return 0;
      }
      html = await resp.text();
    } catch (err) {
      logger.warn({ err, url: this.sourceUrl }, 'E040: bandori network error');
      return 0;
    }

    const events = _parseEvents(html);
    if (events.length === 0) {
      logger.warn({ preview: html.slice(0, 200) }, 'E042: bandori parse returned zero events');
      return 0;
    }

    const nowSecs = Math.floor(Date.now() / 1000);
    for (const e of events) {
      this.repo.upsert({
        eventKey: e.eventKey,
        title: e.title,
        startDate: e.startDate,
        endDate: e.endDate,
        venue: e.venue,
        city: e.city,
        bands: e.bands,
        detailUrl: e.detailUrl,
        ticketInfoText: e.ticketInfoText,
        fetchedAt: nowSecs,
        lastSeenAt: nowSecs,
        rawHash: e.rawHash,
      });
    }
    return events.length;
  }
}
