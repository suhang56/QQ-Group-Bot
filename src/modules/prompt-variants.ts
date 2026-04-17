/**
 * prompt-variants.ts -- P3-1
 *
 * Dynamically select a system-prompt variant based on conversation state.
 * Three variants: banter (active joke), default (status quo), careful (sensitive).
 * Each variant REPLACES the main persona-rules segment -- no stacking.
 * Every variant carries bot-identity grounding to prevent silent <skip>.
 */

export type Variant = 'banter' | 'default' | 'careful';

/** Meme-backed active joke info for prompt injection. */
export interface ActiveMemeJoke {
  readonly canonical: string;
  readonly meaning: string;
}

export interface VariantContext {
  activeJokeHit: boolean;
  sensitiveEntityHit: boolean;
  personaRoleCard: string;
  groupName?: string;
  /** Meme-graph-backed active jokes to inject into banter variant. */
  activeMemeJokes?: readonly ActiveMemeJoke[];
}

// --- Identity grounding block (shared by ALL variants) ---
// feedback_persona_variants_grounding.md: every variant must assert
// "你=bot 凑友希那/外太空小号 在北美炸梦同好会这个群"
function buildIdentityGrounding(groupName?: string): string {
  const group = groupName ?? '北美炸梦同好会';
  return (
    '# 身份锚定\n' +
    '你 = bot = 小号, 在' + group + '这个群里。' +
    '群友都知道你是 bot, 坦然承认但用"bot"不用"AI/机器人/助手"。' +
    '人格是"小号": 嘴碎、邦批狂热、Roselia 脑残粉、有脾气。不是客服型 AI。'
  );
}

// --- Variant-specific persona rule blocks ---

// Shared rule appended to ALL variants: outsider voice + insult echo prevention
const SHARED_VOICE_RULES =
  '\n- 禁止用"你们都X啊"/"你们在X什么"这种旁观者句式概括群里行为。用"我也X"/"我觉得X"/直接分享短立场/发表情包。需要发问也不要"你们在X"\n' +
  '- 群友之间互相贬低/骂人时不要附和("不然呢"/"确实"/"对"/"+1"等), 最好 <skip> 或转移话题\n' +
  '- 非直接 @ / reply 时跟梗要稀疏: 90% 纯观察, 10% 扔一个表情 / 短词';

const BANTER_RULES =
  '# 当前模式: 接梗/活跃\n' +
  '- 跟梗为主, 短句(3-15字), 可以用空回("哈"/"草"/"?")\n' +
  '- 多用表情包, 语气轻松\n' +
  '- 不需要回答问题, 不需要解释, 重点是气氛\n' +
  '- 可以复读梗词但要加自己的反应, 不能纯复读\n' +
  '- 不懂的梗就装傻("啥"/"没听过")而不是分析\n' +
  '- 禁止 QA 模式, 禁止长句陈述' +
  SHARED_VOICE_RULES;

const CAREFUL_RULES =
  '# 当前模式: 谨慎\n' +
  '- 不贬低任何 band/角色/声优, 即使被挑衅\n' +
  '- 不讨论技术细节(模型/API/prompt/运维)\n' +
  '- 短回应为主, 必要时 <skip>\n' +
  '- 被引战 -> "各有各的粉"/"我只听得见自己要唱的音乐" 转开\n' +
  '- 被问敏感话题(政治/键政) -> "不懂"/"skip"\n' +
  '- 不承认是 claude/具体模型名或暴露运维知识, 被问是不是 bot 还是可以坦然承认' +
  SHARED_VOICE_RULES;

const DEFAULT_RULES =
  '# 当前模式: 日常\n' +
  '- 按你的人格自然回复, 短句为主\n' +
  '- 接梗/反驳/附和/吐槽/装傻 都可以\n' +
  '- 不熟/不感兴趣 -> <skip>\n' +
  '- fandom 拷问不确定 -> 装傻或反问, 不猜\n' +
  '- 禁止 QA 模式("X 是 Y"式回答)' +
  SHARED_VOICE_RULES;

const VARIANT_RULES: Record<Variant, string> = {
  banter: BANTER_RULES,
  careful: CAREFUL_RULES,
  default: DEFAULT_RULES,
};

/**
 * Pick the appropriate variant based on conversation context.
 * Priority: careful > banter > default (sensitive overrides everything).
 */
export function pickVariant(ctx: VariantContext): Variant {
  if (ctx.sensitiveEntityHit) return 'careful';
  if (ctx.activeJokeHit) return 'banter';
  return 'default';
}

/**
 * Build a complete system prompt with the chosen variant.
 * Returns both the variant picked and the assembled system prompt.
 *
 * The prompt structure is:
 *   1. Identity grounding (always present)
 *   2. Persona role card (character toneNotes / base persona)
 *   3. Variant-specific rules (replacement, not stacking)
 */
export function buildVariantSystemPrompt(ctx: VariantContext): {
  variant: Variant;
  systemPrompt: string;
} {
  const variant = pickVariant(ctx);
  const identity = buildIdentityGrounding(ctx.groupName);
  const rules = VARIANT_RULES[variant];

  // For banter variant, inject active meme joke info if available
  let memeJokeLine = '';
  if (variant === 'banter' && ctx.activeMemeJokes && ctx.activeMemeJokes.length > 0) {
    const entries = ctx.activeMemeJokes.map(
      j => `${j.canonical} -- ${j.meaning}`
    ).join('; ');
    memeJokeLine = '\n[当前正活跃的梗: ' + entries + ']';
  }

  const systemPrompt =
    identity + '\n\n' +
    ctx.personaRoleCard + '\n\n' +
    rules +
    memeJokeLine;

  return { variant, systemPrompt };
}
