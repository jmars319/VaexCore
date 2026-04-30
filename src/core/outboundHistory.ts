import type { DbClient } from "../db/client";
import type { MessageQueueEventStatus, MessageQueueMetadata } from "./messageQueue";

export type OutboundMessageSource = "setup" | "bot";
export type OutboundMessageStatus = MessageQueueEventStatus | "resent";
export type OutboundMessageImportance = NonNullable<MessageQueueMetadata["importance"]>;
export type OutboundMessageCategory = NonNullable<MessageQueueMetadata["category"]>;

export type OutboundMessageRecord = {
  id: string;
  source: OutboundMessageSource;
  status: OutboundMessageStatus;
  message: string;
  attempts: number;
  queuedAt: string;
  updatedAt: string;
  reason: string;
  queueDepth?: number;
  category: OutboundMessageCategory;
  action: string;
  importance: OutboundMessageImportance;
  giveawayId?: number;
  resentFrom?: string;
};

export type OutboundHistoryEvent = {
  id: string;
  source: OutboundMessageSource;
  status: MessageQueueEventStatus;
  message?: string;
  attempts?: number;
  queuedAt?: string;
  updatedAt?: string;
  reason?: string;
  queueDepth?: number;
  metadata?: MessageQueueMetadata;
};

type OutboundMessageRow = {
  id: string;
  source: OutboundMessageSource;
  status: OutboundMessageStatus;
  message: string;
  attempts: number;
  queued_at: string;
  updated_at: string;
  reason: string;
  queue_depth: number | null;
  category: OutboundMessageCategory;
  action: string;
  importance: OutboundMessageImportance;
  giveaway_id: number | null;
  resent_from: string | null;
};

export const createOutboundHistory = (db: DbClient) => {
  const records = new Map<string, OutboundMessageRecord>();
  const loadRecent = () => {
    records.clear();
    const rows = db
      .prepare(
        `
          SELECT *
          FROM outbound_messages
          ORDER BY updated_at DESC
          LIMIT 100
        `
      )
      .all() as OutboundMessageRow[];

    for (const row of rows) {
      records.set(row.id, outboundRecordFromRow(row));
    }
  };
  const list = () => {
    loadRecent();
    return [...records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };

  loadRecent();

  return {
    record(event: OutboundHistoryEvent) {
      const now = new Date().toISOString();
      const existing = records.get(event.id);
      const classified = classifyOutboundMessage(event.message ?? existing?.message ?? "");
      const metadata = {
        ...classified,
        ...compactOutboundMetadata(event.metadata)
      };
      const next: OutboundMessageRecord = {
        id: event.id,
        source: event.source,
        status: event.status,
        message: event.message ?? existing?.message ?? "",
        attempts: event.attempts ?? existing?.attempts ?? 0,
        queuedAt: event.queuedAt ?? existing?.queuedAt ?? now,
        updatedAt: event.updatedAt ?? now,
        reason: event.reason ?? existing?.reason ?? "",
        queueDepth: event.queueDepth ?? existing?.queueDepth,
        category: metadata.category ?? existing?.category ?? "operator",
        action: metadata.action ?? existing?.action ?? "",
        importance: metadata.importance ?? existing?.importance ?? "normal",
        giveawayId: metadata.giveawayId ?? existing?.giveawayId,
        resentFrom: metadata.resentFrom ?? existing?.resentFrom
      };
      records.set(event.id, next);
      persistOutboundRecord(db, next);
      trimOutboundHistory(records);
      return next;
    },
    list() {
      return list();
    },
    find(id: string | undefined) {
      if (!id) return undefined;
      loadRecent();
      return records.get(id);
    },
    latestFailed() {
      return list().find((record) => record.status === "failed");
    },
    markResent(id: string, resentMessageId: string) {
      const existing = records.get(id);

      if (!existing) {
        return;
      }

      const resent = {
        ...existing,
        status: "resent" as const,
        updatedAt: new Date().toISOString(),
        reason: `Resent as ${resentMessageId}`
      };
      records.set(id, resent);
      persistOutboundRecord(db, resent);
    },
    summary() {
      const current = list();
      const pending = current.filter((record) => isPendingOutboundStatus(record.status));
      const resent = current.filter((record) => record.status === "resent");
      const failed = current.filter((record) => record.status === "failed");
      const criticalFailed = failed.filter((record) => record.importance === "critical");
      const oldestPending = pending
        .slice()
        .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))[0];
      const latestFailed = failed[0];
      return {
        total: current.length,
        queued: pending.length,
        pending: pending.length,
        failed: failed.length,
        criticalFailed: criticalFailed.length,
        sent: current.filter((record) => record.status === "sent").length,
        resent: resent.length,
        delivered: current.filter((record) => record.status === "sent" || record.status === "resent").length,
        oldestPendingAt: oldestPending?.queuedAt ?? "",
        oldestPendingAgeMs: oldestPending ? Date.now() - Date.parse(oldestPending.queuedAt) : 0,
        latestFailedAt: latestFailed?.updatedAt ?? "",
        latestFailedAction: latestFailed?.action ?? "",
        latestFailedReason: latestFailed?.reason ?? ""
      };
    }
  };
};

