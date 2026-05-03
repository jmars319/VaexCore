import type { LiveEnv } from "../config/env";
import type { Logger } from "./logger";
import { CommandRouter } from "./commandRouter";
import { MessageQueue } from "./messageQueue";
import { createOutboundHistory } from "./outboundHistory";
import { createFeatureGateStore } from "./featureGates";
import { TwitchEventSubClient } from "../twitch/eventsub";
import { TwitchChatSender } from "../twitch/sendMessage";
import {
  optionalModerationScopes,
  validateLiveTwitch,
  type TokenValidation
} from "../twitch/validate";
import {
  TwitchModerationClient,
  type TwitchModerationResult
} from "../twitch/moderation";
import type { ChatMessage } from "./chatMessage";
import { StartupChecklist } from "./startupChecklist";
import { createDbClient, type DbClient } from "../db/client";
import { registerCommandsModule } from "../modules/commands/commands.module";
import { registerGiveawaysModule } from "../modules/giveaways/giveaways.module";
import { ModerationService } from "../modules/moderation/moderation.module";
import { isTimerActivityMessage, TimerScheduler, TimersService } from "../modules/timers/timers.module";
import { createRuntimeStatus, type RuntimeStatus } from "./runtimeStatus";
import { registerStatusCommands } from "./statusCommands";
import { registerStudioCommands } from "../studio/studio.commands";
import {
  isInvalidTwitchAccessTokenError,
  refreshStoredTwitchToken
} from "../twitch/tokenManager";
import { redactSecrets } from "./security";

type BotOptions = {
  env: LiveEnv;
  logger: Logger;
};

export class ConsoleBot {
  private readonly commandRouter: CommandRouter;
  private readonly eventSubClient: TwitchEventSubClient;
  private readonly messageQueue: MessageQueue;
  private readonly startupChecklist: StartupChecklist;
  private readonly db: DbClient;
  private readonly runtimeStatus: RuntimeStatus;
  private readonly timerScheduler: TimerScheduler;
  private readonly moderationService: ModerationService;
  private readonly moderationClient: TwitchModerationClient;
  private pendingLivePingConfirmation = false;
  private twitchAccessToken: string;
  private twitchTokenScopes: string[] = [];

