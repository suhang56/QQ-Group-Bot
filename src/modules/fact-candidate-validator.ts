import type { Logger } from 'pino';
import type { LearnedFact } from '../storage/db.js';

export interface FactCandidateInput {
  /** canonical_form / canonical_fact text of the miner candidate */
  canonical: string;
  /** constructed topic string (e.g. "群内梗 ygfn的意思"); null if no topic */
  topic: string | null;
  /** term being superseded/inserted (used for logging and caller context) */
  term: string;
  /** group scope */
  groupId: string;
  /** active rows for this term — caller fetches via findActiveByTopicTerm */
  existingActiveRows: LearnedFact[];
}

export interface FactCandidateResult {
  accept: boolean;
  rejectReason?: string;
}

const CONFUSION_RE = /询问|问|不知道|含义不明|不清楚|是啥|是谁|啥意思|什么意思|新梗|可能|推测|表明/;
const DEFINITION_RE = /=|即|指|就是|缩写为|全名是|CV=|中文名/;
const SPEAKER_SUBJECT_RE =
  /^(西瓜|风平浪静|[^\s]+)[🍉\s]*(多次|曾经|反复|一直|总|又)?(询问|问过|不知道|搞不清)/;

export function shouldAcceptFactCandidate(
  input: FactCandidateInput,
  logger?: Logger,
): FactCandidateResult {
  const { canonical, topic, term, groupId, existingActiveRows } = input;
  const isUserTaughtCandidate = topic?.startsWith('user-taught:') ?? false;

  // Rule 1 — existing user-taught blocks all non-user-taught candidates.
  if (!isUserTaughtCandidate) {
    const hasUserTaught = existingActiveRows.some(
      r => r.topic?.startsWith('user-taught:') ?? false,
    );
    if (hasUserTaught) {
      const reject = {
        accept: false,
        rejectReason: 'existing user-taught fact for term — non-user-taught candidate blocked',
      };
      logger?.info(
        { groupId, term, canonical: canonical.slice(0, 80), rejectReason: reject.rejectReason },
        'fact-candidate rejected',
      );
      return reject;
    }
  }

  const hasDefinition = DEFINITION_RE.test(canonical);

  // Rule 2 — confusion keyword without definition marker.
  if (CONFUSION_RE.test(canonical) && !hasDefinition) {
    const reject = {
      accept: false,
      rejectReason: 'confusion pattern in canonical without definitive marker',
    };
    logger?.info(
      { groupId, term, canonical: canonical.slice(0, 80), rejectReason: reject.rejectReason },
      'fact-candidate rejected',
    );
    return reject;
  }

  // Rule 3 — 群内梗 topic + speaker-as-subject confusion pattern, no def verb.
  if (topic?.startsWith('群内梗') && SPEAKER_SUBJECT_RE.test(canonical) && !hasDefinition) {
    const reject = {
      accept: false,
      rejectReason: '群内梗 topic with speaker-as-subject confusion pattern',
    };
    logger?.info(
      { groupId, term, canonical: canonical.slice(0, 80), rejectReason: reject.rejectReason },
      'fact-candidate rejected',
    );
    return reject;
  }

  return { accept: true };
}