export const classifyOutboundMessage = (message: string): MessageQueueMetadata => {
  if (message.startsWith("Giveaway started:")) {
    return { category: "giveaway", action: "start", importance: "critical" };
  }
  if (message.startsWith("Last call for ")) {
    return { category: "giveaway", action: "last-call", importance: "critical" };
  }
  if (message.startsWith("Reminder:")) {
    return { category: "giveaway", action: "reminder", importance: "important" };
  }
  if (message.startsWith("Entries closed for ")) {
    return { category: "giveaway", action: "close", importance: "critical" };
  }
  if (message.startsWith("Winner") || message === "No eligible winners available.") {
    return { category: "giveaway", action: "draw", importance: "critical" };
  }
  if (message.startsWith("Giveaway ended:")) {
    return { category: "giveaway", action: "end", importance: "critical" };
  }
  if (message.includes(" was rerolled.")) {
    return { category: "giveaway", action: "reroll", importance: "important" };
  }
  if (message.includes(" marked claimed.")) {
    return { category: "giveaway", action: "claim", importance: "normal" };
  }
  if (message.includes(" marked delivered.")) {
    return { category: "giveaway", action: "deliver", importance: "normal" };
  }
  if (message.startsWith("Thanks ") || message.includes("already entered in")) {
    return { category: "giveaway", action: "entry", importance: "normal" };
  }

  return { category: "operator", importance: "normal" };
};

export const compactOutboundMetadata = (metadata: MessageQueueMetadata | undefined) => {
  const compact: MessageQueueMetadata = {};

  if (metadata?.category) compact.category = metadata.category;
  if (metadata?.action) compact.action = metadata.action;
  if (metadata?.importance) compact.importance = metadata.importance;
  if (metadata?.giveawayId !== undefined) compact.giveawayId = metadata.giveawayId;
  if (metadata?.resentFrom) compact.resentFrom = metadata.resentFrom;

  return compact;
};

export const isOutboundCategory = (value: string): value is OutboundMessageCategory =>
  ["operator", "giveaway", "system"].includes(value);

export const isOutboundImportance = (value: string): value is OutboundMessageImportance =>
  ["normal", "important", "critical"].includes(value);

export const isPendingOutboundStatus = (status: OutboundMessageStatus) =>
  status === "queued" || status === "retrying" || status === "sending";

const outboundRecordFromRow = (row: OutboundMessageRow): OutboundMessageRecord => ({
  id: row.id,
  source: row.source,
  status: row.status,
  message: row.message,
  attempts: row.attempts,
  queuedAt: row.queued_at,
  updatedAt: row.updated_at,
  reason: row.reason,
  queueDepth: row.queue_depth ?? undefined,
  category: row.category,
  action: row.action,
  importance: row.importance,
  giveawayId: row.giveaway_id ?? undefined,
  resentFrom: row.resent_from ?? undefined
});

const persistOutboundRecord = (db: DbClient, record: OutboundMessageRecord) => {
  db.prepare(
    `
      INSERT INTO outbound_messages (
        id,
        source,
        status,
        message,
        attempts,
        queued_at,
        updated_at,
        reason,
        queue_depth,
        category,
        action,
        importance,
        giveaway_id,
        resent_from
      ) VALUES (
        @id,
        @source,
        @status,
        @message,
        @attempts,
        @queuedAt,
        @updatedAt,
        @reason,
        @queueDepth,
        @category,
        @action,
        @importance,
        @giveawayId,
        @resentFrom
      )
      ON CONFLICT(id) DO UPDATE SET
        source = excluded.source,
        status = excluded.status,
        message = excluded.message,
        attempts = excluded.attempts,
        queued_at = excluded.queued_at,
        updated_at = excluded.updated_at,
        reason = excluded.reason,
        queue_depth = excluded.queue_depth,
        category = excluded.category,
        action = excluded.action,
        importance = excluded.importance,
        giveaway_id = excluded.giveaway_id,
        resent_from = excluded.resent_from
    `
  ).run({
    ...record,
    queueDepth: record.queueDepth ?? null,
    giveawayId: record.giveawayId ?? null,
    resentFrom: record.resentFrom ?? null
  });
};

const trimOutboundHistory = (records: Map<string, OutboundMessageRecord>) => {
  const max = 100;

  if (records.size <= max) {
    return;
  }

  const byUpdatedAt = [...records.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const record of byUpdatedAt.slice(0, records.size - max)) {
    records.delete(record.id);
  }
};
