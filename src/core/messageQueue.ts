import { defaultConfig } from "../config/defaultConfig";
import type { Logger } from "./logger";

type MessageQueueOptions = {
  logger: Logger;
  send: (message: string) => Promise<"sent" | "retry" | "failed">;
  onSent?: (message: string) => void;
  onEvent?: (event: MessageQueueEvent) => void;
  maxAttempts?: number;
};

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
  queueDepth?: number;
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
  metadata: MessageQueueMetadata;
};

export class MessageQueue {
  private readonly queue: QueuedMessage[] = [];
  private timer: NodeJS.Timeout | undefined;
  private processing = false;
  private nextId = 1;

  constructor(private readonly options: MessageQueueOptions) {}

  start() {
    if (this.timer) {
      return;
    }

    const intervalMs =
      1000 / defaultConfig.outboundMessagesPerChannelPerSecond;

    this.timer = setInterval(() => {
      void this.flushOne();
    }, intervalMs);
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
    return {
      ready: this.isReady(),
      queued: this.queue.length,
      processing: this.processing
    };
  }

  enqueue(message: string, metadata: MessageQueueMetadata = {}) {
    const item = {
      id: `out-${Date.now().toString(36)}-${this.nextId++}`,
      message,
      attempts: 0,
      enqueuedAt: Date.now(),
      queuedAt: new Date().toISOString(),
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

    const item = this.queue.shift();

    if (!item) {
      return;
    }

    this.processing = true;

    try {
      item.attempts += 1;
      this.emit(item, "sending", { queueDepth: this.queue.length });
      const result = await this.options.send(item.message);

      if (result === "retry") {
        this.requeueOrDrop(item, "sender requested retry");
        return;
      }

      if (result === "failed") {
        const maxAttempts = this.options.maxAttempts ?? 4;
        this.options.logger.error(
          {
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
        this.emit(item, "failed", { reason: "sender reported non-retryable failure" });
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

    if (item.attempts < maxAttempts) {
      this.queue.unshift(item);
      const reasonText = formatReason(reason);
      const remainingAttempts = maxAttempts - item.attempts;
      this.emit(item, "retrying", {
        reason: reasonText,
        queueDepth: this.queue.length
      });
      this.options.logger.warn(
        {
          reason: reasonText,
          message: item.message,
          outboundMessageId: item.id,
          outboundStatus: "retrying",
          ...logMetadata(item.metadata),
          attempt: item.attempts,
          maxAttempts,
          remainingAttempts,
          retryDelayMs: 1000,
          queued: this.queue.length
        },
        "Outbound chat send failed; message will be retried"
      );
      return;
    }

    const reasonText = formatReason(reason);
    this.emit(item, "failed", { reason: reasonText });
    this.options.logger.error(
      {
        reason: reasonText,
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

  private emit(
    item: QueuedMessage,
    status: MessageQueueEventStatus,
    details: { reason?: string; queueDepth?: number } = {}
  ) {
    this.options.onEvent?.({
      id: item.id,
      message: item.message,
      status,
      attempts: item.attempts,
      queuedAt: item.queuedAt,
      updatedAt: new Date().toISOString(),
      reason: details.reason,
      queueDepth: details.queueDepth,
      metadata: item.metadata
    });
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
