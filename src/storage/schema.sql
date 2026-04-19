CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id          TEXT    NOT NULL,
  user_id           TEXT    NOT NULL,
  nickname          TEXT    NOT NULL DEFAULT '',
  content           TEXT    NOT NULL,
  raw_content       TEXT,
  timestamp         INTEGER NOT NULL,
  deleted           INTEGER NOT NULL DEFAULT 0,
  source_message_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_user  ON messages(group_id, user_id, timestamp DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source_id ON messages(source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_group_nickname ON messages(group_id, nickname);

CREATE TABLE IF NOT EXISTS users (
  user_id       TEXT    NOT NULL,
  group_id      TEXT    NOT NULL,
  nickname      TEXT    NOT NULL DEFAULT '',
  style_summary TEXT,
  last_seen     INTEGER NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'member',
  PRIMARY KEY (user_id, group_id)
);

CREATE TABLE IF NOT EXISTS moderation_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id    TEXT    NOT NULL,
  group_id  TEXT    NOT NULL,
  user_id   TEXT    NOT NULL,
  violation INTEGER NOT NULL DEFAULT 0,
  severity  INTEGER,
  action    TEXT    NOT NULL DEFAULT 'none',
  reason    TEXT    NOT NULL DEFAULT '',
  appealed          INTEGER NOT NULL DEFAULT 0,
  reversed          INTEGER NOT NULL DEFAULT 0,
  timestamp         INTEGER NOT NULL,
  reviewed          INTEGER NOT NULL DEFAULT 0,
  reviewed_by       TEXT,
  reviewed_at       INTEGER,
  original_content  TEXT
);

CREATE INDEX IF NOT EXISTS idx_mod_log_user     ON moderation_log(user_id, group_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mod_log_msg      ON moderation_log(msg_id);
CREATE INDEX IF NOT EXISTS idx_mod_log_reviewed ON moderation_log(reviewed, group_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS rules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id      TEXT    NOT NULL,
  content       TEXT    NOT NULL,
  type          TEXT    NOT NULL DEFAULT 'positive',
  source        TEXT    NOT NULL DEFAULT 'manual',
  embedding_vec BLOB
);

CREATE INDEX IF NOT EXISTS idx_rules_group ON rules(group_id);

CREATE TABLE IF NOT EXISTS group_announcements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id      TEXT    NOT NULL,
  notice_id     TEXT    NOT NULL,
  content       TEXT    NOT NULL,
  content_hash  TEXT    NOT NULL,
  fetched_at    INTEGER NOT NULL,
  parsed_rules  TEXT    NOT NULL DEFAULT '[]'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_announcements_notice ON group_announcements(group_id, notice_id);

CREATE TABLE IF NOT EXISTS group_config (
  group_id                              TEXT    PRIMARY KEY,
  enabled_modules                       TEXT    NOT NULL DEFAULT 'chat,mimic,moderator,learner',
  auto_mod                              INTEGER NOT NULL DEFAULT 1,
  daily_punishment_limit                INTEGER NOT NULL DEFAULT 10,
  punishments_today                     INTEGER NOT NULL DEFAULT 0,
  punishments_reset_date                TEXT    NOT NULL DEFAULT '',
  mimic_active_user_id                  TEXT,
  mimic_started_by                      TEXT,
  chat_trigger_keywords                 TEXT    NOT NULL DEFAULT '[]',
  chat_trigger_at_only                  INTEGER NOT NULL DEFAULT 0,
  chat_debounce_ms                      INTEGER NOT NULL DEFAULT 2000,
  mod_confidence_threshold              REAL    NOT NULL DEFAULT 0.7,
  mod_whitelist                         TEXT    NOT NULL DEFAULT '[]',
  appeal_window_hours                   INTEGER NOT NULL DEFAULT 24,
  kick_confirm_model                    TEXT    NOT NULL DEFAULT 'claude-opus-4-6',
  name_images_enabled                   INTEGER NOT NULL DEFAULT 1,
  name_images_collection_timeout_ms     INTEGER NOT NULL DEFAULT 120000,
  name_images_collection_max            INTEGER NOT NULL DEFAULT 20,
  name_images_cooldown_ms               INTEGER NOT NULL DEFAULT 300000,
  name_images_max_per_name              INTEGER NOT NULL DEFAULT 50,
  chat_at_mention_queue_max             INTEGER NOT NULL DEFAULT 5,
  chat_at_mention_burst_window_ms       INTEGER NOT NULL DEFAULT 30000,
  chat_at_mention_burst_threshold       INTEGER NOT NULL DEFAULT 3,
  name_images_blocklist                 TEXT    NOT NULL DEFAULT '[]',
  live_sticker_capture_enabled          INTEGER NOT NULL DEFAULT 1,
  sticker_legend_refresh_every_msgs     INTEGER NOT NULL DEFAULT 50,
  chat_persona_text                     TEXT,
  active_character_id                   TEXT,
  char_started_by                       TEXT,
  chat_lore_enabled                     INTEGER NOT NULL DEFAULT 1,
  repeater_enabled                      INTEGER NOT NULL DEFAULT 1,
  repeater_min_count                    INTEGER NOT NULL DEFAULT 3,
  repeater_cooldown_ms                  INTEGER NOT NULL DEFAULT 600000,
  repeater_min_content_length           INTEGER NOT NULL DEFAULT 2,
  repeater_max_content_length           INTEGER NOT NULL DEFAULT 100,
  lore_update_enabled                   INTEGER NOT NULL DEFAULT 1,
  lore_update_threshold                 INTEGER NOT NULL DEFAULT 200,
  lore_update_cooldown_ms               INTEGER NOT NULL DEFAULT 1800000,
  welcome_enabled                       INTEGER NOT NULL DEFAULT 1,
  id_guard_enabled                      INTEGER NOT NULL DEFAULT 1,
  sticker_first_enabled                 INTEGER NOT NULL DEFAULT 0,
  sticker_first_threshold               REAL    NOT NULL DEFAULT 0.55,
  chat_interest_categories              TEXT    NOT NULL DEFAULT '[]',
  chat_interest_min_hits                INTEGER NOT NULL DEFAULT 1,
  air_reading_enabled                   INTEGER NOT NULL DEFAULT 0,
  addressee_graph_enabled               INTEGER NOT NULL DEFAULT 0,
  link_across_groups                    INTEGER NOT NULL DEFAULT 0,
  created_at                            TEXT    NOT NULL DEFAULT '',
  updated_at                            TEXT    NOT NULL DEFAULT ''
);

-- M9.3: cross-group recognition audit. Every successful cross-group score read
-- is logged here so that the privacy boundary is auditable; rows pruned >90d.
CREATE TABLE IF NOT EXISTS cross_group_audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_gid TEXT    NOT NULL,
  target_uid    TEXT    NOT NULL,
  source_gids   TEXT    NOT NULL,  -- JSON array
  aggregated    REAL    NOT NULL,
  ts            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cross_group_audit_ts ON cross_group_audit(ts DESC);

CREATE TABLE IF NOT EXISTS live_stickers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    TEXT    NOT NULL,
  key         TEXT    NOT NULL,
  type        TEXT    NOT NULL,
  cq_code     TEXT    NOT NULL,
  summary     TEXT,
  count       INTEGER NOT NULL DEFAULT 1,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  UNIQUE(group_id, key)
);
CREATE INDEX IF NOT EXISTS idx_live_stickers_group_count ON live_stickers(group_id, count DESC);

CREATE TABLE IF NOT EXISTS name_images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  file_path   TEXT    NOT NULL,
  source_file TEXT,
  added_by    TEXT    NOT NULL,
  added_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_name_images_group_name ON name_images(group_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_name_images_source ON name_images(group_id, name, source_file) WHERE source_file IS NOT NULL;

CREATE TABLE IF NOT EXISTS image_descriptions (
  file_key    TEXT    PRIMARY KEY,
  description TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_image_desc_created ON image_descriptions(created_at);

CREATE TABLE IF NOT EXISTS bot_replies (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id             TEXT    NOT NULL,
  trigger_msg_id       TEXT,
  trigger_user_nickname TEXT,
  trigger_content      TEXT    NOT NULL,
  bot_reply            TEXT    NOT NULL,
  module               TEXT    NOT NULL,
  sent_at              INTEGER NOT NULL,
  rating               INTEGER,
  rating_comment       TEXT,
  rated_at             INTEGER,
  was_evasive          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_bot_replies_group ON bot_replies(group_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_replies_unrated ON bot_replies(rating) WHERE rating IS NULL;

CREATE TABLE IF NOT EXISTS local_stickers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id          TEXT    NOT NULL,
  key               TEXT    NOT NULL,
  type              TEXT    NOT NULL,
  local_path        TEXT,
  cq_code           TEXT    NOT NULL,
  summary           TEXT,
  context_samples   TEXT    NOT NULL DEFAULT '[]',
  count             INTEGER NOT NULL DEFAULT 1,
  first_seen        INTEGER NOT NULL,
  last_seen         INTEGER NOT NULL,
  usage_positive    INTEGER NOT NULL DEFAULT 0,
  usage_negative    INTEGER NOT NULL DEFAULT 0,
  blocked           INTEGER NOT NULL DEFAULT 0,
  embedding_vec     BLOB,
  UNIQUE(group_id, key)
);

CREATE INDEX IF NOT EXISTS idx_local_stickers_group ON local_stickers(group_id, count DESC);

CREATE TABLE IF NOT EXISTS learned_facts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id             TEXT    NOT NULL,
  topic                TEXT,
  fact                 TEXT    NOT NULL,
  source_user_id       TEXT,
  source_user_nickname TEXT,
  source_msg_id        TEXT,
  bot_reply_id         INTEGER,
  confidence           REAL    NOT NULL DEFAULT 1.0,
  status               TEXT    NOT NULL DEFAULT 'active',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  embedding_vec        BLOB,
  embedding_status     TEXT    DEFAULT 'pending',
  last_attempt_at      INTEGER,
  canonical_form       TEXT,
  persona_form         TEXT
);

CREATE INDEX IF NOT EXISTS idx_learned_facts_group_active
  ON learned_facts(group_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_learned_facts_group_pending
  ON learned_facts(group_id, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_learned_facts_null_embedding
  ON learned_facts(id) WHERE status = 'active' AND embedding_vec IS NULL;

-- FTS5 virtual table for BM25 hybrid retrieval. trigram tokenizer required for CJK:
-- unicode61 treats contiguous CJK runs as a single token, so MATCH '"偶像大师"' against
-- INSERT '偶像大师是另一款手游' returns 0 rows. trigram matches any 3-char substring.
CREATE VIRTUAL TABLE IF NOT EXISTS learned_facts_fts USING fts5(
  canonical_form,
  fact,
  group_id UNINDEXED,
  content='learned_facts',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS learned_facts_ai AFTER INSERT ON learned_facts BEGIN
  INSERT INTO learned_facts_fts(rowid, canonical_form, fact, group_id)
  VALUES (new.id, new.canonical_form, new.fact, new.group_id);
END;

CREATE TRIGGER IF NOT EXISTS learned_facts_ad AFTER DELETE ON learned_facts BEGIN
  INSERT INTO learned_facts_fts(learned_facts_fts, rowid, canonical_form, fact, group_id)
  VALUES ('delete', old.id, old.canonical_form, old.fact, old.group_id);
END;

CREATE TRIGGER IF NOT EXISTS learned_facts_au AFTER UPDATE ON learned_facts BEGIN
  INSERT INTO learned_facts_fts(learned_facts_fts, rowid, canonical_form, fact, group_id)
  VALUES ('delete', old.id, old.canonical_form, old.fact, old.group_id);
  INSERT INTO learned_facts_fts(rowid, canonical_form, fact, group_id)
  VALUES (new.id, new.canonical_form, new.fact, new.group_id);
END;

-- Archive tables for messages and bot_replies (3+ months old data)
CREATE TABLE IF NOT EXISTS messages_archive (
  id                INTEGER PRIMARY KEY,
  group_id          TEXT    NOT NULL,
  user_id           TEXT    NOT NULL,
  nickname          TEXT    NOT NULL DEFAULT '',
  content           TEXT    NOT NULL,
  raw_content       TEXT,
  timestamp         INTEGER NOT NULL,
  deleted           INTEGER NOT NULL DEFAULT 0,
  source_message_id TEXT
);

CREATE TABLE IF NOT EXISTS bot_replies_archive (
  id                   INTEGER PRIMARY KEY,
  group_id             TEXT    NOT NULL,
  trigger_msg_id       TEXT,
  trigger_user_nickname TEXT,
  trigger_content      TEXT    NOT NULL,
  bot_reply            TEXT    NOT NULL,
  module               TEXT    NOT NULL,
  sent_at              INTEGER NOT NULL,
  rating               INTEGER,
  rating_comment       TEXT,
  rated_at             INTEGER
);

-- bot_replies.was_evasive: 1 when bot emitted an evasive reply (e.g. "忘了" / "考我呢").
-- Existing DBs are migrated via runtime ALTER TABLE in db.ts._runMigrations.

CREATE TABLE IF NOT EXISTS pending_moderation (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id         TEXT    NOT NULL,
  msg_id           TEXT    NOT NULL,
  user_id          TEXT    NOT NULL,
  user_nickname    TEXT,
  content          TEXT    NOT NULL,
  severity         INTEGER NOT NULL,
  reason           TEXT    NOT NULL,
  proposed_action  TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'pending',
  created_at       INTEGER NOT NULL,
  decided_at       INTEGER,
  decided_by       TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_moderation_status
  ON pending_moderation(status, created_at);

CREATE TABLE IF NOT EXISTS welcome_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id     TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  welcomed_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_welcome_log_user ON welcome_log(group_id, user_id, welcomed_at DESC);

CREATE TABLE IF NOT EXISTS forward_cache (
  forward_id        TEXT    PRIMARY KEY,
  expanded_text     TEXT    NOT NULL,
  nested_image_keys TEXT    NOT NULL DEFAULT '[]',
  fetched_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forward_cache_fetched ON forward_cache(fetched_at);

-- bandori_lives: daily-scraped BanG Dream! live event schedule.
-- fetched_at / last_seen_at are unix seconds.
CREATE TABLE IF NOT EXISTS bandori_lives (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key        TEXT    NOT NULL UNIQUE,
  title            TEXT    NOT NULL,
  start_date       TEXT,                          -- YYYY-MM-DD, NULL if unparseable
  end_date         TEXT,                          -- YYYY-MM-DD, NULL if single-day or unknown
  venue            TEXT,
  city             TEXT,
  bands            TEXT    NOT NULL DEFAULT '[]', -- JSON array
  detail_url       TEXT,
  ticket_info_text TEXT,
  fetched_at       INTEGER NOT NULL,              -- unix seconds
  last_seen_at     INTEGER NOT NULL,              -- unix seconds
  raw_hash         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bandori_lives_start_date ON bandori_lives(start_date);
CREATE INDEX IF NOT EXISTS idx_bandori_lives_last_seen  ON bandori_lives(last_seen_at);

-- jargon_candidates: auto-detected group-specific jargon candidates.
-- Mined by JargonMiner from message frequency analysis + LLM inference.
-- promoted column (memes-v1): 0=active, 1=promoted to meme_graph, 2=promoted to learned_facts.
CREATE TABLE IF NOT EXISTS jargon_candidates (
  group_id              TEXT    NOT NULL,
  content               TEXT    NOT NULL,
  count                 INTEGER NOT NULL DEFAULT 1,
  contexts              TEXT    NOT NULL DEFAULT '[]',
  last_inference_count  INTEGER NOT NULL DEFAULT 0,
  meaning               TEXT,
  -- is_jargon sentinel: -1=stale-unknown, 0=pending, 1=confirmed-jargon, 2=promoted
  is_jargon             INTEGER NOT NULL DEFAULT 0,
  promoted              INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  PRIMARY KEY (group_id, content)
);
CREATE INDEX IF NOT EXISTS idx_jargon_group_count ON jargon_candidates(group_id, count DESC);
CREATE INDEX IF NOT EXISTS idx_jargon_updated ON jargon_candidates(group_id, updated_at);

-- phrase_candidates: multi-word (2-5 gram) jargon candidates mined via sliding window.
-- Similar structure to jargon_candidates but tracks gram length separately.
-- Mined by PhraseMiner; promoted to meme_graph by MemeClusterer.
CREATE TABLE IF NOT EXISTS phrase_candidates (
  group_id              TEXT    NOT NULL,
  content               TEXT    NOT NULL,
  gram_len              INTEGER NOT NULL,         -- 2-5 grams
  count                 INTEGER NOT NULL DEFAULT 1,
  contexts              TEXT    NOT NULL DEFAULT '[]',
  last_inference_count  INTEGER NOT NULL DEFAULT 0,
  meaning               TEXT,
  is_jargon             INTEGER NOT NULL DEFAULT 0,
  promoted              INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  PRIMARY KEY (group_id, content, gram_len)
);
CREATE INDEX IF NOT EXISTS idx_phrase_group_count ON phrase_candidates(group_id, count DESC);
CREATE INDEX IF NOT EXISTS idx_phrase_unpromoted ON phrase_candidates(group_id, is_jargon, promoted) WHERE is_jargon = 1 AND promoted = 0;

-- meme_graph: clustered meme entries after inference + variant aggregation.
-- Canonical form + variants list + optional origin event trace.
-- admin PATCH /memes/:id sets status='manual_edit' to freeze canonical + meaning;
-- clusterer respects this and doesn't overwrite those fields.
CREATE TABLE IF NOT EXISTS meme_graph (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id           TEXT    NOT NULL,
  canonical          TEXT    NOT NULL,
  variants           TEXT    NOT NULL DEFAULT '[]',      -- JSON array of variant strings
  meaning            TEXT    NOT NULL,
  origin_event       TEXT,                               -- LLM-inferred context trigger
  origin_msg_id      TEXT,
  origin_user_id     TEXT,
  origin_ts          INTEGER,
  first_seen_count   INTEGER NOT NULL DEFAULT 1,         -- count at discovery
  total_count        INTEGER NOT NULL DEFAULT 1,         -- cumulative, always mutable
  confidence         REAL    NOT NULL DEFAULT 0.5,       -- 0.3-1.0
  status             TEXT    NOT NULL DEFAULT 'active',  -- 'active' | 'demoted' | 'manual_edit'
  embedding_vec      BLOB,                               -- NULL until backfilled
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE(group_id, canonical)
);
CREATE INDEX IF NOT EXISTS idx_meme_group_active ON meme_graph(group_id, status) WHERE status IN ('active', 'manual_edit');
CREATE INDEX IF NOT EXISTS idx_meme_group_updated ON meme_graph(group_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_meme_null_embedding ON meme_graph(id) WHERE embedding_vec IS NULL;

-- image_mod_cache: cached image moderation verdicts, keyed by sha256 file_key, TTL 7 days.
CREATE TABLE IF NOT EXISTS image_mod_cache (
  file_key   TEXT    PRIMARY KEY,
  violation  INTEGER NOT NULL,
  severity   INTEGER NOT NULL,
  reason     TEXT,
  rule_id    INTEGER,
  created_at INTEGER NOT NULL
);

-- mod_rejections: moderator self-learning false positive examples.
CREATE TABLE IF NOT EXISTS mod_rejections (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id      TEXT    NOT NULL,
  content       TEXT    NOT NULL,
  reason        TEXT    NOT NULL,
  user_nickname TEXT,
  user_id       TEXT,
  severity      INTEGER,
  context_snippet TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mod_rejections_group_ts ON mod_rejections(group_id, created_at DESC);

-- user_affinity: per-group per-user affinity (好感度) tracking.
CREATE TABLE IF NOT EXISTS user_affinity (
  group_id         TEXT    NOT NULL,
  user_id          TEXT    NOT NULL,
  score            INTEGER NOT NULL DEFAULT 30,
  last_interaction INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

-- expression_patterns: bot reply style learning.
CREATE TABLE IF NOT EXISTS expression_patterns (
  group_id    TEXT    NOT NULL,
  situation   TEXT    NOT NULL,
  expression  TEXT    NOT NULL,
  weight      REAL    NOT NULL DEFAULT 1.0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (group_id, situation, expression)
);

CREATE INDEX IF NOT EXISTS idx_expression_patterns_group_weight ON expression_patterns(group_id, weight DESC);

-- groupmate_expression_samples: recurring groupmate expressions learned from non-bot messages.
-- Replaces user→bot pair learning in expression_patterns (schema_version=1).
-- Reader defaults to this table; expression_patterns kept on disk for rollback.
CREATE TABLE IF NOT EXISTS groupmate_expression_samples (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id             TEXT    NOT NULL,
  expression           TEXT    NOT NULL,
  expression_hash      TEXT    NOT NULL,
  speaker_user_ids     TEXT    NOT NULL,
  speaker_count        INTEGER NOT NULL DEFAULT 1,
  source_message_ids   TEXT    NOT NULL,
  occurrence_count     INTEGER NOT NULL DEFAULT 1,
  first_seen_at        INTEGER NOT NULL,
  last_active_at       INTEGER NOT NULL,
  checked_by           TEXT,
  rejected             INTEGER NOT NULL DEFAULT 0,
  modified_by          TEXT,
  schema_version       INTEGER NOT NULL DEFAULT 2
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gex_group_hash
  ON groupmate_expression_samples(group_id, expression_hash);
CREATE INDEX IF NOT EXISTS idx_gex_group_quality
  ON groupmate_expression_samples(group_id, speaker_count DESC, occurrence_count DESC, last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_gex_group_active
  ON groupmate_expression_samples(group_id, last_active_at DESC);

-- user_styles: per-user speaking style profiles.
CREATE TABLE IF NOT EXISTS user_styles (
  group_id    TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  nickname    TEXT    NOT NULL,
  style_json  TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

-- user_styles_aggregate (M8.2): per-group rollup of user style profiles.
-- Populated by StyleLearner when ≥3 users have analyzed styles; consumed by
-- chat identity prompt to inject a "group speech vibe" section.
CREATE TABLE IF NOT EXISTS user_styles_aggregate (
  group_id       TEXT    PRIMARY KEY,
  aggregate_json TEXT    NOT NULL,
  user_count     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- interaction_stats: hourly-updated pairwise interaction counts for relationship tracking.
CREATE TABLE IF NOT EXISTS interaction_stats (
  group_id       TEXT    NOT NULL,
  from_user      TEXT    NOT NULL,
  to_user        TEXT    NOT NULL,
  reply_count    INTEGER NOT NULL DEFAULT 0,
  mention_count  INTEGER NOT NULL DEFAULT 0,
  name_ref_count INTEGER NOT NULL DEFAULT 0,
  last_updated   INTEGER NOT NULL,
  PRIMARY KEY (group_id, from_user, to_user)
);

CREATE INDEX IF NOT EXISTS idx_interaction_stats_group ON interaction_stats(group_id, last_updated DESC);

-- social_relations: daily LLM-inferred relationship types between group members.
CREATE TABLE IF NOT EXISTS social_relations (
  group_id      TEXT    NOT NULL,
  from_user     TEXT    NOT NULL,
  to_user       TEXT    NOT NULL,
  relation_type TEXT    NOT NULL,
  strength      REAL    NOT NULL DEFAULT 0.5,
  evidence      TEXT,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (group_id, from_user, to_user)
);

CREATE INDEX IF NOT EXISTS idx_social_relations_group ON social_relations(group_id, strength DESC);

-- persona_patch_proposals (M6.6): self-reflection → persona patch proposals,
-- queued here pending admin review. status lifecycle:
--   pending → approved (admin /persona_apply, updates group_config.chat_persona_text)
--           → rejected (admin /persona_reject)
--           → superseded (another proposal approved, older pendings auto-close)
--           → expired (older than PERSONA_PATCH_TTL_DAYS, filtered at listPending time
--             — NOT via a stored expires_at column. Runtime cutoff keeps the row
--             auditable after it times out without rewriting state every tick.)
-- old_persona_text snapshot captured at creation time so the diff/apply view is
-- stable even if someone manually edited group_config.chat_persona_text between
-- propose and apply (apply does a conflict check; see repo.apply).
CREATE TABLE IF NOT EXISTS persona_patch_proposals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id          TEXT    NOT NULL,
  old_persona_text  TEXT,                            -- nullable: empty persona → override hint
  new_persona_text  TEXT    NOT NULL,
  reasoning         TEXT    NOT NULL,
  diff_summary      TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'pending', -- pending|approved|rejected|superseded
  kind              TEXT    NOT NULL DEFAULT 'daily',   -- M8.1: 'daily' | 'weekly'
  created_at        INTEGER NOT NULL,                -- unix seconds
  decided_at        INTEGER,
  decided_by        TEXT
);

CREATE INDEX IF NOT EXISTS idx_persona_patch_group_created
  ON persona_patch_proposals(group_id, created_at DESC);
-- Partial index for the hot pending-lookup path — most groups have 0 pending rows most of the time.
CREATE INDEX IF NOT EXISTS idx_persona_patch_group_pending
  ON persona_patch_proposals(group_id, created_at DESC) WHERE status = 'pending';
-- M8.1: per-kind cadence + history queries.
CREATE INDEX IF NOT EXISTS idx_ppp_group_kind_created
  ON persona_patch_proposals(group_id, kind, created_at DESC);

-- mood_state (M9.2): per-group persisted valence/arousal. In-memory MoodTracker
-- hydrates from this table at construction and debounce-writes back (10s). Without
-- persistence the bot starts every process with neutral mood, losing accumulated
-- sentiment from the last session.
CREATE TABLE IF NOT EXISTS mood_state (
  group_id    TEXT    PRIMARY KEY,
  valence     REAL    NOT NULL DEFAULT 0,
  arousal     REAL    NOT NULL DEFAULT 0,
  last_update INTEGER NOT NULL
);

-- group_diary (W-B): daily/weekly/monthly rollup of group chatter, generated
-- by DiaryDistiller via REFLECTION_MODEL. Daily rows are produced nightly and
-- consumed by weekly rollup (which deletes them); weeklies by monthly rollup.
-- period_start/period_end are unix seconds marking Asia/Shanghai local-day
-- boundaries. UNIQUE(group_id, period_start, period_end, kind) makes duplicate
-- cron ticks idempotent.
CREATE TABLE IF NOT EXISTS group_diary (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id      TEXT    NOT NULL,
  period_start  INTEGER NOT NULL,
  period_end    INTEGER NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('daily','weekly','monthly')),
  summary       TEXT    NOT NULL,
  top_topics    TEXT    NOT NULL DEFAULT '[]',
  top_speakers  TEXT    NOT NULL DEFAULT '[]',
  mood          TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE(group_id, period_start, period_end, kind)
);
CREATE INDEX IF NOT EXISTS idx_group_diary_lookup ON group_diary(group_id, kind, period_end DESC);

-- honest_gaps (W-A): per-group tracker of terms the group uses often but that
-- the bot isn't grounded on. Streamed from every incoming group message; hot
-- terms (seen_count >= threshold) are formatted into the chat system prompt so
-- the bot can answer "啥来的" honestly instead of confabulating.
CREATE TABLE IF NOT EXISTS honest_gaps (
  group_id    TEXT    NOT NULL,
  term        TEXT    NOT NULL,
  seen_count  INTEGER NOT NULL DEFAULT 1,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  PRIMARY KEY (group_id, term)
);
CREATE INDEX IF NOT EXISTS idx_honest_gaps_group_count ON honest_gaps(group_id, seen_count DESC);

-- messages_fts (Path A): FTS5 BM25 over chat messages for on-demand jargon lookup.
-- trigram tokenizer required for CJK — unicode61 collapses CJK runs into one token.
-- group_id UNINDEXED: stored but not indexed by FTS; group scoping done post-match.
-- content_rowid links to messages.id (INTEGER PK, not SQLite rowid alias here).
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  group_id UNINDEXED,
  content='messages',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content, group_id)
  VALUES (new.id, new.content, new.group_id);
END;

-- FTS5 content table delete: must use the special 'delete' command row.
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content, group_id)
  VALUES ('delete', old.id, old.content, old.group_id);
END;

-- web_lookup_cache (Path C): CSE results keyed by (group_id, term), TTL 30 days.
CREATE TABLE IF NOT EXISTS web_lookup_cache (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    TEXT    NOT NULL,
  term        TEXT    NOT NULL,
  snippet     TEXT    NOT NULL,
  source_url  TEXT    NOT NULL,
  confidence  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_cache_term
  ON web_lookup_cache(group_id, term, expires_at DESC);
