import type { ChatMessage } from "./chatMessage";
import type { DbClient } from "../db/client";
import {
  parseSafeInteger,
  redactSecrets,
  safeJsonStringify
} from "./security";

export const auditRetentionDefaults = {
  maxEntries: 1000,
  maxAgeDays: 90,
  maxReadLimit: 500
} as const;

export type AuditRetentionPolicy = {
  maxEntries?: number;
  maxAgeDays?: number;
};

export type AuditLogRow = {
  id: number;
  actor_twitch_user_id: string;
  action: string;
  target: string | null;
  metadata_json: string;
  created_at: string;
};

export const writeAuditLog = (
  db: DbClient,
  actor: ChatMessage,
  action: string,
  target: string,
  metadata: Record<string, unknown>,
  options: { createdAt?: string; retention?: AuditRetentionPolicy } = {}
) => {
  const createdAt = options.createdAt ?? timestamp();

  db
    .prepare(
      `
        INSERT INTO audit_logs
          (actor_twitch_user_id, action, target, metadata_json, created_at)
        VALUES
          (@actorTwitchUserId, @action, @target, @metadataJson, @createdAt)
      `
    )
    .run({
      actorTwitchUserId: actor.userId || actor.userLogin,
      action,
      target,
      metadataJson: safeJsonStringify({
        actionType: action,
        actorLogin: actor.userLogin,
        ...metadata
      }),
      createdAt
    });

  pruneAuditLogs(db, options.retention);
};

export const getRecentAuditLogs = (db: DbClient, limit = 100) => {
  const safeLimit = parseSafeInteger(limit, {
    field: "Audit log limit",
    fallback: 100,
    min: 1,
    max: auditRetentionDefaults.maxReadLimit
  });

  return (db
    .prepare(
      `
        SELECT *
        FROM audit_logs
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `
    )
    .all(safeLimit) as AuditLogRow[]).map(redactAuditLogRow);
};

export const pruneAuditLogs = (
  db: DbClient,
  policy: AuditRetentionPolicy = {}
) => {
  const maxEntries = normalizeRetentionNumber(
    policy.maxEntries,
    auditRetentionDefaults.maxEntries,
    "Audit retention entries"
  );
  const maxAgeDays = normalizeRetentionNumber(
    policy.maxAgeDays,
    auditRetentionDefaults.maxAgeDays,
    "Audit retention days"
  );
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

  db.prepare("DELETE FROM audit_logs WHERE created_at < ?").run(cutoff);
  db
    .prepare(
      `
        DELETE FROM audit_logs
        WHERE id IN (
          SELECT id
          FROM audit_logs
          ORDER BY created_at DESC, id DESC
          LIMIT -1 OFFSET ?
        )
      `
    )
    .run(maxEntries);
};

export const safeAuditMetadataJson = (raw: string) => {
  try {
    return JSON.stringify(redactSecrets(JSON.parse(raw)));
  } catch {
    return JSON.stringify({
      unreadable: true
    });
  }
};

const redactAuditLogRow = (row: AuditLogRow): AuditLogRow => ({
  ...row,
  metadata_json: safeAuditMetadataJson(row.metadata_json)
});

const normalizeRetentionNumber = (
  value: unknown,
  fallback: number,
  field: string
) =>
  parseSafeInteger(value, {
    field,
    fallback,
    min: 1,
    max: 100_000
  });

const timestamp = () => new Date().toISOString();
