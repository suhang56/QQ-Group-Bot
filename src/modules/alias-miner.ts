import type { IClaudeClient } from '../ai/claude.js';
import type { IMessageRepository, ILearnedFactsRepository } from '../storage/db.js';
import type { Logger } from 'pino';
import { createLogger } from '../utils/logger.js';

const MIN_NEW_MESSAGES = 50;
const ALIAS_MODEL = 'claude-sonnet-4-6' as const;
const ALIAS_TOPIC_PREFIX = '群友别名 ';

interface AliasEntry {
  alias: string;
  realUserNickname: string;
  realUserId: string;
  evidence: string;
}

export interface AliasMinerOptions {
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

export class AliasMiner {
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

  constructor(opts: AliasMinerOptions) {
    this.messages = opts.messages;
    this.learnedFacts = opts.learnedFacts;
    this.claude = opts.claude;
    this.activeGroups = opts.activeGroups;
    this.logger = opts.logger ?? createLogger('alias-miner');
    this.intervalMs = opts.intervalMs ?? 2 * 60 * 60_000;
    this.windowMessages = opts.windowMessages ?? 500;
    this.enabled = opts.enabled ?? true;
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (!this.enabled) return;
    this.firstTimer = setTimeout(
      () => this._run().catch(err => this.logger.error({ err }, 'alias-miner run failed')),
      5 * 60_000,
    );
    this.timer = setInterval(
      () => this._run().catch(err => this.logger.error({ err }, 'alias-miner run failed')),
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
        this.logger.error({ err, groupId }, 'alias-miner group run failed');
      }
    }
  }

  async _runGroup(groupId: string): Promise<void> {
    const recent = this.messages.getRecent(groupId, this.windowMessages);

    const lastTs = this.lastRunTs.get(groupId) ?? 0;
    const newMsgs = recent.filter(m => m.timestamp * 1000 > lastTs);
    if (newMsgs.length < MIN_NEW_MESSAGES) {
      this.logger.debug({ groupId, newMsgs: newMsgs.length }, 'alias-miner skipped — too few new messages');
      return;
    }

    this.lastRunTs.set(groupId, this.now());

    const chronoMsgs = [...recent].reverse();
    const messagesList = chronoMsgs
      .map(m => `[userId=${m.userId} nickname=${m.nickname}]: ${m.content}`)
      .join('\n');

    const prompt = `你在帮一个 QQ 群 bot 整理「群友别名/外号」知识库。下面是最近 ${chronoMsgs.length} 条群聊消息，消息里包含了发言者的 userId 和 nickname。

消息（时间正序）：
${messagesList}

你的任务：找出消息中出现的**群友别名、外号、简称**，并映射到对应的真实群友。

判断标准：
- 别名/外号：群友用来称呼另一个群友的非官方昵称（如"拉神"、"表哥"、"常山"等）
- 只抽出你有较高把握的映射（消息中明确出现"X 就是 Y"、"叫 X 的那个"、称呼 X 时被 Y 回应等）
- 忽略纯粹的玩笑/角色扮演
- realUserId 必须是消息列表中真实出现过的 userId
- 每个 alias 只需出现一次

只返回 JSON 数组（最多 10 条）：
[
  {
    "alias": "<别名/外号>",
    "realUserNickname": "<对应群友的昵称（来自消息列表）>",
    "realUserId": "<对应群友的 userId（来自消息列表）>",
    "evidence": "<一句话说明判断依据，不超过 40 字>"
  }
]

如果没有发现明确的别名映射，返回空数组 []。`;

    let responseText: string;
    try {
      const resp = await this.claude.complete({
        model: ALIAS_MODEL,
        maxTokens: 1024,
        system: [{ text: '你是一个群聊别名抽取助手，只输出 JSON。', cache: true }],
        messages: [{ role: 'user', content: prompt }],
      });
      responseText = resp.text.trim();
    } catch (err) {
      this.logger.error({ err, groupId }, 'alias-miner Claude call failed');
      return;
    }

    let entries: AliasEntry[];
    try {
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      entries = jsonMatch ? (JSON.parse(jsonMatch[0]) as AliasEntry[]) : [];
      if (!Array.isArray(entries)) entries = [];
    } catch {
      this.logger.warn({ groupId, responseText }, 'alias-miner JSON parse failed');
      return;
    }

    if (entries.length === 0) {
      this.logger.info({ groupId }, 'alias-miner: no aliases found');
      return;
    }

    const existing = this.learnedFacts.listActive(groupId, 1000)
      .filter(f => f.topic?.startsWith(ALIAS_TOPIC_PREFIX));

    let inserted = 0;

    for (const entry of entries) {
      if (
        typeof entry.alias !== 'string' || !entry.alias.trim() ||
        typeof entry.realUserNickname !== 'string' || !entry.realUserNickname.trim() ||
        typeof entry.realUserId !== 'string' || !entry.realUserId.trim()
      ) continue;

      const alias = entry.alias.trim();
      const realUserNickname = entry.realUserNickname.trim();
      const realUserId = entry.realUserId.trim();
      const evidence = (entry.evidence ?? '').trim();

      // Sanity check: realUserId must have appeared in the recent messages
      const userSeen = recent.some(m => m.userId === realUserId);
      if (!userSeen) {
        this.logger.debug({ groupId, alias, realUserId }, 'alias-miner: userId not in recent messages, skipped');
        continue;
      }

      // Dedup: skip if an existing fact already pairs this alias with this nickname
      const isDupe = existing.some(
        f => f.fact.includes(alias) && f.fact.includes(realUserNickname),
      );
      if (isDupe) {
        this.logger.debug({ groupId, alias }, 'alias-miner dupe skipped');
        continue;
      }

      const factText = evidence
        ? `${alias} = ${realUserNickname} (QQ ${realUserId})。${evidence}`
        : `${alias} = ${realUserNickname} (QQ ${realUserId})`;

      this.learnedFacts.insert({
        groupId,
        topic: `${ALIAS_TOPIC_PREFIX}${alias}`,
        fact: factText,
        sourceUserId: null,
        sourceUserNickname: '[alias-miner]',
        sourceMsgId: null,
        botReplyId: null,
        confidence: 0.85,
      });

      existing.push({
        id: 0, groupId,
        topic: `${ALIAS_TOPIC_PREFIX}${alias}`,
        fact: factText,
        sourceUserId: null, sourceUserNickname: '[alias-miner]',
        sourceMsgId: null, botReplyId: null,
        confidence: 0.85, status: 'active',
        createdAt: 0, updatedAt: 0,
      });

      inserted++;
    }

    this.logger.info({ groupId, inserted, total: entries.length }, 'alias-miner complete');
  }
}
