import type { Logger } from "../core/logger";
import { createTwitchHeaders } from "./auth";
import { explainTwitchHttpError } from "./errors";

type TwitchModerationClientOptions = {
  clientId: string;
  accessTokenProvider: () => string | Promise<string>;
  broadcasterId: string;
  moderatorId: string;
  logger: Logger;
  timeoutMs?: number;
};

export type TwitchModerationFailureCategory =
  | "auth"
  | "forbidden"
  | "not_found"
  | "rate_limit"
  | "network"
  | "timeout"
  | "twitch_rejected";

export type TwitchModerationResult =
  | { ok: true }
  | {
      ok: false;
      status?: number;
      failureCategory: TwitchModerationFailureCategory;
      reason: string;
      retryAfterMs?: number;
    };

export class TwitchModerationClient {
  constructor(private readonly options: TwitchModerationClientOptions) {}

  deleteMessage(messageId: string) {
    if (!messageId.trim()) {
      return Promise.resolve({
        ok: false,
        failureCategory: "twitch_rejected",
        reason: "Twitch message ID is required; refusing to clear chat."
      } satisfies TwitchModerationResult);
    }

    const params = new URLSearchParams({
      broadcaster_id: this.options.broadcasterId,
      moderator_id: this.options.moderatorId,
      message_id: messageId
    });

    return this.request({
      method: "DELETE",
      url: `https://api.twitch.tv/helix/moderation/chat?${params}`,
      logAction: "delete chat message",
      errorContext: "moderation_delete"
    });
  }

  timeoutUser(input: {
    userId: string;
    durationSeconds: number;
    reason: string;
  }) {
    if (!input.userId.trim()) {
      return Promise.resolve({
        ok: false,
        failureCategory: "twitch_rejected",
        reason: "Twitch user ID is required for timeout."
      } satisfies TwitchModerationResult);
    }

    const params = new URLSearchParams({
      broadcaster_id: this.options.broadcasterId,
      moderator_id: this.options.moderatorId
    });

    return this.request({
      method: "POST",
      url: `https://api.twitch.tv/helix/moderation/bans?${params}`,
      logAction: "timeout chat user",
      errorContext: "moderation_timeout",
      body: {
        data: {
          user_id: input.userId,
          duration: input.durationSeconds,
          reason: input.reason
        }
      }
    });
  }

  private async request(input: {
    method: "DELETE" | "POST";
    url: string;
    logAction: string;
    errorContext: "moderation_delete" | "moderation_timeout";
    body?: unknown;
  }): Promise<TwitchModerationResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);

    try {
      this.options.logger.info({ action: input.logAction }, "Twitch moderation API attempt");
      const accessToken = await this.options.accessTokenProvider();
      const response = await fetch(input.url, {
        method: input.method,
        signal: controller.signal,
        headers: createTwitchHeaders({
          clientId: this.options.clientId,
          accessToken
        }),
        body: input.body ? JSON.stringify(input.body) : undefined
      });

      if (response.ok) {
        this.options.logger.info({ action: input.logAction }, "Twitch moderation API succeeded");
        return { ok: true };
      }

      const body = await response.text();
      const error = await explainTwitchHttpError(response, input.errorContext, body);
      const category = classifyStatus(response.status);

      this.options.logger.warn(
        { action: input.logAction, status: response.status, failureCategory: category, error },
        "Twitch moderation API failed"
      );

      return {
        ok: false,
        status: response.status,
        failureCategory: category,
        reason: error.message,
        retryAfterMs: getRetryAfterMs(response)
      };
    } catch (error) {
      const category = error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : "network";
      const reason = error instanceof Error ? error.message : String(error);
      this.options.logger.warn(
        { action: input.logAction, failureCategory: category, error },
        "Twitch moderation API request failed"
      );

      return {
        ok: false,
        failureCategory: category,
        reason
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

const classifyStatus = (status: number): TwitchModerationFailureCategory => {
  if (status === 401) {
    return "auth";
  }

  if (status === 403) {
    return "forbidden";
  }

  if (status === 404) {
    return "not_found";
  }

  if (status === 429) {
    return "rate_limit";
  }

  return "twitch_rejected";
};

const getRetryAfterMs = (response: Response) => {
  const retryAfter = response.headers.get("retry-after");

  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number.parseInt(retryAfter, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
};
