/**
 * Text tokenization utilities for lore matching and topic tracking.
 * Extracted from chat.ts to break the circular dependency with lore-retrieval.ts.
 */

// Chinese stopwords that add no retrieval signal
const STOPWORDS = new Set([
  '我','你','他','她','它','我们','你们','他们','的','了','是','不','啥','什么',
  '怎么','一个','这个','那个','就','也','都','在','有','和','吧','嗯','哦','哈',
  '吗','呢','啊','呀','么','这','那','为','以','到','从','但','所以','因为',
]);

const TOPIC_STOPWORDS = new Set([
  '的','了','是','吗','啊','呢','吧','哦','嗯','哈','哇','么','嘛',
  '我','你','他','她','它','我们','你们','他们',
  '在','有','和','就','也','都','不','没','很','太',
  '什么','怎么','这','那','啥','谁',
]);

/**
 * Tokenize lore text into a Set of meaningful tokens (length >= 2).
 * Splits on whitespace/punctuation; includes CJK character runs individually.
 */
export function tokenizeLore(text: string): Set<string> {
  const stripped = text.replace(/\[CQ:[^\]]+\]/g, ' ');
  const tokens = new Set<string>();
  for (const chunk of stripped.split(/[\s\p{P}！？。，、；：""''【】《》（）…—\-_/\\|]+/u)) {
    const t = chunk.trim();
    if (t.length >= 2) tokens.add(t);
  }
  return tokens;
}

/**
 * Extract topic tokens from a message for engagement tracking.
 * English words -> lowercase whole-word token; Chinese chars -> sliding 2-grams.
 * CQ codes and stopwords are excluded.
 */
export function extractTokens(content: string): Set<string> {
  const clean = content.replace(/\[CQ:[^\]]*\]/g, ' ').trim();
  const result = new Set<string>();
  const segments = clean.split(/[\s，。？！、…「」『』【】《》""''【】\u3000\uff0c\uff01\uff1f\uff1a\u300a\u300b\uff08\uff09]+/).filter(Boolean);
  for (const seg of segments) {
    if (/^[a-z0-9]+$/i.test(seg)) {
      const w = seg.toLowerCase();
      if (!TOPIC_STOPWORDS.has(w) && w.length > 1) result.add(w);
    } else {
      for (let i = 0; i < seg.length - 1; i++) {
        const gram = seg.slice(i, i + 2);
        if (!TOPIC_STOPWORDS.has(gram[0]!) && !TOPIC_STOPWORDS.has(gram[1]!)) {
          result.add(gram);
        }
      }
    }
  }
  return result;
}

/** Extract meaningful keywords from a message for corpus retrieval. */
export function extractKeywords(text: string): string[] {
  const stripped = text.replace(/\[CQ:[^\]]+\]/g, ' ');
  const tokens = stripped.split(/[\s\p{P}！？。，、；：""''【】《》（）…—]+/u)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
  return [...new Set(tokens)].slice(0, 5);
}