  constructor(private readonly options: BotOptions) {
    this.twitchAccessToken = options.env.twitchUserAccessToken;
    this.runtimeStatus = createRuntimeStatus(options.env.mode);
    this.db = createDbClient(options.env.databaseUrl);
    const outboundHistory = createOutboundHistory(this.db);
    const featureGates = createFeatureGateStore(this.db);
    const timersService = new TimersService(this.db);

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
    this.moderationClient = new TwitchModerationClient({
      clientId: options.env.twitchClientId,
      accessTokenProvider: () => this.twitchAccessToken,
      broadcasterId: options.env.twitchBroadcasterUserId,
      moderatorId: options.env.twitchBotUserId,
      logger: options.logger
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
    this.timerScheduler = new TimerScheduler({
      service: timersService,
      featureGates,
      logger: options.logger,
      enqueue: (message, metadata) => this.messageQueue.enqueue(message, metadata),
      readiness: () => {
        const queue = this.messageQueue.snapshot();
        const outbound = outboundHistory.summary();

        if (this.runtimeStatus.mode !== "live") {
          return { ok: false, reason: "Timers only fire in live mode." };
        }

        if (!this.runtimeStatus.eventSubConnected || !this.runtimeStatus.chatSubscriptionActive) {
          return { ok: false, reason: "Timers wait for EventSub chat to be connected." };
        }

        if (!this.runtimeStatus.liveChatConfirmed) {
          return { ok: false, reason: "Timers wait for live chat confirmation. Type !ping in chat." };
        }

        if (!queue.ready || queue.processing || queue.queued > 0 || queue.rateLimitDelayMs > 0 || queue.retryDelayMs > 0) {
          return { ok: false, reason: "Timers wait for the outbound queue to clear." };
        }

        if (outbound.failed > 0 || outbound.rateLimited > 0) {
          return { ok: false, reason: "Timers wait for outbound recovery to clear." };
        }

        return { ok: true, reason: "Timer can queue." };
      }
    });

    const giveawaysService = registerGiveawaysModule({
      router: this.commandRouter,
      db: this.db,
      logger: options.logger,
      runtimeStatus: this.runtimeStatus
    });
    this.moderationService = new ModerationService(this.db, {
      featureGates,
      commandPrefix: options.env.commandPrefix,
      exemptCommandNames: () => {
        const active = giveawaysService.status()?.giveaway.keyword;
        return active ? [active] : [];
      }
    });
    registerStatusCommands({
      router: this.commandRouter,
      runtimeStatus: this.runtimeStatus,
      giveawaysService
    });
    registerStudioCommands({
      router: this.commandRouter,
      logger: options.logger
    });
    registerCommandsModule({
      router: this.commandRouter,
      db: this.db,
      featureGates
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
      "vaexcore console LIVE MODE -- waiting for chat confirmation (!ping)"
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
    this.timerScheduler.start();
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
    this.timerScheduler.stop();
    await this.messageQueue.drain(8000);
    this.messageQueue.stop();
    await this.eventSubClient.close();
    this.db.close();
  }

  private async validateLiveTwitchWithRefresh() {
    try {
      const validation = await this.validateLiveTwitchWithCurrentToken();
      this.updateTokenScopes(validation.token);
      return;
    } catch (error) {
      if (!isInvalidTwitchAccessTokenError(error)) {
        throw error;
      }

      const refreshed = await this.refreshRuntimeAccessToken("startup validation");

      if (!refreshed) {
        throw error;
      }

      const validation = await this.validateLiveTwitchWithCurrentToken();
      this.updateTokenScopes(validation.token);
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
      this.twitchTokenScopes = refreshed.twitch.scopes ?? this.twitchTokenScopes;
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

    if (isTimerActivityMessage(message, {
      botUserId: this.options.env.twitchBotUserId,
      commandPrefix: this.options.env.commandPrefix
    })) {
      this.timerScheduler.recordChatActivity(message);
    }

    await this.handleModeration(message);
    await this.commandRouter.handle(message);

    if (
      message.source === "eventsub" &&
      message.text.trim().toLowerCase() === `${this.options.env.commandPrefix}ping` &&
      !this.runtimeStatus.liveChatConfirmed
    ) {
      this.pendingLivePingConfirmation = true;
    }
  }

  private async handleModeration(message: ChatMessage) {
    try {
      const result = this.moderationService.evaluate(message);

      if (!result.hit) {
        return;
      }

      await this.enforceModeration(message, result.hit);

      if (this.moderationService.shouldWarn(message, result.hit)) {
        this.messageQueue.enqueue(result.hit.warningMessage, {
          category: "system",
          action: `moderation:${result.hit.action}`,
          importance: "normal"
        });
      }
    } catch (error) {
      this.options.logger.warn(
        { error: redactSecrets(error), userLogin: message.userLogin },
        "Moderation filters failed open"
      );
    }
  }

  private async enforceModeration(
    message: ChatMessage,
    hit: NonNullable<ReturnType<ModerationService["evaluate"]>["hit"]>
  ) {
    const plan = this.moderationService.planEnforcement(
      message,
      hit,
      this.moderationCapabilities()
    );

    if (plan.status === "skipped") {
      return;
    }

    if (plan.status === "blocked") {
      this.moderationService.recordEnforcement(message, hit, {
        action: plan.action,
        status: plan.status,
        reason: plan.reason,
        durationSeconds: plan.durationSeconds
      });
      return;
    }

    if (plan.action !== "delete" && plan.action !== "timeout") {
      return;
    }

    const result = await this.runModerationApiAction(message, hit, plan.action);

    this.moderationService.recordEnforcement(message, hit, {
      action: plan.action,
      status: result.ok ? "succeeded" : "failed",
      reason: result.ok ? plan.reason : result.reason,
      durationSeconds: plan.durationSeconds,
      statusCode: result.ok ? undefined : result.status
    });
  }

  private async runModerationApiAction(
    message: ChatMessage,
    hit: NonNullable<ReturnType<ModerationService["evaluate"]>["hit"]>,
    action: "delete" | "timeout"
  ): Promise<TwitchModerationResult> {
    const result = action === "delete"
      ? await this.moderationClient.deleteMessage(message.id ?? "")
      : await this.moderationClient.timeoutUser({
          userId: message.userId,
          durationSeconds: hit.timeoutSeconds ?? 60,
          reason: hit.detail
        });

    if (result.ok || result.failureCategory !== "auth") {
      return result;
    }

    const refreshed = await this.refreshRuntimeAccessToken(`moderation ${action}`);

    if (!refreshed) {
      return result;
    }

    this.options.logger.warn(
      { action },
      "Moderation API auth failed; token refreshed and action will be retried once"
    );

    return action === "delete"
      ? this.moderationClient.deleteMessage(message.id ?? "")
      : this.moderationClient.timeoutUser({
          userId: message.userId,
          durationSeconds: hit.timeoutSeconds ?? 60,
          reason: hit.detail
        });
  }

  private moderationCapabilities() {
    const hasScope = (scope: string) => this.twitchTokenScopes.includes(scope);
    const deleteScope = optionalModerationScopes[0];
    const timeoutScope = optionalModerationScopes[1];

    return {
      canDeleteMessages: hasScope(deleteScope),
      canTimeoutUsers: hasScope(timeoutScope),
      deleteUnavailableReason: hasScope(deleteScope)
        ? undefined
        : `Reconnect Twitch with ${deleteScope} to enable message deletion.`,
      timeoutUnavailableReason: hasScope(timeoutScope)
        ? undefined
        : `Reconnect Twitch with ${timeoutScope} to enable timeouts.`
    };
  }

  private updateTokenScopes(token: TokenValidation) {
    this.twitchTokenScopes = token.scopes;
  }
}
