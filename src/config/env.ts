import "dotenv/config";
import { z, ZodError } from "zod";
import { readLocalSecrets } from "./localSecrets";

const modeSchema = z.enum(["local", "live"]).default("live");
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
  TWITCH_USER_ACCESS_TOKEN: z
    .string()
    .trim()
    .min(1)
    .refine((token) => !token.startsWith("oauth:"), {
      message: "Use the raw access token without the oauth: prefix"
    }),
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
    TWITCH_CLIENT_ID: process.env.TWITCH_CLIENT_ID ?? twitch.clientId,
    TWITCH_USER_ACCESS_TOKEN:
      process.env.TWITCH_USER_ACCESS_TOKEN ?? twitch.accessToken,
    TWITCH_BROADCASTER_USER_ID:
      process.env.TWITCH_BROADCASTER_USER_ID ?? twitch.broadcasterUserId,
    TWITCH_BOT_USER_ID: process.env.TWITCH_BOT_USER_ID ?? twitch.botUserId
  });

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
    databaseUrl: env.DATABASE_URL
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
