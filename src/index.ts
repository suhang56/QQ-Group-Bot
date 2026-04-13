import 'dotenv/config';
import path from 'node:path';
import { initLogger, createLogger } from './utils/logger.js';
import { NapCatAdapter } from './adapter/napcat.js';
import { Database } from './storage/db.js';
import { EmbeddingService } from './storage/embeddings.js';
import { ClaudeClient } from './ai/claude.js';
import { RateLimiter } from './core/rateLimiter.js';
import { Router } from './core/router.js';
import { ChatModule } from './modules/chat.js';
import { MimicModule } from './modules/mimic.js';
import { ModeratorModule } from './modules/moderator.js';
import { LearnerModule } from './modules/learner.js';
import { AnnouncementSyncModule } from './modules/announcement-sync.js';
import { NameImagesModule } from './modules/name-images.js';
import { LoreUpdater } from './modules/lore-updater.js';

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
const ACTIVE_GROUPS = process.env['ACTIVE_GROUPS']
  ? process.env['ACTIVE_GROUPS'].split(',').map(s => s.trim()).filter(Boolean)
  : [];

if (!NAPCAT_WS_URL) {
  logger.fatal('Missing required env var: NAPCAT_WS_URL');
  process.exit(1);
}

// 3. Open DB (step 2 of bootstrap order per architecture.md)
const dbPath = process.env['DB_PATH'] ?? 'data/bot.db';
const db = new Database(dbPath);
logger.info({ dbPath }, 'Database opened');

// 4. Instantiate services (bootstrap order per architecture §5.2)
const botUserId = process.env['BOT_QQ_ID'] ?? '';
const adapter = new NapCatAdapter(NAPCAT_WS_URL, process.env['NAPCAT_ACCESS_TOKEN']);
const claude = new ClaudeClient();
const rateLimiter = new RateLimiter();
const router = new Router(db, adapter, rateLimiter, botUserId);
const chat = new ChatModule(claude, db, { botUserId });
router.setChat(chat);

// Embedding service: fire-and-forget init — bot must not block on model load
const embedder = new EmbeddingService();
void embedder.waitReady().then(() => {
  if (embedder.isReady) logger.info('Embedding model ready');
});

const learner = new LearnerModule(embedder, db.rules, db.moderation);
const mimic = new MimicModule(claude, db.messages, db.groupConfig, botUserId);
const moderator = new ModeratorModule(claude, adapter, db.messages, db.moderation, db.groupConfig, db.rules, learner);
router.setMimic(mimic);
router.setModerator(moderator);

const announcementSync = new AnnouncementSyncModule(adapter, db.announcements, db.rules, claude, learner);

const nameImagesDirPath = process.env['NAME_IMAGES_DIR'] ?? path.join(process.cwd(), 'data', 'name-images');
const nameImages = new NameImagesModule(db.nameImages, nameImagesDirPath, adapter);
router.setNameImages(nameImages);

const loreUpdater = new LoreUpdater(claude, db.messages, chat);
router.setLoreUpdater(loreUpdater);

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
  if (ACTIVE_GROUPS.length > 0) {
    void announcementSync.start(ACTIVE_GROUPS);
    logger.info({ groups: ACTIVE_GROUPS }, 'announcement sync started');
  } else {
    logger.warn('no active groups configured, announcement sync disabled');
  }
} catch (err) {
  logger.fatal({ err }, 'Failed to connect to NapCat — check NAPCAT_WS_URL and NapCat status');
  process.exit(1);
}

// 7. Graceful shutdown
const shutdown = async () => {
  logger.info('Shutting down...');
  announcementSync.stop();
  await adapter.disconnect();
  db.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
