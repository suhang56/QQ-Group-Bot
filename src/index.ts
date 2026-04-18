import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { initLogger, createLogger } from './utils/logger.js';
import { NapCatAdapter } from './adapter/napcat.js';
import { Database } from './storage/db.js';
import { EmbeddingService } from './storage/embeddings.js';
import { ClaudeClient, type IClaudeClient } from './ai/claude.js';
import { OllamaClient } from './ai/providers/ollama-llm.js';
import { GeminiClient } from './ai/providers/gemini-llm.js';
import { DeepSeekClient } from './ai/providers/deepseek-llm.js';
import { ModelRouter } from './ai/model-router.js';
import {
  OLLAMA_ENABLED, OLLAMA_BASE_URL, GEMINI_ENABLED, DEEPSEEK_ENABLED,
  WEB_LOOKUP_ENABLED, GOOGLE_CSE_API_KEY, GOOGLE_CSE_CX, WEB_LOOKUP_MAX_PER_DAY,
} from './config.js';
import { WebLookup } from './modules/web-lookup.js';
import type { ILLMClient } from './modules/web-lookup.js';
import { parseIntOr } from './utils/config-parse.js';
import { RateLimiter } from './core/rateLimiter.js';
import { Router } from './core/router.js';
import { MOD_APPROVAL_ADMIN } from './core/constants.js';
import { ChatModule } from './modules/chat.js';
import { CharModule } from './modules/char.js';
import { StickerFirstModule } from './modules/sticker-first.js';
import { MimicModule } from './modules/mimic.js';
import { ModeratorModule } from './modules/moderator.js';
import { LearnerModule } from './modules/learner.js';
import { AnnouncementSyncModule } from './modules/announcement-sync.js';
import { NameImagesModule } from './modules/name-images.js';
import { PokeModule } from './modules/poke.js';
import { LoreUpdater } from './modules/lore-updater.js';
import { LoreLoader } from './modules/lore-loader.js';
import { DeflectionEngine } from './modules/deflection-engine.js';
import { chatHistoryDefaults } from './config.js';
import { SelfLearningModule } from './modules/self-learning.js';
import { runFactEmbeddingBackfill, BACKFILL_INTERVAL_MS } from './modules/fact-embedding-backfill.js';
import { runMemeEmbeddingBackfill, MEME_BACKFILL_INTERVAL_MS } from './modules/meme-embedding-backfill.js';
import { VisionService } from './modules/vision.js';
import { StickerCaptureService } from './modules/sticker-capture.js';
import { WelcomeModule } from './modules/welcome.js';
import { IdCardGuard } from './modules/id-guard.js';
import { SequenceGuard } from './modules/sequence-guard.js';
import { SelfReflectionLoop } from './modules/self-reflection.js';
import { DiaryDistiller, msUntilNextShanghaiHour } from './modules/diary-distiller.js';
import { BandoriLiveScraper } from './modules/bandori-live-scraper.js';
import { OpportunisticHarvest } from './modules/opportunistic-harvest.js';
import { AliasMiner } from './modules/alias-miner.js';
import { ExpressionLearner } from './modules/expression-learner.js';
import { StyleLearner } from './modules/style-learner.js';
import { RelationshipTracker } from './modules/relationship-tracker.js';
import { AffinityModule } from './modules/affinity.js';
import { FatigueModule } from './modules/fatigue.js';
import { PreChatJudge } from './modules/pre-chat-judge.js';
import { ProactiveEngine, loadProactiveEngineConfig } from './modules/proactive-engine.js';
import { JargonMiner } from './modules/jargon-miner.js';
import { HonestGapsTracker } from './modules/honest-gaps.js';
import { OnDemandLookup, LEARN_MODEL } from './modules/on-demand-lookup.js';
import { PhraseMiner } from './modules/phrase-miner.js';
import { MemeClusterer } from './modules/meme-clusterer.js';
import { RatingPortalServer } from './server/rating-portal.js';
import { TuningGenerator } from './server/tuning-generator.js';

