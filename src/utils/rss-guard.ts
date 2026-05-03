import type { Logger } from './logger.js';

export interface RssGuardConfig {
  maxRssMb: number;
  intervalMs: number;
}

export interface RssGuard {
  stop: () => void;
}

export type ExitFn = (code: number) => void;

export function startRssGuard(
  config: RssGuardConfig,
  logger: Pick<Logger, 'error'>,
  exitFn: ExitFn = process.exit as ExitFn,
): RssGuard {
  const { maxRssMb, intervalMs } = config;
  let triggered = false;
  let stopped = false;

  const handle = setInterval(() => {
    if (stopped || triggered) return;
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (rssMb > maxRssMb) {
      triggered = true;
      logger.error(
        { rssMb, limit: maxRssMb },
        'memory limit exceeded — exiting for service auto-restart',
      );
      exitFn(1);
    }
  }, intervalMs);

  handle.unref?.();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
    },
  };
}

export function parseRssLimit(raw: string | undefined): number | null {
  if (raw === undefined) return 1500;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}
