import type { Logger } from "../core/logger";
import type { MessageSendResult, MessageSendFailureCategory } from "../core/messageQueue";
import { createTwitchHeaders } from "./auth";
import { explainTwitchHttpError } from "./errors";

type SendMessageOptions = {
  clientId: string;
  accessToken: string;
  accessTokenProvider?: () => string | Promise<string>;
  broadcasterId: string;
  senderId: string;
  logger: Logger;
  onHealthyChange?: (healthy: boolean) => void;
  timeoutMs?: number;
};

export class TwitchChatSender {
  constructor(private readonly options: SendMessageOptions) {}

  async send(message: string): Promise<MessageSendResult> {
    this.options.logger.info({ length: message.length }, "Twitch chat send attempt");

    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);

    try {
      const accessToken = await this.getAccessToken();
      response = await fetch("https://api.twitch.tv/helix/chat/messages", {
        method: "POST",
        signal: controller.signal,
        headers: createTwitchHeaders({
          clientId: this.options.clientId,
          accessToken
        }),
        body: JSON.stringify({
          broadcaster_id: this.options.broadcasterId,
          sender_id: this.options.senderId,
          message
        })
      });
    } catch (error) {
      this.options.onHealthyChange?.(false);
      const category = classifyFetchError(error);
      const retryAfterMs = category === "timeout" ? 5000 : 3000;
      this.options.logger.warn(
        { error, failureCategory: category, retryAfterMs },
        "Twitch chat send request failed; message will be retried"
      );
      return {
        status: "retry",
        failureCategory: category,
        reason: reasonFromError(error, category),
        retryAfterMs
      };
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      this.options.onHealthyChange?.(false);
      const body = await response.text();
      const category = classifyHttpStatus(response.status);

      if (response.status === 429 || response.status >= 500) {
        const retryAfterMs = getRetryAfterMs(response) ?? 5000;
        this.options.logger.warn(
          { status: response.status, body, failureCategory: category, retryAfterMs },
          "Twitch chat send failed with retryable status; message will be retried"
        );
        return {
          status: "retry",
          failureCategory: category,
          reason: `Twitch response: ${response.status} ${body}`,
          retryAfterMs
        };
      }

      const error = await explainTwitchHttpError(response, "send_chat_message", body);
      this.options.logger.error(
        { error, failureCategory: category },
        "Twitch chat send failed with non-retryable status"
      );
      return {
        status: "failed",
        failureCategory: category,
        reason: error.message
      };
    }

    const body = await response.json().catch(() => null);
    const messageId = getMessageId(body);
    const dropReason = getDropReason(body);

    if (dropReason) {
      this.options.onHealthyChange?.(false);
      this.options.logger.error(
        { messageId, dropReason, response: body },
        "Twitch accepted chat request but did not send message"
      );
      return {
        status: "failed",
        failureCategory: "twitch_rejected",
        reason: `Twitch accepted the request but did not send the message: ${formatDropReason(dropReason)}`
      };
    }

    this.options.onHealthyChange?.(true);
    this.options.logger.info(
      { messageId, response: body },
      "Twitch chat send succeeded"
    );

    return { status: "sent" };
  }

  private async getAccessToken() {
    return this.options.accessTokenProvider
      ? this.options.accessTokenProvider()
      : this.options.accessToken;
  }
}

const classifyFetchError = (error: unknown): MessageSendFailureCategory => {
  if (error instanceof Error && error.name === "AbortError") {
    return "timeout";
  }

  return "network";
};

const classifyHttpStatus = (status: number): MessageSendFailureCategory => {
  if (status === 401 || status === 403) {
    return "auth";
  }

  if (status === 429) {
    return "rate_limit";
  }

  return "twitch_rejected";
};

const reasonFromError = (error: unknown, category: MessageSendFailureCategory) => {
  if (error instanceof Error) {
    return `${category}: ${error.message}`;
  }

  return `${category}: ${String(error)}`;
};

const getMessageId = (body: unknown) => {
  if (
    typeof body === "object" &&
    body !== null &&
    "data" in body &&
    Array.isArray(body.data)
  ) {
    const first = body.data[0] as { message_id?: unknown } | undefined;
    return typeof first?.message_id === "string" ? first.message_id : undefined;
  }

  return undefined;
};

const getDropReason = (body: unknown) => {
  if (
    typeof body === "object" &&
    body !== null &&
    "data" in body &&
    Array.isArray(body.data)
  ) {
    const first = body.data[0] as
      | { is_sent?: unknown; drop_reason?: unknown }
      | undefined;

    if (first?.is_sent === false) {
      return first.drop_reason ?? "unknown";
    }
  }

  return undefined;
};

const formatDropReason = (dropReason: unknown) => {
  if (typeof dropReason === "string") {
    return dropReason;
  }

  try {
    return JSON.stringify(dropReason);
  } catch {
    return "unknown";
  }
};

const getRetryAfterMs = (response: Response) => {
  const retryAfter = response.headers.get("retry-after");

  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number.parseInt(retryAfter, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
};
