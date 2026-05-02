import { defaultConfig } from "../config/defaultConfig";
import type { Logger } from "./logger";

type MessageQueueOptions = {
  logger: Logger;
  send: (message: string) => Promise<MessageSendResult>;
  onSent?: (message: string) => void;
  onEvent?: (event: MessageQueueEvent) => void;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  minIntervalMs?: number;
};

export type MessageSendStatus = "sent" | "retry" | "failed";

export type MessageSendFailureCategory =
  | "none"
  | "config"
  | "auth"
  | "rate_limit"
  | "twitch_rejected"
  | "network"
  | "timeout"
  | "unknown";

export type StructuredMessageSendResult = {
  status: MessageSendStatus;
  reason?: string;
  failureCategory?: MessageSendFailureCategory;
  retryAfterMs?: number;
};

export type MessageSendResult = MessageSendStatus | StructuredMessageSendResult;

export type MessageQueueEventStatus =
  | "queued"
  | "sending"
  | "retrying"
  | "sent"
  | "failed";

export type MessageQueueEvent = {
  id: string;
  message: string;
  status: MessageQueueEventStatus;
  attempts: number;
  queuedAt: string;
  updatedAt: string;
  reason?: string;
  failureCategory?: MessageSendFailureCategory;
  queueDepth?: number;
  retryAfterMs?: number;
  nextAttemptAt?: string;
  metadata?: MessageQueueMetadata;
};

export type MessageQueueMetadata = {
  category?: "operator" | "giveaway" | "system";
  action?: string;
  importance?: "normal" | "important" | "critical";
  giveawayId?: number;
  resentFrom?: string;
};

type QueuedMessage = {
  id: string;
  message: string;
  attempts: number;
  enqueuedAt: number;
  queuedAt: string;
  notBefore: number;
  metadata: MessageQueueMetadata;
};

export class MessageQueue {
  private readonly queue: QueuedMessage[] = [];
  private timer: NodeJS.Timeout | undefined;
  private processing = false;
  private nextId = 1;
  private nextSendAt = 0;

  constructor(private readonly options: MessageQueueOptions) {}

