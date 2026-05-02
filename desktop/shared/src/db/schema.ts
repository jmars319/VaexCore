import type { DbClient } from "./client";

export const initializeSchema = (db: DbClient) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS giveaways (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      keyword TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'ended')),
      winner_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      opened_at TEXT,
      closed_at TEXT,
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS giveaway_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      giveaway_id INTEGER NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
      twitch_user_id TEXT NOT NULL,
      login TEXT NOT NULL,
      display_name TEXT NOT NULL,
      entered_at TEXT NOT NULL,
      UNIQUE (giveaway_id, twitch_user_id)
    );

    CREATE TABLE IF NOT EXISTS giveaway_winners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      giveaway_id INTEGER NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
      twitch_user_id TEXT NOT NULL,
      login TEXT NOT NULL,
      display_name TEXT NOT NULL,
      drawn_at TEXT NOT NULL,
      claimed_at TEXT,
      delivered_at TEXT,
      rerolled_at TEXT,
      UNIQUE (giveaway_id, twitch_user_id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_twitch_user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feature_gates (
      feature_key TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK (mode IN ('off', 'test', 'live')),
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbound_messages (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('setup', 'bot')),
      status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'retrying', 'sent', 'failed', 'resent')),
      message TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      queued_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      failure_category TEXT NOT NULL DEFAULT 'none',
      retry_after_ms INTEGER,
      next_attempt_at TEXT,
      queue_depth INTEGER,
      category TEXT NOT NULL DEFAULT 'operator',
      action TEXT NOT NULL DEFAULT '',
      importance TEXT NOT NULL DEFAULT 'normal' CHECK (importance IN ('normal', 'important', 'critical')),
      giveaway_id INTEGER REFERENCES giveaways(id) ON DELETE SET NULL,
      resent_from TEXT
    );

    CREATE TABLE IF NOT EXISTS giveaway_message_templates (
      action TEXT PRIMARY KEY,
      template TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operator_message_templates (
      id TEXT PRIMARY KEY,
      template TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS custom_commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      permission TEXT NOT NULL CHECK (permission IN ('viewer', 'moderator', 'broadcaster', 'admin')),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      global_cooldown_seconds INTEGER NOT NULL DEFAULT 30,
      user_cooldown_seconds INTEGER NOT NULL DEFAULT 10,
      use_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS custom_command_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command_id INTEGER NOT NULL REFERENCES custom_commands(id) ON DELETE CASCADE,
      alias TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS custom_command_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command_id INTEGER NOT NULL REFERENCES custom_commands(id) ON DELETE CASCADE,
      response_text TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS custom_command_user_cooldowns (
      command_id INTEGER NOT NULL REFERENCES custom_commands(id) ON DELETE CASCADE,
      user_key TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      PRIMARY KEY (command_id, user_key)
    );

    CREATE TABLE IF NOT EXISTS custom_command_invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command_id INTEGER REFERENCES custom_commands(id) ON DELETE SET NULL,
      command_name TEXT NOT NULL,
      alias_used TEXT NOT NULL,
      user_key TEXT NOT NULL,
      user_login TEXT NOT NULL,
      response_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS timers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      message TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      min_chat_messages INTEGER NOT NULL DEFAULT 0,
      chat_messages_since_last_fire INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      fire_count INTEGER NOT NULL DEFAULT 0,
      last_sent_at TEXT NOT NULL DEFAULT '',
      next_fire_at TEXT NOT NULL DEFAULT '',
      last_status TEXT NOT NULL DEFAULT 'never',
      last_error TEXT NOT NULL DEFAULT '',
      last_outbound_message_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS moderation_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      blocked_terms_enabled INTEGER NOT NULL DEFAULT 0 CHECK (blocked_terms_enabled IN (0, 1)),
      link_filter_enabled INTEGER NOT NULL DEFAULT 0 CHECK (link_filter_enabled IN (0, 1)),
      caps_filter_enabled INTEGER NOT NULL DEFAULT 0 CHECK (caps_filter_enabled IN (0, 1)),
      repeat_filter_enabled INTEGER NOT NULL DEFAULT 0 CHECK (repeat_filter_enabled IN (0, 1)),
      symbol_filter_enabled INTEGER NOT NULL DEFAULT 0 CHECK (symbol_filter_enabled IN (0, 1)),
      action TEXT NOT NULL DEFAULT 'warn' CHECK (action IN ('warn')),
      blocked_terms_action TEXT NOT NULL DEFAULT 'warn' CHECK (blocked_terms_action IN ('warn', 'delete', 'timeout')),
      link_filter_action TEXT NOT NULL DEFAULT 'warn' CHECK (link_filter_action IN ('warn', 'delete', 'timeout')),
      caps_filter_action TEXT NOT NULL DEFAULT 'warn' CHECK (caps_filter_action IN ('warn', 'delete', 'timeout')),
      repeat_filter_action TEXT NOT NULL DEFAULT 'warn' CHECK (repeat_filter_action IN ('warn', 'delete', 'timeout')),
      symbol_filter_action TEXT NOT NULL DEFAULT 'warn' CHECK (symbol_filter_action IN ('warn', 'delete', 'timeout')),
      timeout_seconds INTEGER NOT NULL DEFAULT 60,
      warning_message TEXT NOT NULL DEFAULT '@{user}, please keep chat within channel guidelines.',
      caps_min_length INTEGER NOT NULL DEFAULT 20,
      caps_ratio REAL NOT NULL DEFAULT 0.75,
      repeat_window_seconds INTEGER NOT NULL DEFAULT 30,
      repeat_limit INTEGER NOT NULL DEFAULT 3,
      symbol_min_length INTEGER NOT NULL DEFAULT 12,
      symbol_ratio REAL NOT NULL DEFAULT 0.6,
      escalation_enabled INTEGER NOT NULL DEFAULT 0 CHECK (escalation_enabled IN (0, 1)),
      escalation_window_seconds INTEGER NOT NULL DEFAULT 300,
      escalation_delete_after INTEGER NOT NULL DEFAULT 2,
      escalation_timeout_after INTEGER NOT NULL DEFAULT 3,
      exempt_broadcaster INTEGER NOT NULL DEFAULT 1 CHECK (exempt_broadcaster IN (0, 1)),
      exempt_moderators INTEGER NOT NULL DEFAULT 1 CHECK (exempt_moderators IN (0, 1)),
      exempt_vips INTEGER NOT NULL DEFAULT 0 CHECK (exempt_vips IN (0, 1)),
      exempt_subscribers INTEGER NOT NULL DEFAULT 0 CHECK (exempt_subscribers IN (0, 1)),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS moderation_blocked_terms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS moderation_hits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filter_type TEXT NOT NULL,
      action TEXT NOT NULL,
      user_key TEXT NOT NULL,
      user_login TEXT NOT NULL,
      message_preview TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS moderation_allowed_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS moderation_blocked_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS moderation_link_permits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_login TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS giveaway_reminder_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      interval_minutes INTEGER NOT NULL DEFAULT 10,
      last_sent_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_giveaways_status ON giveaways(status);
    CREATE INDEX IF NOT EXISTS idx_giveaway_entries_giveaway_id
      ON giveaway_entries(giveaway_id);
    CREATE INDEX IF NOT EXISTS idx_giveaway_winners_giveaway_id
      ON giveaway_winners(giveaway_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_feature_gates_mode ON feature_gates(mode);
    CREATE INDEX IF NOT EXISTS idx_outbound_messages_updated_at
      ON outbound_messages(updated_at);
    CREATE INDEX IF NOT EXISTS idx_outbound_messages_giveaway_id
      ON outbound_messages(giveaway_id);
    CREATE INDEX IF NOT EXISTS idx_custom_command_aliases_command_id
      ON custom_command_aliases(command_id);
    CREATE INDEX IF NOT EXISTS idx_custom_command_responses_command_id
      ON custom_command_responses(command_id);
    CREATE INDEX IF NOT EXISTS idx_custom_command_invocations_created_at
      ON custom_command_invocations(created_at);
    CREATE INDEX IF NOT EXISTS idx_custom_command_invocations_command_id
      ON custom_command_invocations(command_id);
    CREATE INDEX IF NOT EXISTS idx_timers_enabled_next_fire
      ON timers(enabled, next_fire_at);
    CREATE INDEX IF NOT EXISTS idx_moderation_hits_created_at
      ON moderation_hits(created_at);
    CREATE INDEX IF NOT EXISTS idx_moderation_blocked_terms_enabled
      ON moderation_blocked_terms(enabled);
    CREATE INDEX IF NOT EXISTS idx_moderation_allowed_links_enabled
      ON moderation_allowed_links(enabled);
    CREATE INDEX IF NOT EXISTS idx_moderation_link_permits_user
      ON moderation_link_permits(user_login, expires_at, used_at);
  `);

  ensureColumn(db, "outbound_messages", "failure_category", "TEXT NOT NULL DEFAULT 'none'");
  ensureColumn(db, "outbound_messages", "retry_after_ms", "INTEGER");
  ensureColumn(db, "outbound_messages", "next_attempt_at", "TEXT");
  ensureColumn(db, "timers", "min_chat_messages", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "timers", "chat_messages_since_last_fire", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "moderation_settings", "exempt_broadcaster", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "moderation_settings", "exempt_moderators", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "moderation_settings", "exempt_vips", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "moderation_settings", "exempt_subscribers", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "moderation_settings", "blocked_terms_action", "TEXT NOT NULL DEFAULT 'warn' CHECK (blocked_terms_action IN ('warn', 'delete', 'timeout'))");
  ensureColumn(db, "moderation_settings", "link_filter_action", "TEXT NOT NULL DEFAULT 'warn' CHECK (link_filter_action IN ('warn', 'delete', 'timeout'))");
  ensureColumn(db, "moderation_settings", "caps_filter_action", "TEXT NOT NULL DEFAULT 'warn' CHECK (caps_filter_action IN ('warn', 'delete', 'timeout'))");
  ensureColumn(db, "moderation_settings", "repeat_filter_action", "TEXT NOT NULL DEFAULT 'warn' CHECK (repeat_filter_action IN ('warn', 'delete', 'timeout'))");
  ensureColumn(db, "moderation_settings", "symbol_filter_action", "TEXT NOT NULL DEFAULT 'warn' CHECK (symbol_filter_action IN ('warn', 'delete', 'timeout'))");
  ensureColumn(db, "moderation_settings", "timeout_seconds", "INTEGER NOT NULL DEFAULT 60");
  ensureColumn(db, "moderation_settings", "escalation_enabled", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "moderation_settings", "escalation_window_seconds", "INTEGER NOT NULL DEFAULT 300");
  ensureColumn(db, "moderation_settings", "escalation_delete_after", "INTEGER NOT NULL DEFAULT 2");
  ensureColumn(db, "moderation_settings", "escalation_timeout_after", "INTEGER NOT NULL DEFAULT 3");
};

const ensureColumn = (
  db: DbClient,
  table: string,
  column: string,
  definition: string
) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];

  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};