// ============================================================
// PHASE 1: Infrastructure (logger, env, PID lock, database)
// ============================================================

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

// 2a. Web-lookup startup check
if (WEB_LOOKUP_ENABLED) {
  if (!GOOGLE_CSE_API_KEY || !GOOGLE_CSE_CX) {
    logger.warn('web-lookup disabled: WEB_LOOKUP_ENABLED=1 but GOOGLE_CSE_API_KEY or GOOGLE_CSE_CX is empty');
  } else {
    logger.info(`web lookup enabled: ${WEB_LOOKUP_MAX_PER_DAY}/day budget, CSE CX set`);
  }
}

// 2b. PID lock — prevent duplicate instances
const pidPath = path.join(process.cwd(), 'data', 'bot.pid');
if (fs.existsSync(pidPath)) {
  const oldPid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
  if (!isNaN(oldPid)) {
    try {
      process.kill(oldPid, 0); // throws ESRCH if dead
      logger.fatal({ oldPid }, 'another bot instance is running — refusing to start');
      process.exit(1);
    } catch { /* dead process — ok to take over */ }
  }
}
fs.writeFileSync(pidPath, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(pidPath); } catch { /* ignore */ } });

// 3. Open DB (step 2 of bootstrap order per architecture.md)
const dbPath = process.env['DB_PATH'] ?? 'data/bot.db';
const db = new Database(dbPath);
logger.info({ dbPath }, 'Database opened');

// ============================================================
// PHASE 2: Services (LLM providers, embeddings, adapters)
// ============================================================

// 4. Instantiate services (bootstrap order per architecture §5.2)
const botUserId = process.env['BOT_QQ_ID'] ?? '';
const adapter = new NapCatAdapter(NAPCAT_WS_URL, process.env['NAPCAT_ACCESS_TOKEN']);

// LLM provider setup: Claude always present; Ollama + Gemini optional based
// on env. ModelRouter implements IClaudeClient and dispatches by model-name
// prefix so all downstream modules continue to receive a single client.
const claudeRaw = new ClaudeClient();
const providerMap: { claude: ClaudeClient; ollama?: OllamaClient; gemini?: GeminiClient; deepseek?: DeepSeekClient } = {
  claude: claudeRaw,
};
if (OLLAMA_ENABLED) {
  const ollamaClient = new OllamaClient({ baseUrl: OLLAMA_BASE_URL });
  const ollamaOk = await ollamaClient.healthCheck().then(
    models => {
      logger.info({ models }, 'Ollama healthy — registering provider');
      return true;
    },
    err => {
      logger.warn({ err: String(err) }, 'Ollama unreachable — falling back to claude for qwen* models');
      return false;
    },
  );
  if (ollamaOk) providerMap.ollama = ollamaClient;
}
if (GEMINI_ENABLED) {
  try {
    providerMap.gemini = new GeminiClient();
    logger.info('Gemini registered — gemini* models routed to Google AI Studio');
  } catch (err) {
    logger.warn({ err: String(err) }, 'Gemini init failed');
  }
}
if (DEEPSEEK_ENABLED()) {
  try {
    providerMap.deepseek = new DeepSeekClient();
    logger.info('DeepSeek registered — deepseek* models routed to api.deepseek.com');
  } catch (err) {
    logger.warn({ err: String(err) }, 'DeepSeek init failed');
  }
}
const claude: IClaudeClient = new ModelRouter({
  claude: claudeRaw,
  ollama: providerMap.ollama,
  gemini: providerMap.gemini,
  deepseek: providerMap.deepseek,
});
logger.info({ providers: (claude as ModelRouter).getRegisteredProviders() }, 'model router ready');

const rateLimiter = new RateLimiter();
const router = new Router(db, adapter, rateLimiter, botUserId);
// Embedding service: fire-and-forget init — bot must not block on model load
const embedder = new EmbeddingService();

