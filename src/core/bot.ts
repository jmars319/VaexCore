import type { LiveEnv } from "../config/env";
import type { Logger } from "./logger";
import { CommandRouter } from "./commandRouter";
import { MessageQueue } from "./messageQueue";
import { createOutboundHistory } from "./outboundHistory";
import { TwitchEventSubClient } from "../twitch/eventsub";
import { TwitchChatSender } from "../twitch/sendMessage";
import type { ChatMessage } from "./chatMessage";
import { StartupChecklist } from "./startupChecklist";
import { createDbClient, type DbClient } from "../db/client";
import { registerGiveawaysModule } from "../modules/giveaways/giveaways.module";
import { createRuntimeStatus, type RuntimeStatus } from "./runtimeStatus";
import { registerStatusCommands } from "./statusCommands";
import { validateLiveTwitch } from "../twitch/validate";
import {
  isInvalidTwitchAccessTokenError,
  refreshStoredTwitchToken
} from "../twitch/tokenManager";
import { redactSecrets } from "./security";

type BotOptions = {
  env: LiveEnv;
  logger: Logger;
};

export class VaexCoreBot {
  private readonly commandRouter: CommandRouter;
  private readonly eventSubClient: TwitchEventSubClient;
  private readonly messageQueue: MessageQueue;
  private readonly startupChecklist: StartupChecklist;
  private readonly db: DbClient;
  private readonly runtimeStatus: RuntimeStatus;
  private pendingLivePingConfirmation = false;
  private twitchAccessToken: string;

  constructor(private readonly options: BotOptions) {
    this.twitchAccessToken = options.env.twitchUserAccessToken;
    this.runtimeStatus = createRuntimeStatus(options.env.mode);
    this.db = createDbClient(options.env.databaseUrl);
    const outboundHistory = createOutboundHistory(this.db);

    const sender = new TwitchChatSender({
      clientId: options.env.twitchClientId,
      accessToken: options.env.twitchUserAccessToken,
      accessTokenProvider: () => this.twitchAccessToken,
      broadcasterId: options.env.twitchBroadcasterUserId,
      senderId: options.env.twitchBotUserId,
      logger: options.logger,
      onHealthyChange: (healthy) => {
        this.runtimeStatus.outboundHealthy = healthy;
      }
    });

    this.messageQueue = new MessageQueue({
      logger: options.logger,
      send: (message) => this.sendChatMessage(sender, message),
      onEvent: (event) => outboundHistory.record({
        ...event,
        source: "bot"
      }),
      onSent: (message) => {
        if (this.pendingLivePingConfirmation && message === "pong") {
          this.pendingLivePingConfirmation = false;
          this.runtimeStatus.liveChatConfirmed = true;
          this.options.logger.info("LIVE CHAT CONFIRMED");
        }
      }
    });

    this.commandRouter = new CommandRouter({
      prefix: options.env.commandPrefix,
      logger: options.logger,
      enqueueMessage: (message, metadata) => this.messageQueue.enqueue(message, metadata)
    });

    const giveawaysService = registerGiveawaysModule({
      router: this.commandRouter,
      db: this.db,
      logger: options.logger,
      runtimeStatus: this.runtimeStatus
    });
    registerStatusCommands({
      router: this.commandRouter,
      runtimeStatus: this.runtimeStatus,
      giveawaysService
    });

    this.eventSubClient = new TwitchEventSubClient({
      eventSubUrl: options.env.twitchEventSubUrl,
      clientId: options.env.twitchClientId,
      accessToken: options.env.twitchUserAccessToken,
      accessTokenProvider: () => this.twitchAccessToken,
      broadcasterUserId: options.env.twitchBroadcasterUserId,
      botUserId: options.env.twitchBotUserId,
      logger: options.logger,
      debugPayloads: options.env.debug,
      runtimeStatus: this.runtimeStatus,
      onAuthFailure: () => this.refreshRuntimeAccessToken("eventsub chat subscription"),
      onChatMessage: (event) => this.handleChatMessage(event)
    });

    this.startupChecklist = new StartupChecklist({
      logger: options.logger
    });
  }

