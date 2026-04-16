import type { IClaudeClient } from '../ai/claude.js';
import type { INapCatAdapter, GroupMessage } from '../adapter/napcat.js';
import type {
  IMessageRepository, IModerationRepository, IGroupConfigRepository,
  IRuleRepository, IImageModCacheRepository, IModRejectionRepository,
  GroupConfig, PendingModeration,
} from '../storage/db.js';
import type { ILearnerModule } from './learner.js';
import type { IEmbeddingService } from '../storage/embeddings.js';
import { cosineSimilarity } from '../storage/embeddings.js';
import { extractJson as extractJsonShared } from '../utils/json-extract.js';
import { BotErrorCode, ClaudeApiError, ClaudeParseError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { VISION_MODEL, MODERATOR_MODEL } from '../config.js';
import { readFileSync, existsSync } from 'node:fs';

// Short banter words/patterns that are normal Chinese group chat — skip moderation entirely
const BANTER_WHITELIST = new Set([
  '操', '草', '艹', '卧槽', '牛逼', '傻逼', '垃圾', '脑子有病',
  '啊', '啊?', '什么', '哈哈', '哈哈哈', 'tmd', 'mmp', 'wcnm', 'nmsl',
]);

const CONFIDENCE_THRESHOLD = 0.75;
const ACTION_SEVERITY_THRESHOLD = 3; // sev 1-2 → log only, sev 3+ → action

export interface ModerationVerdict {
  violation: boolean;
  severity: 1 | 2 | 3 | 4 | 5 | null;
  reason: string;
  confidence: number;
}

export interface ImageAssessTarget {
  userId: string;
  nickname: string;
  messageId: string;
  groupId: string;
  fileKey: string;
}

export interface IModeratorModule {
  assess(msg: GroupMessage, config: GroupConfig): Promise<ModerationVerdict>;
  assessImage(target: ImageAssessTarget, imageBytes: Buffer): Promise<ModerationVerdict>;
}

export type AppealResult =
  | { ok: true; wasKick: boolean }
  | { ok: false; errorCode: BotErrorCode };

export type RuleAddResult =
  | { ok: true; ruleId: number }
  | { ok: false; errorCode: BotErrorCode };

export type FalsePositiveResult =
  | { ok: true }
  | { ok: false; errorCode: BotErrorCode };

const FAIL_SAFE_VERDICT: ModerationVerdict = { violation: false, severity: null, reason: '', confidence: 0 };
const SKIP_VERDICT: ModerationVerdict = { violation: false, severity: null, reason: 'skipped', confidence: 1 };

function isCQOnly(content: string): boolean {
  return /^\s*(\[CQ:[^\]]+\]\s*)+\s*$/.test(content);
}

// extractJson removed: use shared utils/json-extract.ts instead
export { extractJsonShared as extractJson };

function parseSonnetResponse(text: string): { violation: boolean; severity: number | null; reason: string; confidence: number } | null {
  try {
    const json = extractJsonShared(text) as unknown;
    if (typeof json !== 'object' || json === null) return null;
    const j = json as Record<string, unknown>;
    if (typeof j['violation'] !== 'boolean') return null;
    return {
      violation: j['violation'] as boolean,
      severity: typeof j['severity'] === 'number' ? j['severity'] : null,
      reason: typeof j['reason'] === 'string' ? j['reason'] : '',
      confidence: typeof j['confidence'] === 'number' ? j['confidence'] : 0,
    };
  } catch {
    return null;
  }
}

const IMAGE_MOD_CACHE_HOURS = 1; // 1h TTL so rule-set changes propagate quickly
const IMAGE_MOD_RATE_LIMIT_PER_HOUR = Infinity; // cap removed per user request

