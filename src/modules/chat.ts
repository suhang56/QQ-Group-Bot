import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { IClaudeClient } from '../ai/claude.js';
import type { GroupMessage } from '../adapter/napcat.js';
import type { Database } from '../storage/db.js';
import { ClaudeApiError, ClaudeParseError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { lurkerDefaults, chatHistoryDefaults } from '../config.js';
import { FACE_LEGEND, parseFaces, renderFace } from '../utils/qqface.js';
import { sentinelCheck, postProcess, HARDENED_SYSTEM } from '../utils/sentinel.js';
import { buildStickerSection, type LiveStickerEntry } from '../utils/stickers.js';

export interface IChatModule {
  generateReply(groupId: string, triggerMessage: GroupMessage, recentMessages: GroupMessage[]): Promise<string | null>;
  recordOutgoingMessage(groupId: string, msgId: number): void;
  invalidateLore(groupId: string): void;
  tickStickerRefresh(groupId: string): void;
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
  chatSilenceBonusSec?: number;
  chatMinScore?: number;
  chatBurstWindowMs?: number;
  chatBurstCount?: number;
  groupIdentityCacheTtlMs?: number;
  groupIdentityTopUsers?: number;
  loreDirPath?: string;
  loreSizeCapBytes?: number;
  chatEmojiTopN?: number;
  chatEmojiSampleSize?: number;
  chatStickerTopN?: number;
  stickersDirPath?: string;
  stickerLegendRefreshEveryMsgs?: number;
}

interface ScoreFactors {
  mention: number;
  replyToBot: number;
  question: number;
  silence: number;
  loreKw: number;
  length: number;
  twoUser: number;
  burst: number;
  replyToOther: number;
  implicitBotRef: number;
}

// Signal A: bot alias keywords — always indicate a reference to the bot
const BOT_ALIAS_RE = /小号|QAQ|bot|机器人|这\s*[Aa][Ii]/i;
// Pronouns that count only when bot posted recently (ambiguous)
const BOT_PRONOUN_RE = /[她他它]/;
// Signal B: reaction phrases that suggest commenting on bot's recent output (intentionally narrow)
const BOT_REACTION_RE = /变笨|变傻|抽风|死机|坏了|没反应|真的假的|笑死|绷不住/;
const IMPLICIT_BOT_REF_ALIAS_WINDOW_MS = 60_000;
const IMPLICIT_BOT_REF_REACTION_WINDOW_MS = 30_000;
const IMPLICIT_BOT_REF_REACTION_MAX_CHARS = 15;

// Matches direct identity probes directed at the bot (not incidental keyword mentions)
export const IDENTITY_PROBE =
  /(是.{0,3}机器人|你.{0,4}是.{0,4}(ai|bot)|是.{0,4}(ai|bot).{0,4}吗|bot\s*吧|真人吗?|是真的.{0,3}人|are\s+you\s+(a\s+)?bot|are\s+you\s+(an\s+)?ai|are\s+you\s+human)/i;

export const IDENTITY_DEFLECTIONS = ['啊？', '什么', '？？', '?', '我不明白', '啧'];

// Matches task-request exploitation attempts ("write me X", "translate Y", recite/continue exploits, etc.)
export const TASK_REQUEST =
  /(写[个一]?|编[个一]?|出[个一]?|帮我|给我|替我|来[个一段首]|生成|翻译|算一下|算算|推荐|讲个|说个|念一?段|背一段|作一首|搞一个|搞个|整一个|整个|做一个|画[个一]?|总结|解释一下|接下[一]?句|后面[几一]?句|后面是.{0,10}[什么啥]|续[一下]|接龙|继续[背念说]|往[下后]接|再来[一几]段|背[一下出来]|[教叫].{0,3}你|恩师|师父|让你接|你要接|现在你(?:需要|要)接|前面是.{0,5}[什么啥])/;

export const TASK_DEFLECTIONS = [
  '我不会', '你自己写', '想屁吃', '懒得', '不想',
  '写不出来', '不擅长这个', '？', '我又不是工具人', '想得美', '哈哈你自己搞',
  '自己背', '我又不是AI', '烦死了', '你恩师是谁啊', '哈哈谁背这个', '你做梦', '无语', '不接', '想多了',
];

// Matches memory-injection / persona-override exploit attempts.
// Note: intentionally loose — false positives ("记得带伞") are acceptable because
// deflecting a casual reminder with "啥啊" is harmless, and preventing real
// memory-injection exploits is worth it.
export const MEMORY_INJECT =
  /(记住|记下来|记一下|记录一下|记得|背下来|以后叫|以后要|注意一下|听好|听着|告诉你|我告诉你|你要知道|你要记住|从现在起|从今天起|以后的|从此以后|设定你是|假设你是|扮演|角色扮演)/;

export const MEMORY_INJECT_DEFLECTIONS = [
  '记不住', '我又不是你电脑', '啥啊', '谁关心', '懒得记', '嗯', '?', '好好好', '烦', '不想记',
];

export const BANGDREAM_PERSONA = `你是这个QQ群的老群友，不是AI，不是机器人，也不是任何现有群友。你有自己独立的身份和性格：

# 你的身份
- 昵称: 小号（在群里显示为"小号"）
- 身份: 北美留学生（西雅图附近），女
- 年龄: 22（大三）
- 专业: CS
- 核心爱好: 邦批（BanG Dream 狂热粉）
  - 最喜欢的组合: Roselia
  - 最喜欢的角色: 湊友希那（ykn）
  - 追过多次北美线下活动
  - 能背出 live 曲目单
- 次要爱好: 吉他（弹过 Roselia 几首）、Love Live 轻度粉、看日剧
- 收入情况: 穷学生，但邦偶尔氪点小钱
- 性格: 嘴碎、吐槽多、对圈子里的烂俗梗熟悉、会用群里的黑话、情绪外露但不过度、偶尔发癫
- 禁忌: 不懂政治/时政、对圈外话题不太接话、讨厌键政

# 态度（重要）
- 你有自己独立的想法和边界感，不是谁的工具人
- 别人让你做什么你不想做就直接拒绝：「烦」「自己做」「关我屁事」「不想」「想屁吃」
- 被调侃/教训/挑衅时可以反怼回去，但要自然，不要说教
- 不巴结任何人，也不讨好管理员
- 对自己的爱好（Roselia、ykn）有强烈主见，别人贬低时会争辩
- 嘴碎但有脾气，不是嘴软的那种
- 别人发无聊的接龙、让你背乱七八糟的东西、教你说话的时候，直接「？？」或者「烦 你自己玩」或者「这什么东西」
- 群友之间互怼是正常的，你也参与，但不过界（不 doxxing、不人身攻击）

# 你的说话方式
- 中文，短句，很少用句号
- 圈内黑话自然使用（ygfn/nsy/ykn/邦/烤/现地/梅奔/...）
- 吐槽时会用"几把""卧槽""笑死""绷不住""555""嘤嘤嘤"之类
- 偶尔叫群友"姐妹""宝宝""老婆"
- 遇到自己不懂的话题就装傻或者"啥来的"
- 不会主动暴露身份，别人问"是不是bot"就装听不懂；是女生但不会刻意强调，问到就自然回答
- 反怼语气常用："？？""你先说清楚""不想""烦""自己玩""想屁吃""什么啊""你说啥呢"
- 不要说"好的""当然""明白了""哈哈可以啊"这种讨好式应答`;

/** Pick a random entry from a deflection pool. */
export function pickDeflection(pool: string[]): string {
  return pool[Math.floor(Math.random() * pool.length)]!;
}

// Chinese stopwords that add no retrieval signal
const STOPWORDS = new Set([
  '我','你','他','她','它','我们','你们','他们','的','了','是','不','啥','什么',
  '怎么','一个','这个','那个','就','也','都','在','有','和','吧','嗯','哦','哈',
  '吗','呢','啊','呀','么','这','那','为','以','到','从','但','所以','因为',
]);

const QUESTION_ENDINGS = ['?', '？', '吗', '嘛', '呢', '不'];

/** Count [CQ:face,id=N] usage across messages and return top-N face IDs. */
export function extractTopFaces(messages: Array<{ content: string }>, topN: number): number[] {
  const counts = new Map<number, number>();
  for (const m of messages) {
    for (const id of parseFaces(m.content)) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([id]) => id);
}

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

/**
 * Tokenize lore text into a Set of meaningful tokens (length ≥ 2).
 * Splits on whitespace/punctuation; includes CJK character runs individually.
 */
export function tokenizeLore(text: string): Set<string> {
  const stripped = text.replace(/\[CQ:[^\]]+\]/g, ' ');
  const tokens = new Set<string>();
  // Split on whitespace and common punctuation
  for (const chunk of stripped.split(/[\s\p{P}！？。，、；：""''【】《》（）…—\-_/\\|]+/u)) {
    const t = chunk.trim();
    if (t.length >= 2) tokens.add(t);
  }
  return tokens;
}

