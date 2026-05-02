import WebSocket from "ws";
import type { ChatMessage } from "../core/chatMessage";
import type { Logger } from "../core/logger";
import type { RuntimeStatus } from "../core/runtimeStatus";
import {
  normalizeLogin,
  sanitizeChatMessage,
  sanitizeDisplayName
} from "../core/security";
import { createTwitchHeaders } from "./auth";
import { explainTwitchHttpError } from "./errors";
import type { ChatBadge, EventSubMessage } from "./types";

type EventSubOptions = {
  eventSubUrl: string;
  clientId: string;
  accessToken: string;
  accessTokenProvider?: () => string | Promise<string>;
  broadcasterUserId: string;
  botUserId: string;
  logger: Logger;
  debugPayloads: boolean;
  runtimeStatus: RuntimeStatus;
  onAuthFailure?: () => Promise<boolean>;
  onChatMessage: (message: ChatMessage) => Promise<void> | void;
};

export class TwitchEventSubClient {
  private readonly seenMessageIds = new Set<string>();
  private readonly seenMessageIdQueue: string[] = [];
  private socket: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private manuallyClosed = false;
  private reconnectAttempt = 0;

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
        this.logRawPayload(raw.toString());
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
          this.options.runtimeStatus.eventSubConnected = false;
          this.options.runtimeStatus.chatSubscriptionActive = false;
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
      this.options.runtimeStatus.eventSubConnected = true;
      this.options.runtimeStatus.sessionId = sessionId;
      this.reconnectAttempt = 0;

      if (!twitchInitiatedReconnect) {
        await this.subscribeToChatMessages(sessionId);
        this.options.runtimeStatus.chatSubscriptionActive = true;
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
      if (this.isDuplicate(message.metadata.message_id)) {
        this.options.logger.debug(
          { messageId: message.metadata.message_id },
          "Duplicate EventSub notification ignored"
        );
        return false;
      }

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

    let normalized: ChatMessage;

    try {
      normalized = normalizeEventSubChatMessage({
        id: event.message_id,
        text: event.message.text,
        broadcasterUserId: event.broadcaster_user_id,
        userId: event.chatter_user_id,
        userLogin: event.chatter_user_login,
        userDisplayName: event.chatter_user_name,
        badges: event.badges ?? []
      });
    } catch (error) {
      this.options.logger.warn({ error }, "Malformed EventSub chat message ignored");
      return;
    }

    this.options.logger.debug({ chatMessage: normalized }, "Normalized ChatMessage");

    await this.options.onChatMessage(normalized);
  }

  private async subscribeToChatMessages(sessionId: string) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      this.options.logger.info(
        { attempt, sessionId },
        "EventSub chat subscription request sent"
      );

      const response = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
        method: "POST",
        headers: createTwitchHeaders({
          clientId: this.options.clientId,
          accessToken: await this.getAccessToken()
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

      if (response.ok) {
        this.options.logger.info(
          { operatorEvent: "chat subscription created", subscriptionType: "channel.chat.message" },
          "Chat subscription created"
        );
        return;
      }

      if (response.status === 401 && this.options.onAuthFailure) {
        const refreshed = await this.options.onAuthFailure();

        if (refreshed) {
          this.options.logger.warn(
            { attempt },
            "EventSub chat subscription auth failed; token refreshed and request will be retried"
          );
          continue;
        }
      }

      const error = await explainTwitchHttpError(
        response,
        "eventsub_chat_subscription"
      );

      this.options.logger.error(
        { error, attempt },
        "EventSub chat subscription attempt failed"
      );

      if (attempt === 3) {
        throw error;
      }

      await delay(1000 * attempt);
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectAttempt += 1;
    const delayMs = Math.min(30000, 1000 * 2 ** (this.reconnectAttempt - 1));

    this.options.logger.warn(
      { attempt: this.reconnectAttempt, delayMs },
      "EventSub reconnect scheduled"
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delayMs);
  }

  private async getAccessToken() {
    return this.options.accessTokenProvider
      ? this.options.accessTokenProvider()
      : this.options.accessToken;
  }

  private isDuplicate(messageId: string) {
    if (this.seenMessageIds.has(messageId)) {
      return true;
    }

    this.seenMessageIds.add(messageId);
    this.seenMessageIdQueue.push(messageId);

    while (this.seenMessageIdQueue.length > 1000) {
      const expired = this.seenMessageIdQueue.shift();

      if (expired) {
        this.seenMessageIds.delete(expired);
      }
    }

    return false;
  }

  private logRawPayload(raw: string) {
    if (!this.options.debugPayloads) {
      return;
    }

    const truncated = raw.length > 4000 ? `${raw.slice(0, 4000)}...` : raw;
    this.options.logger.debug({ payload: truncated }, "Raw EventSub payload");
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeEventSubChatMessage = (input: {
  id: string;
  text: string;
  broadcasterUserId: string;
  userId: string;
  userLogin: string;
  userDisplayName: string;
  badges: ChatBadge[];
}): ChatMessage => {
  const badges = input.badges.map((badge) => badge.set_id);
  const userLogin = normalizeLogin(input.userLogin);
  const userDisplayName = sanitizeDisplayName(input.userDisplayName, userLogin);
  const isBroadcaster =
    input.userId === input.broadcasterUserId || badges.includes("broadcaster");

  return {
    id: input.id,
    text: sanitizeChatMessage(input.text),
    userId: input.userId,
    userLogin,
    userDisplayName,
    broadcasterUserId: input.broadcasterUserId,
    badges,
    isBroadcaster,
    isMod: badges.includes("moderator"),
    isVip: badges.includes("vip"),
    isSubscriber: badges.includes("subscriber"),
    source: "eventsub",
    receivedAt: new Date()
  };
};
