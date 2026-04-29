import { defaultConfig } from "../config/defaultConfig";
import type { Logger } from "./logger";

type MessageQueueOptions = {
  logger: Logger;
  send: (message: string) => Promise<"sent" | "retry">;
  onSent?: (message: string) => void;
};

export class MessageQueue {
  private readonly queue: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private processing = false;

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

  isReady() {
    return Boolean(this.timer);
  }

  enqueue(message: string) {
    this.queue.push(message);
    this.options.logger.info(
      { queued: this.queue.length, message },
      "Outbound chat message queued"
    );
  }

  private async flushOne() {
    if (this.processing) {
      return;
    }

    const message = this.queue.shift();

    if (!message) {
      return;
    }

    this.processing = true;

    try {
      const result = await this.options.send(message);

      if (result === "retry") {
        this.queue.unshift(message);
        return;
      }

      this.options.logger.info({ message }, "Outbound chat message sent");
      this.options.onSent?.(message);
    } catch (error) {
      this.options.logger.error({ error, message }, "Outbound chat send failed");
    } finally {
      this.processing = false;
    }
  }
}
