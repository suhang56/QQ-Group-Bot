import { writeFileSync, mkdirSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type { IClaudeClient, ClaudeModel } from '../ai/claude.js';
import type {
  IBotReplyRepository, IModerationRepository, ILearnedFactsRepository,
} from '../storage/db.js';
import { createLogger } from '../utils/logger.js';
import { REFLECTION_MODEL } from '../config.js';

const logger = createLogger('self-reflection');

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

    // Seed the reflection with the existing permanent-memory file so the LLM
    // knows what's already been learned long-term and can avoid duplicating
    // or contradicting those lessons.
    const permanentPath = path.join(path.dirname(this.opts.outputPath), 'tuning-permanent.md');
    const existingPermanent = existsSync(permanentPath)
      ? readFileSync(permanentPath, 'utf8').slice(0, 3000)
      : '（无）';

    const systemPrompt = `You are a tuning agent for a QQ group bot persona'd as a 邦批 (BanG Dream fan). Analyze the recent bot outputs and produce ONLY a structured system-prompt snippet that the bot will read directly on its next turn. Do NOT write prose commentary or analysis paragraphs — output ONLY the FIVE markdown sections below, in Chinese, with bullet points under each. Keep each bullet concise and actionable (≤20 chars preferred). If a section has nothing to add, write "（无）" as its only bullet.

Output format (exact headers required):
## 继续这样做
- <rule for the NEXT hour>

## 不要再这样
- <anti-pattern>

## 避开的句式
- <phrase or sentence pattern to avoid>

## 补充记忆
- <fact about recent group context or corrections>

## 永久记住的 (long-term)
- <high-value lesson that should be remembered forever, not just the next hour>

The "永久记住的" section is special: only put entries here that represent STABLE, LONG-TERM lessons — persona calibration insights, canonical fandom corrections the user has taught, user preference patterns, or architectural understandings of the group. Do NOT repeat short-term tuning here. Do NOT add anything already present in the existing permanent memory below (skip duplicates). If nothing meets this bar, write "（无）".

Existing permanent memory (do not duplicate these):
${existingPermanent}`;

    let reflection: string;
    try {
      const resp = await this.opts.claude.complete({
        model: REFLECTION_MODEL as ClaudeModel,
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

    const outputDir = path.dirname(this.opts.outputPath);
    const archiveDir = path.join(outputDir, 'tuning-archive');

    try {
      mkdirSync(outputDir, { recursive: true });
      // Archive: copy previous tuning.md (if exists) to timestamped file before
      // overwrite. Filename uses local-time slug safe for Windows.
      if (existsSync(this.opts.outputPath)) {
        try {
          mkdirSync(archiveDir, { recursive: true });
          const slug = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
          const archivePath = path.join(archiveDir, `tuning-${slug}.md`);
          copyFileSync(this.opts.outputPath, archivePath);
        } catch (archiveErr) {
          logger.warn({ err: archiveErr }, 'tuning archive failed — continuing with write');
        }
      }
      writeFileSync(this.opts.outputPath, md, 'utf8');
      logger.info({ outputPath: this.opts.outputPath, groupId: this.opts.groupId, replies: recent.length }, 'self-reflection written');
    } catch (err) {
      logger.error({ err, outputPath: this.opts.outputPath }, 'self-reflection file write failed');
      throw err;
    }

    // Distill-merge the permanent memory: extract "## 永久记住的" section from
    // this cycle's reflection, combine with the existing permanent file, and
    // run a SECOND LLM call to dedupe/compact the merged content. This keeps
    // tuning-permanent.md bounded instead of growing unbounded via append.
    await this._updatePermanentMemory(reflection, permanentPath);
  }

  /**
   * Extract the `## 永久记住的` section from the latest reflection, merge it
   * with the existing permanent-memory file, and distill the combined content
   * via an LLM call so duplicates/outdated entries collapse.
   */
  private async _updatePermanentMemory(reflection: string, permanentPath: string): Promise<void> {
    // Extract "## 永久记住的" block from the reflection
    const match = reflection.match(/##\s*永久记住的[^\n]*\n([\s\S]*?)(?=\n##\s|\n*$)/);
    if (!match) {
      logger.debug('no 永久记住的 section in reflection — skip permanent merge');
      return;
    }
    const newBullets = match[1]!.trim();
    if (!newBullets || /^[-*]?\s*（?无）?$/.test(newBullets.replace(/^[-*]\s*/gm, '').trim())) {
      logger.debug('permanent section empty — skip merge');
      return;
    }

    const existing = existsSync(permanentPath)
      ? readFileSync(permanentPath, 'utf8')
      : '';

    const mergePrompt = `你是一个长期记忆整理器。下面是一个邦多利群聊 bot 的「永久记住的」长期记忆文件，和本次反思新加入的候选条目。任务：\n\n1. 合并两部分\n2. **去重** — 语义相同的只保留最清晰那条\n3. **淘汰** — 去掉已经过时 / 跟其它条目矛盾 / 太琐碎 / 只是短期 tuning 不该存永久的\n4. **压缩** — 相似主题合并成一条（比如多条都是"XX 是 YY 的 CV" → 合并成一条列表）\n5. 输出严格 markdown，标题保持 \`# 永久记忆 (distilled)\`，下面只用无序列表（\`- xxx\`），每条 ≤ 40 字\n6. 总条目数不超过 50 条。如果超过 50，砍掉最不重要的\n\n只输出 markdown，不要前后的解释。如果合并后为空，输出 "# 永久记忆 (distilled)\n\n（无）"。`;

    const userContent = `## 现有永久记忆
${existing || '（空）'}

## 本次新增候选
${newBullets}`;

    let distilled: string;
    try {
      const resp = await this.opts.claude.complete({
        model: REFLECTION_MODEL as ClaudeModel,
        maxTokens: 2000,
        system: [{ text: mergePrompt, cache: true }],
        messages: [{ role: 'user', content: userContent }],
      });
      distilled = resp.text.trim();
    } catch (err) {
      logger.warn({ err }, 'permanent-memory distill LLM call failed — keeping existing file unchanged');
      return;
    }

    if (!distilled || distilled.length < 10) {
      logger.warn({ len: distilled?.length }, 'permanent-memory distill output too short — skip write');
      return;
    }

    try {
      writeFileSync(permanentPath, distilled + '\n', 'utf8');
      logger.info({ permanentPath, len: distilled.length }, 'permanent memory distilled');
    } catch (err) {
      logger.error({ err, permanentPath }, 'permanent memory write failed');
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
