import type { Logger } from 'pino';
import type { IMemeGraphRepo } from '../storage/db.js';
import type { IEmbeddingService } from '../storage/embeddings.js';
import { createLogger } from '../utils/logger.js';

const BATCH_SIZE = 50;
const SLEEP_MS = 50;
/** Periodic re-run interval. Defense in depth against insert-time races. */
export const MEME_BACKFILL_INTERVAL_MS = 15 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * One-shot worker that walks meme_graph rows with NULL embedding_vec
 * and computes the missing embedding. Modeled on runFactEmbeddingBackfill.
 */
export async function runMemeEmbeddingBackfill(
  memeGraph: IMemeGraphRepo,
  embeddingService: IEmbeddingService,
  logger: Logger = createLogger('meme-embedding-backfill'),
): Promise<{ filled: number; failed: number }> {
  if (!embeddingService.isReady) {
    logger.warn('embedding service not ready -- meme backfill skipped');
    return { filled: 0, failed: 0 };
  }
  let filled = 0;
  let failed = 0;
  const skip = new Set<number>();
  logger.info('meme embedding backfill: start');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = memeGraph.listAllNullEmbedding(BATCH_SIZE + skip.size)
      .filter(e => !skip.has(e.id))
      .slice(0, BATCH_SIZE);
    if (batch.length === 0) break;

    for (const entry of batch) {
      try {
        const text = entry.canonical + ' ' + entry.meaning;
        const vec = await embeddingService.embed(text);
        memeGraph.update(entry.id, { embeddingVec: vec });
        filled++;
      } catch (err) {
        failed++;
        skip.add(entry.id);
        logger.warn({ err, entryId: entry.id }, 'meme embedding backfill: row failed');
      }
    }
    await sleep(SLEEP_MS);
  }
  logger.info({ filled, failed }, 'meme embedding backfill: done');
  return { filled, failed };
}