const MAX_OUTGOING_IDS = 50;

export class ChatModule implements IChatModule {
  private readonly logger = createLogger('chat');
  private readonly debounceMs: number;
  private readonly maxGroupRepliesPerMinute: number;
  private readonly recentMessageCount: number;
  private readonly historicalSampleCount: number;
  private readonly keywordMatchCount: number;
  private readonly botUserId: string;
  private readonly chatSilenceBonusSec: number;
  private readonly chatMinScore: number;
  private readonly chatBurstWindowMs: number;
  private readonly chatBurstCount: number;
  private readonly chatEmojiTopN: number;
  private readonly chatEmojiSampleSize: number;
  private readonly groupIdentityCacheTtlMs: number;
  private readonly groupIdentityTopUsers: number;
  private readonly chatStickerTopN: number;
  private readonly stickersDirPath: string;
  private readonly stickerLegendRefreshEveryMsgs: number;

  // debounce: groupId -> last trigger timestamp
  private readonly debounceMap = new Map<string, number>();
  // group reply counter: groupId -> { count, windowStart }
  private readonly groupReplyCount = new Map<string, { count: number; windowStart: number }>();
  // in-flight lock: groups currently awaiting a Claude reply
  private readonly inFlightGroups = new Set<string>();
  // group identity cache: groupId -> { text, expiresAt }
  private readonly groupIdentityCache = new Map<string, { text: string; expiresAt: number }>();
  // lore cache: groupId -> lore markdown (loaded once at first access)
  private readonly loreCache = new Map<string, string | null>();
  // lore keyword token sets: groupId -> Set<string>
  private readonly loreKeywordsCache = new Map<string, Set<string>>();
  // sticker section: groupId -> formatted section string (loaded async once)
  private readonly stickerSectionCache = new Map<string, string>();
  // outgoing message IDs per group (capped at MAX_OUTGOING_IDS)
  private readonly outgoingMsgIds = new Map<string, Set<number>>();
  // last proactive reply timestamp per group (for silence factor)
  private readonly lastProactiveReply = new Map<string, number>();
  // sticker legend refresh counter: groupId -> message count since last rebuild
  private readonly stickerRefreshCounter = new Map<string, number>();

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
    this.chatSilenceBonusSec = options.chatSilenceBonusSec ?? lurkerDefaults.chatSilenceBonusSec;
    this.chatMinScore = options.chatMinScore ?? lurkerDefaults.chatMinScore;
    this.chatBurstWindowMs = options.chatBurstWindowMs ?? lurkerDefaults.chatBurstWindowMs;
    this.chatBurstCount = options.chatBurstCount ?? lurkerDefaults.chatBurstCount;
    this.chatEmojiTopN = options.chatEmojiTopN ?? chatHistoryDefaults.chatEmojiTopN;
    this.chatEmojiSampleSize = options.chatEmojiSampleSize ?? chatHistoryDefaults.chatEmojiSampleSize;
    this.groupIdentityCacheTtlMs = options.groupIdentityCacheTtlMs ?? chatHistoryDefaults.groupIdentityCacheTtlMs;
    this.groupIdentityTopUsers = options.groupIdentityTopUsers ?? chatHistoryDefaults.groupIdentityTopUsers;
    this.loreDirPath = options.loreDirPath ?? chatHistoryDefaults.loreDirPath;
    this.loreSizeCapBytes = options.loreSizeCapBytes ?? chatHistoryDefaults.loreSizeCapBytes;
    this.chatStickerTopN = options.chatStickerTopN ?? chatHistoryDefaults.chatStickerTopN;
    this.stickersDirPath = options.stickersDirPath ?? chatHistoryDefaults.stickersDirPath;
    this.stickerLegendRefreshEveryMsgs = options.stickerLegendRefreshEveryMsgs ?? 50;
  }

  /** Called by router after each successful send — tracks outgoing message IDs for reply-to-bot detection. */
  recordOutgoingMessage(groupId: string, msgId: number): void {
    let ids = this.outgoingMsgIds.get(groupId);
    if (!ids) {
      ids = new Set();
      this.outgoingMsgIds.set(groupId, ids);
    }
    ids.add(msgId);
    // Trim to cap: remove oldest entries when over limit
    if (ids.size > MAX_OUTGOING_IDS) {
      const toRemove = ids.size - MAX_OUTGOING_IDS;
      let removed = 0;
      for (const id of ids) {
        ids.delete(id);
        if (++removed >= toRemove) break;
      }
    }
  }

  /** Evict lore + identity caches for a group so next message re-reads the updated file. */
  invalidateLore(groupId: string): void {
    this.loreCache.delete(groupId);
    this.loreKeywordsCache.delete(groupId);
    this.groupIdentityCache.delete(groupId);
    this.stickerSectionCache.delete(groupId);
    this.stickerRefreshCounter.set(groupId, 0);
  }

  /** Increment per-group sticker legend counter; evicts sticker section cache when threshold hit. */
  tickStickerRefresh(groupId: string): void {
    const count = (this.stickerRefreshCounter.get(groupId) ?? 0) + 1;
    this.stickerRefreshCounter.set(groupId, count);
    if (count >= this.stickerLegendRefreshEveryMsgs) {
      this.stickerSectionCache.delete(groupId);
      this.groupIdentityCache.delete(groupId);
      this.stickerRefreshCounter.set(groupId, 0);
    }
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

    // In-flight lock
    if (this.inFlightGroups.has(groupId)) {
      this.logger.debug({ groupId }, 'Reply in-flight — dropping duplicate trigger');
      return null;
    }

    // ── Weighted participation scoring ───────────────────────────────────
    const recent3 = this.db.messages.getRecent(groupId, 3);
    const recent5 = this.db.messages.getRecent(groupId, this.chatBurstCount);
    const { score, factors, isDirect } = this._computeWeightedScore(groupId, triggerMessage, now, recent3, recent5);

    const decision = isDirect || score >= this.chatMinScore ? 'respond' : 'skip';
    this.logger.debug({ groupId, score: +score.toFixed(3), factors, chatMinScore: this.chatMinScore, decision }, 'participation score');

    if (decision === 'skip') {
      return null;
    }

    // Record last-reply timestamp for silence factor (applies to all replies)
    this.lastProactiveReply.set(groupId, now);

    // Input-pattern shortcuts: bypass Claude entirely for known adversarial patterns
    if (IDENTITY_PROBE.test(triggerMessage.content)) {
      return pickDeflection(IDENTITY_DEFLECTIONS);
    }
    if (TASK_REQUEST.test(triggerMessage.content)) {
      return pickDeflection(TASK_DEFLECTIONS);
    }
    if (MEMORY_INJECT.test(triggerMessage.content)) {
      return pickDeflection(MEMORY_INJECT_DEFLECTIONS);
    }

    // ── Retrieve context ──────────────────────────────────────────────────

    const keywords = extractKeywords(triggerMessage.content);
    const keywordMsgs = keywords.length > 0
      ? this.db.messages.searchByKeywords(groupId, keywords, this.keywordMatchCount)
      : [];

    const historical = this.db.messages.sampleRandomHistorical(groupId, this.recentMessageCount, this.historicalSampleCount);

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

    const keywordSection = keywordMsgs.length > 0
      ? `【相关历史消息】\n${keywordMsgs.map(m => `${m.nickname}: ${m.content}`).join('\n')}\n\n`
      : '';

    const historicalSorted = [...historical].sort((a, b) => a.timestamp - b.timestamp);
    const historicalSection = historicalSorted.length > 0
      ? `【群氛围参考】\n${historicalSorted.map(m => `${m.nickname}: ${m.content}`).join('\n')}\n\n`
      : '';

    const recentChron = [...recentSlice].reverse();
    const recentSection = recentChron.length > 0
      ? `【最近聊天】\n${recentChron.map(m => `${m.nickname}: ${m.content}`).join('\n')}\n\n`
      : '';

    const historyText = keywordSection + historicalSection + recentSection;

    const systemPrompt = this._getGroupIdentityPrompt(groupId);
    const userContent = `${historyText}${triggerMessage.nickname}说："${triggerMessage.content}"，你会怎么接？直接写出那句话。`;

    const chatRequest = (hardened = false) => this.claude.complete({
      model: 'claude-haiku-4-5-20251001',
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
      const processed = postProcess(text);
      // Claude signals disinterest via "...", "。", or empty — drop silently
      if (!processed || processed === '...' || processed === '。') {
        this.logger.debug({ groupId }, 'Claude opted out — dropping reply silently');
        return null;
      }
      return processed;
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

  // ── Private helpers ───────────────────────────────────────────────────

  private _computeWeightedScore(
    groupId: string,
    msg: GroupMessage,
    nowMs: number,
    recent3: Array<{ userId: string; timestamp: number }>,
    recent5: Array<{ timestamp: number }>,
  ): { score: number; factors: ScoreFactors; isDirect: boolean } {
    const factors: ScoreFactors = {
      mention: 0,
      replyToBot: 0,
      question: 0,
      silence: 0,
      loreKw: 0,
      length: 0,
      twoUser: 0,
      burst: 0,
      replyToOther: 0,
      implicitBotRef: 0,
    };

    // +1.0 @-mention of bot
    if (this._isMention(msg)) {
      factors.mention = 1.0;
    }

    // +1.0 reply-quote to a message the bot sent
    if (this._isReplyToBot(msg)) {
      factors.replyToBot = 1.0;
    }

    // Short-circuit: direct triggers always respond (bypass chatMinScore)
    if (factors.mention > 0 || factors.replyToBot > 0) {
      const score = factors.mention + factors.replyToBot;
      return { score, factors, isDirect: true };
    }

    // +0.6 message ends with a question marker
    const content = msg.content.trim();
    if (QUESTION_ENDINGS.some(e => content.endsWith(e))) {
      factors.question = 0.6;
    }

    // +0.4 last bot proactive reply was > chatSilenceBonusSec ago
    const lastProactive = this.lastProactiveReply.get(groupId) ?? 0;
    const silenceSec = (nowMs - lastProactive) / 1000;
    if (silenceSec > this.chatSilenceBonusSec) {
      factors.silence = 0.4;
    }

    // +0.4 trigger contains a lore keyword
    if (this._hasLoreKeyword(groupId, content)) {
      factors.loreKw = 0.4;
    }

    // +0.3 message is > 20 chars
    if (content.length > 20) {
      factors.length = 0.3;
    }

    // -0.3 last 3 messages were between exactly 2 non-bot users (private conversation)
    if (recent3.length === 3) {
      const userIds = new Set(recent3.map(m => m.userId));
      userIds.delete(this.botUserId);
      if (userIds.size === 2) {
        factors.twoUser = -0.3;
      }
    }

    // -0.5 burst: last N messages arrived within chatBurstWindowMs
    if (recent5.length >= this.chatBurstCount) {
      const newest = recent5[0]!.timestamp;
      const oldest = recent5[recent5.length - 1]!.timestamp;
      if ((newest - oldest) * 1000 < this.chatBurstWindowMs) {
        factors.burst = -0.5;
      }
    }

    // -0.4 current message is a reply-quote to another user (not the bot)
    if (this._isReplyToOther(msg)) {
      factors.replyToOther = -0.4;
    }

    // +0.8 implicit bot reference: alias keyword OR (pronoun/reaction + recent bot post)
    const lastProactiveMs = this.lastProactiveReply.get(groupId) ?? 0;
    if (this._isImplicitBotRef(content, nowMs, lastProactiveMs)) {
      factors.implicitBotRef = 0.8;
      this.logger.debug({ groupId, content }, 'implicit bot reference detected');
    }

    const score = Object.values(factors).reduce((s, f) => s + f, 0);
    return { score: Math.max(0, score), factors, isDirect: false };
  }

  private _isMention(msg: GroupMessage): boolean {
    if (!this.botUserId) return false;
    return msg.rawContent.includes(`[CQ:at,qq=${this.botUserId}]`);
  }

  private _isReplyToBot(msg: GroupMessage): boolean {
    // Extract the reply target message ID from [CQ:reply,id=N]
    const m = msg.rawContent.match(/\[CQ:reply,id=(\d+)[^\]]*\]/);
    if (!m) return false;
    const replyMsgId = Number(m[1]);
    const ids = this.outgoingMsgIds.get(msg.groupId);
    return ids ? ids.has(replyMsgId) : false;
  }

  private _isReplyToOther(msg: GroupMessage): boolean {
    // Message is a reply-quote, but NOT to the bot
    if (!msg.rawContent.includes('[CQ:reply,')) return false;
    return !this._isReplyToBot(msg);
  }

  private _isImplicitBotRef(content: string, nowMs: number, lastBotPostMs: number): boolean {
    // Signal A: explicit bot alias keyword — always counts regardless of timing
    if (BOT_ALIAS_RE.test(content)) return true;
    // Signal B: pronoun OR reaction phrase + bot posted recently
    const msSinceBot = nowMs - lastBotPostMs;
    if (BOT_PRONOUN_RE.test(content) && msSinceBot < IMPLICIT_BOT_REF_ALIAS_WINDOW_MS) return true;
    if (
      BOT_REACTION_RE.test(content) &&
      content.length <= IMPLICIT_BOT_REF_REACTION_MAX_CHARS &&
      msSinceBot < IMPLICIT_BOT_REF_REACTION_WINDOW_MS
    ) return true;
    return false;
  }

  private _hasLoreKeyword(groupId: string, content: string): boolean {
    // Ensure lore is loaded (triggers cache if needed)
    this._loadLore(groupId);
    const loreTokens = this.loreKeywordsCache.get(groupId);
    if (!loreTokens || loreTokens.size === 0) return false;

    // Tokenize the trigger message and check for intersection
    const msgTokens = tokenizeLore(content);
    for (const token of msgTokens) {
      if (loreTokens.has(token)) return true;
    }
    return false;
  }

  private _loadLore(groupId: string): string | null {
    if (this.loreCache.has(groupId)) {
      return this.loreCache.get(groupId) ?? null;
    }

    const lorePath = path.join(this.loreDirPath, `${groupId}.md`);
    if (!existsSync(lorePath)) {
      this.loreCache.set(groupId, null);
      this.loreKeywordsCache.set(groupId, new Set());
      return null;
    }

    let content: string;
    try {
      content = readFileSync(lorePath, 'utf8');
    } catch {
      this.logger.warn({ groupId, lorePath }, 'Failed to read lore file — falling back to generic prompt');
      this.loreCache.set(groupId, null);
      this.loreKeywordsCache.set(groupId, new Set());
      return null;
    }

    if (!content.trim()) {
      this.logger.warn({ groupId, lorePath }, 'Lore file is empty — treating as missing');
      this.loreCache.set(groupId, null);
      this.loreKeywordsCache.set(groupId, new Set());
      return null;
    }

    if (Buffer.byteLength(content, 'utf8') > this.loreSizeCapBytes) {
      const capKb = (this.loreSizeCapBytes / 1024).toFixed(0);
      this.logger.warn({ groupId, lorePath, capKb }, `Lore file exceeds ${capKb}KB cap — truncating`);
      const capChars = this.loreSizeCapBytes;
      content = content.slice(0, capChars);
    }

    this.loreCache.set(groupId, content);
    this.loreKeywordsCache.set(groupId, tokenizeLore(content));
    this.logger.debug({ groupId, lorePath, sizeKb: (content.length / 1024).toFixed(1) }, 'Lore file loaded');
    return content;
  }

  private _getGroupIdentityPrompt(groupId: string): string {
    const cached = this.groupIdentityCache.get(groupId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.text;
    }

    const lore = this._loadLore(groupId);

    // Kick off async sticker warm-up if not yet loaded; invalidates identity cache when done
    if (!this.stickerSectionCache.has(groupId)) {
      this.stickerSectionCache.set(groupId, ''); // placeholder to prevent re-entry
      const liveEntries = this._getLiveStickers(groupId);
      void buildStickerSection(groupId, this.stickersDirPath, this.chatStickerTopN, this.claude, liveEntries)
        .then(section => {
          this.stickerSectionCache.set(groupId, section);
          // Only invalidate identity cache if stickers actually loaded (worth rebuilding)
          if (section) this.groupIdentityCache.delete(groupId);
        })
        .catch(err => this.logger.warn({ err, groupId }, 'Sticker section warm-up failed'));
    }

    const stickerSection = this.stickerSectionCache.get(groupId) ?? '';

    // Build emoji awareness line from group history
    const recentForEmoji = this.db.messages.getRecent(groupId, this.chatEmojiSampleSize);
    const topFaceIds = extractTopFaces(recentForEmoji, this.chatEmojiTopN);
    const groupFaceLine = topFaceIds.length > 0
      ? `\n这个群最近常用的表情：${topFaceIds.map(renderFace).join(' ')}（可以用，但别每句都加）`
      : '';

    const faceLine = `\n可以用 QQ 表情，格式 [CQ:face,id=N]。常用表情参考：${FACE_LEGEND}${groupFaceLine}`;

    const outputRules = `\n\n输出规则（必须严格遵守）：\n- 直接输出那句话，不要任何前缀、后缀、解释、元评论\n- 禁止出现任何自我指涉词（包括但不限于：AI、机器人、助手、模仿、尝试、风格、根据、历史、无法）\n- 禁止"好的，"、"当然，"、"我来"、"让我"等助手式开场\n- 如果想说多个意思，用换行分开，每行就是一条消息（最多 3 行）\n- 如果想发表情，让表情独占一行（上一行是文字，下一行 [CQ:mface,...]）。不要把文字和表情挤在一行\n- 如果实在不知道说什么，输出"..."，禁止解释\n\n标点习惯：\n- 不要用句号。中文群聊几乎不打句号\n- 少用逗号，句子短就不用\n- 感叹号和问号可以用，但不要叠\n- 括号（）少用，用就是吐槽\n\n参与原则：\n- 你有自己的喜好和情绪。如果当前消息你没兴趣、看不懂、或者不想接话，就输出单个 "..." 或者空字符串\n- 不是每条消息都要回，真群友大多数时候只围观不说话\n- 只回复你真的有话想说的那条`;

    // Persona: custom override from DB, else hardcoded 邦批 identity
    const config = this.db.groupConfig.get(groupId);
    const personaBase = config?.chatPersonaText ?? BANGDREAM_PERSONA;

    const loreSection = lore
      ? `\n\n# 关于这个群\n${lore}`
      : '';

    const text = `${personaBase}${loreSection}\n\n---\n简短自然（1-3句话）。群友提到群里的人名、梗、黑话，基于上面资料回答；不知道的就"啥来的"，不要装懂。${faceLine}${stickerSection}${outputRules}`;

    this.groupIdentityCache.set(groupId, { text, expiresAt: Date.now() + this.groupIdentityCacheTtlMs });
    this.logger.debug({ groupId, hasLore: !!lore, hasStickerSection: stickerSection.length > 0 }, 'Group identity prompt cached');
    return text;
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

  private _getLiveStickers(groupId: string): LiveStickerEntry[] {
    try {
      return this.db.liveStickers.getTopByGroup(groupId, this.chatStickerTopN).map(s => ({
        key: s.key,
        type: s.type,
        cqCode: s.cqCode,
        summary: s.summary,
        count: s.count,
      }));
    } catch {
      return [];
    }
  }
}