const selfLearning = new SelfLearningModule({
  db, claude, botUserId,
  researchEnabled: process.env['SELF_LEARN_ONLINE'] !== '0',
  embeddingService: embedder,
});

const memesDisabled = process.env['MEMES_V1_DISABLED'] === '1';

let factBackfillTimer: NodeJS.Timeout | null = null;
let memeBackfillTimer: NodeJS.Timeout | null = null;
void embedder.waitReady().then(() => {
  if (embedder.isReady) {
    logger.info('Embedding model ready');
    // LearnedFactsRepo gets the service via setter — repos are built at
    // Database init, before EmbeddingService waitReady resolves. Different
    // lifecycle from SelfLearningModule (which takes it via constructor).
    db.learnedFacts.setEmbeddingService(embedder);
    void runFactEmbeddingBackfill(db, embedder, logger).catch(err => {
      logger.warn({ err }, 'fact embedding backfill failed');
    });
    // Periodic re-run: defense in depth against insert-time races where
    // embed() failed and the row was left NULL.
    factBackfillTimer = setInterval(() => {
      void runFactEmbeddingBackfill(db, embedder, logger).catch(err => {
        logger.warn({ err }, 'periodic fact embedding backfill failed');
      });
    }, BACKFILL_INTERVAL_MS);
    factBackfillTimer.unref?.();

    // Meme graph embedding backfill (same pattern as facts)
    if (!memesDisabled) {
      void runMemeEmbeddingBackfill(db.memeGraph, embedder, logger).catch(err => {
        logger.warn({ err }, 'meme embedding backfill failed');
      });
      memeBackfillTimer = setInterval(() => {
        void runMemeEmbeddingBackfill(db.memeGraph, embedder, logger).catch(err => {
          logger.warn({ err }, 'periodic meme embedding backfill failed');
        });
      }, MEME_BACKFILL_INTERVAL_MS);
      memeBackfillTimer.unref?.();
    }
  }
});
router.setSelfLearning(selfLearning);

// memes-v1 P4: wire meme graph repo into self-learning and chat
// db.memeGraph is added by P0; conditional access for merge-order safety
const memeGraphRepo = (db as unknown as Record<string, unknown>)['memeGraph'] as
  import('./modules/self-learning.js').IMemeGraphRepo | undefined;
if (memeGraphRepo) {
  selfLearning.setMemeGraphRepo(memeGraphRepo);
  logger.info('meme graph repo wired into self-learning');
}

// ============================================================
// PHASE 3: Modules (chat, mimic, moderation, stickers, etc.)
// ============================================================

// Tuning path is group-specific; falls back to data/tuning.md if no active group
const tuningGroupId = process.env['ACTIVE_GROUPS']?.split(',')[0]?.trim();
const tuningPath = tuningGroupId
  ? path.join(process.cwd(), 'data', 'groups', tuningGroupId, 'tuning.md')
  : path.join(process.cwd(), 'data', 'tuning.md');

const vision = new VisionService(claude, adapter, db.imageDescriptions);
const stickerFirst = new StickerFirstModule(db.localStickers, embedder);
const loreLoader = new LoreLoader(
  chatHistoryDefaults.loreDirPath,
  chatHistoryDefaults.loreSizeCapBytes,
  tuningPath,
  (groupId: string) => db.learnedFacts.listActiveAliasFacts(groupId),
);
const deflectionEngine = new DeflectionEngine(claude, { cacheEnabled: true });

const bandoriEnabled = process.env['BANDORI_SCRAPE_ENABLED'] !== 'false';
const bandoriScraper = new BandoriLiveScraper(db.bandoriLives, {
  enabled: bandoriEnabled,
  intervalMs: parseIntOr(process.env['BANDORI_SCRAPE_INTERVAL_MS'], 86_400_000, 'BANDORI_SCRAPE_INTERVAL_MS'),
});
bandoriScraper.start();
deflectionEngine.start();

