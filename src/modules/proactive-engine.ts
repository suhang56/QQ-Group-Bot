/**
 * Proactive Engine: handles mood-driven proactive messages and silence-breaker.
 * Extracted from ChatModule to isolate timer-driven proactive behavior.
 *
 * Note: This is a delegation wrapper. The actual proactive logic remains in
 * ChatModule as inline fallback for safe revert. When this module is injected,
 * ChatModule delegates to it; when not, it uses its own inline implementation.
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('proactive-engine');

export interface IProactiveEngine {
  /** Start the proactive tick timer. */
  start(): void;
  /** Stop the proactive tick timer. */
  stop(): void;
  /** Register a group for proactive monitoring. */
  registerGroup(groupId: string): void;
  /** Record bot reply time for silence-breaker calculations. */
  recordBotReply(groupId: string, nowMs: number): void;
  /** Get the last bot reply time for a group. */
  getLastReplyTime(groupId: string): number;
}

/**
 * Stub implementation that exposes the interface but delegates actual behavior
 * to ChatModule's inline code. This allows future extraction of the proactive
 * tick logic without breaking the current working system.
 */
export class ProactiveEngine implements IProactiveEngine {
  private readonly knownGroups = new Set<string>();
  private readonly lastReplyTime = new Map<string, number>();

  start(): void {
    logger.debug('proactive-engine started (delegation stub)');
  }

  stop(): void {
    logger.debug('proactive-engine stopped');
  }

  registerGroup(groupId: string): void {
    this.knownGroups.add(groupId);
  }

  recordBotReply(groupId: string, nowMs: number): void {
    this.lastReplyTime.set(groupId, nowMs);
  }

  getLastReplyTime(groupId: string): number {
    return this.lastReplyTime.get(groupId) ?? 0;
  }
}
