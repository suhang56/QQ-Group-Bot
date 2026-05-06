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

// CN question-tail whitelist — sorted longest-first (ARCH Q3 lock)
const CN_TAIL_WHITELIST: readonly string[] = [
  '是啥意思',
  '是什么意思',
  '是哪一个',
  '是哪一位',
  '怎么回事',
  '是什么啊',
  '是谁啊',
  '是谁呀',
  '是谁呢',
  '啥意思',
  '什么意思',
  '是哪个',
  '是哪位',
  '是什么',
  '是谁',
  '谁啊',
  '是啥',
];

// CN leading-demonstrative whitelist — sorted longest-first (ARCH Q3 lock)
const CN_LEAD_WHITELIST: readonly string[] = [
  '那啥',
  '这个',
  '那个',
  '这位',
  '那位',
];

// Union set for post-wrap whitelist-collapse check (ARCH Q1 option a)
const CN_WHITELIST_UNION: ReadonlySet<string> = new Set([
  ...CN_TAIL_WHITELIST,
  ...CN_LEAD_WHITELIST,
]);

/**
 * Sanitize raw user text into a FTS5-safe MATCH query.
 * Strategy: strip FTS5 operator chars, strip CJK question tails and leading
 * demonstratives (trigram tokenizer — phrase-literal wrapping), split on
 * whitespace, drop bare boolean keywords, wrap each remaining token in double
 * quotes (implicit AND), join with space.
 *
 *   '偶像大师'       -> '"偶像大师"'
 *   '高松灯是谁'     -> '"高松灯"'         // tail stripped
 *   '这个高松灯是谁' -> '"高松灯"'         // demonstrative + tail stripped
 *   'foo-bar baz'   -> '"foobar" "baz"'   // hyphen stripped
 *   '*'             -> ''                  // empty after strip
 */
export function sanitizeFtsQuery(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';

  // Step 2: strip FTS5 operator chars: " * : ^ ( ) - +
  let s = raw.replace(/["*:^()\-+]/g, '').trim();
  if (!s) return '';

  // Step 3: strip trailing CJK punctuation
  s = s.replace(/[？！。，]+$/, '');

  // Step 4: CN question-tail strip (suffix, longest-first, ≥2-char leftover guard)
  for (const tail of CN_TAIL_WHITELIST) {
    if (s.endsWith(tail)) {
      const leftover = s.slice(0, s.length - tail.length);
      if (leftover.length >= 2) {
        s = leftover;
      }
      break;
    }
  }

  // Step 5: CN leading-demonstrative strip (prefix, longest-first, ≥2-char leftover guard)
  for (const lead of CN_LEAD_WHITELIST) {
    if (s.startsWith(lead)) {
      const leftover = s.slice(lead.length);
      if (leftover.length >= 2) {
        s = leftover;
      }
      break;
    }
  }

  // Step 6: trailing CJK punctuation re-run (idempotent)
  s = s.replace(/[？！。，]+$/, '');

  // Step 7: empty/whitespace guard
  if (!s.trim()) return '';

  // Step 8: split on whitespace, drop bool keywords, filter empty tokens
  const tokens = s
    .split(/\s+/)
    .map(t => t.replace(/^(AND|OR|NOT|NEAR)$/i, ''))
    .filter(t => t.length > 0);

  // Step 9: empty tokens guard
  if (tokens.length === 0) return '';

  // Step 10: wrap each token in phrase-literal quotes, join (implicit AND)
  const result = tokens.map(t => `"${t}"`).join(' ');

  // ARCH Q1 option (a): post-wrap whitelist-collapse — if the entire output is
  // a single whitelist entry wrapped in quotes, the input was tail/demonstrative-only;
  // return '' so callers treat as 0-hit (A5 acceptance criterion).
  if (tokens.length === 1 && CN_WHITELIST_UNION.has(tokens[0]!)) {
    return '';
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
