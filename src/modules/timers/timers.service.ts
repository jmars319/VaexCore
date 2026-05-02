import type { ChatMessage } from "../../core/chatMessage";
import { writeAuditLog } from "../../core/auditLog";
import {
  assertNoSecretLikeContent,
  limits,
  parseSafeInteger,
  sanitizeChatMessage,
  sanitizeText
} from "../../core/security";
import type { DbClient } from "../../db/client";

export const timerLimits = {
  nameLength: 60,
  minIntervalMinutes: 5,
  maxIntervalMinutes: 24 * 60,
  maxChatMessages: 500,
  maxDuePerTick: 5,
  blockedRetryMs: 60_000
} as const;

export type TimerLastStatus = "never" | "queued" | "blocked" | "failed";

type TimerRow = {
  id: number;
  name: string;
  message: string;
  interval_minutes: number;
  min_chat_messages: number;
  chat_messages_since_last_fire: number;
  enabled: number;
  fire_count: number;
  last_sent_at: string;
  next_fire_at: string;
  last_status: TimerLastStatus;
  last_error: string;
  last_outbound_message_id: string;
  created_at: string;
  updated_at: string;
};

export type TimerDefinition = {
  id: number;
  name: string;
  message: string;
  intervalMinutes: number;
  minChatMessages: number;
  chatMessagesSinceLastFire: number;
  enabled: boolean;
  fireCount: number;
  lastSentAt: string;
  nextFireAt: string;
  lastStatus: TimerLastStatus;
  lastError: string;
  lastOutboundMessageId: string;
  createdAt: string;
  updatedAt: string;
};

export type TimerSaveInput = {
  id?: number;
  name?: unknown;
  message?: unknown;
  intervalMinutes?: unknown;
  minChatMessages?: unknown;
  enabled?: unknown;
};

export class TimersService {
  constructor(private readonly db: DbClient) {}

  listTimers(): TimerDefinition[] {
    return (this.db
      .prepare(
        `
          SELECT *
          FROM timers
          ORDER BY name ASC
        `
      )
      .all() as TimerRow[]).map(timerFromRow);
  }

  saveTimer(input: TimerSaveInput, actor: ChatMessage) {
    const existing = input.id ? this.requireTimerRow(Number(input.id)) : undefined;
    const existingTimer = existing ? timerFromRow(existing) : undefined;
    const name = normalizeTimerName(input.name ?? existingTimer?.name);
    const message = normalizeTimerMessage(input.message ?? existingTimer?.message);
    const intervalMinutes = normalizeTimerInterval(
      input.intervalMinutes,
      existingTimer?.intervalMinutes ?? timerLimits.minIntervalMinutes
    );
    const minChatMessages = normalizeTimerMinChatMessages(
      input.minChatMessages,
      existingTimer?.minChatMessages ?? 0
    );
    const enabled = input.enabled === undefined
      ? existingTimer?.enabled ?? false
      : Boolean(input.enabled);
    const now = timestamp();
    const nextFireAt = enabled
      ? existingTimer?.nextFireAt || nextTimerFireAt(intervalMinutes, now)
      : "";
    let timerId = existing?.id;

    this.assertTimerNameAvailable(name, existing?.id);

    if (existing) {
      this.db
        .prepare(
          `
            UPDATE timers
            SET
              name = @name,
              message = @message,
              interval_minutes = @intervalMinutes,
              min_chat_messages = @minChatMessages,
              chat_messages_since_last_fire = CASE
                WHEN @enabled = 1 AND @minChatMessages > 0 THEN MIN(chat_messages_since_last_fire, @minChatMessages)
                ELSE 0
              END,
              enabled = @enabled,
              next_fire_at = @nextFireAt,
              last_status = CASE WHEN @enabled = 1 THEN last_status ELSE 'never' END,
              last_error = CASE WHEN @enabled = 1 THEN last_error ELSE '' END,
              updated_at = @updatedAt
            WHERE id = @id
          `
        )
        .run({
          id: existing.id,
          name,
          message,
          intervalMinutes,
          minChatMessages,
          enabled: enabled ? 1 : 0,
          nextFireAt,
          updatedAt: now
        });
    } else {
      const result = this.db
        .prepare(
          `
            INSERT INTO timers (
              name,
              message,
              interval_minutes,
              min_chat_messages,
              chat_messages_since_last_fire,
              enabled,
              next_fire_at,
              created_at,
              updated_at
            ) VALUES (
              @name,
              @message,
              @intervalMinutes,
              @minChatMessages,
              0,
              @enabled,
              @nextFireAt,
              @createdAt,
              @updatedAt
            )
          `
        )
        .run({
          name,
          message,
          intervalMinutes,
          minChatMessages,
          enabled: enabled ? 1 : 0,
          nextFireAt,
          createdAt: now,
          updatedAt: now
        });
      timerId = Number(result.lastInsertRowid);
    }

    const timer = timerId ? this.requireTimer(timerId) : this.requireTimerByName(name);
    writeAuditLog(
      this.db,
      actor,
      existing ? "timer.update" : "timer.create",
      `timer:${timer.id}`,
      {
        timerId: timer.id,
        name: timer.name,
        enabled: timer.enabled,
        intervalMinutes: timer.intervalMinutes,
        minChatMessages: timer.minChatMessages
      }
    );

    return timer;
  }

