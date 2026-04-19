const AT_FALLBACK_POOLS = {
  request: ['不想', '不帮', '想啥呢', '做梦', '别闹', '想得美', '不干', '不不不'],
  question: ['不知道', '不清楚', '别问我', '懒得想', '问别人', '谁知道'],
  exclaim: ['嗯', '哦', '好', '收到', '行吧'],
  generic: ['啊?', '咋了', '啥事', '?', '怎么了', '叫我干嘛', '什么'],
} as const;

const requestRE = /^(@\S+\s*)?(帮|给我|替我|你来|快|去).+(吗|呀|啊|吧)?[。！!.]?$|霸凌|整|骂|教训|欺负/;
const questionRE = /[?？]|(怎么|为啥|为什么|咋|什么|哪|谁|几|多少).*[?？]?$/;
const exclaimRE = /[!！]$|好棒|牛|笑死|哈哈/;

export function pickAtFallback(triggerText: string): string {
  const pool = requestRE.test(triggerText) ? AT_FALLBACK_POOLS.request
             : questionRE.test(triggerText) ? AT_FALLBACK_POOLS.question
             : exclaimRE.test(triggerText) ? AT_FALLBACK_POOLS.exclaim
             : AT_FALLBACK_POOLS.generic;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

export function classifyAtFallbackReason(triggerText: string): 'low-comprehension-direct' | 'bot-blank-needed-ack' {
  if (requestRE.test(triggerText) || questionRE.test(triggerText) || exclaimRE.test(triggerText)) {
    return 'low-comprehension-direct';
  }
  return 'bot-blank-needed-ack';
}
