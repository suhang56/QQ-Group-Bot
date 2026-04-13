import 'dotenv/config';
import path from 'node:path';
import { initLogger, createLogger } from './utils/logger.js';

// 1. Bootstrap logger first with optional file transport
const logLevel = process.env['LOG_LEVEL'] ?? 'info';
const logDir = path.join(process.cwd(), 'data', 'logs');
const today = new Date().toISOString().slice(0, 10);

initLogger({
  level: logLevel,
  transport: process.env['NODE_ENV'] !== 'test'
    ? {
        target: 'pino/file',
        options: { destination: path.join(logDir, `bot-${today}.log`), mkdir: true },
      }
    : undefined,
});

const logger = createLogger('bootstrap');

// 2. Validate required env vars
const NAPCAT_WS_URL = process.env['NAPCAT_WS_URL'];
const ANTHROPIC_API_KEY = process.env['ANTHROPIC_API_KEY'];

if (!NAPCAT_WS_URL) {
  logger.fatal('Missing required env var: NAPCAT_WS_URL');
  process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
  logger.fatal('Missing required env var: ANTHROPIC_API_KEY');
  process.exit(1);
}

// 3. Create adapter and connect
import('./adapter/napcat.js').then(async ({ NapCatAdapter }) => {
  const adapter = new NapCatAdapter(
    NAPCAT_WS_URL!,
    process.env['NAPCAT_ACCESS_TOKEN']
  );

  adapter.on('error', (err) => {
    logger.fatal({ err }, 'Adapter fatal error');
    process.exit(1);
  });

  adapter.on('message.group', (msg) => {
    logger.trace({ messageId: msg.messageId, groupId: msg.groupId }, 'group message');
  });

  try {
    await adapter.connect();
    logger.info('Bot ready');
  } catch (err) {
    logger.fatal({ err }, 'Failed to connect to NapCat — check NAPCAT_WS_URL and NapCat status');
    process.exit(1);
  }

  const shutdown = async () => {
    logger.info('Shutting down...');
    await adapter.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}).catch((err: unknown) => {
  console.error('Fatal: failed to load adapter module', err);
  process.exit(1);
});
