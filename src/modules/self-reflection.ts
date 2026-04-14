import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { IClaudeClient } from '../ai/claude.js';
import type {
  IBotReplyRepository, IModerationRepository, ILearnedFactsRepository,
} from '../storage/db.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('self-reflection');

const REFLECTION_MODEL = 'claude-haiku-4-5-20251001' as const;
const HOURLY_MS = 60 * 60 * 1000;
const INITIAL_DELAY_MS = 30_000;
const BOT_REPLIES_LIMIT = 200;
const MODERATION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h window for recent mod records

export interface SelfReflectionOptions {
  claude: IClaudeClient;
  botReplies: IBotReplyRepository;
  moderation: IModerationRepository;
  learnedFacts: ILearnedFactsRepository;
  groupId: string;
  outputPath: string;
  enabled?: boolean;
}

export class SelfReflectionLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly enabled: boolean;

  constructor(private readonly opts: SelfReflectionOptions) {
    this.enabled = opts.enabled ?? true;
  }

  start(): void {
    if (!this.enabled) {
      logger.info('self-reflection disabled (SELF_REFLECTION_ENABLED=0)');
      return;
    }
    // First run after 30s warm-up, then every hour
    this.timer = setTimeout(() => {
      void this._runAndSchedule();
    }, INITIAL_DELAY_MS);
    logger.info({ groupId: this.opts.groupId, outputPath: this.opts.outputPath }, 'self-reflection loop started');
  }

  private _scheduleNext(): void {
    this.timer = setTimeout(() => {
      void this._runAndSchedule();
    }, HOURLY_MS);
  }

  private async _runAndSchedule(): Promise<void> {
    try {
      await this.reflect();
    } catch (err) {
      logger.error({ err }, 'self-reflection run failed');
    }
    this._scheduleNext();
  }

  async reflect(): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    const oneHourAgoSec = nowSec - 3600;

    // Check if there are any new replies in the last hour
    const recent = this.opts.botReplies.getRecent(this.opts.groupId, BOT_REPLIES_LIMIT);
    const recentInHour = recent.filter(r => r.sentAt >= oneHourAgoSec);
    if (recentInHour.length === 0) {
      logger.info({ groupId: this.opts.groupId }, 'self-reflection skipped — no new bot replies in last hour');
      return;
    }

    // Rating stats
    const rated = recent.filter(r => r.rating !== null);
    const avgRating = rated.length > 0
      ? (rated.reduce((s, r) => s + r.rating!, 0) / rated.length).toFixed(2)
      : 'N/A';
    const negCount = rated.filter(r => r.rating! <= 2).length;
    const negPct = rated.length > 0 ? ((negCount / rated.length) * 100).toFixed(0) : '0';
    const comments = rated.filter(r => r.ratingComment).map(r => `[${r.rating}★] ${r.ratingComment}`).join('\n');

    const repliesText = recent.slice(0, BOT_REPLIES_LIMIT).map(r => {
      const ratingStr = r.rating !== null ? ` [${r.rating}★${r.ratingComment ? ` "${r.ratingComment}"` : ''}]` : '';
      return `- 触发: ${r.triggerContent.slice(0, 80)}\n  回复: ${r.botReply.slice(0, 120)}${ratingStr}`;
    }).join('\n');

    // Recent moderation flags
    const modRecords = this.opts.moderation.findRecentByGroup(this.opts.groupId, MODERATION_WINDOW_MS);
    const modText = modRecords.slice(0, 50).map(r => `[sev:${r.severity} ${r.action}] ${r.reason}`).join('\n') || '（无）';

    // Learned facts / corrections
    const facts = this.opts.learnedFacts.listActive(this.opts.groupId, 30);
    const factsText = facts.map(f => `- ${f.fact}`).join('\n') || '（无）';

    const userContent = `## Recent bot replies (last ${BOT_REPLIES_LIMIT}, newest first)
${repliesText}

## Rating stats
Total reviewed: ${rated.length} | Avg: ${avgRating} | Negative (≤2★): ${negPct}%
Comments:
${comments || '（无评语）'}

## Recently learned facts (user corrections)
${factsText}

## Recent moderation flags (last 24h)
${modText}`;

    const systemPrompt = `You are a tuning agent for a QQ group bot persona'd as a 邦批 (BanG Dream fan). Analyze the recent bot outputs and produce ONLY a structured system-prompt snippet that the bot will read directly on its next turn. Do NOT write prose commentary or analysis paragraphs — output ONLY the four markdown sections below, in Chinese, with bullet points under each. Keep each bullet concise and actionable (≤20 chars preferred). If a section has nothing to add, write "（无）" as its only bullet.

Output format (exact headers required):
## 继续这样做
- <rule>

## 不要再这样
- <anti-pattern>

## 避开的句式
- <phrase or sentence pattern to avoid>

## 补充记忆
- <fact about recent group context or corrections>`;

    let reflection: string;
    try {
      const resp = await this.opts.claude.complete({
        model: REFLECTION_MODEL,
        maxTokens: 800,
        system: [{ text: systemPrompt, cache: true }],
        messages: [{ role: 'user', content: userContent }],
      });
      reflection = resp.text.trim();
    } catch (err) {
      logger.error({ err, groupId: this.opts.groupId }, 'self-reflection Claude call failed — skipping file write');
      throw err;
    }

    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const md = `# 最近对话 tuning (auto-generated ${now})

${reflection}
`;

    try {
      mkdirSync(path.dirname(this.opts.outputPath), { recursive: true });
      writeFileSync(this.opts.outputPath, md, 'utf8');
      logger.info({ outputPath: this.opts.outputPath, groupId: this.opts.groupId, replies: recent.length }, 'self-reflection written');
    } catch (err) {
      logger.error({ err, outputPath: this.opts.outputPath }, 'self-reflection file write failed');
      throw err;
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
