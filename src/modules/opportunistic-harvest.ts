import type { IClaudeClient } from '../ai/claude.js';
import type { IMessageRepository, ILearnedFactsRepository } from '../storage/db.js';
import type { Logger } from 'pino';
import { createLogger } from '../utils/logger.js';

const MIN_NEW_MESSAGES = 10;
const MAX_FACTS_PER_RUN = 5;
const FACT_DEDUP_PREFIX_LEN = 20;
const HARVEST_MODEL = 'claude-sonnet-4-6' as const;

interface HarvestItem {
  topic: string;
  fact: string;
  sourceNickname: string;
}

export interface OpportunisticHarvestOptions {
  messages: IMessageRepository;
  learnedFacts: ILearnedFactsRepository;
  claude: IClaudeClient;
  activeGroups: string[];
  logger?: Logger;
  intervalMs?: number;
  windowMessages?: number;
  enabled?: boolean;
  /** Injected for testing */
  now?: () => number;
}

export class OpportunisticHarvest {
  private readonly messages: IMessageRepository;
  private readonly learnedFacts: ILearnedFactsRepository;
  private readonly claude: IClaudeClient;
  private readonly activeGroups: string[];
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly windowMessages: number;
  private readonly enabled: boolean;
  private readonly now: () => number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly lastRunTs = new Map<string, number>();

  constructor(opts: OpportunisticHarvestOptions) {
    this.messages = opts.messages;
    this.learnedFacts = opts.learnedFacts;
    this.claude = opts.claude;
    this.activeGroups = opts.activeGroups;
    this.logger = opts.logger ?? createLogger('opportunistic-harvest');
    this.intervalMs = opts.intervalMs ?? 30 * 60_000;
    this.windowMessages = opts.windowMessages ?? 80;
    this.enabled = opts.enabled ?? true;
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (!this.enabled) return;
    this.firstTimer = setTimeout(
      () => this._run().catch(err => this.logger.error({ err }, 'harvest failed')),
      60_000,
    );
    this.timer = setInterval(
      () => this._run().catch(err => this.logger.error({ err }, 'harvest failed')),
      this.intervalMs,
    );
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.firstTimer) { clearTimeout(this.firstTimer); this.firstTimer = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async _run(): Promise<void> {
    for (const groupId of this.activeGroups) {
      try {
        await this._runGroup(groupId);
      } catch (err) {
        this.logger.error({ err, groupId }, 'harvest group run failed');
      }
    }
  }

  private async _runGroup(groupId: string): Promise<void> {
    const recent = this.messages.getRecent(groupId, this.windowMessages);

    const lastTs = this.lastRunTs.get(groupId) ?? 0;
    const newMsgs = recent.filter(m => m.timestamp * 1000 > lastTs);
    if (newMsgs.length < MIN_NEW_MESSAGES) {
      this.logger.debug({ groupId, newMsgs: newMsgs.length }, 'harvest skipped — too few new messages');
      return;
    }

    this.lastRunTs.set(groupId, this.now());

    // Chronological order for the prompt
    const chronoMsgs = [...recent].reverse();
    const messagesList = chronoMsgs
      .map(m => `[${m.nickname}]: ${m.content}`)
      .join('\n');

    const prompt = `你在帮一个 QQ 群 bot 补充知识库。下面是最近 ${chronoMsgs.length} 条群聊消息。你的任务：**抽出值得让 bot 记住的具体事实**，以便下次聊天时 bot 能用上。

消息（时间正序）：
${messagesList}

提取规则：
- 值得记住的类型：
  - 群友之间的关系/外号/身份（"A 是 B 的本命推"、"C 是 D 的室友"、"E 在波士顿读书"）
  - 群友别名/外号/简称（"大家叫他 X"、"X 就是 Y"、"X 的外号是 Y"）
  - 群友对某事物的立场/态度（"A 讨厌 X 乐队"、"B 最喜欢 Y 曲目"）
  - 群内梗/黑话定义（"XX 是说 YY 的意思"、"群里叫 Z 是 W"）
  - 群友的纠正（"不是 A 是 B" 类句式）
  - 新名字 / 新事件 / 新曲目 / 新成员信息
  - 群友分享的真实客观事实（不是玩笑/猜测/吐槽）
- 不要抽：
  - 玩笑 / 讽刺 / 情绪发泄
  - 一次性话题（"今天吃了什么"）
  - 敏感信息（身份证/电话/地址）
  - 无法确认真假的谣言

只返回 JSON 数组，最多 5 条（宁缺毋滥）：
[
  { "topic": "<简短标题>", "fact": "<具体事实陈述，中文，最多 80 字>", "sourceNickname": "<在消息列表里提供这条信息的群友昵称>" }
]

如果没有值得抽的事实，返回空数组 []。`;

    let responseText: string;
    try {
      const resp = await this.claude.complete({
        model: HARVEST_MODEL,
        maxTokens: 512,
        system: [{ text: '你是一个群聊知识抽取助手，只输出 JSON。', cache: true }],
        messages: [{ role: 'user', content: prompt }],
      });
      responseText = resp.text.trim();
    } catch (err) {
      this.logger.error({ err, groupId }, 'harvest Claude call failed');
      return;
    }

    let items: HarvestItem[];
    try {
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      items = jsonMatch ? (JSON.parse(jsonMatch[0]) as HarvestItem[]) : [];
      if (!Array.isArray(items)) items = [];
    } catch {
      this.logger.warn({ groupId, responseText }, 'harvest JSON parse failed');
      return;
    }

    if (items.length === 0) {
      this.logger.info({ groupId }, 'harvest: no facts extracted');
      return;
    }

    const existing = this.learnedFacts.listActive(groupId, 500);
    let inserted = 0;

    for (const item of items.slice(0, MAX_FACTS_PER_RUN)) {
      if (typeof item.fact !== 'string' || !item.fact.trim()) continue;
      const factText = item.fact.trim();
      const prefix = factText.slice(0, FACT_DEDUP_PREFIX_LEN);
      const isDupe = existing.some(e => e.fact.includes(prefix));
      if (isDupe) {
        this.logger.debug({ groupId, fact: factText }, 'harvest dupe skipped');
        continue;
      }
      this.learnedFacts.insert({
        groupId,
        topic: item.topic?.trim() || null,
        fact: factText,
        sourceUserId: null,
        sourceUserNickname: `[harvest:${(item.sourceNickname ?? '').trim()}]`,
        sourceMsgId: null,
        botReplyId: null,
        confidence: 0.7,
      });
      existing.push({
        id: 0, groupId, topic: item.topic?.trim() || null, fact: factText,
        sourceUserId: null, sourceUserNickname: null, sourceMsgId: null,
        botReplyId: null, confidence: 0.7, status: 'active',
        createdAt: 0, updatedAt: 0,
      });
      inserted++;
    }

    this.logger.info({ groupId, inserted, total: items.length }, 'harvest complete');
  }
}
