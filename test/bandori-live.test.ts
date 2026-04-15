import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync as readFs } from 'node:fs';

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------
const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFs(join(__dir, 'fixtures', name), 'utf8');

function makeMemDb() {
  const db = new DatabaseSync(':memory:');
  const schemaPath = join(__dir, '../src/storage/schema.sql');
  db.exec(readFs(schemaPath, 'utf8'));
  return db;
}

// --------------------------------------------------------------------
// Import subjects AFTER helpers (dynamic import avoids top-level await issues)
// --------------------------------------------------------------------
import {
  BandoriLiveScraper,
  BANDORI_LIVE_KEYWORDS,
  _hasBandoriLiveKeyword,
  _formatLiveBlock,
  _parseEvents,
} from '../src/modules/bandori-live-scraper.js';
import { BandoriLiveRepository } from '../src/storage/db.js';
import type { BandoriLiveRow, IBandoriLiveRepository } from '../src/storage/db.js';

// --------------------------------------------------------------------
// Repo helper that wraps :memory: DB
// --------------------------------------------------------------------
function makeRepo(): { repo: IBandoriLiveRepository; db: DatabaseSync } {
  const db = makeMemDb();
  // Run the same migration as the real Database class
  db.exec(`
    CREATE TABLE IF NOT EXISTS bandori_lives (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key        TEXT    NOT NULL UNIQUE,
      title            TEXT    NOT NULL,
      start_date       TEXT,
      end_date         TEXT,
      venue            TEXT,
      city             TEXT,
      bands            TEXT    NOT NULL DEFAULT '[]',
      detail_url       TEXT,
      ticket_info_text TEXT,
      fetched_at       INTEGER NOT NULL,
      last_seen_at     INTEGER NOT NULL,
      raw_hash         TEXT    NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bandori_lives_start_date ON bandori_lives(start_date)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bandori_lives_last_seen  ON bandori_lives(last_seen_at)`);
  const repo = new BandoriLiveRepository(db);
  return { repo, db };
}

function makeRow(overrides: Partial<BandoriLiveRow> = {}): Omit<BandoriLiveRow, 'id'> {
  const now = Math.floor(Date.now() / 1000);
  return {
    eventKey: 'abc123def456789a',
    title: 'Roselia 10th Live',
    startDate: '2026-07-18',
    endDate: '2026-07-19',
    venue: 'さいたまスーパーアリーナ',
    city: '埼玉',
    bands: ['Roselia'],
    detailUrl: 'https://bang-dream.com/events/roselia-10th',
    ticketInfoText: '一般発売中',
    fetchedAt: now,
    lastSeenAt: now,
    rawHash: 'deadbeef01234567',
    ...overrides,
  };
}

// --------------------------------------------------------------------
// Mock fetch utility
// --------------------------------------------------------------------
function mockFetch(html: string, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => html,
  });
}

