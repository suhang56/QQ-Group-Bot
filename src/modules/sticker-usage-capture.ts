import { createHash } from 'node:crypto';
import type { ClaudeModel, IClaudeClient } from '../ai/claude.js';
import type { IEmbeddingService } from '../storage/embeddings.js';
import type {
  IMessageRepository,
  IStickerUsageSampleRepository,
  LaterReaction,
  StickerUsageSample,
} from '../storage/db.js';
import { REFLECTION_MODEL } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { StickerCaptureService } from './sticker-capture.js';

const logger = createLogger('sticker-usage-capture');

const VALID_LABELS = new Set([
  'laugh', 'confused', 'mock', 'agree', 'reject', 'cute', 'shock', 'comfort', 'spam-unknown',
]);

const REBUTTAL_RE = /关你屁事|神经病|别戳啦|闹麻了|你有病吧/;
// Negative lookahead avoids matching '草莓'. '哈哈+' requires at least 2 hahas.
const MEME_RE = /笑死|草(?!莓)|awsl|绷不住|哈哈+/;

const ACT_LABEL_CACHE = new Map<string, string>();
const ACT_LABEL_CACHE_MAX = 2000;

export interface StickerUsageCaptureOptions {
  claude?: IClaudeClient;
  embedder?: IEmbeddingService;
  /** Override REFLECTION_MODEL for tests. */
  actLabelModel?: string;
  /** prev_msgs LIMIT (default 5). */
  prevN?: number;
}

export class StickerUsageCaptureService {
  private readonly claude: IClaudeClient | null;
  private readonly embedder: IEmbeddingService | null;
  private readonly actLabelModel: string;
  private readonly prevN: number;

  constructor(
    private readonly repo: IStickerUsageSampleRepository,
    private readonly messages: IMessageRepository,
    options: StickerUsageCaptureOptions = {},
  ) {
    this.claude = options.claude ?? null;
    this.embedder = options.embedder ?? null;
    this.actLabelModel = options.actLabelModel ?? REFLECTION_MODEL;
    this.prevN = options.prevN ?? 5;
  }

  /** Resolve sticker key from CQ:image (sub_type=1) or CQ:mface raw content. */
  static extractStickerKey(rawContent: string): string | null {
    const mfaces = StickerCaptureService.extractMfaces(rawContent);
    if (mfaces.length > 0 && mfaces[0]) return mfaces[0].key;
    const imgFile = StickerCaptureService.extractImageStickerFile(rawContent);
    if (imgFile) return `img:${imgFile}`;
    return null;
  }

  /** Capture a usage sample. Synchronous DB INSERT, then fire-and-forget label + embedding. Skips bot-source. */
  captureUsageFromMessage(
    msg: { groupId: string; userId: string; rawContent: string; timestamp: number; nickname?: string },
    botUserId: string,
  ): void {
    if (msg.userId === botUserId) return;
    const stickerKey = StickerUsageCaptureService.extractStickerKey(msg.rawContent);
    if (!stickerKey) return;

    // Sync work: query prev_msgs (newest-first from repo), filter, take prevN, reverse to chronological.
    const prevAll = this.messages.getRecent(msg.groupId, this.prevN + 8);
    const prev = prevAll
      .filter(m => m.timestamp < msg.timestamp && m.userId !== botUserId && m.content.trim().length > 0)
      .slice(0, this.prevN)
      .reverse();
    const triggerText = prev.length > 0 ? (prev[prev.length - 1]?.content ?? '') : '';

    let replyToTarget: string | null = null;
    const r = msg.rawContent.match(/\[CQ:reply,id=(\d+)\]/);
    if (r && r[1]) {
      const target = this.messages.findBySourceId(r[1]);
      if (target) replyToTarget = `${target.userId}: ${target.content}`;
    }

    const id = this.repo.insert({
      groupId: msg.groupId,
      stickerKey,
      senderUserId: msg.userId,
      prevMsgs: prev.map(p => ({ userId: p.userId, content: p.content, timestamp: p.timestamp })),
      triggerText,
      replyToTarget,
      createdAt: msg.timestamp,
    });

    // Async fire-and-forget: act label + embedding. No await.
    void this._resolveActLabel(id, prev.map(p => p.content), stickerKey)
      .catch(err => logger.warn({ err, id }, 'act-label resolve failed'));
    const embedText = prev.map(p => p.content).join(' ') + (triggerText ? ' ' + triggerText : '');
    void this._resolveEmbedding(id, embedText)
      .catch(err => logger.warn({ err, id }, 'context embedding failed'));
  }

