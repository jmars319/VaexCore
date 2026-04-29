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

    CREATE INDEX IF NOT EXISTS idx_giveaways_status ON giveaways(status);
    CREATE INDEX IF NOT EXISTS idx_giveaway_entries_giveaway_id
      ON giveaway_entries(giveaway_id);
    CREATE INDEX IF NOT EXISTS idx_giveaway_winners_giveaway_id
      ON giveaway_winners(giveaway_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
  `);
};
