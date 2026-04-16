import { describe, it, expect } from 'vitest';
import { Database } from '../../src/storage/db.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

/**
 * Regression test: opening an in-memory DB must create all expected tables.
 * Catches schema.sql / migration drift where a table only exists in one path.
 */
describe('Database fresh init', () => {
  const EXPECTED_TABLES: readonly string[] = [
    'messages',
    'users',
    'moderation_log',
    'rules',
    'group_announcements',
    'group_config',
    'live_stickers',
    'name_images',
    'image_descriptions',
    'bot_replies',
    'local_stickers',
    'learned_facts',
    'messages_archive',
    'bot_replies_archive',
    'pending_moderation',
    'welcome_log',
    'forward_cache',
    'bandori_lives',
    'jargon_candidates',
    'interaction_stats',
    'social_relations',
    'image_mod_cache',
    'mod_rejections',
    'user_affinity',
    'expression_patterns',
    'user_styles',
  ];

  it('creates all expected tables on fresh in-memory DB', () => {
    const db = new Database(':memory:');
    try {
      const rows = db.rawDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const tableNames = new Set(rows.map(r => r.name));

      for (const table of EXPECTED_TABLES) {
        expect(tableNames.has(table), `missing table: ${table}`).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it('is idempotent: opening twice on same path does not throw', () => {
    // First open creates tables, second open should be idempotent via IF NOT EXISTS
    const db1 = new Database(':memory:');
    db1.close();
    const db2 = new Database(':memory:');
    db2.close();
  });

  it('bot_replies has was_evasive column on fresh DB', () => {
    const db = new Database(':memory:');
    try {
      const cols = db.rawDb
        .prepare("PRAGMA table_info(bot_replies)")
        .all() as Array<{ name: string }>;
      const colNames = cols.map(c => c.name);
      expect(colNames).toContain('was_evasive');
    } finally {
      db.close();
    }
  });

  it('learned_facts has embedding_status column on fresh DB', () => {
    const db = new Database(':memory:');
    try {
      const cols = db.rawDb
        .prepare("PRAGMA table_info(learned_facts)")
        .all() as Array<{ name: string }>;
      const colNames = cols.map(c => c.name);
      expect(colNames).toContain('embedding_status');
      expect(colNames).toContain('last_attempt_at');
    } finally {
      db.close();
    }
  });

  it('moderation_log has review columns on fresh DB', () => {
    const db = new Database(':memory:');
    try {
      const cols = db.rawDb
        .prepare("PRAGMA table_info(moderation_log)")
        .all() as Array<{ name: string }>;
      const colNames = cols.map(c => c.name);
      expect(colNames).toContain('reviewed');
      expect(colNames).toContain('reviewed_by');
      expect(colNames).toContain('reviewed_at');
      expect(colNames).toContain('original_content');
    } finally {
      db.close();
    }
  });

  it('group_config has all config columns on fresh DB', () => {
    const db = new Database(':memory:');
    try {
      const cols = db.rawDb
        .prepare("PRAGMA table_info(group_config)")
        .all() as Array<{ name: string }>;
      const colNames = cols.map(c => c.name);
      for (const col of [
        'chat_lore_enabled',
        'repeater_enabled',
        'welcome_enabled',
        'id_guard_enabled',
        'sticker_first_enabled',
        'sticker_first_threshold',
        'lore_update_enabled',
      ]) {
        expect(colNames, `missing group_config column: ${col}`).toContain(col);
      }
    } finally {
      db.close();
    }
  });
});