  async start() {
    this.options.logger.info(
      "VaexCore LIVE MODE -- waiting for chat confirmation (!ping)"
    );

    await this.validateLiveTwitchWithRefresh();

    this.startupChecklist.pass("bot user ID present", {
      botUserId: this.options.env.twitchBotUserId
    });
    this.startupChecklist.pass("broadcaster ID present", {
      broadcasterUserId: this.options.env.twitchBroadcasterUserId
    });

    this.messageQueue.start();
    this.runtimeStatus.messageQueueReady = this.messageQueue.isReady();
    this.startupChecklist.pass("outbound message queue ready", {
      messagesPerSecond: 1
    });

    await this.eventSubClient.connect();
    this.startupChecklist.pass("EventSub connected", {
      sessionId: this.runtimeStatus.sessionId
    });
    this.startupChecklist.pass("chat subscription created", {
      subscriptionType: "channel.chat.message"
    });
  }

  async stop() {
    await this.messageQueue.drain(8000);
    this.messageQueue.stop();
    await this.eventSubClient.close();
    this.db.close();
  }

  private async validateLiveTwitchWithRefresh() {
    try {
      await this.validateLiveTwitchWithCurrentToken();
      return;
    } catch (error) {
      if (!isInvalidTwitchAccessTokenError(error)) {
        throw error;
      }

      const refreshed = await this.refreshRuntimeAccessToken("startup validation");

      if (!refreshed) {
        throw error;
      }

      await this.validateLiveTwitchWithCurrentToken();
    }
  }

  private validateLiveTwitchWithCurrentToken() {
    return validateLiveTwitch({
      clientId: this.options.env.twitchClientId,
      accessToken: this.twitchAccessToken,
      broadcasterUserId: this.options.env.twitchBroadcasterUserId,
      botUserId: this.options.env.twitchBotUserId,
      logger: this.options.logger
    });
  }

  private async sendChatMessage(sender: TwitchChatSender, message: string) {
    const result = await sender.send(message);
    const structured = typeof result === "string" ? { status: result } : result;

    if (structured.status !== "failed" || structured.failureCategory !== "auth") {
      return result;
    }

    const refreshed = await this.refreshRuntimeAccessToken("outbound chat send");

    if (!refreshed) {
      return result;
    }

    this.options.logger.warn(
      { failureCategory: structured.failureCategory },
      "Outbound chat auth failed; token refreshed and message will be retried once"
    );

    return sender.send(message);
  }

  private async refreshRuntimeAccessToken(reason: string) {
    try {
      const refreshed = await refreshStoredTwitchToken({
        expectedClientId: this.options.env.twitchClientId,
        expectedBotUserId: this.options.env.twitchBotUserId,
        logger: this.options.logger
      });

      if (!refreshed.twitch.accessToken) {
        throw new Error("Refreshed Twitch token was not saved.");
      }

      this.twitchAccessToken = refreshed.twitch.accessToken;
      this.options.logger.warn(
        { reason },
        "Twitch OAuth token refreshed for live bot runtime"
      );
      return true;
    } catch (error) {
      this.options.logger.error(
        { error: redactSecrets(error), reason },
        "Twitch OAuth token refresh failed for live bot runtime"
      );
      return false;
    }
  }

  private async handleChatMessage(message: ChatMessage) {
    if (!this.runtimeStatus.firstChatReceived) {
      this.runtimeStatus.firstChatReceived = true;
      this.options.logger.info("First live chat message received");
    }

    this.options.logger.info(
      {
        messageId: message.id,
        userLogin: message.userLogin,
        source: message.source
      },
      "Inbound chat message"
    );
    this.options.logger.debug(
      {
        messageId: message.id,
        userLogin: message.userLogin,
        text: message.text
      },
      "Inbound chat message text"
    );

    await this.commandRouter.handle(message);

    if (
      message.source === "eventsub" &&
      message.text.trim().toLowerCase() === `${this.options.env.commandPrefix}ping` &&
      !this.runtimeStatus.liveChatConfirmed
    ) {
      this.pendingLivePingConfirmation = true;
    }
  }
}