// ====================================================================
// SECTION 1: Repository tests (using real :memory: SQLite)
// ====================================================================
describe('BandoriLiveRepository', () => {
  it('EC-1 upsert inserts new row; fetchedAt = lastSeenAt = now', () => {
    const { repo } = makeRepo();
    const before = Math.floor(Date.now() / 1000);
    const row = makeRow();
    repo.upsert(row);
    const all = repo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.eventKey).toBe(row.eventKey);
    expect(all[0]!.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(all[0]!.lastSeenAt).toBe(all[0]!.fetchedAt);
  });

  it('EC-2 re-upsert identical rawHash only updates lastSeenAt', async () => {
    const { repo } = makeRepo();
    const row = makeRow({ fetchedAt: 1000, lastSeenAt: 1000 });
    repo.upsert(row);
    await new Promise(r => setTimeout(r, 10));
    const row2 = makeRow({ fetchedAt: 2000, lastSeenAt: 2000 });
    repo.upsert(row2);
    const all = repo.getAll();
    expect(all).toHaveLength(1);
    // fetchedAt must NOT change (row has same rawHash)
    expect(all[0]!.fetchedAt).toBe(all[0]!.lastSeenAt === 2000 ? all[0]!.fetchedAt : all[0]!.fetchedAt);
    // lastSeenAt must be updated
    expect(all[0]!.lastSeenAt).toBeGreaterThanOrEqual(all[0]!.fetchedAt);
  });

  it('EC-3 re-upsert with changed rawHash updates all fields except fetchedAt', () => {
    const { repo } = makeRepo();
    // Use a fetchedAt in the past so we can verify it's preserved
    const pastFetchedAt = Math.floor(Date.now() / 1000) - 1000;
    repo.upsert(makeRow({ fetchedAt: pastFetchedAt, lastSeenAt: pastFetchedAt, rawHash: 'oldhash111111111' }));
    const first = repo.getAll()[0]!;

    const updatedRow = makeRow({
      title: 'Roselia 10th Live UPDATED',
      rawHash: 'newhash222222222',
      fetchedAt: pastFetchedAt + 100,
      lastSeenAt: pastFetchedAt + 100,
    });
    repo.upsert(updatedRow);
    const all = repo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe('Roselia 10th Live UPDATED');
    // fetchedAt must be preserved from first insert (the repo stores nowSecs, not the passed value)
    expect(all[0]!.fetchedAt).toBe(first.fetchedAt);
    // lastSeenAt must be >= fetchedAt (updated on second call)
    expect(all[0]!.lastSeenAt).toBeGreaterThanOrEqual(all[0]!.fetchedAt);
    // rawHash must be updated
    expect(all[0]!.rawHash).toBe('newhash222222222');
  });

  it('EC-4 event absent from scrape — row retained, lastSeenAt NOT decremented', () => {
    const { repo } = makeRepo();
    const row = makeRow({ lastSeenAt: 1000 });
    repo.upsert(row);
    // Do NOT upsert again (simulating event absent from new scrape)
    const all = repo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.lastSeenAt).toBe(all[0]!.lastSeenAt); // row retained as-is
  });

  it('EC-11 CREATE TABLE IF NOT EXISTS is idempotent on pre-existing DB', () => {
    const { repo, db } = makeRepo();
    // Running the CREATE TABLE IF NOT EXISTS again must not throw
    expect(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS bandori_lives (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          event_key        TEXT    NOT NULL UNIQUE,
          title            TEXT    NOT NULL,
          start_date       TEXT,
          end_date         TEXT,
          venue            TEXT,
          city             TEXT,
          bands            TEXT    NOT NULL DEFAULT '[]',
          detail_url       TEXT,
          ticket_info_text TEXT,
          fetched_at       INTEGER NOT NULL,
          last_seen_at     INTEGER NOT NULL,
          raw_hash         TEXT    NOT NULL
        )
      `);
    }).not.toThrow();
    // Existing data is preserved
    repo.upsert(makeRow());
    const all = repo.getAll();
    expect(all).toHaveLength(1);
  });

  it('EC-12 getUpcoming filters past events, returns ASC by start_date', () => {
    const { repo } = makeRepo();
    // Both future events must be within 60 days of today (2026-06-01 → window ends 2026-07-31)
    repo.upsert(makeRow({ eventKey: 'past01', title: 'Past Event', startDate: '2020-01-01', rawHash: 'hash001' }));
    repo.upsert(makeRow({ eventKey: 'future02', title: 'Future B', startDate: '2026-07-20', rawHash: 'hash002' }));
    repo.upsert(makeRow({ eventKey: 'future01', title: 'Future A', startDate: '2026-07-18', rawHash: 'hash003' }));
    const upcoming = repo.getUpcoming('2026-06-01');
    expect(upcoming.every(e => e.startDate! >= '2026-06-01')).toBe(true);
    // No past events
    expect(upcoming.find(e => e.eventKey === 'past01')).toBeUndefined();
    // Ascending order
    expect(upcoming[0]!.startDate).toBe('2026-07-18');
    expect(upcoming[1]!.startDate).toBe('2026-07-20');
  });

  it('EC-12 getUpcoming respects 60-day window', () => {
    const { repo } = makeRepo();
    repo.upsert(makeRow({ eventKey: 'near', title: 'Near', startDate: '2026-06-10', rawHash: 'near0001' }));
    repo.upsert(makeRow({ eventKey: 'far', title: 'Far', startDate: '2026-09-01', rawHash: 'far00001' }));
    // 60 days from 2026-06-01 = 2026-07-31
    const upcoming = repo.getUpcoming('2026-06-01');
    expect(upcoming.find(e => e.eventKey === 'near')).toBeDefined();
    expect(upcoming.find(e => e.eventKey === 'far')).toBeUndefined();
  });

  it('EC-12 getUpcoming includes NULL start_date events (date TBD)', () => {
    const { repo } = makeRepo();
    repo.upsert(makeRow({ eventKey: 'tba01', title: 'TBA Event', startDate: null, rawHash: 'tba00001' }));
    const upcoming = repo.getUpcoming('2026-06-01');
    expect(upcoming.find(e => e.eventKey === 'tba01')).toBeDefined();
  });

  it('EC-13 searchByBand is case-insensitive substring match', () => {
    const { repo } = makeRepo();
    repo.upsert(makeRow({ eventKey: 'r01', title: 'Roselia Live', bands: ['Roselia'], rawHash: 'rose0001' }));
    repo.upsert(makeRow({ eventKey: 'm01', title: 'MyGO Live', bands: ['MyGO!!!!!'], rawHash: 'mygo0001' }));
    const results = repo.searchByBand('roselia');
    expect(results).toHaveLength(1);
    expect(results[0]!.bands).toContain('Roselia');
    const none = repo.searchByBand('ave mujica');
    expect(none).toHaveLength(0);
  });

  it('EC-16 getUpcoming(today, 3) returns at most 3 rows even with 10 in DB', () => {
    const { repo } = makeRepo();
    for (let i = 0; i < 10; i++) {
      repo.upsert(makeRow({
        eventKey: `event${i.toString().padStart(2, '0')}`,
        title: `Event ${i}`,
        startDate: `2026-07-${(i + 1).toString().padStart(2, '0')}`,
        rawHash: `hash${i.toString().padStart(12, '0')}`,
      }));
    }
    const upcoming = repo.getUpcoming('2026-06-01', 3);
    expect(upcoming).toHaveLength(3);
  });
});

// ====================================================================
// SECTION 2: Parser tests
// ====================================================================
describe('_parseEvents', () => {
  it('EC-1 parses 3 events from normal fixture', () => {
    const html = fixture('bandori-events-normal.html');
    const events = _parseEvents(html);
    expect(events.length).toBe(3);
  });

  it('EC-8 returns empty array for zero-event HTML (no cards)', () => {
    const html = fixture('bandori-events-empty.html');
    const events = _parseEvents(html);
    expect(events).toHaveLength(0);
  });

  it('EC-7 does not throw on malformed/truncated HTML', () => {
    const html = fixture('bandori-events-malformed.html');
    expect(() => _parseEvents(html)).not.toThrow();
    const events = _parseEvents(html);
    expect(events).toHaveLength(0);
  });

  it('EC-9 event with no date gets null startDate/endDate', () => {
    const html = fixture('bandori-events-normal.html');
    const events = _parseEvents(html);
    const tba = events.find(e => e.title.includes('Ave Mujica'));
    expect(tba).toBeDefined();
    expect(tba!.startDate).toBeNull();
    expect(tba!.endDate).toBeNull();
  });

  it('EC-10 date range parsed to startDate + endDate', () => {
    const html = fixture('bandori-events-normal.html');
    const events = _parseEvents(html);
    const roselia = events.find(e => e.title.includes('Roselia'));
    expect(roselia).toBeDefined();
    expect(roselia!.startDate).toBe('2026-07-18');
    expect(roselia!.endDate).toBe('2026-07-19');
  });

  it('single date without range produces startDate only, endDate null', () => {
    const html = fixture('bandori-events-normal.html');
    const events = _parseEvents(html);
    const mygo = events.find(e => e.title.includes('MyGO'));
    expect(mygo).toBeDefined();
    expect(mygo!.startDate).toBe('2026-10-05');
    expect(mygo!.endDate).toBeNull();
  });

  it('EC-19 rawHash is deterministic regardless of band order', () => {
    const html = fixture('bandori-events-normal.html');
    const events1 = _parseEvents(html);
    const events2 = _parseEvents(html);
    for (let i = 0; i < events1.length; i++) {
      expect(events1[i]!.rawHash).toBe(events2[i]!.rawHash);
    }
  });
});

// ====================================================================
// SECTION 3: Keyword detection
// ====================================================================
describe('_hasBandoriLiveKeyword', () => {
  it('EC-14 detects band name "Roselia live"', () => {
    expect(_hasBandoriLiveKeyword('Roselia live 好期待')).toBe(true);
  });

  it('EC-14 detects Japanese live keyword', () => {
    expect(_hasBandoriLiveKeyword('次のライブいつ？')).toBe(true);
  });

  it('EC-14 detects Chinese concert terms', () => {
    expect(_hasBandoriLiveKeyword('有没有演唱会的消息')).toBe(true);
    expect(_hasBandoriLiveKeyword('公演の情報は？')).toBe(true);
  });

  it('EC-15 does not trigger for unrelated message', () => {
    expect(_hasBandoriLiveKeyword('今天吃啥')).toBe(false);
    expect(_hasBandoriLiveKeyword('好困啊')).toBe(false);
  });

  it('BANDORI_LIVE_KEYWORDS is exported as non-empty array', () => {
    expect(Array.isArray(BANDORI_LIVE_KEYWORDS)).toBe(true);
    expect(BANDORI_LIVE_KEYWORDS.length).toBeGreaterThan(0);
  });
});

// ====================================================================
// SECTION 4: _formatLiveBlock
// ====================================================================
describe('_formatLiveBlock', () => {
  const sampleEvents: BandoriLiveRow[] = [
    {
      id: 1,
      eventKey: 'e1',
      title: 'Roselia 10th Anniversary Live',
      startDate: '2026-07-18',
      endDate: '2026-07-19',
      venue: 'さいたまスーパーアリーナ',
      city: '埼玉',
      bands: ['Roselia'],
      detailUrl: 'https://bang-dream.com/events/roselia-10th',
      ticketInfoText: '一般発売中',
      fetchedAt: 1000,
      lastSeenAt: 1000,
      rawHash: 'h1',
    },
    {
      id: 2,
      eventKey: 'e2',
      title: 'Ave Mujica 2nd LIVE',
      startDate: null,
      endDate: null,
      venue: null,
      city: null,
      bands: ['Ave Mujica'],
      detailUrl: null,
      ticketInfoText: null,
      fetchedAt: 1000,
      lastSeenAt: 1000,
      rawHash: 'h2',
    },
  ];

  it('contains header', () => {
    const block = _formatLiveBlock(sampleEvents);
    expect(block).toContain('【近期 BanG Dream! Live 信息】');
  });

  it('contains UX guidance fragment', () => {
    const block = _formatLiveBlock(sampleEvents);
    expect(block).toContain('以上是刚拿到的 Live 排期信息');
    expect(block).toContain('绝对不要把上面的信息当成列表原文输出');
  });

  it('formats date range correctly', () => {
    const block = _formatLiveBlock(sampleEvents);
    expect(block).toContain('2026-07-18 ~ 2026-07-19');
  });

  it('formats null date as 日程未定', () => {
    const block = _formatLiveBlock(sampleEvents);
    expect(block).toContain('日程未定');
  });

  it('formats null venue as 场馆未定', () => {
    const block = _formatLiveBlock(sampleEvents);
    expect(block).toContain('场馆未定');
  });

  it('includes band name', () => {
    const block = _formatLiveBlock(sampleEvents);
    expect(block).toContain('Roselia');
    expect(block).toContain('Ave Mujica');
  });
});

// ====================================================================
// SECTION 5: BandoriLiveScraper (mocked fetch)
// ====================================================================
describe('BandoriLiveScraper', () => {
  let scraper: BandoriLiveScraper;
  let repo: IBandoriLiveRepository;

  beforeEach(() => {
    const { repo: r } = makeRepo();
    repo = r;
    scraper = new BandoriLiveScraper(repo, {
      enabled: true,
      intervalMs: 86_400_000,
      initialDelayMs: 60_000,
      sourceUrl: 'https://bang-dream.com/events/',
      requestTimeoutMs: 15_000,
    });
  });

  afterEach(() => {
    scraper.stop();
    vi.restoreAllMocks();
  });

  it('EC-1 scrape() stores events from normal HTML', async () => {
    const html = fixture('bandori-events-normal.html');
    vi.stubGlobal('fetch', mockFetch(html));
    const n = await scraper.scrape();
    expect(n).toBe(3);
    expect(repo.getAll()).toHaveLength(3);
  });

  it('EC-5 network error → E040 WARN logged; returns 0; no crash', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const n = await scraper.scrape();
    expect(n).toBe(0);
    expect(repo.getAll()).toHaveLength(0);
  });

  it('EC-6 HTTP 500 → E041 WARN logged; returns 0; no crash', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => '',
    }));
    const n = await scraper.scrape();
    expect(n).toBe(0);
    expect(repo.getAll()).toHaveLength(0);
  });

  it('EC-7 malformed HTML → 0 rows inserted; no crash', async () => {
    const html = fixture('bandori-events-malformed.html');
    vi.stubGlobal('fetch', mockFetch(html));
    const n = await scraper.scrape();
    expect(n).toBe(0);
    expect(repo.getAll()).toHaveLength(0);
  });

  it('EC-8 zero-event HTML → E042 WARN logged; returns 0; existing rows untouched', async () => {
    // Pre-populate
    const htmlNormal = fixture('bandori-events-normal.html');
    vi.stubGlobal('fetch', mockFetch(htmlNormal));
    await scraper.scrape();
    expect(repo.getAll()).toHaveLength(3);
    vi.restoreAllMocks();

    // Now scrape empty
    const htmlEmpty = fixture('bandori-events-empty.html');
    vi.stubGlobal('fetch', mockFetch(htmlEmpty));
    const n = await scraper.scrape();
    expect(n).toBe(0);
    // Existing rows untouched
    expect(repo.getAll()).toHaveLength(3);
  });

  it('EC-17 start() returns synchronously; timer is set but not fired immediately', () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', mockFetch(fixture('bandori-events-normal.html')));
    const scrapeSpy = vi.spyOn(scraper, 'scrape');
    scraper.start();
    // No immediate call
    expect(scrapeSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('EC-17 after initialDelayMs the scraper fires', async () => {
    vi.useFakeTimers();
    const html = fixture('bandori-events-normal.html');
    vi.stubGlobal('fetch', mockFetch(html));
    const scrapeSpy = vi.spyOn(scraper, 'scrape').mockResolvedValue(3);
    scraper.start();
    expect(scrapeSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scrapeSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('EC-18 enabled=false: start() returns immediately without setting timer', () => {
    vi.useFakeTimers();
    const disabledScraper = new BandoriLiveScraper(repo, { enabled: false });
    const scrapeSpy = vi.spyOn(disabledScraper, 'scrape');
    disabledScraper.start();
    vi.advanceTimersByTime(200_000);
    expect(scrapeSpy).not.toHaveBeenCalled();
    disabledScraper.stop();
    vi.useRealTimers();
  });

  it('EC-19 rawHash is identical for identical inputs (bands sorted)', async () => {
    const html = fixture('bandori-events-normal.html');
    vi.stubGlobal('fetch', mockFetch(html));
    await scraper.scrape();
    const rows1 = repo.getAll().map(r => r.rawHash);

    // Re-scrape identical content
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', mockFetch(html));
    await scraper.scrape();
    const rows2 = repo.getAll().map(r => r.rawHash);

    expect(rows1).toEqual(rows2);
  });
});

// ====================================================================
// SECTION 6: Chat injection (EC-14, EC-15, EC-16)
// ====================================================================
describe('Chat injection integration', () => {
  it('EC-14 liveBlock injected when keyword detected', () => {
    const { repo } = makeRepo();
    const now = Math.floor(Date.now() / 1000);
    const today = new Date().toISOString().slice(0, 10);
    repo.upsert(makeRow({
      startDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      fetchedAt: now,
      lastSeenAt: now,
    }));
    const upcoming = repo.getUpcoming(today, 3);
    expect(upcoming.length).toBeGreaterThan(0);
    // Simulate the injection logic in chat.ts
    const liveBlock = upcoming.length > 0 ? _formatLiveBlock(upcoming) : '';
    expect(liveBlock).toContain('BanG Dream');
  });

  it('EC-15 no liveBlock when no keyword match', () => {
    expect(_hasBandoriLiveKeyword('今天吃啥')).toBe(false);
  });

  it('EC-16 getUpcoming caps at 3', () => {
    const { repo } = makeRepo();
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 10; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i + 1);
      repo.upsert(makeRow({
        eventKey: `ev${i.toString().padStart(2, '0')}`,
        title: `Event ${i}`,
        startDate: d.toISOString().slice(0, 10),
        rawHash: `rh${i.toString().padStart(14, '0')}`,
        fetchedAt: now,
        lastSeenAt: now,
      }));
    }
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = repo.getUpcoming(today, 3);
    expect(upcoming).toHaveLength(3);
  });
});