const chat = new ChatModule(claude, db, {
  botUserId, deflectCacheEnabled: true, visionService: vision,
  localStickerRepo: db.localStickers, embedder, selfLearning,
  tuningPath, imageDescriptions: db.imageDescriptions,
  forwardCache: db.forwardCache,
  stickerFirst,
  bandoriLiveRepo: bandoriEnabled ? db.bandoriLives : undefined,
  loreLoader,
  deflectionEngine,
});
// Restore bot recent outputs from DB so dedup survives restarts
chat.restoreBotRecentOutputs(ACTIVE_GROUPS);
router.setChat(chat);
router.setStickerFirst(stickerFirst);
router.setVisionService(vision);

// memes-v1 P4: wire meme graph repo into chat's conversation state tracker
if (memeGraphRepo) {
  chat.setMemeGraphRepo(memeGraphRepo);
  logger.info('meme graph repo wired into chat conversation state');
}

const charDataDir = path.join(process.cwd(), 'data', 'characters');
const charModule = new CharModule(charDataDir);
chat.setCharModule(charModule);
router.setChar(charModule);

const learner = new LearnerModule(embedder, db.rules, db.moderation);
const mimic = new MimicModule(claude, db.messages, db.groupConfig, botUserId);
const moderator = new ModeratorModule(claude, adapter, db.messages, db.moderation, db.groupConfig, db.rules, learner, db.imageModCache, db.modRejections);
router.setMimic(mimic);
router.setModerator(moderator);

const announcementSync = new AnnouncementSyncModule(adapter, db.announcements, db.rules, claude, learner);

const nameImagesDirPath = process.env['NAME_IMAGES_DIR'] ?? path.join(process.cwd(), 'data', 'name-images');
const nameImages = new NameImagesModule(db.nameImages, nameImagesDirPath, adapter);
router.setNameImages(nameImages);
chat.setPicNameProvider(nameImages);

const loreUpdater = new LoreUpdater(claude, db.messages, chat);
router.setLoreUpdater(loreUpdater);

const stickerCapture = new StickerCaptureService(db.localStickers, adapter, { claude, embedder });
router.setStickerCapture(stickerCapture);
stickerCapture.startBackfillLoop(ACTIVE_GROUPS);

const welcome = new WelcomeModule({ welcomeLog: db.welcomeLog, claude, adapter, botUserId });
const poke = new PokeModule({ adapter, botUserId });
router.setPoke(poke);

const idGuard = new IdCardGuard({
  adapter,
  moderation: db.moderation,
  pendingModeration: db.pendingModeration,
  vision,
  adminUserId: MOD_APPROVAL_ADMIN,
  botUserId,
  enabled: () => true,
});
router.setIdGuard(idGuard);

const sequenceGuard = new SequenceGuard({
  adapter,
  pendingModeration: db.pendingModeration,
  adminUserId: MOD_APPROVAL_ADMIN,
  botUserId,
});
router.setSequenceGuard(sequenceGuard);

const expressionLearner = new ExpressionLearner({
  messages: db.messages,
  expressionPatterns: db.expressionPatterns,
  botUserId,
});

const styleLearner = new StyleLearner({
  messages: db.messages,
  userStyles: db.userStyles,
  userStylesAggregate: db.userStylesAggregate,
  claude,
  activeGroups: ACTIVE_GROUPS,
  onAggregateUpdated: (gid) => chat.invalidateGroupIdentityCache(gid),
});

const relationshipTracker = new RelationshipTracker({
  messages: db.messages,
  users: db.users,
  claude,
  activeGroups: ACTIVE_GROUPS,
  dbExec: (sql: string, ...params: unknown[]) => (db.rawDb.prepare(sql) as unknown as { run(...a: unknown[]): void }).run(...params),
  dbQuery: <T>(sql: string, ...params: unknown[]) => (db.rawDb.prepare(sql) as unknown as { all(...a: unknown[]): T[] }).all(...params),
});

