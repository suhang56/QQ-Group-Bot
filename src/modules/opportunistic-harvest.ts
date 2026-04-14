import type { IClaudeClient } from '../ai/claude.js';
import type { IMessageRepository, ILearnedFactsRepository } from '../storage/db.js';
import type { Logger } from 'pino';
import { createLogger } from '../utils/logger.js';

const MIN_NEW_MESSAGES = 8;
const MAX_FACTS_PER_RUN = 12;
const MAX_FACTS_DEEP = 30;
const FACT_DEDUP_PREFIX_LEN = 20;
const HARVEST_MODEL = 'claude-sonnet-4-6' as const;

interface HarvestItem {
  category?: string;
  topic: string;
  fact: string;
  sourceNickname: string;
  confidence?: number;
}

export interface OpportunisticHarvestOptions {
  messages: IMessageRepository;
  learnedFacts: ILearnedFactsRepository;
  claude: IClaudeClient;
  activeGroups: string[];
  logger?: Logger;
  intervalMs?: number;
  deepIntervalMs?: number;
  windowMessages?: number;
  deepWindowMessages?: number;
  enabled?: boolean;
  /** Injected for testing */
  now?: () => number;
}

function buildPrompt(chronoMsgs: Array<{ nickname: string; content: string }>, maxFacts: number, deep: boolean): string {
  const msgList = chronoMsgs.map(m => `[${m.nickname}]: ${m.content}`).join('\n');
  const deepHint = deep ? `\n**因为窗口很大（${chronoMsgs.length} 条），重点找：**\n- 反复出现 3+ 次的稳定模式（不是单次玩笑）\n- 跨多个对话的群友行为习惯\n- 长期话题（持续多天的 thread）\n- 上面 1-8 类别中的高 confidence 事实` : '';

  return `你在帮一个 QQ 群 bot 持续构建知识库。下面是最近 ${chronoMsgs.length} 条群消息。任务：**广泛抽取**值得让 bot 长期记住的内容，让 bot 越泡越懂这个群。

消息（时间正序）：
${msgList}

## 提取目标（要广 不要窄）

1. **群友个人信息**（地理 / 职业 / 学校 / 兴趣 / 品味）
   - "X 在波士顿读书"、"Y 是金融狗"、"Z 玩 LoL 杰斯"
2. **群友关系 / CP / 外号 / 代称**
   - "X 是 Y 的本命推"、"X 和 Y 凑 CP"、"X 别名 Z"、"X 被叫 Z 是因为..."
3. **群内梗 / 黑话 / 内部词义**
   - "在群里 X 的意思是 Y"、"X 这个词是 Z 演化来的"
4. **fandom 事实**（声优 / 乐队 / 角色 / 曲目 / live / 八卦）
   - "X 是 Y band 的 Z 乐器"、"X 曲是 Y 唱的"、"X 声优最近在做 Y"
5. **群友态度 / 立场**
   - "X 讨厌 Y 行为"、"X 最爱 Z 角色"、"X 反对 W 观点"
6. **群文化 / 仪式 / 共享活动**
   - "群里每周 X 会做 Y"、"X 节日大家会 Z"、"X 事件之后大家都说 Y"
7. **新事件 / 时间敏感信息**
   - "X 演唱会在 Y 时间地点"、"X 月 Y 日有 Z 活动"
8. **群友的纠正**
   - "X 不是 A 是 B" 类纠正陈述

## 不要抽
- 一次性玩笑 / 情绪发泄 / 吵架
- "今天吃了什么" 这种琐碎 daily 话题
- 私人敏感信息（身份证 / 电话 / 地址精确到门牌）
- 政治 / 历史敏感话题
- 谣言 / 推测 / 不确定的陈述

## 输出
只返回 JSON 数组，最多 ${maxFacts} 条（按价值排序，最有用的在前）：
[
  {
    "category": "<上面 1-8 之一的中文标签>",
    "topic": "<10 字内简短主题>",
    "fact": "<具体事实陈述，中文，最多 100 字>",
    "sourceNickname": "<提供该信息的群友昵称，多人就写主要的那一个>",
    "confidence": 0.0-1.0
  }
]

如果没有值得抽的事实，返回空数组 []。${deepHint}`;
}

export class OpportunisticHarvest {
  private readonly messages: IMessageRepository;
  private readonly learnedFacts: ILearnedFactsRepository;
  private readonly claude: IClaudeClient;
  private readonly activeGroups: string[];
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly deepIntervalMs: number;
  private readonly windowMessages: number;
  private readonly deepWindowMessages: number;
  private readonly enabled: boolean;
  private readonly now: () => number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private deepTimer: ReturnType<typeof setInterval> | null = null;
  private deepFirstTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly lastRunTs = new Map<string, number>();
  private readonly lastDeepRunTs = new Map<string, number>();

