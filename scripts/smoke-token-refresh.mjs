import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tempDir = mkdtempSync(join(tmpdir(), "vaexcore-refresh-smoke-"));
const smokeDbPath = join(tempDir, "data/vaexcore.sqlite");
const realFetch = globalThis.fetch;

process.env.VAEXCORE_CONFIG_DIR = tempDir;
process.env.DATABASE_URL = `file:${smokeDbPath}`;

const twitchCalls = [];

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;

  if (url.startsWith("https://id.twitch.tv/oauth2/validate")) {
    return mockValidate(init);
  }

  if (url.startsWith("https://id.twitch.tv/oauth2/token")) {
    return mockTokenRefresh(init);
  }

  if (url.startsWith("https://api.twitch.tv/helix/users")) {
    return mockUsers(url, init);
  }

  if (url.startsWith("https://api.twitch.tv/helix/chat/messages")) {
    return mockChatSend(init);
  }

  return realFetch(input, init);
};

writeLocalSecretsFixture({
  mode: "live",
  twitch: {
    clientId: "refresh-client-id",
    clientSecret: "refresh-client-secret",
    redirectUri: "http://localhost:3434/auth/twitch/callback",
    broadcasterLogin: "vaexil",
    botLogin: "vaexcorebot",
    accessToken: "expired-access-token",
    refreshToken: "old-refresh-token",
    scopes: ["user:read:chat", "user:write:chat"],
    tokenExpiresAt: "2026-01-01T00:00:00.000Z",
    tokenValidatedAt: "2026-01-01T00:00:00.000Z"
  }
});

const { startSetupServer } = await import(
  pathToFileURL(resolve("dist-bundle/setup-server.js")).href
);

const handle = await startSetupServer({ port: 3437 });
const baseUrl = handle.url;

try {
  await runSmoke();
  console.log("token refresh smoke passed");
} finally {
  await handle.stop();
  globalThis.fetch = realFetch;
  rmSync(tempDir, { recursive: true, force: true });
}

async function runSmoke() {
  const validation = await json("/api/validate", { method: "POST" });
  assert(validation.ok === true, "validation succeeds after refreshing expired token");
  assert(
    validation.checks.some((check) => check.ok && check.name === "Token refreshed"),
    "validation reports token refresh"
  );
  assert(
    twitchCalls.some((call) => call.type === "refresh" && call.refreshToken === "old-refresh-token"),
    "refresh endpoint was called with saved refresh token"
  );

  const secrets = readLocalSecretsFixture();
  assert(secrets.twitch.accessToken === "fresh-access-token", "fresh access token is saved");
  assert(secrets.twitch.refreshToken === "fresh-refresh-token", "rotated refresh token is saved");
  assert(secrets.twitch.botUserId === "bot-user-id", "bot user ID is saved after validation");
  assert(secrets.twitch.broadcasterUserId === "broadcaster-user-id", "broadcaster user ID is saved after validation");
  assert(Boolean(secrets.twitch.tokenExpiresAt), "token expiry is saved");
  assert(Boolean(secrets.twitch.tokenValidatedAt), "token validation timestamp is saved");

  const config = await json("/api/config");
  assert(config.hasAccessToken === true, "safe config reports access token present");
  assert(config.hasRefreshToken === true, "safe config reports refresh token available");
  assert(config.tokenExpiresAt === secrets.twitch.tokenExpiresAt, "safe config reports non-secret token expiry");
  assertSafeConfig(config);

  const status = await json("/api/status");
  assert(status.runtime.tokenValid === true, "status sees refreshed token as valid");
  assert(status.runtime.requiredScopesPresent === true, "status sees required scopes after refresh");

  const testSend = await json("/api/test-send", { method: "POST" });
  assert(testSend.ok === true, "test chat send succeeds with refreshed token");
  assert(
    twitchCalls.some((call) => call.type === "chat" && call.accessToken === "fresh-access-token"),
    "chat send uses refreshed access token"
  );
}