// M6.2a: wire miner helpers into chat prompt / userContent.
chat.setExpressionSource(expressionLearner);
chat.setStyleSource(styleLearner);
chat.setRelationshipSource(relationshipTracker);

// W-A: honest-gaps tracker — streamed per-message from router.dispatch via
// chat.recordHonestGapsMessage, and read back in _buildGroupIdentityPrompt via
// chat.honestGapsSource. Same instance handles both interfaces.
// UR-N M5: pass learned_facts + meme_graph so the tracker drops terms the bot
// already has grounding for — avoids "honest gap" + "learned fact" on same term.
const honestGapsTracker = new HonestGapsTracker(db.honestGaps, {
  known: { learnedFacts: db.learnedFacts, memeGraph: db.memeGraph, messagesRepo: db.messages },
});
chat.setHonestGapsSource(honestGapsTracker);
chat.setHonestGapsTracker(honestGapsTracker);

const onDemandLookup = new OnDemandLookup({
  db: { learnedFacts: db.learnedFacts, messages: db.messages },
  llm: claude,
  model: LEARN_MODEL,
  logger: createLogger('on-demand-lookup'),
});
chat.setOnDemandLookup(onDemandLookup);

const affinity = new AffinityModule(db.rawDb);
// M6.2b: wire affinity producer + consumer into chat scoring / userContent.
// M9.3: router.setAffinity below also enables /cross_group_audit +
//       /forget_me_cross_group admin DM commands on the same injected module.
chat.setAffinitySource(affinity);
router.setAffinity(affinity);

// M6.3: per-group reply fatigue — exponential decay, additive penalty once
// bot has replied heavily. Pure in-memory, no persistence.
const fatigue = new FatigueModule();
chat.setFatigueSource(fatigue);
router.setFatigue(fatigue);

// M7 (M7.1+M7.3+M7.4): pre-chat LLM judge — routed through ModelRouter so
// gemini-2.5-flash goes to the Google AI Studio provider. Module-level kill
// switch via PRE_CHAT_JUDGE_DISABLED=1. When GEMINI provider is absent, the
// router falls back to Claude Haiku; fail-open timeout still applies so a
// mis-wired provider never blocks the chat path.
const preChatJudge = new PreChatJudge(claude);
chat.setPreChatJudge(preChatJudge);

// M9.1 — proactive engine (silence-breaker v2). Ships dark by default;
// enable with PROACTIVE_ENGINE_ENABLED=1. start() is a no-op when disabled.
const proactiveEngineConfig = loadProactiveEngineConfig(process.env);
const proactiveEngine = new ProactiveEngine({
  chat,
  activityTracker: chat.getActivityTracker(),
  moodTracker: chat.getMoodTracker(),
  db,
  preChatJudge,
  config: proactiveEngineConfig,
});
proactiveEngine.start();

const jargonMiner = new JargonMiner({
  db: db.rawDb,
  messages: db.messages,
  learnedFacts: db.learnedFacts,
  claude,
  activeGroups: ACTIVE_GROUPS,
});

// Daily stale-candidate prune at 03:00 Asia/Shanghai.
// Uses setTimeout chain so the interval self-corrects to wall-clock time.
// .unref?.() on every handle so the process can exit cleanly.
{
  const PRUNE_HOUR_SHANGHAI = 3;
  const schedulePruneCron = (): void => {
    const delay = msUntilNextShanghaiHour(Date.now(), PRUNE_HOUR_SHANGHAI);
    const t = setTimeout(async function pruneTick() {
      for (const groupId of ACTIVE_GROUPS) {
        try {
          jargonMiner.pruneStale(groupId);
        } catch (err) {
          logger.warn({ err, groupId }, 'jargon stale prune failed');
        }
      }
      schedulePruneCron();
    }, delay);
    t.unref?.();
  };
  schedulePruneCron();
}