  private async _resolveActLabel(id: number, prevTexts: string[], stickerKey: string): Promise<void> {
    if (!this.claude) return;
    const cacheKey = createHash('sha256')
      .update(prevTexts.join('|') + '\n' + stickerKey)
      .digest('hex')
      .slice(0, 32);
    const cached = ACT_LABEL_CACHE.get(cacheKey);
    if (cached) {
      this.repo.setActLabel(id, cached);
      return;
    }

    const system = `Classify the social act of sending a sticker into ONE of: laugh, confused, mock, agree, reject, cute, shock, comfort, spam-unknown. Output ONE label only — no punctuation, no explanation.`;
    const user = `Recent context (chronological):\n${prevTexts.join('\n') || '(none)'}\n\nSticker key: ${stickerKey}\n\nLabel:`;

    let label: string;
    try {
      const resp = await this.claude.complete({
        model: this.actLabelModel as ClaudeModel,
        system: [{ text: system, cache: false }],
        messages: [{ role: 'user', content: user }],
        maxTokens: 16,
      });
      const cleaned = resp.text.trim().toLowerCase().replace(/[^a-z\-]/g, '');
      label = VALID_LABELS.has(cleaned) ? cleaned : 'spam-unknown';
    } catch {
      label = 'spam-unknown';
    }

    if (ACT_LABEL_CACHE.size >= ACT_LABEL_CACHE_MAX) {
      const firstKey = ACT_LABEL_CACHE.keys().next().value;
      if (firstKey !== undefined) ACT_LABEL_CACHE.delete(firstKey);
    }
    ACT_LABEL_CACHE.set(cacheKey, label);
    this.repo.setActLabel(id, label);
  }

  private async _resolveEmbedding(id: number, text: string): Promise<void> {
    if (!this.embedder?.isReady) return;
    if (text.trim().length < 2) return;
    const vec = await this.embedder.embed(text);
    this.repo.setEmbedding(id, vec);
  }

  /** Test-only escape hatch. */
  static _resetCacheForTests(): void { ACT_LABEL_CACHE.clear(); }
}

/** Later-reactions classifier. Stateless — DB-only. */
export class LaterReactionWorker {
  /** Window in seconds (default 120 = 2min). */
  static readonly WINDOW_SEC = 120;
  /** Number of subsequent messages to inspect (per Architect A2). */
  static readonly N_FOLLOWUPS = 8;

  constructor(
    private readonly repo: IStickerUsageSampleRepository,
    private readonly messages: IMessageRepository,
  ) {}

  /** Scan + update all rows in window. Idempotent — re-runs overwrite later_reactions. */
  scan(groupId: string, nowSec: number): void {
    const since = nowSec - LaterReactionWorker.WINDOW_SEC;
    const rows = this.repo.findRecentForUpdate(groupId, since);
    for (const row of rows) {
      const reactions = this._classify(row);
      this.repo.updateLaterReactions(row.id, reactions);
    }
  }

  private _classify(row: StickerUsageSample): LaterReaction[] {
    const followups = this.messages
      .getAroundTimestamp(row.groupId, row.createdAt, LaterReactionWorker.WINDOW_SEC, 64)
      .filter(m => m.timestamp > row.createdAt)
      .slice(0, LaterReactionWorker.N_FOLLOWUPS);

    let echoCount = 0, rebuttalCount = 0, memeCount = 0;
    let echoSample: string | null = null;
    let rebuttalSample: string | null = null;
    let memeSample: string | null = null;

    for (const f of followups) {
      const fKey = StickerUsageCaptureService.extractStickerKey(f.rawContent);
      if (fKey === row.stickerKey) {
        echoCount += 1;
        if (echoSample === null) echoSample = f.content || `[sticker ${fKey}]`;
      }
      if (REBUTTAL_RE.test(f.content)) {
        rebuttalCount += 1;
        if (rebuttalSample === null) rebuttalSample = f.content;
      }
      if (MEME_RE.test(f.content)) {
        memeCount += 1;
        if (memeSample === null) memeSample = f.content;
      }
    }

    const out: LaterReaction[] = [];
    if (echoCount > 0) out.push({ type: 'echo', count: echoCount, sampleMsg: echoSample });
    if (rebuttalCount > 0) out.push({ type: 'rebuttal', count: rebuttalCount, sampleMsg: rebuttalSample });
    if (memeCount > 0) out.push({ type: 'meme-react', count: memeCount, sampleMsg: memeSample });
    if (out.length === 0 && followups.length >= 2) {
      out.push({ type: 'silence', count: followups.length, sampleMsg: null });
    }
    return out;
  }
}