  setEnabled(id: number, enabled: boolean, actor: ChatMessage) {
    const timer = this.requireTimer(id);
    const now = timestamp();
    const nextFireAt = enabled ? nextTimerFireAt(timer.intervalMinutes, now) : "";

    this.db
      .prepare(
        `
          UPDATE timers
          SET enabled = @enabled,
              next_fire_at = @nextFireAt,
              chat_messages_since_last_fire = 0,
              last_status = @lastStatus,
              last_error = '',
              updated_at = @updatedAt
          WHERE id = @id
        `
      )
      .run({
        id,
        enabled: enabled ? 1 : 0,
        nextFireAt,
        lastStatus: enabled ? timer.lastStatus : "never",
        updatedAt: now
      });

    writeAuditLog(
      this.db,
      actor,
      enabled ? "timer.enable" : "timer.disable",
      `timer:${timer.id}`,
      {
        timerId: timer.id,
        name: timer.name,
        intervalMinutes: timer.intervalMinutes,
        minChatMessages: timer.minChatMessages
      }
    );

    return this.requireTimer(id);
  }

  deleteTimer(id: number, actor: ChatMessage) {
    const timer = this.requireTimer(id);

    this.db.prepare("DELETE FROM timers WHERE id = ?").run(id);
    writeAuditLog(this.db, actor, "timer.delete", `timer:${timer.id}`, {
      timerId: timer.id,
      name: timer.name
    });

    return timer;
  }

  requireTimer(id: number) {
    return timerFromRow(this.requireTimerRow(id));
  }

  getDueTimers(now = new Date()) {
    this.ensureEnabledSchedules(now);

    return (this.db
      .prepare(
        `
          SELECT *
          FROM timers
          WHERE enabled = 1
            AND next_fire_at != ''
            AND next_fire_at <= ?
            AND (
              min_chat_messages <= 0
              OR chat_messages_since_last_fire >= min_chat_messages
            )
          ORDER BY next_fire_at ASC, id ASC
          LIMIT ?
        `
      )
      .all(now.toISOString(), timerLimits.maxDuePerTick) as TimerRow[]).map(timerFromRow);
  }

  getActivityBlockedTimers(now = new Date()) {
    this.ensureEnabledSchedules(now);

    return (this.db
      .prepare(
        `
          SELECT *
          FROM timers
          WHERE enabled = 1
            AND next_fire_at != ''
            AND next_fire_at <= ?
            AND min_chat_messages > 0
            AND chat_messages_since_last_fire < min_chat_messages
          ORDER BY next_fire_at ASC, id ASC
          LIMIT ?
        `
      )
      .all(now.toISOString(), timerLimits.maxDuePerTick) as TimerRow[]).map(timerFromRow);
  }

  recordChatActivity() {
    const result = this.db
      .prepare(
        `
          UPDATE timers
          SET chat_messages_since_last_fire = CASE
            WHEN chat_messages_since_last_fire >= min_chat_messages THEN chat_messages_since_last_fire
            ELSE chat_messages_since_last_fire + 1
          END
          WHERE enabled = 1
            AND min_chat_messages > 0
            AND chat_messages_since_last_fire < min_chat_messages
        `
      )
      .run();

    return Number(result.changes ?? 0);
  }

  markQueued(id: number, outboundMessageId: string, sentAt = new Date()) {
    const timer = this.requireTimer(id);
    const sentAtIso = sentAt.toISOString();

    this.db
      .prepare(
        `
          UPDATE timers
          SET fire_count = fire_count + 1,
              last_sent_at = @lastSentAt,
              next_fire_at = @nextFireAt,
              chat_messages_since_last_fire = 0,
              last_status = 'queued',
              last_error = '',
              last_outbound_message_id = @outboundMessageId,
              updated_at = @updatedAt
          WHERE id = @id
        `
      )
      .run({
        id,
        lastSentAt: sentAtIso,
        nextFireAt: nextTimerFireAt(timer.intervalMinutes, sentAtIso),
        outboundMessageId,
        updatedAt: sentAtIso
      });

    return this.requireTimer(id);
  }