  start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.flushOne();
    }, this.intervalMs());
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async drain(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;

    while ((this.queue.length > 0 || this.processing) && Date.now() < deadline) {
      await this.flushOne();

      if (this.queue.length > 0 || this.processing) {
        await delay(100);
      }
    }

    const drained = this.queue.length === 0 && !this.processing;

    if (!drained) {
      this.options.logger.warn(
        { queued: this.queue.length, processing: this.processing },
        "Outbound chat queue did not drain before shutdown"
      );
    }

    return drained;
  }

  isReady() {
    return Boolean(this.timer);
  }

  snapshot() {
    const oldest = this.queue[0];
    const newest = this.queue[this.queue.length - 1];
    const now = Date.now();
    const pendingRetry = this.queue.find((item) => item.notBefore > now);
    const rateLimitDelayMs = Math.max(0, this.nextSendAt - now);

    return {
      ready: this.isReady(),
      queued: this.queue.length,
      processing: this.processing,
      oldestQueuedAt: oldest?.queuedAt ?? "",
      oldestAgeMs: oldest ? Date.now() - oldest.enqueuedAt : 0,
      oldestMessageId: oldest?.id ?? "",
      oldestAction: oldest?.metadata.action ?? "",
      oldestImportance: oldest?.metadata.importance ?? "normal",
      newestQueuedAt: newest?.queuedAt ?? "",
      nextAttemptAt: pendingRetry ? new Date(pendingRetry.notBefore).toISOString() : "",
      retryDelayMs: pendingRetry ? Math.max(0, pendingRetry.notBefore - now) : 0,
      rateLimitedUntil: rateLimitDelayMs > 0 && this.queue.length > 0
        ? new Date(this.nextSendAt).toISOString()
        : "",
      rateLimitDelayMs: this.queue.length > 0 ? rateLimitDelayMs : 0,
      maxAttempts: this.options.maxAttempts ?? 4
    };
  }

  enqueue(message: string, metadata: MessageQueueMetadata = {}) {
    const item = {
      id: `out-${Date.now().toString(36)}-${this.nextId++}`,
      message,
      attempts: 0,
      enqueuedAt: Date.now(),
      queuedAt: new Date().toISOString(),
      notBefore: 0,
      metadata
    };
    this.queue.push(item);
    this.emit(item, "queued", { queueDepth: this.queue.length });
    this.options.logger.info(
      {
        outboundMessageId: item.id,
        outboundStatus: "queued",
        ...logMetadata(item.metadata),
        queued: this.queue.length,
        message
      },
      "Outbound chat message queued"
    );
    return item.id;
  }

  private async flushOne() {
    if (this.processing) {
      return;
    }

    if (Date.now() < this.nextSendAt) {
      return;
    }

    const item = this.queue.shift();

    if (!item) {
      return;
    }

    if (item.notBefore > Date.now()) {
      this.queue.unshift(item);
      return;
    }

    this.processing = true;
    this.nextSendAt = Date.now() + this.intervalMs();

    try {
      item.attempts += 1;
      this.emit(item, "sending", { queueDepth: this.queue.length });
      const result = normalizeSendResult(await this.options.send(item.message));

      if (result.status === "retry") {
        this.requeueOrDrop(item, result);
        return;
      }

      if (result.status === "failed") {
        const maxAttempts = this.options.maxAttempts ?? 4;
        this.options.logger.error(
          {
            reason: result.reason || "sender reported non-retryable failure",
            failureCategory: result.failureCategory ?? "unknown",
            message: item.message,
            outboundMessageId: item.id,
            outboundStatus: "failed",
            ...logMetadata(item.metadata),
            attempts: item.attempts,
            maxAttempts,
            remainingAttempts: 0,
            ageMs: Date.now() - item.enqueuedAt
          },
          "Outbound chat send failed; message dropped"
        );
        this.emit(item, "failed", {
          reason: result.reason || "sender reported non-retryable failure",
          failureCategory: result.failureCategory ?? "unknown"
        });
        return;
      }

      this.emit(item, "sent", { queueDepth: this.queue.length });
      this.options.logger.info(
        {
          outboundMessageId: item.id,
          outboundStatus: "sent",
          ...logMetadata(item.metadata),
          message: item.message
        },
        "Outbound chat message sent"
      );
      this.options.onSent?.(item.message);
    } catch (error) {
      this.requeueOrDrop(item, error);
    } finally {
      this.processing = false;
    }
  }

  private requeueOrDrop(item: QueuedMessage, reason: unknown) {
    const maxAttempts = this.options.maxAttempts ?? 4;
    const result = normalizeRetryReason(reason);
    const reasonText = result.reason;
    const failureCategory = result.failureCategory;

    if (item.attempts < maxAttempts) {
      const retryAfterMs = result.retryAfterMs ?? this.retryDelayMs(item.attempts);
      item.notBefore = Date.now() + retryAfterMs;
      this.queue.unshift(item);
      const remainingAttempts = maxAttempts - item.attempts;
      this.emit(item, "retrying", {
        reason: reasonText,
        failureCategory,
        queueDepth: this.queue.length,
        retryAfterMs,
        nextAttemptAt: new Date(item.notBefore).toISOString()
      });
      this.options.logger.warn(
        {
          reason: reasonText,
          failureCategory,
          message: item.message,
          outboundMessageId: item.id,
          outboundStatus: "retrying",
          ...logMetadata(item.metadata),
          attempt: item.attempts,
          maxAttempts,
          remainingAttempts,
          retryDelayMs: retryAfterMs,
          nextAttemptAt: new Date(item.notBefore).toISOString(),
          queued: this.queue.length
        },
        "Outbound chat send failed; message will be retried"
      );
      return;
    }

    this.emit(item, "failed", { reason: reasonText, failureCategory });
    this.options.logger.error(
      {
        reason: reasonText,
        failureCategory,
        message: item.message,
        outboundMessageId: item.id,
        outboundStatus: "failed",
        ...logMetadata(item.metadata),
        attempts: item.attempts,
        maxAttempts,
        remainingAttempts: 0,
        ageMs: Date.now() - item.enqueuedAt
      },
      "Outbound chat send failed; retry limit reached"
    );
  }

  private intervalMs() {
    return this.options.minIntervalMs ?? Math.ceil(1000 / defaultConfig.outboundMessagesPerChannelPerSecond);
  }

  private retryDelayMs(attempts: number) {
    const base = this.options.retryBaseDelayMs ?? 1000;
    return Math.min(base * 2 ** Math.max(0, attempts - 1), 15_000);
  }

  private emit(
    item: QueuedMessage,
    status: MessageQueueEventStatus,
    details: {
      reason?: string;
      failureCategory?: MessageSendFailureCategory;
      queueDepth?: number;
      retryAfterMs?: number;
      nextAttemptAt?: string;
    } = {}
  ) {
    this.options.onEvent?.({
      id: item.id,
      message: item.message,
      status,
      attempts: item.attempts,
      queuedAt: item.queuedAt,
      updatedAt: new Date().toISOString(),
      reason: details.reason,
      failureCategory: details.failureCategory,
      queueDepth: details.queueDepth,
      retryAfterMs: details.retryAfterMs,
      nextAttemptAt: details.nextAttemptAt,
      metadata: item.metadata
    });
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeSendResult = (result: MessageSendResult): StructuredMessageSendResult => {
  if (typeof result === "string") {
    return { status: result };
  }

  return result;
};

const normalizeRetryReason = (reason: unknown): Required<Pick<StructuredMessageSendResult, "reason" | "failureCategory">> &
  Pick<StructuredMessageSendResult, "retryAfterMs"> => {
  if (typeof reason === "object" && reason !== null && "status" in reason) {
    const result = normalizeSendResult(reason as MessageSendResult);
    return {
      reason: result.reason || "sender requested retry",
      failureCategory: result.failureCategory ?? "unknown",
      retryAfterMs: result.retryAfterMs
    };
  }

  return {
    reason: formatReason(reason),
    failureCategory: "unknown"
  };
};

const formatReason = (reason: unknown) => {
  if (reason instanceof Error) {
    return reason.message;
  }

  if (typeof reason === "string") {
    return reason;
  }

  try {
    return JSON.stringify(reason);
  } catch {
    return "Unknown send failure";
  }
};

const logMetadata = (metadata: MessageQueueMetadata) => ({
  outboundCategory: metadata.category,
  outboundAction: metadata.action,
  outboundImportance: metadata.importance,
  giveawayId: metadata.giveawayId,
  resentFrom: metadata.resentFrom
});