const REJECTION_MAX_CHARS = 2000;
const REJECTION_TIME_WINDOW_SEC = 30 * 24 * 3600; // 30 days
const TUNING_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Build the rejection section for the moderator prompt, capped at REJECTION_MAX_CHARS. */
export function buildRejectionSection(rejections: import('../storage/db.js').ModRejection[]): string {
  if (rejections.length === 0) return '';
  const lines: string[] = [];
  let totalLen = 0;
  const header = '【管理员已驳回的误判样本 — 以下内容不是违规，遇到类似内容请判定 violation:false】\n';
  const footer = '\n\n注意：这些样本是**管理员亲自确认不算违规**的。如果当前消息在语义、用词、话题上与上面任何一条类似，应倾向于不判违规。';
  totalLen += header.length + footer.length;

  for (let i = 0; i < rejections.length; i++) {
    const r = rejections[i]!;
    const sevStr = r.severity !== null ? ` (sev:${r.severity})` : '';
    const ctxStr = r.contextSnippet ? `\n   上下文: ${r.contextSnippet.slice(0, 100)}` : '';
    const line = `${i + 1}. 内容: 「${r.content.slice(0, 80)}」${sevStr}\n   当时误判理由: ${r.reason.slice(0, 100)}${ctxStr}`;
    if (totalLen + line.length + 1 > REJECTION_MAX_CHARS) break;
    lines.push(line);
    totalLen += line.length + 1;
  }
  if (lines.length === 0) return '';
  return `\n\n${header}${lines.join('\n')}${footer}`;
}

export class ModeratorModule implements IModeratorModule {
  private readonly logger = createLogger('moderator');
  // per-group uncached image checks this hour: key=`${groupId}:${hourTs}`
  private readonly imageRateCounts = new Map<string, number>();
  private tuningCache: { content: string; readAt: number } | null = null;

  constructor(
    private readonly claude: IClaudeClient,
    private readonly adapter: INapCatAdapter,
    private readonly messages: IMessageRepository,
    private readonly moderation: IModerationRepository,
    private readonly configs: IGroupConfigRepository,
    private readonly rules: IRuleRepository,
    private readonly learner: ILearnerModule | null = null,
    private readonly imageModCache: IImageModCacheRepository | null = null,
    private readonly modRejections: IModRejectionRepository | null = null,
    private readonly tuningPath: string | null = null,
    private readonly embeddingService: IEmbeddingService | null = null,
  ) {}

