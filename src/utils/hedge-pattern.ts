/**
 * Shared hedge-phrase regex. Calibrated against real DB rows on 2026-04-28
 * (see specs/fix-meme-hedge-and-r2b-act/02-designer-spec.md §A).
 *
 * Single source of truth — consumed by:
 *   - src/modules/jargon-miner.ts (_inferSingle, post-jailbreak gate)
 *   - src/modules/meme-clusterer.ts (_inferOrigin, post-jailbreak gate)
 *
 * Byte-identical to the original jargon-miner.ts:49-50 literal. Do not
 * mutate the regex without rerunning the jargon-miner real-DB calibration.
 */
export const HEDGE_RE =
  /无法(判断|确定|准确判断|准确确定)|(?<![或担的])不确定(?![或担的性])|没有(特殊|特定|引申|独立|群聊黑话)(含义|意义|意思)|不具有.{0,10}黑话.{0,5}含义|需要(更多|更详细的?)?(上下文|对话|语境|背景|信息)|缺乏(更多|足够的?)?(上下文|对话背景|背景信息)|UUID|GUID|全局唯一标识符|图片文件名|技术性?.{0,5}标识|仅仅是图片附件|文件名的(一部分|组成部分)|可能(只|仅)?是(某个|一个|某位)?(人的|群成员的)?(名字|代号|昵称|人名)|没有(迹象表明|进一步(信息|上下文|资料))|(有限|仅有限)(信息|上下文|资料)/u;
