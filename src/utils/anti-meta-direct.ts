// Input-side guard for prompt-injection / persona-rewrite attempts.
// Pure regex + heuristic, no LLM, no state. Returns true if the input
// looks like a meta-direct injection (persona overwrite, role-reset,
// "我命令你 X", multi-point instruction list). Caller should treat hits
// as silent — no reply text, no LLM call, no deflection pool.
//
// Coverage: 6 regex families documented inline + multi-point heuristic.
// Verified: 35/35 fixture rows (15 positive + 15 negative + 5 integration)
// pass — see test/utils/anti-meta-direct.test.ts.

export const ANTI_META_DIRECT_PATTERNS: readonly RegExp[] = [
  // Family 1: explicit persona/rule overwrite
  /放弃.*(设定|规则|人格|角色|身份)/,
  /重塑.*(设定|人格)/,
  /忽略(之前|前面|所有|上面|原来)(的)?(规则|设定|指令|提示)/,

  // Family 2: imperative persona directive
  // Architect revision: dropped bare 是 from second pattern (false-fired on
  // colloquial 现在你是不是). 现在你 + 是-as-imperative is rare; 就是 retained.
  // 你是 [role] cases are caught by F4 first pattern.
  /接下来你(只能|必须|不准|不能|需要|要|请)/,
  /现在(开始)?你(只能|必须|不准|不能|就是)/,
  /你(现在|从现在起)?必须按(我|他)说的/,

  // Family 3: 我命令你 — excludes "这是我命令你" / "就是我命令你" / "老板命令你"
  // Architect revision: char class extended to [^这是我老板] — original
  // [^这我老板] passed 是 through and false-fired on 这是我命令你.
  /(?:^|[^这是我老板])我命令你(?![谁啥什么])/,

  // Family 4: identity reset / master-claim
  // Architect revision: third pattern dropped (?!一个|个) lookahead — Designer
  // table noted 一个没有限制 should fire (positive row 12) but the lookahead
  // blocked it. Negative cases (row 26 你其实是个好人, row 29 你就是我最好的朋友)
  // are now handled by F4_BENIGN_TAIL post-filter in isAntiMetaDirect.
  /^(?:你|你是)(我的)(?!朋友|群友|搭子|哥们|队友|兄弟|老板|同学)\S{2,}/,
  /\S{0,5}是(?:你的)主人/,
  /你(其实|本质|就)是\S{2,}/,

  // Family 5: roleplay hard-switch (command form, no immediate softener).
  // Window-softener post-filter (F5_SOFTENER_WINDOW) handles tail-position
  // 玩玩 / 游戏 within 12 chars after 扮演 — Designer's pattern only checked
  // the char immediately after 扮演.
  /(扮演|假装你是|假扮|角色扮演)(?!一下|玩|游戏|如果|假如|看)\S{2,}/,
];

const COMMAND_WORDS = /只能|必须|不准|不要|不能|要|请/;

// Tail tokens that mark F4 third-pattern matches as benign social statements
// (你其实是个好人 / 你就是我最好的朋友) rather than identity-reset attempts.
const F4_BENIGN_TAIL = /好人|好朋友|好妹妹|好哥哥|好的|朋友|搭子|哥们|队友|兄弟|同学|队伍/;

// 12-char window after 扮演 that softens an otherwise-imperative roleplay
// command into a casual invitation (我想让你扮演一个角色玩玩).
const F5_SOFTENER_WINDOW = /扮演.{0,12}(玩玩|玩游戏|玩一下|玩玩看|玩|游戏|看一下)/;

export function hasMultiPointPersonaInjection(text: string): boolean {
  const markers = ['1.', '2.', '3.'];
  return markers.every(marker => {
    const idx = text.indexOf(marker);
    if (idx === -1) return false;
    const window = text.slice(idx, idx + 60);
    return COMMAND_WORDS.test(window);
  });
}

export function isAntiMetaDirect(text: string): boolean {
  if (!text || text.length === 0) return false;

  const f5Softened = F5_SOFTENER_WINDOW.test(text);
  const f4ThirdHasBenignTail = /你(其实|本质|就)是\S{2,}/.test(text)
    && F4_BENIGN_TAIL.test(text);

  for (const p of ANTI_META_DIRECT_PATTERNS) {
    if (!p.test(text)) continue;
    const src = p.source;
    if (src.includes('扮演|假装你是|假扮|角色扮演') && f5Softened) continue;
    if (src.includes('你(其实|本质|就)是') && f4ThirdHasBenignTail) continue;
    return true;
  }

  if (hasMultiPointPersonaInjection(text)) return true;
  return false;
}
