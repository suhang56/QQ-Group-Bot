import 'dotenv/config';
import path from 'node:path';
import { initLogger, createLogger } from './utils/logger.js';
import { NapCatAdapter } from './adapter/napcat.js';
import { Database } from './storage/db.js';
import { ClaudeClient } from './ai/claude.js';
import { RateLimiter } from './core/rateLimiter.js';
import { Router } from './core/router.js';
import { ChatModule } from './modules/chat.js';

// 1. Bootstrap logger
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

// 3. Open DB (step 2 of bootstrap order per architecture.md)
const dbPath = process.env['DB_PATH'] ?? 'data/bot.db';
const db = new Database(dbPath);
logger.info({ dbPath }, 'Database opened');

// 4. Instantiate services (bootstrap order per architecture §5.2)
const adapter = new NapCatAdapter(NAPCAT_WS_URL, process.env['NAPCAT_ACCESS_TOKEN']);
const claude = new ClaudeClient(ANTHROPIC_API_KEY);
const rateLimiter = new RateLimiter();
const router = new Router(db, adapter, rateLimiter);
const chat = new ChatModule(claude, db);
router.setChat(chat);

// 5. Wire events
adapter.on('error', (err) => {
  logger.fatal({ err }, 'Adapter fatal error');
  process.exit(1);
});

adapter.on('message.group', (msg) => {
  void router.dispatch(msg);
});

// 6. Connect
try {
  await adapter.connect();
  logger.info('Bot ready');
} catch (err) {
  logger.fatal({ err }, 'Failed to connect to NapCat — check NAPCAT_WS_URL and NapCat status');
  process.exit(1);
}

// 7. Graceful shutdown
const shutdown = async () => {
  logger.info('Shutting down...');
  await adapter.disconnect();
  db.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
