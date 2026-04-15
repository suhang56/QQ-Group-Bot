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
  appealed  INTEGER NOT NULL DEFAULT 0,
  reversed  INTEGER NOT NULL DEFAULT 0,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mod_log_user  ON moderation_log(user_id, group_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mod_log_msg   ON moderation_log(msg_id);

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
  created_at                            TEXT    NOT NULL DEFAULT '',
  updated_at                            TEXT    NOT NULL DEFAULT ''
);

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
  rated_at             INTEGER
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
  embedding_vec        BLOB
);

CREATE INDEX IF NOT EXISTS idx_learned_facts_group_active
  ON learned_facts(group_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_learned_facts_group_pending
  ON learned_facts(group_id, status) WHERE status = 'pending';

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
