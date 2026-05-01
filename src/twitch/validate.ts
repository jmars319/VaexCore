import type { Logger } from "../core/logger";
import { createTwitchHeaders, type TwitchAuthOptions } from "./auth";
import type { TwitchUser } from "./users";

export const requiredTwitchScopes = ["user:read:chat", "user:write:chat"] as const;

export type TokenValidation = {
  client_id: string;
  login: string;
  scopes: string[];
  user_id: string;
  expires_in: number;
};

export class TwitchTokenValidationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
    this.name = "TwitchTokenValidationError";
  }
}

type ValidateLiveTwitchOptions = TwitchAuthOptions & {
  broadcasterUserId: string;
  botUserId: string;
  logger: Logger;
};

export const validateLiveTwitch = async ({
  clientId,
  accessToken,
  broadcasterUserId,
  botUserId,
  logger
}: ValidateLiveTwitchOptions) => {
  const token = await validateToken(accessToken);

  const missingScopes = requiredTwitchScopes.filter(
    (scope) => !token.scopes.includes(scope)
  );

  logger.info(
    {
      botUserIdFromToken: token.user_id,
      botLoginFromToken: token.login,
      scopes: token.scopes
    },
    "Twitch token validated"
  );

  if (token.client_id !== clientId) {
    throw new Error(
      "Twitch token client_id does not match TWITCH_CLIENT_ID. Re-auth with the configured app."
    );
  }

  if (token.user_id !== botUserId) {
    throw new Error(
      `TWITCH_BOT_USER_ID is ${botUserId}, but the token belongs to ${token.user_id} (${token.login}). Use the bot account token or fix TWITCH_BOT_USER_ID.`
    );
  }

  if (missingScopes.length > 0) {
    throw new Error(
      `Twitch token is missing required scope(s): ${missingScopes.join(
        ", "
      )}. Re-auth the bot token with user:read:chat and user:write:chat.`
    );
  }

  const [botUser, broadcasterUser] = await Promise.all([
    getTwitchUserById({ clientId, accessToken }, botUserId),
    getTwitchUserById({ clientId, accessToken }, broadcasterUserId)
  ]);

  if (!botUser) {
    throw new Error(
      `Bot user ${botUserId} was not found. Check TWITCH_BOT_USER_ID and the token account.`
    );
  }

  if (!broadcasterUser) {
    throw new Error(
      `Broadcaster user ${broadcasterUserId} was not found. Check TWITCH_BROADCASTER_USER_ID.`
    );
  }

  logger.info(
    {
      botUserId: botUser.id,
      botLogin: botUser.login,
      broadcasterUserId: broadcasterUser.id,
      broadcasterLogin: broadcasterUser.login
    },
    "Twitch identity validation passed"
  );

  return { token, botUser, broadcasterUser };
};

export const validateToken = async (accessToken: string) => {
  const response = await fetch("https://id.twitch.tv/oauth2/validate", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new TwitchTokenValidationError(
      `Twitch token validation failed: ${response.status} ${body}. If this is 401, reconnect Twitch to refresh authorization.`,
      response.status,
      body
    );
  }

  return (await response.json()) as TokenValidation;
};

export const getTwitchUserById = async (
  auth: TwitchAuthOptions,
  id: string
): Promise<TwitchUser | undefined> => {
  const params = new URLSearchParams({ id });
  const response = await fetch(`https://api.twitch.tv/helix/users?${params}`, {
    headers: createTwitchHeaders(auth)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch Twitch user ${id}: ${response.status} ${body}`);
  }

  const body = (await response.json()) as { data: TwitchUser[] };
  return body.data[0];
};

export const getTwitchUserByLogin = async (
  auth: TwitchAuthOptions,
  login: string
): Promise<TwitchUser | undefined> => {
  const params = new URLSearchParams({ login });
  const response = await fetch(`https://api.twitch.tv/helix/users?${params}`, {
    headers: createTwitchHeaders(auth)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch Twitch user ${login}: ${response.status} ${body}`);
  }

  const body = (await response.json()) as { data: TwitchUser[] };
  return body.data[0];
};