  markBlocked(id: number, reason: string, blockedAt = new Date()) {
    const blockedAtIso = blockedAt.toISOString();

    this.db
      .prepare(
        `
          UPDATE timers
          SET next_fire_at = @nextFireAt,
              last_status = 'blocked',
              last_error = @lastError,
              updated_at = @updatedAt
          WHERE id = @id
        `
      )
      .run({
        id,
        nextFireAt: new Date(blockedAt.getTime() + timerLimits.blockedRetryMs).toISOString(),
        lastError: sanitizeTimerStatus(reason),
        updatedAt: blockedAtIso
      });

    return this.requireTimer(id);
  }

  private ensureEnabledSchedules(now: Date) {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM timers
          WHERE enabled = 1
            AND next_fire_at = ''
        `
      )
      .all() as TimerRow[];

    for (const row of rows) {
      this.db
        .prepare(
          `
            UPDATE timers
            SET next_fire_at = @nextFireAt,
                updated_at = @updatedAt
            WHERE id = @id
          `
        )
        .run({
          id: row.id,
          nextFireAt: nextTimerFireAt(row.interval_minutes, now.toISOString()),
          updatedAt: now.toISOString()
        });
    }
  }

  private requireTimerRow(id: number) {
    const row = this.db
      .prepare("SELECT * FROM timers WHERE id = ?")
      .get(id) as TimerRow | undefined;

    if (!row) {
      throw new Error(`Timer #${id} was not found.`);
    }

    return row;
  }

  private requireTimerByName(name: string) {
    const row = this.db
      .prepare("SELECT * FROM timers WHERE name = ?")
      .get(name) as TimerRow | undefined;

    if (!row) {
      throw new Error(`Timer ${name} was not found.`);
    }

    return timerFromRow(row);
  }

  private assertTimerNameAvailable(name: string, currentTimerId?: number) {
    const row = this.db
      .prepare("SELECT id FROM timers WHERE name = ?")
      .get(name) as { id: number } | undefined;

    if (row && row.id !== currentTimerId) {
      throw new Error(`Timer "${name}" already exists.`);
    }
  }
}

export const normalizeTimerName = (value: unknown) =>
  sanitizeText(value, {
    field: "Timer name",
    maxLength: timerLimits.nameLength,
    required: true
  });

export const normalizeTimerMessage = (value: unknown) => {
  const message = sanitizeChatMessage(value);
  assertNoSecretLikeContent(message, "Timer message");
  return message;
};

export const normalizeTimerInterval = (value: unknown, fallback: number) =>
  parseSafeInteger(value, {
    field: "Timer interval",
    fallback,
    min: timerLimits.minIntervalMinutes,
    max: timerLimits.maxIntervalMinutes
  });

export const normalizeTimerMinChatMessages = (value: unknown, fallback = 0) =>
  parseSafeInteger(value, {
    field: "Timer chat message requirement",
    fallback,
    min: 0,
    max: timerLimits.maxChatMessages
  });

export const nextTimerFireAt = (intervalMinutes: number, from: string | Date = new Date()) => {
  const fromMs = typeof from === "string" ? Date.parse(from) : from.getTime();
  const base = Number.isFinite(fromMs) ? fromMs : Date.now();
  return new Date(base + intervalMinutes * 60 * 1000).toISOString();
};

const sanitizeTimerStatus = (value: string) =>
  sanitizeText(value, {
    field: "Timer status",
    maxLength: limits.chatMessageLength
  });

const timerFromRow = (row: TimerRow): TimerDefinition => ({
  id: row.id,
  name: row.name,
  message: row.message,
  intervalMinutes: row.interval_minutes,
  minChatMessages: row.min_chat_messages,
  chatMessagesSinceLastFire: row.chat_messages_since_last_fire,
  enabled: row.enabled === 1,
  fireCount: row.fire_count,
  lastSentAt: row.last_sent_at,
  nextFireAt: row.next_fire_at,
  lastStatus: row.last_status,
  lastError: row.last_error,
  lastOutboundMessageId: row.last_outbound_message_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const timestamp = () => new Date().toISOString();
