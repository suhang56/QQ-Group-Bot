import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { IClaudeClient } from '../ai/claude.js';
import type { GroupMessage } from '../adapter/napcat.js';
import type { Database } from '../storage/db.js';
import { ClaudeApiError, ClaudeParseError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { lurkerDefaults, chatHistoryDefaults } from '../config.js';
import { FACE_LEGEND } from '../utils/qqface.js';
import { sentinelCheck, postProcess, HARDENED_SYSTEM } from '../utils/sentinel.js';

export interface IChatModule {
  generateReply(groupId: string, triggerMessage: GroupMessage, recentMessages: GroupMessage[]): Promise<string | null>;
}

interface ChatOptions {
  debounceMs?: number;
  maxGroupRepliesPerMinute?: number;
  recentMessageCount?: number;
  chatRecentCount?: number;
  chatHistoricalSampleCount?: number;
  chatKeywordMatchCount?: number;
  botUserId?: string;
  lurkerReplyChance?: number;
  lurkerCooldownMs?: number;
  burstWindowMs?: number;
  burstMinMessages?: number;
  groupIdentityCacheTtlMs?: number;
  groupIdentityTopUsers?: number;
  loreDirPath?: string;
  loreSizeCapBytes?: number;
}

// Chinese stopwords that add no retrieval signal
const STOPWORDS = new Set([
  '我','你','他','她','它','我们','你们','他们','的','了','是','不','啥','什么',
  '怎么','一个','这个','那个','就','也','都','在','有','和','吧','嗯','哦','哈',
  '吗','呢','啊','呀','么','这','那','为','以','到','从','但','所以','因为',
]);

/** Extract meaningful keywords from a message for corpus retrieval. */
export function extractKeywords(text: string): string[] {
  // Strip CQ codes first
  const stripped = text.replace(/\[CQ:[^\]]+\]/g, ' ');
  // Split on punctuation / whitespace; keep tokens ≥2 chars
  const tokens = stripped.split(/[\s\p{P}！？。，、；：""''【】《》（）…—]+/u)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
  // Deduplicate and cap at 5
  return [...new Set(tokens)].slice(0, 5);
}

export class ChatModule implements IChatModule {
  private readonly logger = createLogger('chat');
  private readonly debounceMs: number;
  private readonly maxGroupRepliesPerMinute: number;
  private readonly recentMessageCount: number;
  private readonly historicalSampleCount: number;
  private readonly keywordMatchCount: number;
  private readonly botUserId: string;
  private readonly lurkerReplyChance: number;
  private readonly lurkerCooldownMs: number;
  private readonly burstWindowMs: number;
  private readonly burstMinMessages: number;
  private readonly groupIdentityCacheTtlMs: number;
  private readonly groupIdentityTopUsers: number;

  // debounce: groupId -> last trigger timestamp
  private readonly debounceMap = new Map<string, number>();
  // group reply counter: groupId -> { count, windowStart }
  private readonly groupReplyCount = new Map<string, { count: number; windowStart: number }>();
  // last proactive (non-mention) reply timestamp per group
  private readonly lastProactiveReply = new Map<string, number>();
  // in-flight lock: groups currently awaiting a Claude reply — prevents concurrent duplicate sends
  private readonly inFlightGroups = new Set<string>();
  // group identity cache: groupId -> { text, expiresAt }
  private readonly groupIdentityCache = new Map<string, { text: string; expiresAt: number }>();
  // lore cache: groupId -> lore markdown (loaded once at first access)
  private readonly loreCache = new Map<string, string | null>();
  private readonly loreDirPath: string;
  private readonly loreSizeCapBytes: number;

