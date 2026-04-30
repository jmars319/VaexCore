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

  constructor(private readonly options: BotOptions) {
    this.runtimeStatus = createRuntimeStatus(options.env.mode);
    this.db = createDbClient(options.env.databaseUrl);
    const outboundHistory = createOutboundHistory(this.db);

    const sender = new TwitchChatSender({
      clientId: options.env.twitchClientId,
      accessToken: options.env.twitchUserAccessToken,
      broadcasterId: options.env.twitchBroadcasterUserId,
      senderId: options.env.twitchBotUserId,
      logger: options.logger,
      onHealthyChange: (healthy) => {
        this.runtimeStatus.outboundHealthy = healthy;
      }
    });

    this.messageQueue = new MessageQueue({
      logger: options.logger,
      send: (message) => sender.send(message),
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
      broadcasterUserId: options.env.twitchBroadcasterUserId,
      botUserId: options.env.twitchBotUserId,
      logger: options.logger,
      debugPayloads: options.env.debug,
      runtimeStatus: this.runtimeStatus,
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

    await validateLiveTwitch({
      clientId: this.options.env.twitchClientId,
      accessToken: this.options.env.twitchUserAccessToken,
      broadcasterUserId: this.options.env.twitchBroadcasterUserId,
      botUserId: this.options.env.twitchBotUserId,
      logger: this.options.logger
    });

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
