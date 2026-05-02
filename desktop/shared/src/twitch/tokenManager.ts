import type { Logger } from "../core/logger";
import { normalizeLogin } from "../core/security";
import {
  readLocalSecrets,
  writeLocalSecrets,
  type LocalSecrets
} from "../config/localSecrets";
import {
  type TokenValidation,
  TwitchTokenValidationError,
  validateToken
} from "./validate";

const twitchTokenEndpoint = "https://id.twitch.tv/oauth2/token";

export type TwitchOAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string[];
  token_type: string;
};

export type StoredTwitchTokenValidation = {
  secrets: LocalSecrets;
  twitch: LocalSecrets["twitch"];
  token: TokenValidation;
  refreshed: boolean;
};

type StoredTwitchTokenOptions = {
  secrets?: LocalSecrets;
  expectedClientId?: string;
  expectedBotUserId?: string;
  expectedBotLogin?: string;
  logger?: Logger;
};

export const validateStoredTwitchToken = async (
  options: StoredTwitchTokenOptions = {}
): Promise<StoredTwitchTokenValidation> => {
  const secrets = options.secrets ?? readLocalSecrets();
  const twitch = secrets.twitch;

  if (!twitch.accessToken) {
    throw new Error("OAuth token is missing. Connect Twitch first.");
  }

  try {
    const token = await validateToken(twitch.accessToken);
    return { secrets, twitch, token, refreshed: false };
  } catch (error) {
    if (!isInvalidTwitchAccessTokenError(error)) {
      throw error;
    }

    return refreshStoredTwitchToken({
      ...options,
      secrets
    });
  }
};

export const refreshStoredTwitchToken = async (
  options: StoredTwitchTokenOptions = {}
): Promise<StoredTwitchTokenValidation> => {
  const secrets = options.secrets ?? readLocalSecrets();
  const twitch = secrets.twitch;
  const clientId = options.expectedClientId ?? twitch.clientId;

  if (!clientId || !twitch.clientSecret || !twitch.refreshToken) {
    throw new Error(
      "Twitch OAuth refresh is unavailable. Reconnect Twitch to create a fresh access token and refresh token."
    );
  }

  const tokens = await refreshTwitchAccessToken({
    clientId,
    clientSecret: twitch.clientSecret,
    refreshToken: twitch.refreshToken
  });
  const token = await validateToken(tokens.access_token);
  assertRefreshedTokenMatchesConfiguration(token, {
    clientId,
    botUserId: options.expectedBotUserId ?? twitch.botUserId,
    botLogin: options.expectedBotLogin ?? twitch.botLogin,
    secrets
  });

  const refreshedAt = new Date().toISOString();
  const tokenLogin = normalizeLogin(token.login, "Bot login");
  const nextSecrets: LocalSecrets = {
    ...secrets,
    twitch: {
      ...twitch,
      clientId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? twitch.refreshToken,
      scopes: token.scopes.length ? token.scopes : tokens.scope,
      tokenExpiresAt: getTokenExpiresAt(tokens.expires_in),
      tokenValidatedAt: refreshedAt,
      botLogin: tokenLogin,
      botUserId: token.user_id
    }
  };

  writeLocalSecrets(nextSecrets);
  options.logger?.info(
    {
      botLogin: tokenLogin,
      botUserId: token.user_id,
      tokenExpiresAt: nextSecrets.twitch.tokenExpiresAt
    },
    "Twitch OAuth token refreshed"
  );

  return {
    secrets: nextSecrets,
    twitch: nextSecrets.twitch,
    token,
    refreshed: true
  };
};

export const refreshTwitchAccessToken = async (input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}) => {
  const params = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "refresh_token",
    refresh_token: input.refreshToken
  });
  const response = await fetch(twitchTokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Twitch token refresh failed: ${response.status} ${body}. Reconnect Twitch to authorize again.`
    );
  }

  const tokens = (await response.json()) as Partial<TwitchOAuthTokenResponse>;

  if (!tokens.access_token || !tokens.expires_in) {
    throw new Error("Twitch token refresh response did not include a usable access token.");
  }

  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
    scope: tokens.scope ?? [],
    token_type: tokens.token_type ?? "bearer"
  } satisfies TwitchOAuthTokenResponse;
};

export const getTokenExpiresAt = (expiresInSeconds: number) =>
  new Date(Date.now() + Math.max(0, expiresInSeconds) * 1000).toISOString();

export const isInvalidTwitchAccessTokenError = (error: unknown) => {
  if (error instanceof TwitchTokenValidationError) {
    return error.status === 401;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return /Twitch token validation failed:\s*401|invalid access token|status"?\s*:?\s*401/i.test(
    error.message
  );
};

const assertRefreshedTokenMatchesConfiguration = (
  token: TokenValidation,
  options: {
    clientId: string;
    botUserId?: string;
    botLogin?: string;
    secrets: LocalSecrets;
  }
) => {
  if (token.client_id !== options.clientId) {
    clearStoredAuthorization(options.secrets);
    throw new Error(
      "Refreshed OAuth token belongs to a different Twitch app. Reconnect Twitch with the saved Client ID and Client Secret."
    );
  }

  if (options.botUserId && token.user_id !== options.botUserId) {
    clearStoredAuthorization(options.secrets);
    throw new Error(
      `Refreshed OAuth token belongs to ${token.login}, but the configured bot user ID is ${options.botUserId}. Reconnect Twitch while logged into the Bot Login account.`
    );
  }

  const expectedBotLogin = options.botLogin
    ? normalizeLogin(options.botLogin, "Bot login")
    : undefined;
  const tokenLogin = normalizeLogin(token.login, "Bot login");

  if (expectedBotLogin && tokenLogin !== expectedBotLogin) {
    clearStoredAuthorization(options.secrets);
    throw new Error(
      `Refreshed OAuth token belongs to ${tokenLogin}, but Bot Login is ${expectedBotLogin}. Reconnect Twitch while logged into the Bot Login account.`
    );
  }
};

const clearStoredAuthorization = (secrets: LocalSecrets) => {
  writeLocalSecrets({
    ...secrets,
    twitch: {
      ...secrets.twitch,
      accessToken: undefined,
      refreshToken: undefined,
      scopes: [],
      tokenExpiresAt: undefined,
      tokenValidatedAt: undefined,
      botUserId: undefined
    }
  });
};
