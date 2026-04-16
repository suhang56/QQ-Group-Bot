import type { IClaudeClient, ClaudeModel } from '../ai/claude.js';
import type { IMessageRepository, IUserStyleRepository, StyleJsonData } from '../storage/db.js';
import { createLogger } from '../utils/logger.js';
import { extractJson } from '../utils/json-extract.js';
import type { Logger } from 'pino';

const CQ_ONLY_RE = /^\[CQ:[^\]]+\]$/;
const COMMAND_RE = /^\//;
const MIN_MESSAGES_FOR_STYLE = 20;
const STYLE_MODEL = 'gemini-2.5-flash';

export type StyleJson = StyleJsonData;

export interface StyleLearnerOptions {
  messages: IMessageRepository;
  userStyles: IUserStyleRepository;
  claude: IClaudeClient;
  activeGroups: string[];
  logger?: Logger;
  intervalMs?: number;
}

export class StyleLearner {
  private readonly messages: IMessageRepository;
  private readonly userStyles: IUserStyleRepository;
  private readonly claude: IClaudeClient;
  private readonly activeGroups: string[];
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: StyleLearnerOptions) {
    this.messages = opts.messages;
    this.userStyles = opts.userStyles;
    this.claude = opts.claude;
    this.activeGroups = opts.activeGroups;
    this.logger = opts.logger ?? createLogger('style-learner');
    this.intervalMs = opts.intervalMs ?? 4 * 60 * 60_000; // 4 hours
  }

  start(): void {
    // Initial run after 5 minutes
    this.firstTimer = setTimeout(() => {
      void this._runAll().catch(err => this.logger.error({ err }, 'style learner initial run failed'));
    }, 5 * 60_000);
    this.firstTimer.unref?.();

    this.timer = setInterval(() => {
      void this._runAll().catch(err => this.logger.error({ err }, 'style learner run failed'));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.firstTimer) { clearTimeout(this.firstTimer); this.firstTimer = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async _runAll(): Promise<void> {
    for (const groupId of this.activeGroups) {
      try {
        await this.learnStyles(groupId);
      } catch (err) {
        this.logger.error({ err, groupId }, 'style learning failed for group');
      }
    }
  }

  async learnStyles(groupId: string): Promise<void> {
    // Get distinct active users (posted in last 7 days)
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    const topUsers = this.messages.getTopUsers(groupId, 50);

    let learned = 0;
    for (const user of topUsers) {
      const userMsgs = this.messages.getByUser(groupId, user.userId, 200);

      // Only consider users active in last 7 days
      if (userMsgs.length === 0 || userMsgs[0]!.timestamp < sevenDaysAgo) continue;

      // Filter out CQ, commands, short messages
      const filtered = userMsgs.filter(m =>
        m.content.length >= 3 &&
        !COMMAND_RE.test(m.content) &&
        !CQ_ONLY_RE.test(m.content),
      );

      if (filtered.length < MIN_MESSAGES_FOR_STYLE) {
        this.logger.debug({ groupId, userId: user.userId, msgCount: filtered.length }, 'too few messages for style analysis');
        continue;
      }

      const nickname = userMsgs[0]!.nickname;
      const sampleText = filtered
        .slice(0, 100)
        .reverse()
        .map(m => m.content)
        .join('\n');

      const prompt = `分析这个群友"${nickname}"的说话风格。以下是他们最近的发言：

${sampleText}

返回 JSON 格式的风格分析：
{
  "catchphrases": ["这个人常用的口头禅/习惯用语，最多5个"],
  "punctuationStyle": "标点使用习惯的简短描述",
  "sentencePattern": "句式特点的简短描述",
  "emotionalSignatures": {"happy": "开心时的表达方式", "annoyed": "不爽时的表达方式"},
  "topicAffinity": ["这个人经常聊的话题，最多5个"]
}

只返回 JSON，不要其他内容。`;

      try {
        const resp = await this.claude.complete({
          model: STYLE_MODEL as ClaudeModel,
          maxTokens: 512,
          system: [{ text: '你是一个群聊风格分析助手，只输出 JSON。', cache: true }],
          messages: [{ role: 'user', content: prompt }],
        });

        const parsed = extractJson<StyleJson>(resp.text.trim());
        if (parsed === null) {
          this.logger.warn({ groupId, userId: user.userId }, 'style JSON parse failed');
          continue;
        }

        this.userStyles.upsert(groupId, user.userId, nickname, parsed);
        learned++;
        this.logger.debug({ groupId, userId: user.userId, nickname }, 'style learned');
      } catch (err) {
        this.logger.warn({ err, groupId, userId: user.userId }, 'style LLM call failed');
      }
    }

    this.logger.info({ groupId, usersAnalyzed: learned }, 'style learning cycle complete');
  }

  getStyle(groupId: string, userId: string): StyleJson | null {
    return this.userStyles.get(groupId, userId);
  }

  formatStyleForPrompt(groupId: string, userId: string): string {
    const style = this.getStyle(groupId, userId);
    if (!style) return '';

    const lines: string[] = [];
    if (style.catchphrases?.length) {
      lines.push(`- 口头禅: ${style.catchphrases.join('、')}`);
    }
    if (style.punctuationStyle) {
      lines.push(`- 标点习惯: ${style.punctuationStyle}`);
    }
    if (style.sentencePattern) {
      lines.push(`- 句式特点: ${style.sentencePattern}`);
    }
    if (style.topicAffinity?.length) {
      lines.push(`- 常聊话题: ${style.topicAffinity.join('、')}`);
    }

    if (lines.length === 0) return '';
    return `## 这个人的说话风格\n${lines.join('\n')}`;
  }
}