const phraseMiner = memesDisabled ? null : new PhraseMiner({
  messages: db.messages,
  claude,
  phraseCandidates: db.phraseCandidates,
  activeGroups: ACTIVE_GROUPS,
});
const memeClusterer = memesDisabled ? null : new MemeClusterer({
  db: db.rawDb,
  memeGraph: db.memeGraph,
  phraseCandidates: db.phraseCandidates,
  claude,
  embeddingService: embedder,
});

const harvest = new OpportunisticHarvest({
  messages: db.messages,
  learnedFacts: db.learnedFacts,
  claude,
  activeGroups: ACTIVE_GROUPS,
  selfLearning,
  enabled: process.env['OPPORTUNISTIC_HARVEST_ENABLED'] !== '0',
  onCycleComplete: (groups) => {
    for (const g of groups) {
      try { expressionLearner.scan(g); } catch { /* logged internally */ }
      void jargonMiner.run(g).catch(err => logger.warn({ err, groupId: g }, 'jargon miner cycle failed'));
    }
    if (phraseMiner) {
      void phraseMiner.runAll().catch((err) => logger.error({ err }, 'phrase-miner failed'));
    }
    if (memeClusterer) {
      for (const g of groups) {
        void memeClusterer.clusterAll(g).catch((err) => logger.error({ err, groupId: g }, 'meme-clusterer failed'));
      }
    }
  },
});

const aliasMiner = new AliasMiner({
  messages: db.messages,
  learnedFacts: db.learnedFacts,
  claude,
  activeGroups: ACTIVE_GROUPS,
  enabled: process.env['ALIAS_MINER_ENABLED'] !== '0',
});

const selfReflectionEnabled = process.env['SELF_REFLECTION_ENABLED'] !== '0';
const selfReflection = ACTIVE_GROUPS[0]
  ? new SelfReflectionLoop({
      claude, botReplies: db.botReplies, moderation: db.moderation,
      learnedFacts: db.learnedFacts,
      groupId: ACTIVE_GROUPS[0],
      outputPath: tuningPath,
      enabled: selfReflectionEnabled,
      messages: db.messages,
      groupConfig: db.groupConfig,
      personaPatches: db.personaPatches,
    })
  : null;

// W-B: diary-distiller — daily/weekly/monthly group chatter rollup feeding
// "群最近的事情" into the chat identity prompt. Off when DIARY_ENABLED=0.
const diaryEnabled = process.env['DIARY_ENABLED'] !== '0';
const diaryDistiller = diaryEnabled
  ? new DiaryDistiller({
      claude,
      messages: db.messages,
      groupDiary: db.groupDiary,
      botUserId,
    })
  : null;

// Path C: WebSearch — adapt ModelRouter (IClaudeClient) to ILLMClient thin interface
const modelRouterAsLlm: ILLMClient = {
  chat: async (opts) => {
    const resp = await claude.complete({
      model: opts.model,
      maxTokens: opts.maxTokens,
      system: [],
      messages: opts.messages,
    });
    return { text: resp.text };
  },
};
const webLookup = new WebLookup(
  db.webLookupCache,
  db.learnedFacts,
  modelRouterAsLlm,
);
router.setWebLookup(webLookup);
chat.setWebLookup(webLookup);

// 5. Wire events
adapter.on('error', (err) => {
  logger.fatal({ err }, 'Adapter fatal error');
  process.exit(1);
});

adapter.on('message.group', (msg) => {
  void router.dispatch(msg);
});

adapter.on('message.private', (msg) => {
  void router.dispatchPrivate(msg);
});

