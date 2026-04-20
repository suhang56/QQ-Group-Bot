import type { RelayDetection } from '../modules/relay-detector.js';

export type PathKind = 'hard-bypass' | 'ultra-light' | 'timing-gated' | 'direct';

export interface ClassifyCtx {
  readonly isAtMention: boolean;
  readonly isReplyToBot: boolean;
  readonly isSlashCommand: boolean;
  readonly commandIsRegistered: boolean;
  readonly relay: RelayDetection | null;
}

// Priority: hard-bypass > direct > ultra-light > timing-gated.
// An admin `/kick @bot` stays a command; a user who @bot during a relay chain still deserves a direct reply.
export function classifyPath(ctx: ClassifyCtx): PathKind {
  if (ctx.isSlashCommand && ctx.commandIsRegistered) return 'hard-bypass';
  if (ctx.isAtMention || ctx.isReplyToBot) return 'direct';
  if (ctx.relay !== null) return 'ultra-light';
  return 'timing-gated';
}
