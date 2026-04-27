/**
 * R4-lite UtteranceAct enum + StrategyPreviewContext shape.
 * Observability layer only — used to label what the bot intended to do
 * before timing/defer gates intervene. No behavior change.
 */

export type UtteranceAct =
  | 'direct_chat'
  | 'chime_in'
  | 'conflict_handle'
  | 'summarize'
  | 'bot_status_query'
  | 'relay'
  | 'meta_admin_status'
  | 'object_react';

export const ALL_UTTERANCE_ACTS: readonly UtteranceAct[] = [
  'direct_chat',
  'chime_in',
  'conflict_handle',
  'summarize',
  'bot_status_query',
  'relay',
  'meta_admin_status',
  'object_react',
] as const;

export interface StrategyPreviewContext {
  msg: {
    content: string;
    rawContent?: string;
    isAtMention: boolean;
    isDirect: boolean;
    shouldReply: boolean;
  };
  recent5Msgs: Array<{ content: string; userId: string }>;
  hasKnownFactTerm: boolean;
  /** undefined at Router pre-generate stage (fact retrieval not done yet). */
  hasRealFactHit: boolean | undefined;
  /** Pre-computed by caller (caller invokes detectRelay if relevant). */
  relayHit: boolean;
}