adapter.on('notice.group_increase', (groupId, userId) => {
  const cfg = db.groupConfig.get(groupId);
  if (cfg && !cfg.welcomeEnabled) return;
  if (ACTIVE_GROUPS.length > 0 && !ACTIVE_GROUPS.includes(groupId)) return;
  void welcome.handleJoin(groupId, userId).catch(err => logger.error({ err, groupId, userId }, 'welcome failed'));
});

adapter.on('notice.group_poke', (notice) => {
  logger.info(notice, 'group poke notice received');
  if (ACTIVE_GROUPS.length > 0 && !ACTIVE_GROUPS.includes(notice.groupId)) {
    logger.info({ groupId: notice.groupId, activeGroups: ACTIVE_GROUPS }, 'group poke ignored: inactive group');
    return;
  }
  void router.dispatchPoke(notice);
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
  selfReflection?.start();
  if (diaryDistiller) {
    const diaryTimers = diaryDistiller.start();
    for (const t of Object.values(diaryTimers)) t?.unref?.();
  }
  harvest.start();
  aliasMiner.start();
  styleLearner.start();
  relationshipTracker.start();

  // Daily affinity decay
  const affinityDecayTimer = setInterval(() => {
    try { affinity.dailyDecay(); } catch (err) { logger.warn({ err }, 'affinity decay failed'); }
  }, 24 * 60 * 60_000);
  affinityDecayTimer.unref?.();

  // Jargon mining piggybacks on harvest cycle — run after each harvest
  // (already wired via onCycleComplete for expression learner; add jargon here)

  // Daily expression pattern decay
  const expressionDecayTimer = setInterval(() => {
    for (const g of ACTIVE_GROUPS) {
      try { expressionLearner.applyDecay(g); } catch (err) { logger.warn({ err, groupId: g }, 'expression decay failed'); }
    }
  }, 24 * 60 * 60_000);
  expressionDecayTimer.unref?.();
} catch (err) {
  logger.fatal({ err }, 'Failed to connect to NapCat — check NAPCAT_WS_URL and NapCat status');
  process.exit(1);
}

// 7. Rating portal (optional — only if RATING_PORT configured, defaults to 4000)
const ratingPortGroup = ACTIVE_GROUPS[0] ?? '';
let ratingPortal: RatingPortalServer | null = null;
if (ratingPortGroup) {
  const ratingPort = parseIntOr(process.env['RATING_PORT'], 4000, 'RATING_PORT');
  const ratingOrigins = (process.env['RATING_PORTAL_ORIGINS']?.split(',').map(s => s.trim()).filter(Boolean))
    ?? [`http://localhost:${ratingPort}`];
  ratingPortal = new RatingPortalServer(db.botReplies, ratingPortGroup, db.moderation, db.messages, db.localStickers, {
    adminToken: process.env['RATING_PORTAL_TOKEN'],
    allowedOrigins: ratingOrigins,
  });
  ratingPortal.setMemeGraphRepo(db.memeGraph);
  ratingPortal.start(ratingPort);

  // Generate tuning report on SIGUSR1
  const tuner = new TuningGenerator(db.botReplies, claude, ratingPortGroup, tuningPath);
  process.on('SIGUSR1', () => { void tuner.generate(); });
  logger.info({ tuningPath }, 'send SIGUSR1 to generate tuning report');
}

// 8. Graceful shutdown
const shutdown = async () => {
  logger.info('Shutting down...');
  announcementSync.stop();
  selfReflection?.dispose();
  diaryDistiller?.dispose();
  harvest.dispose();
  aliasMiner.dispose();
  styleLearner.dispose();
  relationshipTracker.dispose();
  proactiveEngine.stop();
  chat.destroy();
  if (factBackfillTimer) clearInterval(factBackfillTimer);
  if (memeBackfillTimer) clearInterval(memeBackfillTimer);
  stickerCapture.stopBackfillLoop();
  bandoriScraper.stop();
  deflectionEngine.stop();
  router.dispose();
  ratingPortal?.stop();
  await adapter.disconnect();
  db.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
