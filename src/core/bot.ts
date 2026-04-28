import type { Env } from "../config/env";
import type { Logger } from "./logger";
import { CommandRouter } from "./commandRouter";
import { MessageQueue } from "./messageQueue";
import { TwitchEventSubClient } from "../twitch/eventsub";
import { TwitchChatSender } from "../twitch/sendMessage";
import type { ChatMessageEvent } from "../twitch/types";
import { StartupChecklist } from "./startupChecklist";

type BotOptions = {
  env: Env;
  logger: Logger;
};

export class VaexCoreBot {
  private readonly commandRouter: CommandRouter;
  private readonly eventSubClient: TwitchEventSubClient;
  private readonly messageQueue: MessageQueue;
  private readonly startupChecklist: StartupChecklist;

  constructor(private readonly options: BotOptions) {
    const sender = new TwitchChatSender({
      clientId: options.env.twitchClientId,
      accessToken: options.env.twitchUserAccessToken,
      broadcasterId: options.env.twitchBroadcasterUserId,
      senderId: options.env.twitchBotUserId,
      logger: options.logger
    });

    this.messageQueue = new MessageQueue({
      logger: options.logger,
      send: (message) => sender.send(message)
    });

    this.commandRouter = new CommandRouter({
      prefix: options.env.commandPrefix,
      logger: options.logger,
      enqueueMessage: (message) => this.messageQueue.enqueue(message)
    });

    this.eventSubClient = new TwitchEventSubClient({
      eventSubUrl: options.env.twitchEventSubUrl,
      clientId: options.env.twitchClientId,
      accessToken: options.env.twitchUserAccessToken,
      broadcasterUserId: options.env.twitchBroadcasterUserId,
      botUserId: options.env.twitchBotUserId,
      logger: options.logger,
      onChatMessage: (event) => this.handleChatMessage(event)
    });

    this.startupChecklist = new StartupChecklist({
      logger: options.logger
    });
  }

  async start() {
    this.options.logger.info("Starting VaexCore");

    this.startupChecklist.pass("bot user ID present", {
      botUserId: this.options.env.twitchBotUserId
    });
    this.startupChecklist.pass("broadcaster ID present", {
      broadcasterUserId: this.options.env.twitchBroadcasterUserId
    });

    this.messageQueue.start();
    this.startupChecklist.pass("outbound message queue ready", {
      messagesPerSecond: 1
    });

    await this.eventSubClient.connect();
    this.startupChecklist.pass("EventSub connected");
    this.startupChecklist.pass("chat subscription created", {
      subscriptionType: "channel.chat.message"
    });
  }

  async stop() {
    this.messageQueue.stop();
    await this.eventSubClient.close();
  }

  private async handleChatMessage(event: ChatMessageEvent) {
    this.options.logger.info(
      {
        messageId: event.messageId,
        chatter: event.chatterLogin,
        text: event.text
      },
      "Inbound chat message"
    );

    await this.commandRouter.handle(event);
  }
}