  constructor(opts: OpportunisticHarvestOptions) {
    this.messages = opts.messages;
    this.learnedFacts = opts.learnedFacts;
    this.claude = opts.claude;
    this.activeGroups = opts.activeGroups;
    this.logger = opts.logger ?? createLogger('opportunistic-harvest');
    this.intervalMs = opts.intervalMs ?? 15 * 60_000;
    this.deepIntervalMs = opts.deepIntervalMs ?? 24 * 60 * 60_000;
    this.windowMessages = opts.windowMessages ?? 150;
    this.deepWindowMessages = opts.deepWindowMessages ?? 1000;
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

    this.deepFirstTimer = setTimeout(
      () => this._runDeep().catch(err => this.logger.error({ err }, 'deep harvest failed')),
      30 * 60_000,
    );
    this.deepTimer = setInterval(
      () => this._runDeep().catch(err => this.logger.error({ err }, 'deep harvest failed')),
      this.deepIntervalMs,
    );
    this.deepTimer.unref?.();
  }

  dispose(): void {
    if (this.firstTimer) { clearTimeout(this.firstTimer); this.firstTimer = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.deepFirstTimer) { clearTimeout(this.deepFirstTimer); this.deepFirstTimer = null; }
    if (this.deepTimer) { clearInterval(this.deepTimer); this.deepTimer = null; }
  }

  async _run(): Promise<void> {
    for (const groupId of this.activeGroups) {
      try {
        await this._runGroup(groupId, false);
      } catch (err) {
        this.logger.error({ err, groupId }, 'harvest group run failed');
      }
    }
  }

  async _runDeep(): Promise<void> {
    for (const groupId of this.activeGroups) {
      try {
        await this._runGroup(groupId, true);
      } catch (err) {
        this.logger.error({ err, groupId }, 'deep harvest group run failed');
      }
    }
  }

  async _runGroup(groupId: string, deep: boolean): Promise<void> {
    const window = deep ? this.deepWindowMessages : this.windowMessages;
    const maxFacts = deep ? MAX_FACTS_DEEP : MAX_FACTS_PER_RUN;
    const lastRunMap = deep ? this.lastDeepRunTs : this.lastRunTs;
    const cycleLabel = deep ? 'deep harvest' : 'harvest';

    const recent = this.messages.getRecent(groupId, window);

    const lastTs = lastRunMap.get(groupId) ?? 0;
    const newMsgs = recent.filter(m => m.timestamp * 1000 > lastTs);
    if (newMsgs.length < MIN_NEW_MESSAGES) {
      this.logger.debug({ groupId, newMsgs: newMsgs.length, deep }, `${cycleLabel} skipped — too few new messages`);
      return;
    }

    lastRunMap.set(groupId, this.now());

    const chronoMsgs = [...recent].reverse();
    const prompt = buildPrompt(chronoMsgs, maxFacts, deep);

    let responseText: string;
    try {
      const resp = await this.claude.complete({
        model: HARVEST_MODEL,
        maxTokens: deep ? 2048 : 1024,
        system: [{ text: '你是一个群聊知识抽取助手，只输出 JSON。', cache: true }],
        messages: [{ role: 'user', content: prompt }],
      });
      responseText = resp.text.trim();
    } catch (err) {
      this.logger.error({ err, groupId }, `${cycleLabel} Claude call failed`);
      return;
    }

    let items: HarvestItem[];
    try {
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      items = jsonMatch ? (JSON.parse(jsonMatch[0]) as HarvestItem[]) : [];
      if (!Array.isArray(items)) items = [];
    } catch {
      this.logger.warn({ groupId, responseText }, `${cycleLabel} JSON parse failed`);
      return;
    }

    if (items.length === 0) {
      this.logger.info({ groupId }, `${cycleLabel}: no facts extracted`);
      return;
    }

    const existing = this.learnedFacts.listActive(groupId, 1000);
    const totalBefore = existing.length;
    let inserted = 0;
    let dedupped = 0;

    for (const item of items.slice(0, maxFacts)) {
      if (typeof item.fact !== 'string' || !item.fact.trim()) continue;
      const factText = item.fact.trim();
      const prefix = factText.slice(0, FACT_DEDUP_PREFIX_LEN);
      const isDupe = existing.some(e => e.fact.includes(prefix));
      if (isDupe) {
        this.logger.debug({ groupId, fact: factText }, `${cycleLabel} dupe skipped`);
        dedupped++;
        continue;
      }

      const category = item.category?.trim() || '';
      const rawTopic = item.topic?.trim() || null;
      const topic = category && rawTopic ? `${category} ${rawTopic}` : (rawTopic ?? (category || null));
      const confidence = typeof item.confidence === 'number'
        ? Math.min(1, Math.max(0, item.confidence))
        : 0.7;

      this.learnedFacts.insert({
        groupId,
        topic,
        fact: factText,
        sourceUserId: null,
        sourceUserNickname: `[harvest:${(item.sourceNickname ?? '').trim()}]`,
        sourceMsgId: null,
        botReplyId: null,
        confidence,
      });
      existing.push({
        id: 0, groupId, topic, fact: factText,
        sourceUserId: null, sourceUserNickname: null, sourceMsgId: null,
        botReplyId: null, confidence, status: 'active',
        createdAt: 0, updatedAt: 0,
      });
      inserted++;
    }

    const totalAfter = totalBefore + inserted;
    this.logger.info(
      { groupId, inserted, dedupped, totalActiveFacts: totalAfter, deep },
      `${cycleLabel} cycle: ${inserted} facts inserted, ${dedupped} dedupped, ${totalAfter} total active`,
    );
  }
}
