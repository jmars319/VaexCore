import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { normalizeLogin, sanitizeText } from "../core/security";

const configDir = process.env.VAEXCORE_CONFIG_DIR
  ? resolve(process.env.VAEXCORE_CONFIG_DIR)
  : resolve(process.cwd(), "config");
const secretsPath = resolve(configDir, "local.secrets.json");

const localSecretsSchema = z.object({
  mode: z.enum(["local", "live"]).default("live"),
  twitch: z
    .object({
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
      redirectUri: z
        .string()
        .default("http://localhost:3434/auth/twitch/callback"),
      broadcasterLogin: z.string().optional(),
      broadcasterUserId: z.string().optional(),
      botLogin: z.string().optional(),
      botUserId: z.string().optional(),
      accessToken: z.string().optional(),
      refreshToken: z.string().optional(),
      scopes: z.array(z.string()).default([]),
      tokenExpiresAt: z.string().optional(),
      tokenValidatedAt: z.string().optional()
    })
    .default({})
});

export type LocalSecrets = z.infer<typeof localSecretsSchema>;

export const readLocalSecrets = (): LocalSecrets => {
  if (!existsSync(secretsPath)) {
    return { mode: "live", twitch: { redirectUri: defaultRedirectUri, scopes: [] } };
  }

  const raw = readFileSync(secretsPath, "utf8");
  return normalizeSecrets(localSecretsSchema.parse(JSON.parse(raw)));
};

export const writeLocalSecrets = (secrets: LocalSecrets) => {
  mkdirSync(dirname(secretsPath), { recursive: true });
  writeFileSync(secretsPath, `${JSON.stringify(normalizeSecrets(secrets), null, 2)}\n`, {
    mode: 0o600
  });
};

export const getLocalSecretsPath = () => secretsPath;

export const defaultRedirectUri = "http://localhost:3434/auth/twitch/callback";

const normalizeSecrets = (secrets: LocalSecrets): LocalSecrets => ({
  mode: secrets.mode,
  twitch: {
    ...secrets.twitch,
    clientId: sanitizeOptional(secrets.twitch.clientId, "Client ID", 120),
    clientSecret: sanitizeOptional(secrets.twitch.clientSecret, "Client secret", 200),
    redirectUri: secrets.twitch.redirectUri || defaultRedirectUri,
    broadcasterLogin: secrets.twitch.broadcasterLogin
      ? normalizeLogin(secrets.twitch.broadcasterLogin, "Broadcaster login")
      : undefined,
    botLogin: secrets.twitch.botLogin
      ? normalizeLogin(secrets.twitch.botLogin, "Bot login")
      : undefined
  }
});

const sanitizeOptional = (
  value: string | undefined,
  field: string,
  maxLength: number
) =>
  value
    ? sanitizeText(value, {
        field,
        maxLength,
        required: true
      })
    : undefined;