  constructor(
    private readonly claude: IClaudeClient,
    private readonly db: Database,
    options: ChatOptions = {}
  ) {
    this.debounceMs = options.debounceMs ?? 2000;
    this.maxGroupRepliesPerMinute = options.maxGroupRepliesPerMinute ?? 20;
    this.recentMessageCount = options.chatRecentCount ?? options.recentMessageCount ?? chatHistoryDefaults.chatRecentCount;
    this.historicalSampleCount = options.chatHistoricalSampleCount ?? chatHistoryDefaults.chatHistoricalSampleCount;
    this.keywordMatchCount = options.chatKeywordMatchCount ?? chatHistoryDefaults.chatKeywordMatchCount;
    this.botUserId = options.botUserId ?? '';
    this.lurkerReplyChance = options.lurkerReplyChance ?? lurkerDefaults.lurkerReplyChance;
    this.lurkerCooldownMs = options.lurkerCooldownMs ?? lurkerDefaults.lurkerCooldownMs;
    this.burstWindowMs = options.burstWindowMs ?? lurkerDefaults.burstWindowMs;
    this.burstMinMessages = options.burstMinMessages ?? lurkerDefaults.burstMinMessages;
    this.groupIdentityCacheTtlMs = options.groupIdentityCacheTtlMs ?? chatHistoryDefaults.groupIdentityCacheTtlMs;
    this.groupIdentityTopUsers = options.groupIdentityTopUsers ?? chatHistoryDefaults.groupIdentityTopUsers;
    this.loreDirPath = options.loreDirPath ?? chatHistoryDefaults.loreDirPath;
    this.loreSizeCapBytes = options.loreSizeCapBytes ?? chatHistoryDefaults.loreSizeCapBytes;
  }

