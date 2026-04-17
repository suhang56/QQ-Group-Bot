/**
 * mention-spam.ts — shared sliding-window counter for @-mention / "你"-probe
 * spam detection. Used by ChatModule for @-mentions and (indirectly via chat
 * routing) for `你`-probe paths so per-character prompts can use the same
 * threshold behavior without each holding its own map.
 */

export interface MentionSpamTracker {
  /** Record an event at `nowMs` and return count inside the rolling window. */
  record(key: string, nowMs: number): number;
  /** Peek the count without recording. */
  peek(key: string, nowMs: number): number;
}

export interface MentionSpamOpts {
  windowMs: number;
}

export function createMentionSpamTracker(opts: MentionSpamOpts): MentionSpamTracker {
  const history = new Map<string, number[]>();
  return {
    record(key, nowMs) {
      const cutoff = nowMs - opts.windowMs;
      const arr = (history.get(key) ?? []).filter(t => t > cutoff);
      arr.push(nowMs);
      history.set(key, arr);
      return arr.length;
    },
    peek(key, nowMs) {
      const cutoff = nowMs - opts.windowMs;
      const arr = (history.get(key) ?? []).filter(t => t > cutoff);
      if (arr.length !== (history.get(key)?.length ?? 0)) history.set(key, arr);
      return arr.length;
    },
  };
}
