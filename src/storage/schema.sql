CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id          TEXT    NOT NULL,
  user_id           TEXT    NOT NULL,
  nickname          TEXT    NOT NULL DEFAULT '',
  content           TEXT    NOT NULL,
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
  group_id                 TEXT    PRIMARY KEY,
  enabled_modules          TEXT    NOT NULL DEFAULT 'chat,mimic,moderator,learner',
  auto_mod                 INTEGER NOT NULL DEFAULT 1,
  daily_punishment_limit   INTEGER NOT NULL DEFAULT 10,
  punishments_today        INTEGER NOT NULL DEFAULT 0,
  punishments_reset_date   TEXT    NOT NULL DEFAULT '',
  mimic_active_user_id     TEXT,
  mimic_started_by         TEXT,
  chat_trigger_keywords    TEXT    NOT NULL DEFAULT '[]',
  chat_trigger_at_only     INTEGER NOT NULL DEFAULT 0,
  chat_debounce_ms         INTEGER NOT NULL DEFAULT 2000,
  mod_confidence_threshold REAL    NOT NULL DEFAULT 0.7,
  mod_whitelist            TEXT    NOT NULL DEFAULT '[]',
  appeal_window_hours      INTEGER NOT NULL DEFAULT 24,
  kick_confirm_model       TEXT    NOT NULL DEFAULT 'claude-opus-4-6',
  created_at               TEXT    NOT NULL DEFAULT '',
  updated_at               TEXT    NOT NULL DEFAULT ''
);
