import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tempDir = mkdtempSync(join(tmpdir(), "vaexcore-cli-env-smoke-"));
const secretsPath = join(tempDir, "local.secrets.json");

process.env.VAEXCORE_CONFIG_DIR = tempDir;
process.env.DATABASE_URL = "file:./data/vaexcore.sqlite";
process.env.VAEXCORE_MODE = "live";
process.env.TWITCH_CLIENT_ID = "cli-client-id";
process.env.TWITCH_CLIENT_SECRET = "cli-client-secret";
process.env.TWITCH_USER_ACCESS_TOKEN = "cli-access-token";
process.env.TWITCH_REFRESH_TOKEN = "cli-refresh-token";
process.env.TWITCH_BROADCASTER_USER_ID = "cli-broadcaster-id";
process.env.TWITCH_BOT_USER_ID = "cli-bot-id";

const { loadEnv } = await import(pathToFileURL(resolve("src/config/env.ts")).href);

try {
  await runSmoke();
  console.log("cli env bootstrap smoke passed");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

async function runSmoke() {
  const refreshCapable = loadEnv();
  assert(refreshCapable.mode === "live", "refresh-capable env loads live mode");
  assert(refreshCapable.twitchAutoRefreshAvailable === true, "auto-refresh is reported available");
  assert(refreshCapable.twitchSecretsBootstrapped === true, "refresh-capable env bootstraps local secrets");

  const stored = readLocalSecretsFixture();
  assert(stored.mode === "live", "stored mode is live");
  assert(stored.twitch.clientId === "cli-client-id", "client ID is stored");
  assert(stored.twitch.clientSecret === "cli-client-secret", "client secret is stored");
  assert(stored.twitch.accessToken === "cli-access-token", "access token is stored");
  assert(stored.twitch.refreshToken === "cli-refresh-token", "refresh token is stored");
  assert(stored.twitch.broadcasterUserId === "cli-broadcaster-id", "broadcaster ID is stored");
  assert(stored.twitch.botUserId === "cli-bot-id", "bot ID is stored");

  const secondLoad = loadEnv();
  assert(secondLoad.twitchSecretsBootstrapped === false, "unchanged bootstrap is idempotent");

  rmSync(secretsPath, { force: true });
  delete process.env.TWITCH_CLIENT_SECRET;
  delete process.env.TWITCH_REFRESH_TOKEN;
  process.env.TWITCH_CLIENT_ID = "access-only-client-id";
  process.env.TWITCH_USER_ACCESS_TOKEN = "access-only-token";
  process.env.TWITCH_BROADCASTER_USER_ID = "access-only-broadcaster-id";
  process.env.TWITCH_BOT_USER_ID = "access-only-bot-id";

  const accessOnly = loadEnv();
  assert(accessOnly.twitchAutoRefreshAvailable === false, "access-token-only env stays supported");
  assert(accessOnly.twitchSecretsBootstrapped === false, "access-token-only env does not write local secrets");
  assert(!existsSync(secretsPath), "access-token-only env leaves local OAuth store untouched");
}

function readLocalSecretsFixture() {
  return JSON.parse(readFileSync(secretsPath, "utf8"));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Smoke failed: ${message}`);
  }
}
