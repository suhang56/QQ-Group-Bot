import type { Logger } from 'pino';
import type { Database } from '../storage/db.js';
import type { IEmbeddingService } from '../storage/embeddings.js';
import { createLogger } from '../utils/logger.js';

const BATCH_SIZE = 100;
const SLEEP_MS = 50;
/** Periodic re-run interval for the backfill worker. Defense in depth against
 * insert-time races where the model wasn't ready or the embed call failed. */
export const BACKFILL_INTERVAL_MS = 15 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * One-shot startup worker that walks every active learned_fact row whose
 * `embedding_vec` is NULL and computes the missing embedding via the
 * supplied service. Runs to completion, then exits — invoked at bootstrap
 * after `EmbeddingService.waitReady()` resolves.
 *
 * Errors per row are logged at warn level and the loop continues so a
 * single bad row cannot stall the backfill.
 */
export async function runFactEmbeddingBackfill(
  db: Database,
  embeddingService: IEmbeddingService,
  logger: Logger = createLogger('fact-embedding-backfill'),
): Promise<{ filled: number; failed: number }> {
  if (!embeddingService.isReady) {
    logger.warn('embedding service not ready — backfill skipped');
    return { filled: 0, failed: 0 };
  }
  let filled = 0;
  let failed = 0;
  // Track ids that already failed so the next listAllNullEmbeddingActive call
  // can skip them — without this, a permanently-broken row would loop forever.
  const skip = new Set<number>();
  logger.info('fact embedding backfill: start');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const raw = db.learnedFacts.listAllNullEmbeddingActive(BATCH_SIZE + skip.size);
    const batch = raw.filter(f => !skip.has(f.id)).slice(0, BATCH_SIZE);
    if (batch.length === 0) break;
    for (const fact of batch) {
      try {
        const vec = await embeddingService.embed(fact.fact);
        db.learnedFacts.updateEmbedding(fact.id, vec);
        filled++;
      } catch (err) {
        failed++;
        skip.add(fact.id);
        logger.warn({ err, factId: fact.id }, 'fact embedding backfill: row failed');
      }
    }
    await sleep(SLEEP_MS);
  }
  logger.info({ filled, failed }, 'fact embedding backfill: done');
  return { filled, failed };
}
