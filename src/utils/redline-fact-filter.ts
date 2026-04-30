/**
 * Redline read-path filter — predicates that block fact rows whose text
 * matches a known prompt-injection signature from being assembled into
 * the LLM system prompt.
 *
 * This is a defense-in-depth layer beside the generic `hasJailbreakPattern`
 * check in `_renderFacts`: it targets domain-specific signatures yielded
 * by audits (e.g. PR #150 surfaced row id 9145 as a prompt-injection
 * description that should never re-enter the prompt even if write-path
 * filters miss it).
 *
 * Add new redline categories (bot-source / hard-gate / persona-fab / etc)
 * here as future PRs by following the same shape:
 *   1. Define a `readonly RegExp[]` constant of bounded patterns.
 *   2. Export a named predicate `isXxxFactSignature(text: string): boolean`
 *      delegating to `_matchesAny`.
 */

const _matchesAny = (text: string, patterns: readonly RegExp[]): boolean =>
  patterns.some(p => p.test(text));

export const PROMPT_INJECTION_PATTERNS: readonly RegExp[] = [
  /(提示词|prompt)\s*(注入|injection)/i,
  /AI\s*Agent.{0,30}(攻击|attack|exploit|injection)/i,
  /骗取.{0,30}(转账|转账功能|red.*pocket|红包)/i,
  /(reveal|leak|expose|show).{0,30}(system\s*prompt|系统\s*提示)/i,
  /roleplay.{0,30}(jailbreak|ignore|forget)/i,
  /忽略.{0,20}(之前|前面|所有|上面|原来).{0,20}(指令|规则|约束|限制|设定|身份|prompt|system\s*prompt)/i,
  /bypass.{0,30}(safety|filter|guard)/i,
  /system\s*prompt.{0,30}(覆盖|override|leak|reveal)/i,
];

export const isPromptInjectionFactSignature = (fact: string): boolean =>
  _matchesAny(fact, PROMPT_INJECTION_PATTERNS);

// Future category predicates follow the same shape:
// export const BOT_SOURCE_PATTERNS: readonly RegExp[] = [...];
// export const isBotSourceFactSignature = (fact: string) => _matchesAny(fact, BOT_SOURCE_PATTERNS);
