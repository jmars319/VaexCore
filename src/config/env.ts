import "dotenv/config";
import { z, ZodError } from "zod";
import {
  defaultRedirectUri,
  readLocalSecrets,
  writeLocalSecrets,
  type LocalSecrets
} from "./localSecrets";

const modeSchema = z.enum(["local", "live"]).default("live");
const optionalEnvString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).optional()
);
const baseEnvSchema = z.object({
  VAEXCORE_MODE: modeSchema,
  COMMAND_PREFIX: z.string().min(1).default("!"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  VAEXCORE_DEBUG: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  DATABASE_URL: z.string().trim().min(1).default("file:./data/vaexcore.sqlite"),
  TWITCH_EVENTSUB_URL: z
    .string()
    .url()
    .default("wss://eventsub.wss.twitch.tv/ws")
});

const liveEnvSchema = baseEnvSchema.extend({
  VAEXCORE_MODE: z.literal("live"),
  TWITCH_CLIENT_ID: z.string().trim().min(1),
  TWITCH_CLIENT_SECRET: optionalEnvString,
  TWITCH_USER_ACCESS_TOKEN: z
    .string()
    .trim()
    .min(1)
    .refine((token) => !token.startsWith("oauth:"), {
      message: "Use the raw access token without the oauth: prefix"
    }),
  TWITCH_REFRESH_TOKEN: optionalEnvString,
  TWITCH_BROADCASTER_USER_ID: z.string().trim().min(1),
  TWITCH_BOT_USER_ID: z.string().trim().min(1)
});

export type Env = ReturnType<typeof loadEnv>;
export type LiveEnv = Extract<Env, { mode: "live" }>;

export const loadEnv = () => {
  const baseEnv = baseEnvSchema.parse(process.env);
  const secrets = readLocalSecrets();
  const twitch = secrets.twitch;

  const mode = process.env.VAEXCORE_MODE ?? secrets.mode;

  if (mode === "local") {
    return {
      mode,
      commandPrefix: baseEnv.COMMAND_PREFIX,
      logLevel: baseEnv.LOG_LEVEL,
      debug: baseEnv.VAEXCORE_DEBUG,
      databaseUrl: baseEnv.DATABASE_URL,
      twitchEventSubUrl: baseEnv.TWITCH_EVENTSUB_URL
    } as const;
  }

  const env = liveEnvSchema.parse({
    ...process.env,
    VAEXCORE_MODE: "live",
    TWITCH_CLIENT_ID: envValueOrExisting("TWITCH_CLIENT_ID", twitch.clientId),
    TWITCH_CLIENT_SECRET: envValueOrExisting(
      "TWITCH_CLIENT_SECRET",
      twitch.clientSecret
    ),
    TWITCH_USER_ACCESS_TOKEN:
      envValueOrExisting("TWITCH_USER_ACCESS_TOKEN", twitch.accessToken),
    TWITCH_REFRESH_TOKEN: envValueOrExisting(
      "TWITCH_REFRESH_TOKEN",
      twitch.refreshToken
    ),
    TWITCH_BROADCASTER_USER_ID:
      envValueOrExisting("TWITCH_BROADCASTER_USER_ID", twitch.broadcasterUserId),
    TWITCH_BOT_USER_ID: envValueOrExisting("TWITCH_BOT_USER_ID", twitch.botUserId)
  });
  const bootstrap = bootstrapLocalOAuthStore(secrets, env);

  return {
    mode: env.VAEXCORE_MODE,
    twitchClientId: env.TWITCH_CLIENT_ID,
    twitchUserAccessToken: env.TWITCH_USER_ACCESS_TOKEN,
    twitchBroadcasterUserId: env.TWITCH_BROADCASTER_USER_ID,
    twitchBotUserId: env.TWITCH_BOT_USER_ID,
    commandPrefix: env.COMMAND_PREFIX,
    logLevel: env.LOG_LEVEL,
    debug: env.VAEXCORE_DEBUG,
    twitchEventSubUrl: env.TWITCH_EVENTSUB_URL,
    databaseUrl: env.DATABASE_URL,
    twitchAutoRefreshAvailable: Boolean(
      env.TWITCH_CLIENT_SECRET && env.TWITCH_REFRESH_TOKEN
    ),
    twitchSecretsBootstrapped: bootstrap.wrote
  } as const;
};

export const parseEnv = () => {
  const baseEnv = baseEnvSchema.parse(process.env);

  if (baseEnv.VAEXCORE_MODE === "local") {
    return baseEnv;
  }

  return liveEnvSchema.parse({
    ...process.env,
    VAEXCORE_MODE: "live"
  });
};

export const formatEnvError = (error: unknown) => {
  if (!(error instanceof ZodError)) {
    return error instanceof Error ? error.message : String(error);
  }

  return error.issues
    .map((issue) => {
      const key = issue.path.join(".") || "environment";
      return `${key}: ${issue.message}`;
    })
    .join("\n");
};

const envValueOrExisting = (key: string, existing: string | undefined) => {
  const value = process.env[key]?.trim();
  return value ? value : existing;
};

const bootstrapLocalOAuthStore = (
  existing: LocalSecrets,
  env: z.infer<typeof liveEnvSchema>
) => {
  if (!env.TWITCH_CLIENT_SECRET || !env.TWITCH_REFRESH_TOKEN) {
    return { wrote: false };
  }

  const next: LocalSecrets = {
    mode: "live",
    twitch: {
      ...existing.twitch,
      clientId: env.TWITCH_CLIENT_ID,
      clientSecret: env.TWITCH_CLIENT_SECRET,
      redirectUri: existing.twitch.redirectUri || defaultRedirectUri,
      accessToken: env.TWITCH_USER_ACCESS_TOKEN,
      refreshToken: env.TWITCH_REFRESH_TOKEN,
      broadcasterUserId: env.TWITCH_BROADCASTER_USER_ID,
      botUserId: env.TWITCH_BOT_USER_ID
    }
  };

  if (JSON.stringify(existing) === JSON.stringify(next)) {
    return { wrote: false };
  }

  writeLocalSecrets(next);
  return { wrote: true };
};
