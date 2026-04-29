import WebSocket from "ws";
import type { Logger } from "../core/logger";
import { createTwitchHeaders } from "./auth";
import { explainTwitchHttpError } from "./errors";
import type { ChatMessageEvent, EventSubMessage } from "./types";

type EventSubOptions = {
  eventSubUrl: string;
  clientId: string;
  accessToken: string;
  broadcasterUserId: string;
  botUserId: string;
  logger: Logger;
  onChatMessage: (event: ChatMessageEvent) => Promise<void> | void;
};

export class TwitchEventSubClient {
  private socket: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private manuallyClosed = false;

  constructor(private readonly options: EventSubOptions) {}

  async connect(url = this.options.eventSubUrl, twitchInitiatedReconnect = false) {
    this.manuallyClosed = false;

    this.options.logger.info({ url }, "Connecting to Twitch EventSub WebSocket");

    await new Promise<void>((resolve, reject) => {
      const nextSocket = new WebSocket(url);
      let settled = false;

      const startupTimeout = setTimeout(() => {
        settleWithError(
          new Error(
            "Timed out waiting for EventSub welcome and chat subscription confirmation"
          )
        );
        nextSocket.close();
      }, 15000);

      const settle = () => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(startupTimeout);
        resolve();
      };

      const settleWithError = (error: unknown) => {
        if (settled) {
          this.options.logger.error({ error }, "EventSub runtime error");
          return;
        }

        settled = true;
        clearTimeout(startupTimeout);
        reject(error);
      };

      nextSocket.on("open", () => {
        this.options.logger.info("EventSub WebSocket opened");
      });

      nextSocket.on("message", (raw) => {
        void this.handleRawMessage(
          nextSocket,
          raw.toString(),
          twitchInitiatedReconnect
        )
          .then((ready) => {
            if (ready) {
              settle();
            }
          })
          .catch((error: unknown) => {
            settleWithError(error);
            nextSocket.close();
          });
      });

      nextSocket.on("close", (code, reason) => {
        this.options.logger.warn(
          { code, reason: reason.toString() },
          "EventSub WebSocket closed"
        );

        const wasActiveSocket = this.socket === nextSocket;

        if (wasActiveSocket) {
          this.socket = undefined;
        }

        if (!settled) {
          settleWithError(
            new Error(
              `EventSub WebSocket closed before startup completed: ${code} ${reason.toString()}`
            )
          );
          return;
        }

        if (!this.manuallyClosed && wasActiveSocket) {
          this.scheduleReconnect();
        }
      });

      nextSocket.on("error", (error) => {
        this.options.logger.error({ error }, "EventSub WebSocket error");

        if (!settled) {
          settleWithError(error);
        }
      });
    });
  }

  async close() {
    this.manuallyClosed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const socket = this.socket;
    this.socket = undefined;

    if (!socket || socket.readyState === WebSocket.CLOSED) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 2000);

      socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });

      socket.close();
    });
  }

  private async handleRawMessage(
    socket: WebSocket,
    raw: string,
    twitchInitiatedReconnect: boolean
  ): Promise<boolean> {
    const message = JSON.parse(raw) as EventSubMessage;
    const type = message.metadata.message_type;

    this.options.logger.debug({ type }, "EventSub message received");

    if (type === "session_welcome") {
      const previousSocket = this.socket;
      this.socket = socket;

      const sessionId = message.payload.session?.id;

      if (!sessionId) {
        this.options.logger.error("EventSub welcome did not include a session ID");
        return false;
      }

      this.options.logger.info({ sessionId }, "EventSub session welcomed");

      if (!twitchInitiatedReconnect) {
        await this.subscribeToChatMessages(sessionId);
      }

      if (previousSocket && previousSocket !== socket) {
        previousSocket.close();
      }

      return true;
    }

    if (type === "session_keepalive") {
      this.options.logger.debug("EventSub keepalive");
      return false;
    }

    if (type === "session_reconnect") {
      const reconnectUrl = message.payload.session?.reconnect_url;

      if (!reconnectUrl) {
        this.options.logger.error("EventSub reconnect message did not include a URL");
        return false;
      }

      await this.connect(reconnectUrl, true);
      return false;
    }

    if (type === "revocation") {
      this.options.logger.warn({ payload: message.payload }, "EventSub subscription revoked");
      return false;
    }

    if (type === "notification") {
      await this.handleNotification(message);
    }

    return false;
  }

  private async handleNotification(message: EventSubMessage) {
    if (message.payload.subscription?.type !== "channel.chat.message") {
      return;
    }

    const event = message.payload.event;

    if (!event?.message?.text) {
      return;
    }

    await this.options.onChatMessage({
      mode: "live",
      broadcasterUserId: event.broadcaster_user_id,
      broadcasterLogin: event.broadcaster_user_login,
      broadcasterName: event.broadcaster_user_name,
      chatterUserId: event.chatter_user_id,
      chatterLogin: event.chatter_user_login,
      chatterName: event.chatter_user_name,
      messageId: event.message_id,
      text: event.message.text,
      badges: event.badges ?? []
    });
  }

  private async subscribeToChatMessages(sessionId: string) {
    const response = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
      method: "POST",
      headers: createTwitchHeaders({
        clientId: this.options.clientId,
        accessToken: this.options.accessToken
      }),
      body: JSON.stringify({
        type: "channel.chat.message",
        version: "1",
        condition: {
          broadcaster_user_id: this.options.broadcasterUserId,
          user_id: this.options.botUserId
        },
        transport: {
          method: "websocket",
          session_id: sessionId
        }
      })
    });

    if (!response.ok) {
      throw await explainTwitchHttpError(response, "eventsub_chat_subscription");
    }

    this.options.logger.info("Subscribed to channel.chat.message");
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, 5000);
  }
}
