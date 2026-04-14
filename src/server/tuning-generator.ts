import { writeFileSync } from 'node:fs';
import type { IBotReplyRepository, BotReply } from '../storage/db.js';
import type { IClaudeClient, ClaudeMessage } from '../ai/claude.js';
import { createLogger } from '../utils/logger.js';
import { RUNTIME_CHAT_MODEL } from '../config.js';

const logger = createLogger('tuning-generator');

export class TuningGenerator {
  constructor(
    private readonly repo: IBotReplyRepository,
    private readonly claude: IClaudeClient,
    private readonly groupId: string,
    private readonly outputPath: string,
  ) {}

  async generate(): Promise<void> {
    const all = this.repo.getRecent(this.groupId, 500);
    const rated = all.filter(r => r.rating !== null);
    if (rated.length === 0) {
      logger.info('no rated replies yet, skipping tuning generation');
      return;
    }

    const good = rated.filter(r => r.rating! >= 4);
    const bad = rated.filter(r => r.rating! <= 2);
    const mid = rated.filter(r => r.rating === 3);

    const formatSample = (r: BotReply) =>
      `[触发] ${r.triggerContent}\n[回复] ${r.botReply}${r.ratingComment ? `\n[评语] ${r.ratingComment}` : ''}`;

    const goodSamples = good.slice(0, 15).map(formatSample).join('\n\n');
    const badSamples = bad.slice(0, 15).map(formatSample).join('\n\n');
    const midSamples = mid.slice(0, 10).map(formatSample).join('\n\n');

    const prompt = `你是一个QQ群机器人的行为调优分析师。
以下是对机器人回复的用户评分数据（1-5分，4-5=好，1-2=差，3=中等）。

===好评回复（${good.length}条，抽样如下）===
${goodSamples || '（无）'}

===差评回复（${bad.length}条，抽样如下）===
${badSamples || '（无）'}

===中评回复（${mid.length}条，抽样如下）===
${midSamples || '（无）'}

请分析：
1. 好评回复的共同特征（语气、长度、内容类型等）
2. 差评回复的主要问题
3. 给出3-5条具体的system prompt改进建议，用中文，每条一行以"- "开头

只输出分析内容，不要解释你在做什么。`;

    const messages: ClaudeMessage[] = [{ role: 'user', content: prompt }];
    const resp = await this.claude.complete({
      model: RUNTIME_CHAT_MODEL,
      maxTokens: 1000,
      system: [],
      messages,
    });
    const analysis = resp.text;

    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const md = `# Bot Reply Tuning Report
Generated: ${now}
Rated: ${rated.length} / ${all.length} total | Good: ${good.length} | Bad: ${bad.length} | Mid: ${mid.length}

## Analysis

${analysis}

## Raw Stats

| Rating | Count |
|--------|-------|
| ★★★★★ 5 | ${rated.filter(r => r.rating === 5).length} |
| ★★★★ 4 | ${rated.filter(r => r.rating === 4).length} |
| ★★★ 3 | ${mid.length} |
| ★★ 2 | ${rated.filter(r => r.rating === 2).length} |
| ★ 1 | ${rated.filter(r => r.rating === 1).length} |

## Comments

${rated.filter(r => r.ratingComment).map(r => `- [${r.rating}★] **${r.triggerContent.slice(0, 40)}** → ${r.ratingComment}`).join('\n') || '（无评语）'}
`;

    writeFileSync(this.outputPath, md, 'utf8');
    logger.info({ outputPath: this.outputPath, rated: rated.length }, 'tuning report generated');
  }
}
