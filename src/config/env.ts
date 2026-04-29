import "dotenv/config";
import { z, ZodError } from "zod";

const envSchema = z.object({
  TWITCH_CLIENT_ID: z.string().trim().min(1),
  TWITCH_USER_ACCESS_TOKEN: z
    .string()
    .trim()
    .min(1)
    .refine((token) => !token.startsWith("oauth:"), {
      message: "Use the raw access token without the oauth: prefix"
    }),
  TWITCH_BROADCASTER_USER_ID: z.string().trim().min(1),
  TWITCH_BOT_USER_ID: z.string().trim().min(1),
  COMMAND_PREFIX: z.string().min(1).default("!"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  TWITCH_EVENTSUB_URL: z
    .string()
    .url()
    .default("wss://eventsub.wss.twitch.tv/ws"),
  DATABASE_URL: z.string().trim().min(1).default("file:./data/vaexcore.sqlite")
});

export type Env = ReturnType<typeof loadEnv>;

export const loadEnv = () => {
  const env = parseEnv();

  return {
    twitchClientId: env.TWITCH_CLIENT_ID,
    twitchUserAccessToken: env.TWITCH_USER_ACCESS_TOKEN,
    twitchBroadcasterUserId: env.TWITCH_BROADCASTER_USER_ID,
    twitchBotUserId: env.TWITCH_BOT_USER_ID,
    commandPrefix: env.COMMAND_PREFIX,
    logLevel: env.LOG_LEVEL,
    twitchEventSubUrl: env.TWITCH_EVENTSUB_URL,
    databaseUrl: env.DATABASE_URL
  };
};

export const parseEnv = () => envSchema.parse(process.env);

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
