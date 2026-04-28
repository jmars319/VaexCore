import type { Logger } from "../core/logger";
import { createTwitchHeaders } from "./auth";
import { explainTwitchHttpError } from "./errors";

type SendMessageOptions = {
  clientId: string;
  accessToken: string;
  broadcasterId: string;
  senderId: string;
  logger: Logger;
};

export class TwitchChatSender {
  constructor(private readonly options: SendMessageOptions) {}

  async send(message: string) {
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
      throw await explainTwitchHttpError(response, "send_chat_message");
    }

    const body = await response.json().catch(() => null);

    this.options.logger.debug({ response: body }, "Twitch Send Chat Message response");
  }
}
