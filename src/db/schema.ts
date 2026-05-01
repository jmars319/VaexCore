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
  `);

  ensureColumn(db, "outbound_messages", "failure_category", "TEXT NOT NULL DEFAULT 'none'");
  ensureColumn(db, "outbound_messages", "retry_after_ms", "INTEGER");
  ensureColumn(db, "outbound_messages", "next_attempt_at", "TEXT");
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