function mockValidate(init) {
  const accessToken = authToken(init);
  twitchCalls.push({ type: "validate", accessToken });

  if (accessToken === "expired-access-token") {
    return jsonResponse({ status: 401, message: "invalid access token" }, 401);
  }

  if (accessToken !== "fresh-access-token") {
    return jsonResponse({ status: 401, message: "unknown access token" }, 401);
  }

  return jsonResponse({
    client_id: "refresh-client-id",
    login: "vaexcorebot",
    scopes: ["user:read:chat", "user:write:chat"],
    user_id: "bot-user-id",
    expires_in: 14400
  });
}

async function mockTokenRefresh(init) {
  const body = new URLSearchParams(String(init?.body ?? ""));
  twitchCalls.push({
    type: "refresh",
    clientId: body.get("client_id"),
    refreshToken: body.get("refresh_token"),
    grantType: body.get("grant_type")
  });

  assert(body.get("client_id") === "refresh-client-id", "refresh uses saved Client ID");
  assert(body.get("client_secret") === "refresh-client-secret", "refresh uses saved Client Secret");
  assert(body.get("grant_type") === "refresh_token", "refresh uses refresh_token grant");
  assert(body.get("refresh_token") === "old-refresh-token", "refresh uses saved refresh token");

  return jsonResponse({
    access_token: "fresh-access-token",
    refresh_token: "fresh-refresh-token",
    expires_in: 14400,
    scope: ["user:read:chat", "user:write:chat"],
    token_type: "bearer"
  });
}

function mockUsers(url, init) {
  const parsed = new URL(url);
  const login = parsed.searchParams.get("login");
  twitchCalls.push({ type: "users", login, accessToken: authToken(init) });

  if (authToken(init) !== "fresh-access-token") {
    return jsonResponse({ status: 401, message: "invalid access token" }, 401);
  }

  if (login === "vaexcorebot") {
    return jsonResponse({ data: [{ id: "bot-user-id", login, display_name: "VaexCoreBot" }] });
  }

  if (login === "vaexil") {
    return jsonResponse({ data: [{ id: "broadcaster-user-id", login, display_name: "Vaexil" }] });
  }

  return jsonResponse({ data: [] });
}

async function mockChatSend(init) {
  const accessToken = authToken(init);
  twitchCalls.push({ type: "chat", accessToken, body: JSON.parse(String(init?.body ?? "{}")) });

  if (accessToken !== "fresh-access-token") {
    return jsonResponse({ status: 401, message: "invalid access token" }, 401);
  }

  return jsonResponse({
    data: [{ message_id: "smoke-message-id", is_sent: true }]
  });
}

function authToken(init) {
  const header = new Headers(init?.headers).get("authorization") || "";
  return header.replace(/^Bearer\s+/i, "");
}

async function json(path, options = {}) {
  const response = await realFetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  assert(response.ok, `${path} returned ${response.status}`);
  return response.json();
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function writeLocalSecretsFixture(secrets) {
  writeFileSync(join(tempDir, "local.secrets.json"), `${JSON.stringify(secrets, null, 2)}\n`, {
    mode: 0o600
  });
}

function readLocalSecretsFixture() {
  return JSON.parse(readFileSync(join(tempDir, "local.secrets.json"), "utf8"));
}

function assertSafeConfig(config) {
  const raw = JSON.stringify(config);
  assert(!("clientSecret" in config), "safe config omits clientSecret");
  assert(!("accessToken" in config), "safe config omits accessToken");
  assert(!("refreshToken" in config), "safe config omits refreshToken");
  assert(!raw.includes("refresh-client-secret"), "safe config does not expose saved secret");
  assert(!raw.includes("fresh-access-token"), "safe config does not expose access token");
  assert(!raw.includes("fresh-refresh-token"), "safe config does not expose refresh token");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Smoke failed: ${message}`);
  }
}