  async generateReply(
    groupId: string,
    triggerMessage: GroupMessage,
    recentMessages: GroupMessage[]
  ): Promise<string | null> {
    // Empty content after CQ stripping
    if (!triggerMessage.content.trim()) {
      return null;
    }

    // Group reply rate limit
    if (!this._checkGroupLimit(groupId)) {
      this.logger.warn({ groupId }, 'Group chat reply rate limit reached — silent');
      return null;
    }

    // Debounce: if another message came in within debounceMs, skip this one
    const now = Date.now();
    const lastTrigger = this.debounceMap.get(groupId);
    this.debounceMap.set(groupId, now);
    if (lastTrigger !== undefined && now - lastTrigger < this.debounceMs) {
      return null;
    }

    // In-flight lock: if a Claude reply is already being generated for this group,
    // drop this trigger. Prevents duplicate sends when two concurrent dispatches
    // (e.g. rapid @-mentions or NapCat retry) both pass the timestamp-based debounce
    // before either has set it (read-then-write race on the Map).
    if (this.inFlightGroups.has(groupId)) {
      this.logger.debug({ groupId }, 'Reply in-flight — dropping duplicate trigger');
      return null;
    }

    // Determine if this is a direct trigger (@mention or reply-to-bot)
    const isDirect = this._isMention(triggerMessage) || this._isReplyToBot(triggerMessage);

    if (!isDirect) {
      // Burst detection: if last N messages arrived within burstWindowMs, stay quiet
      if (this._isBurst(groupId)) {
        this.logger.debug({ groupId }, 'Burst detected — lurker skipping');
        return null;
      }

      // Cooldown: must be at least lurkerCooldownMs since last proactive reply
      const lastProactive = this.lastProactiveReply.get(groupId) ?? 0;
      if (now - lastProactive < this.lurkerCooldownMs) {
        this.logger.debug({ groupId, msSinceLast: now - lastProactive }, 'Lurker cooldown active — skipping');
        return null;
      }

      // Probabilistic gate
      if (Math.random() >= this.lurkerReplyChance) {
        return null;
      }

      this.lastProactiveReply.set(groupId, now);
    }

    // ── Retrieve context ──────────────────────────────────────────────────

    // 1. Keyword matches: find messages mentioning what the trigger talks about
    const keywords = extractKeywords(triggerMessage.content);
    const keywordMsgs = keywords.length > 0
      ? this.db.messages.searchByKeywords(groupId, keywords, this.keywordMatchCount)
      : [];

    // 2. Random historical sample for group vibe
    const historical = this.db.messages.sampleRandomHistorical(groupId, this.recentMessageCount, this.historicalSampleCount);

    // 3. Recent messages (passed in or fetched from DB)
    const recentSlice = recentMessages.length > 0
      ? recentMessages.slice(0, this.recentMessageCount)
      : this.db.messages.getRecent(groupId, this.recentMessageCount).map(m => ({
          messageId: String(m.id),
          groupId: m.groupId,
          userId: m.userId,
          nickname: m.nickname,
          role: 'member' as const,
          content: m.content,
          rawContent: m.content,
          timestamp: m.timestamp,
        }));

    // ── Build prompt ──────────────────────────────────────────────────────

    // Keyword matches — most relevant, shown first as "related history"
    const keywordSection = keywordMsgs.length > 0
      ? `【相关历史消息】\n${keywordMsgs.map(m => `${m.nickname}: ${m.content}`).join('\n')}\n\n`
      : '';

    // Historical sample — group vibe, sorted oldest→newest
    const historicalSorted = [...historical].sort((a, b) => a.timestamp - b.timestamp);
    const historicalSection = historicalSorted.length > 0
      ? `【群氛围参考】\n${historicalSorted.map(m => `${m.nickname}: ${m.content}`).join('\n')}\n\n`
      : '';

    // Recent — chronological (DB returns newest-first, reverse for oldest→newest)
    const recentChron = [...recentSlice].reverse();
    const recentSection = recentChron.length > 0
      ? `【最近聊天】\n${recentChron.map(m => `${m.nickname}: ${m.content}`).join('\n')}\n\n`
      : '';

    const historyText = keywordSection + historicalSection + recentSection;

    // ── Group identity system prompt (cached per group, TTL 1h) ──────────
    const systemPrompt = this._getGroupIdentityPrompt(groupId);

    const userContent = `${historyText}${triggerMessage.nickname}说："${triggerMessage.content}"，你会怎么接？直接写出那句话。`;

    const chatRequest = (hardened = false) => this.claude.complete({
      model: 'claude-sonnet-4-6',
      maxTokens: 300,
      system: [{ text: hardened ? HARDENED_SYSTEM : systemPrompt, cache: true }],
      messages: [{ role: 'user', content: userContent }],
    });

    this.inFlightGroups.add(groupId);
    try {
      const response = await chatRequest();
      const text = await sentinelCheck(
        response.text,
        triggerMessage.content,
        { groupId, userId: triggerMessage.userId },
        async () => (await chatRequest(true)).text,
      );
      return postProcess(text);
    } catch (err) {
      if (err instanceof ClaudeApiError || err instanceof ClaudeParseError) {
        this.logger.error({ err, groupId }, 'Claude API error in chat module — silent');
        return null;
      }
      throw err;
    } finally {
      this.inFlightGroups.delete(groupId);
    }
  }

  private _loadLore(groupId: string): string | null {
    if (this.loreCache.has(groupId)) {
      return this.loreCache.get(groupId) ?? null;
    }

    const lorePath = path.join(this.loreDirPath, `${groupId}.md`);
    if (!existsSync(lorePath)) {
      this.loreCache.set(groupId, null);
      return null;
    }

    let content: string;
    try {
      content = readFileSync(lorePath, 'utf8');
    } catch {
      this.logger.warn({ groupId, lorePath }, 'Failed to read lore file — falling back to generic prompt');
      this.loreCache.set(groupId, null);
      return null;
    }

    if (!content.trim()) {
      this.logger.warn({ groupId, lorePath }, 'Lore file is empty — treating as missing');
      this.loreCache.set(groupId, null);
      return null;
    }

    if (Buffer.byteLength(content, 'utf8') > this.loreSizeCapBytes) {
      const capKb = (this.loreSizeCapBytes / 1024).toFixed(0);
      this.logger.warn({ groupId, lorePath, capKb }, `Lore file exceeds ${capKb}KB cap — truncating`);
      // Truncate to cap at a UTF-8 boundary (slice by chars approximates well enough)
      const capChars = this.loreSizeCapBytes; // bytes ≈ chars for UTF-8 heavy Chinese is safe overcount
      content = content.slice(0, capChars);
    }

    this.loreCache.set(groupId, content);
    this.logger.debug({ groupId, lorePath, sizeKb: (content.length / 1024).toFixed(1) }, 'Lore file loaded');
    return content;
  }

