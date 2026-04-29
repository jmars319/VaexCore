import type { Logger } from "../core/logger";
import { createTwitchHeaders } from "./auth";
import { explainTwitchHttpError } from "./errors";

type SendMessageOptions = {
  clientId: string;
  accessToken: string;
  broadcasterId: string;
  senderId: string;
  logger: Logger;
  onHealthyChange?: (healthy: boolean) => void;
};

export class TwitchChatSender {
  constructor(private readonly options: SendMessageOptions) {}

  async send(message: string): Promise<"sent" | "retry"> {
    this.options.logger.info({ length: message.length }, "Twitch chat send attempt");

    const response = await fetch("https://api.twitch.tv/helix/chat/messages", {
      method: "POST",
      headers: createTwitchHeaders({
        clientId: this.options.clientId,
        accessToken: this.options.accessToken
      }),
      body: JSON.stringify({
        broadcaster_id: this.options.broadcasterId,
        sender_id: this.options.senderId,
        message
      })
    });

    if (!response.ok) {
      this.options.onHealthyChange?.(false);

      if (response.status === 429) {
        const body = await response.text();
        const retryAfterMs = getRetryAfterMs(response) ?? 5000;
        this.options.logger.warn(
          { status: response.status, body, retryAfterMs },
          "Twitch chat send rate-limited; message will be retried"
        );
        await delay(retryAfterMs);
        return "retry";
      }

      throw await explainTwitchHttpError(response, "send_chat_message");
    }

    const body = await response.json().catch(() => null);
    const messageId = getMessageId(body);

    this.options.onHealthyChange?.(true);
    this.options.logger.info(
      { messageId, response: body },
      "Twitch chat send succeeded"
    );

    return "sent";
  }
}

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

const getRetryAfterMs = (response: Response) => {
  const retryAfter = response.headers.get("retry-after");

  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number.parseInt(retryAfter, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