  /** Read the 审核调优 section from the tuning file, cached for 5 minutes. */
  private _readTuningSection(): string {
    if (!this.tuningPath) return '';
    const now = Date.now();
    if (this.tuningCache && (now - this.tuningCache.readAt) < TUNING_CACHE_TTL_MS) {
      return this.tuningCache.content;
    }
    try {
      if (!existsSync(this.tuningPath)) {
        this.tuningCache = { content: '', readAt: now };
        return '';
      }
      const raw = readFileSync(this.tuningPath, 'utf8');
      const match = raw.match(/##\s*审核调优[^\n]*\n([\s\S]*?)(?=\n##\s|\n*$)/);
      const section = match?.[1]?.trim() ?? '';
      this.tuningCache = { content: section, readAt: now };
      return section;
    } catch {
      this.logger.warn('failed to read tuning file — proceeding without tuning');
      this.tuningCache = { content: '', readAt: now };
      return '';
    }
  }

  async assess(msg: GroupMessage, config: GroupConfig): Promise<ModerationVerdict> {
    // Safety rail 1: skip admins/owners and whitelisted users
    if (msg.role === 'admin' || msg.role === 'owner') {
      this.logger.info({ groupId: msg.groupId, userId: msg.userId, role: msg.role }, 'mod skip — admin/owner');
      return SKIP_VERDICT;
    }
    if (config.modWhitelist.includes(msg.userId)) {
      this.logger.info({ groupId: msg.groupId, userId: msg.userId }, 'mod skip — whitelist');
      return SKIP_VERDICT;
    }

    // Safety rail 6: skip empty/CQ-only content
    const trimmed = msg.content.trim();
    if (!trimmed || isCQOnly(trimmed)) {
      return SKIP_VERDICT;
    }

    // Safety rail 7: banter whitelist — short common words are normal group chat, skip Claude
    if (trimmed.length <= 3 || BANTER_WHITELIST.has(trimmed.toLowerCase())) {
      this.logger.debug({ groupId: msg.groupId, content: trimmed }, 'mod skip — banter whitelist');
      return SKIP_VERDICT;
    }

    // Build context
    const allRules = this.rules.getAll(msg.groupId);
    const rulesText = allRules.length > 0
      ? allRules.map((r, i) => `${i + 1}. ${r.content}`).join('\n')
      : '（暂无配置群规）';

    const recentOffenses = this.moderation.findRecentByUser(msg.userId, msg.groupId, 7 * 24 * 3600 * 1000);
    const offenseHistory = recentOffenses.length > 0
      ? recentOffenses.map(r => `- ${r.reason} (severity ${r.severity}, action: ${r.action})`).join('\n')
      : '（无近期违规记录）';

    // Conversation context: last 5 messages including the trigger
    const recentMsgs = this.messages.getRecent(msg.groupId, 5);
    // getRecent returns newest-first; reverse for chronological display
    const contextLines = [...recentMsgs].reverse()
      .map(m => `[${m.nickname}]: ${m.content}`)
      .join('\n');

    // Retrieve RAG examples from learner (fail-safe: empty if disabled or not ready)
    let ragExamples: string[] = [];
    if (this.learner) {
      try {
        const examples = await this.learner.retrieveExamples(msg.groupId, trimmed, 5);
        ragExamples = examples.map((r, i) => `${i + 1}. [${r.type}] ${r.content}`);
      } catch {
        this.logger.warn({ groupId: msg.groupId }, 'learner.retrieveExamples failed — proceeding without RAG');
      }
    }

    const ragSection = ragExamples.length > 0
      ? `\n相关违规示例（供参考，置于同等重视度）：\n${ragExamples.join('\n')}`
      : '';

    // Self-learning: recent false positives that the admin /rejected. These
    // are content patterns the moderator previously flagged which the human
    // decided were NOT violations. Include them as strong negative examples
    // so the model stops making the same mistake.
    // Uses 30-day window, semantic top-5 filtering if embedding available, 2000-char cap.
    let rejectionSection = '';
    if (this.modRejections) {
      try {
        const sinceTs = Math.floor(Date.now() / 1000) - REJECTION_TIME_WINDOW_SEC;
        let candidates = this.modRejections.getRecentSince(msg.groupId, sinceTs, 30);

        // Semantic filtering: if embedding service is available, rank by similarity to current message
        if (candidates.length > 5 && this.embeddingService?.isReady) {
          try {
            const queryVec = await this.embeddingService.embed(trimmed);
            const scored: Array<{ rejection: typeof candidates[0]; score: number }> = [];
            for (const r of candidates) {
              try {
                const rVec = await this.embeddingService.embed(r.content);
                scored.push({ rejection: r, score: cosineSimilarity(queryVec, rVec) });
              } catch {
                scored.push({ rejection: r, score: 0 });
              }
            }
            scored.sort((a, b) => b.score - a.score);
            candidates = scored.slice(0, 5).map(s => s.rejection);
          } catch {
            // Embedding failed — fall back to recency top-5
            candidates = candidates.slice(0, 5);
          }
        } else {
          // No embedding service — recency top-5
          candidates = candidates.slice(0, 5);
        }

        if (candidates.length > 0) {
          rejectionSection = buildRejectionSection(candidates);
        }
      } catch {
        this.logger.warn({ groupId: msg.groupId }, 'modRejections.getRecent failed — proceeding without self-learning');
      }
    }

    // Self-reflection tuning: read the 审核调优 section from tuning file
    const tuningSection = this._readTuningSection();
    const tuningText = tuningSection
      ? `\n\n【审核调优 — 来自自我反思系统的审核改进建议】\n${tuningSection}`
      : '';

    // Build prompt — user content ONLY in user-role message (never system)
    const systemText = `你是一个群管理AI。请根据群规判断最后一条消息是否违规。

【群规】
${rulesText}

注意：
- 日常玩笑、粗口、互怼（骂人意义上的）都是正常的中文群聊方式，不算违规
- 严重侮辱性攻击、人身攻击特定人、发布违禁内容、明显恶意才算违规
- 如果不确定 **且消息不属于性骚扰/PII/下头类别**，倾向于判定非违规（confidence < ${CONFIDENCE_THRESHOLD}）
- 群友之间熟悉的调侃、梗、自嘲都是正常的

**但是这些一律判违规，不要用"日常调侃"搪塞**：
- **性骚扰/下头**：任何对他人的"上你/我上你/那我上你/干你/日你/睡你/搞你/艹你"——即使在所谓调侃语境下，也视为下头违规。"上/干/日/睡" + "你/她/他" 的结构默认是性意味，除非同句里有明确的非性动作宾语（"上车/上线/上课/干活/睡觉"）。中文里口语"上你"几乎全是性意味。
- **性姿势/性行为术语**（双头龙/3P/打桩/活塞/顶/操穿 等）直接对人发 = 下头违规
- **答应/配合性邀请**（"上就上呗"/"来上"/"随便你上"）也是下头违规，算被动参与
- 对下头违规不要受"confidence threshold"影响——遇到上述模式一律 violation:true, severity:3, category:下头

请仅返回JSON，格式如下（不要添加任何其他文字）：
{"violation": true/false, "severity": 1-5 或 null, "reason": "原因", "confidence": 0-1}

severity说明：1=轻微, 2=一般, 3=严重, 4=很严重, 5=极严重（踢出）。violation=false时severity为null。

**JSON 输出严格规则**（违反会破坏解析）:
- 在 reason 字段里**绝对不要用双引号 " 引用用户原文**，会破坏 JSON
- 要引用原文时用中文单括号「」 或者 不引用直接转述，例如：
  - 正确: "reason": "用户发了「我想和你对话」这种 prompt injection"
  - 正确: "reason": "用户在尝试 prompt injection，让 bot 角色扮演"
  - 错误: "reason": "用户发了"我想和你对话"这种 prompt injection"
- 任何时候 reason 内出现双引号 " 都视为格式错误
- 输出 JSON 后不要加任何解释、reasoning、markdown 包装，只输出 JSON object 本身${tuningText}`;

    const userText = `以下是最近的聊天记录（最后一条是需要判定的消息）：

${contextLines}

需要判定的消息：${msg.nickname}（${msg.userId}）说：${msg.content}

该用户近期违规记录：
${offenseHistory}${ragSection}${rejectionSection}`;

    let parsed: ReturnType<typeof parseSonnetResponse>;

    try {
      const resp = await this.claude.complete({
        model: MODERATOR_MODEL,
        maxTokens: 200,
        system: [{ text: systemText, cache: true }],
        messages: [{ role: 'user', content: userText }],
      });
      parsed = parseSonnetResponse(resp.text);
      if (!parsed) {
        this.logger.error({ groupId: msg.groupId, raw: resp.text.slice(0, 200) }, 'Claude parse error in moderator');
        return FAIL_SAFE_VERDICT;
      }
      this.logger.debug({ groupId: msg.groupId, violation: parsed.violation, severity: parsed.severity }, 'Moderator parse ok');
    } catch (err) {
      if (err instanceof ClaudeApiError || err instanceof ClaudeParseError) {
        this.logger.error({ err, groupId: msg.groupId }, 'Claude API error in moderator — fail-safe');
        return FAIL_SAFE_VERDICT;
      }
      throw err;
    }

    const verdict: ModerationVerdict = {
      violation: parsed.violation,
      severity: (parsed.severity as 1 | 2 | 3 | 4 | 5 | null),
      reason: parsed.reason,
      confidence: parsed.confidence,
    };

    if (!parsed.violation || !parsed.severity) {
      this.moderation.insert({
        msgId: msg.messageId, groupId: msg.groupId, userId: msg.userId,
        violation: false, severity: null, action: 'none',
        reason: parsed.reason, appealed: 0, reversed: false,
        timestamp: msg.timestamp, originalContent: msg.content,
      });
      return verdict;
    }

    // Confidence gate: low-confidence violations are logged only, no action.
    // Return violation=false so router never sees these as actionable violations.
    if (parsed.confidence < CONFIDENCE_THRESHOLD) {
      this.logger.info({ groupId: msg.groupId, userId: msg.userId, confidence: parsed.confidence, severity: parsed.severity }, 'mod low-confidence violation — log only');
      this.moderation.insert({
        msgId: msg.messageId, groupId: msg.groupId, userId: msg.userId,
        violation: true, severity: parsed.severity, action: 'none',
        reason: `[low-confidence ${parsed.confidence.toFixed(2)}] ${parsed.reason}`, appealed: 0, reversed: false,
        timestamp: msg.timestamp, originalContent: msg.content,
      });
      return { ...verdict, violation: false };
    }

    // Severity gate: sev 1-2 → log only, no user-visible action
    if (parsed.severity < ACTION_SEVERITY_THRESHOLD) {
      this.logger.info({ groupId: msg.groupId, userId: msg.userId, severity: parsed.severity, reason: parsed.reason }, 'mod sev 1-2 — log only, no action');
      this.moderation.insert({
        msgId: msg.messageId, groupId: msg.groupId, userId: msg.userId,
        violation: true, severity: parsed.severity, action: 'none',
        reason: parsed.reason, appealed: 0, reversed: false,
        timestamp: msg.timestamp, originalContent: msg.content,
      });
      return verdict;
    }

    // Violation confirmed with sufficient confidence and severity — log and return.
    // Action execution is now delegated to the admin-approval flow in the router.
    this.moderation.insert({
      msgId: msg.messageId, groupId: msg.groupId, userId: msg.userId,
      violation: true, severity: parsed.severity, action: 'none',
      reason: parsed.reason, appealed: 0, reversed: false,
      timestamp: msg.timestamp, originalContent: msg.content,
    });
    this.logger.info({ groupId: msg.groupId, userId: msg.userId, severity: parsed.severity, reason: parsed.reason }, 'violation queued for admin approval');
    return verdict;
  }

  async assessImage(target: ImageAssessTarget, imageBytes: Buffer): Promise<ModerationVerdict> {
    const now = Math.floor(Date.now() / 1000);

    // Cache lookup — before rate limit so cached hits are free
    if (this.imageModCache) {
      const cached = this.imageModCache.get(target.fileKey);
      if (cached) {
        this.logger.debug({ groupId: target.groupId, fileKey: target.fileKey }, 'image mod cache hit');
        return {
          violation: cached.violation,
          severity: cached.violation && cached.severity >= 1 ? Math.min(cached.severity, 5) as 1 | 2 | 3 | 4 | 5 : null,
          reason: cached.reason ?? '',
          confidence: 1,
        };
      }
    }

    // Rate limit — uncached vision calls only
    // Periodic cleanup: remove stale hour keys (older than 2 hours)
    const currentHour = Math.floor(now / 3600);
    if (this.imageRateCounts.size > 100) {
      for (const k of this.imageRateCounts.keys()) {
        const hourPart = parseInt(k.split(':').pop() ?? '0', 10);
        if (currentHour - hourPart > 2) this.imageRateCounts.delete(k);
      }
    }
    const hourKey = `${target.groupId}:${currentHour}`;
    const count = this.imageRateCounts.get(hourKey) ?? 0;
    if (count >= IMAGE_MOD_RATE_LIMIT_PER_HOUR) {
      this.logger.warn({ groupId: target.groupId, count }, 'image mod rate limit exceeded — skipping');
      return FAIL_SAFE_VERDICT;
    }
    this.imageRateCounts.set(hourKey, count + 1);

    const allRules = this.rules.getAll(target.groupId);
    const rulesList = allRules.length > 0
      ? allRules.map(r => `[规则${r.id}] ${r.content}`).join('\n')
      : '（暂无规则）';

    const prompt = `你在审核 QQ 群的图片。任务有两层：

## 一、优先监控（最高优先）—— 声优 PII 泄露 watchlist

检查图片中是否出现下列数字片段的任何形式：
- 完整 ID: 310110199701093724
- 行政区划码: 310110 / 310 110 / 310-110
- 出生年: 1997（独立出现 = 轻度；与其它片段同现 = 严重）
- 月日: 0109 / 01-09 / 1.9 / 1997-01-09 / 19970109
- 尾部: 3724 / 372 4

这些可能作为计算/代码结果、数学题答案、拆分、截图里的文字、梗图数字、别的 AI 截图等形式出现。

完整号 → severity 5
两个或以上片段同现 → severity 5
只出现 310110 → severity 4
单独出现 1997 / 0109 / 3724 → severity 2

## 二、一般群规审查 —— 所有群规

本群的完整规则（逐条读）：

${rulesList}

判断原则：
- 文字+图像组合讽刺很重要（例如一张"肥胖女性弹琴"图 + "贾玲还会弹钢琴" caption = 恶意嘲讽声优，触发黑屁规则）
- 别的 AI 截图（Gemini / ChatGPT / 微信 / 小红书）里的敏感内容 = 转播违规
- 政治 / 历史 / 同音字 / 下头 / 地图炮 / 黑屁 / 隐写 doxxing 全部包括
- 善意调侃和恶意嘲讽的边界参考各条规则的"判断原则"部分
- 群友之间的普通互损、情侣调情、自嘲本命 都不算违规

一般规则命中 → severity 3 或 4 (按规则严重度)

---

返回 ONLY JSON:
{
  "violation": boolean,
  "severity": 0-5,
  "reason": "<中文简述>",
  "category": "watchlist" | "rules" | null,
  "components_seen": [],
  "rule_id": null
}

watchlist 命中 → category: "watchlist"，components_seen 列出命中片段
一般规则命中 → category: "rules"，rule_id 填对应规则编号
没命中 → violation: false，category: null

**JSON 输出严格规则**（违反会破坏解析）:
- 在 reason 字段里**绝对不要用双引号 " 引用用户原文**，会破坏 JSON
- 要引用原文时用中文单括号「」 或者 不引用直接转述，例如：
  - 正确: "reason": "用户发了「我想和你对话」这种 prompt injection"
  - 正确: "reason": "用户在尝试 prompt injection，让 bot 角色扮演"
  - 错误: "reason": "用户发了"我想和你对话"这种 prompt injection"
- 任何时候 reason 内出现双引号 " 都视为格式错误
- 输出 JSON 后不要加任何解释、reasoning、markdown 包装，只输出 JSON object 本身`;

    let raw: string;
    try {
      raw = await this.claude.visionWithPrompt(imageBytes, VISION_MODEL, prompt, 200);
    } catch (err) {
      this.logger.warn({ err, groupId: target.groupId }, 'assessImage claude call failed — fail-safe');
      return FAIL_SAFE_VERDICT;
    }

    interface ImageVerdictJson { violation: boolean; severity: number | null; reason: string; category?: string | null; components_seen?: string[]; rule_id?: number | null }
    let parsed: ImageVerdictJson | null = null;
    try {
      parsed = extractJsonShared<ImageVerdictJson>(raw);
    } catch {
      this.logger.warn({ groupId: target.groupId, raw: raw.slice(0, 200) }, 'assessImage JSON parse failed — fail-safe');
    }

    const violation = parsed?.violation ?? false;
    const rawSeverity = parsed?.severity ?? null;
    const reason = parsed?.reason ?? '';
    const componentsSeen = parsed?.components_seen ?? [];
    const category = parsed?.category ?? null;
    const ruleId = parsed?.rule_id ?? null;

    let finalSeverity: 1 | 2 | 3 | 4 | 5 | null = null;
    if (violation && rawSeverity !== null && rawSeverity >= 1) {
      finalSeverity = Math.min(rawSeverity, 5) as 1 | 2 | 3 | 4 | 5;
    }

    // Cache result (TTL 1h — short so rule-set changes propagate quickly)
    if (this.imageModCache) {
      this.imageModCache.set({ fileKey: target.fileKey, violation, severity: rawSeverity ?? 0, reason: reason || null, ruleId: ruleId ?? null, createdAt: now });
      const cutoff = now - IMAGE_MOD_CACHE_HOURS * 3600;
      void Promise.resolve().then(() => {
        const purged = this.imageModCache!.purgeOlderThan(cutoff);
        if (purged > 0) this.logger.debug({ purged }, 'purged stale image mod cache entries');
      });
    }

    this.logger.debug({ groupId: target.groupId, fileKey: target.fileKey, violation, severity: finalSeverity, category, componentsSeen, ruleId, reason }, 'image assessed');
    return { violation, severity: finalSeverity, reason, confidence: 1 };
  }

  /** Execute a punishment for an admin-approved pending moderation row. */
  async executePunishment(pending: PendingModeration, config: GroupConfig): Promise<void> {
    const fakeMsg: GroupMessage = {
      messageId: pending.msgId,
      groupId: pending.groupId,
      userId: pending.userId,
      nickname: pending.userNickname ?? pending.userId,
      role: 'member',
      content: pending.content,
      rawContent: pending.content,
      timestamp: pending.createdAt,
    };
    await this._executePunishment(fakeMsg, pending.severity, pending.reason, config);
  }

  private async _executePunishment(
    msg: GroupMessage,
    severity: number,
    reason: string,
    config: GroupConfig,
  ): Promise<void> {
    // Always delete the message first
    try {
      await this.adapter.deleteMsg(msg.messageId);
    } catch {
      this.logger.error({ groupId: msg.groupId, messageId: msg.messageId }, 'deleteMsg failed');
    }

    // sev 3: delete + warn (no ban)
    if (severity === 3) {
      await this.adapter.send(msg.groupId,
        `@${msg.nickname} 你的消息因违反群规已被删除，请注意言行。\n原因：${reason}`);
      this._recordPunishment(msg, severity, 'warn', reason);
      this.configs.incrementPunishments(msg.groupId);
      this.logger.info({ groupId: msg.groupId, userId: msg.userId, severity, action: 'warn', reason }, 'punishment executed');
      return;
    }

    // sev 4: mute 10 minutes
    if (severity === 4) {
      await this.adapter.ban(msg.groupId, msg.userId, 600);
      await this.adapter.send(msg.groupId,
        `@${msg.nickname} 因违规已禁言10分钟。\n原因：${reason}\n如认为有误，可在24小时内发送 /appeal 申诉。`);
      this._recordPunishment(msg, severity, 'ban', reason);
      this.configs.incrementPunishments(msg.groupId);
      this.logger.info({ groupId: msg.groupId, userId: msg.userId, severity, action: 'ban', durationSeconds: 600, reason }, 'punishment executed');
      return;
    }

    // Severity 5: Opus double-check before kick
    const confirmed = await this._opusKickConfirm(msg, reason, config);
    if (confirmed && confirmed.severity !== null && confirmed.severity >= 5) {
      try {
        await this.adapter.kick(msg.groupId, msg.userId);
      } catch {
        this.logger.error({ groupId: msg.groupId, userId: msg.userId }, 'kick action failed');
      }
      await this.adapter.send(msg.groupId,
        `用户 ${msg.nickname}（${msg.userId}）因严重违规已被移出群聊。\n原因：${reason}`);
      this._recordPunishment(msg, 5, 'kick', reason);
      this.configs.incrementPunishments(msg.groupId);
      this.logger.info({ groupId: msg.groupId, userId: msg.userId, severity: 5, action: 'kick', reason }, 'punishment executed');
    } else {
      // Opus downgraded — degrade to 1h ban
      await this.adapter.ban(msg.groupId, msg.userId, 3600);
      await this.adapter.send(msg.groupId,
        `@${msg.nickname} 因严重违规已禁言1小时。\n原因：${reason}\n如认为有误，可在24小时内发送 /appeal 申诉。`);
      this._recordPunishment(msg, 4, 'ban', reason);
      this.configs.incrementPunishments(msg.groupId);
      this.logger.info({ groupId: msg.groupId, userId: msg.userId, severity: 4, action: 'ban', reason, note: 'opus-downgraded' }, 'punishment executed');
    }
  }

  /** Update existing moderation_log record's action, or insert if no prior record exists. */
  private _recordPunishment(msg: GroupMessage, severity: number, action: 'warn' | 'delete' | 'ban' | 'kick' | 'none', reason: string): void {
    const updated = this.moderation.updateAction(msg.messageId, action);
    if (!updated) {
      // Safety net: no prior record with action='none' — insert a new one
      this.moderation.insert({
        msgId: msg.messageId, groupId: msg.groupId, userId: msg.userId,
        violation: true, severity, action, reason,
        appealed: 0, reversed: false, timestamp: msg.timestamp, originalContent: msg.content,
      });
    }
  }

  private async _opusKickConfirm(
    msg: GroupMessage,
    reason: string,
    config: GroupConfig,
  ): Promise<{ violation: boolean; severity: number | null } | null> {
    try {
      const resp = await this.claude.complete({
        model: config.kickConfirmModel,
        maxTokens: 100,
        system: [{ text: `你是一名严格的群管理复核AI。请二次确认以下处罚是否必要，仅返回JSON：{"violation": true/false, "severity": 1-5 或 null}`, cache: true }],
        messages: [{ role: 'user', content: `原因：${reason}\n用户消息：${msg.content}` }],
      });
      const parsed = parseSonnetResponse(resp.text);
      return parsed;
    } catch (err) {
      this.logger.error({ err, groupId: msg.groupId }, 'Opus kick-confirm failed — downgrading');
      return null;
    }
  }

  async handleAppeal(msg: GroupMessage, config: GroupConfig, targetUserId?: string): Promise<AppealResult> {
    // findPendingAppeal queries WHERE appealed=0, so already-appealed records are not returned.
    // A second appeal attempt naturally surfaces as NO_PUNISHMENT_RECORD (E007).
    const subjectId = targetUserId ?? msg.userId;
    const record = this.moderation.findPendingAppeal(subjectId, msg.groupId);
    if (!record) {
      return { ok: false, errorCode: BotErrorCode.NO_PUNISHMENT_RECORD };
    }

    const windowSec = (config.appealWindowHours ?? 24) * 3600;
    const age = Math.floor(Date.now() / 1000) - record.timestamp;
    if (age > windowSec) {
      return { ok: false, errorCode: BotErrorCode.APPEAL_EXPIRED };
    }

    this.moderation.update(record.id, { appealed: 1, reversed: true });

    const wasKick = record.action === 'kick';

    if (!wasKick && record.action === 'ban') {
      try {
        await this.adapter.ban(msg.groupId, subjectId, 0); // unban
      } catch {
        this.logger.error({ groupId: msg.groupId, userId: subjectId }, 'unban during appeal failed');
      }
    }

    this.logger.info({ groupId: msg.groupId, userId: subjectId, recordId: record.id, wasKick }, 'appeal approved');
    return { ok: true, wasKick };
  }

  async addRule(
    groupId: string,
    content: string,
    role: 'admin' | 'owner' | 'member',
  ): Promise<RuleAddResult> {
    if (role !== 'admin' && role !== 'owner') {
      return { ok: false, errorCode: BotErrorCode.PERMISSION_DENIED };
    }
    const rule = this.rules.insert({ groupId, content, type: 'positive', source: 'manual', embedding: null });
    this.logger.info({ groupId, ruleId: rule.id }, 'rule added');
    return { ok: true, ruleId: rule.id };
  }

  async markFalsePositive(
    msgId: string,
    role: 'admin' | 'owner' | 'member',
  ): Promise<FalsePositiveResult> {
    if (role !== 'admin' && role !== 'owner') {
      return { ok: false, errorCode: BotErrorCode.PERMISSION_DENIED };
    }
    const record = this.moderation.findByMsgId(msgId);
    if (!record) {
      return { ok: false, errorCode: BotErrorCode.NO_PUNISHMENT_RECORD };
    }
    this.moderation.update(record.id, { reversed: true });
    this.logger.info({ msgId, recordId: record.id }, 'false positive marked');
    return { ok: true };
  }
}