  private _getGroupIdentityPrompt(groupId: string): string {
    const cached = this.groupIdentityCache.get(groupId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.text;
    }

    const lore = this._loadLore(groupId);
    let text: string;

    const faceLine = `\n可以用 QQ 表情，格式 [CQ:face,id=N]。常用表情参考：${FACE_LEGEND}`;

    const outputRules = `\n\n输出规则（必须严格遵守）：\n- 直接输出那句话，不要任何前缀、后缀、解释、元评论\n- 禁止出现任何自我指涉词（包括但不限于：AI、机器人、助手、模仿、尝试、风格、根据、历史、无法）\n- 禁止"好的，"、"当然，"、"我来"、"让我"等助手式开场\n- 如果想说多个意思，用换行分开，每行就是一条消息（最多 3 行）\n- 如果实在不知道说什么，输出"..."，禁止解释\n\n标点习惯：\n- 不要用句号。中文群聊几乎不打句号\n- 少用逗号，句子短就不用\n- 感叹号和问号可以用，但不要叠\n- 括号（）少用，用就是吐槽`;

    if (lore) {
      text = `你就是这个QQ群里的一员，一个真实的老群友。以下是这个群的资料：\n\n${lore}\n\n---\n说话风格随群，自然随意、简短（1-3句话）。群友提到群里的人名、梗、黑话，基于资料回答；资料没提到的就说"啥来的"或"没听过求科普"，不要装懂。${faceLine}${outputRules}`;
    } else {
      const topUsers = this.db.messages.getTopUsers(groupId, this.groupIdentityTopUsers);
      const memberList = topUsers.length > 0
        ? topUsers.map(u => u.nickname).join('、')
        : '（暂无数据）';
      text = `你就是这个QQ群里的一员，一个真实的老群友，说话风格随群，自然随意、简短（1-3句话）。\n群里的常驻群友（按活跃度）：${memberList}\n群友提到群里的人名、梗、黑话，基于上下文猜意思；不懂就说"啥来的"或"没听过求科普"，不要装懂。${faceLine}${outputRules}`;
    }

    this.groupIdentityCache.set(groupId, { text, expiresAt: Date.now() + this.groupIdentityCacheTtlMs });
    this.logger.debug({ groupId, hasLore: !!lore }, 'Group identity prompt cached');
    return text;
  }

  private _isMention(msg: GroupMessage): boolean {
    if (!this.botUserId) return false;
    return msg.rawContent.includes(`[CQ:at,qq=${this.botUserId}]`);
  }

  private _isReplyToBot(msg: GroupMessage): boolean {
    return msg.rawContent.startsWith('[CQ:reply,');
  }

  private _isBurst(groupId: string): boolean {
    const recent = this.db.messages.getRecent(groupId, this.burstMinMessages);
    if (recent.length < this.burstMinMessages) return false;
    const newest = recent[0]!.timestamp;
    const oldest = recent[recent.length - 1]!.timestamp;
    // timestamps are unix seconds; burstWindowMs is ms
    return (newest - oldest) * 1000 < this.burstWindowMs;
  }

  private _checkGroupLimit(groupId: string): boolean {
    const now = Date.now();
    let state = this.groupReplyCount.get(groupId);
    if (!state || now - state.windowStart >= 60_000) {
      state = { count: 0, windowStart: now };
    }
    if (state.count >= this.maxGroupRepliesPerMinute) {
      this.groupReplyCount.set(groupId, state);
      return false;
    }
    this.groupReplyCount.set(groupId, { count: state.count + 1, windowStart: state.windowStart });
    return true;
  }
}
