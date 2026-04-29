import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tempDir = mkdtempSync(join(tmpdir(), "vaexcore-smoke-"));
process.env.VAEXCORE_CONFIG_DIR = tempDir;
process.env.DATABASE_URL = `file:${join(tempDir, "data/vaexcore.sqlite")}`;

const { startSetupServer } = await import(
  pathToFileURL(resolve("dist-bundle/setup-server.js")).href
);

const handle = await startSetupServer({ port: 3435 });
const baseUrl = handle.url;

try {
  await runSmoke();
  console.log("setup UI smoke passed");
} finally {
  await handle.stop();
  rmSync(tempDir, { recursive: true, force: true });
}

async function runSmoke() {
  await assertPortConflictRejects();

  const shell = await text("/");
  assert(shell.includes("/ui/app.js"), "setup shell references app.js");
  assert(shell.includes("/ui/styles.css"), "setup shell references styles.css");

  const appJs = await text("/ui/app.js");
  const styles = await text("/ui/styles.css");
  assert(appJs.includes("CommandRouter") === false, "browser UI does not duplicate router logic");
  assert(appJs.includes("Dashboard") && appJs.includes("Giveaways"), "browser UI has tabs");
  assert(appJs.includes("Setup Guide"), "setup guide renders from UI bundle");
  assert(appJs.includes("Open Twitch Developer Console"), "setup guide includes Twitch Developer Console link");
  assert(appJs.includes("Twitch authorization failed"), "setup guide surfaces OAuth errors");
  assert(appJs.indexOf("const payload = readSettingsPayload();") < appJs.indexOf('runAction("save"'), "settings save snapshots fields before rerender");
  assert(appJs.includes("const savedCredentialMask"), "settings UI uses visible masked credential sentinel");
  assert(appJs.includes("missingCredentialLabels"), "setup guide names missing credential fields");
  assert(appJs.includes("normalizeLoginInput"), "settings UI normalizes Twitch login fields");
  assert(appJs.includes("Bot Login must be the account that grants OAuth"), "setup guide explains bot OAuth identity");
  assert(appJs.includes("botLoginReconnectCallout"), "settings UI warns when bot login needs reconnect");
  assert(appJs.includes("Disconnect Twitch"), "settings UI can clear the current Twitch OAuth token");
  assert(appJs.includes("wrong_bot_account"), "settings UI explains wrong-account OAuth callbacks");
  assert(appJs.includes("npm run dev:app-config"), "setup guide points packaged app users at app-config live runtime");
  assert(appJs.includes("Start Bot") && appJs.includes("Stop Bot"), "setup UI exposes bot runtime controls");
  assert(appJs.includes("Saved Client ID and Client Secret are intentionally not shown"), "settings UI explains masked credentials");
  assert(appJs.includes("giveawayDraft"), "giveaway form uses draft state across refreshes");
  assert(appJs.includes("updateGiveawayDraft"), "giveaway inputs preserve operator edits during polling");
  assert(styles.includes(".tab-panel"), "styles asset loaded");
  assert(styles.includes(".setup-step"), "setup guide styles loaded");
  assert(styles.includes(".runtime-log"), "bot runtime log styles loaded");

  const initialConfig = await json("/api/config");
  assertSafeConfig(initialConfig);

  const invalidBotStart = await json("/api/bot/start", { method: "POST" });
  assert(invalidBotStart.ok === false, "bot start is blocked before validation");
  const stoppedBot = await json("/api/bot/stop", { method: "POST" });
  assert(stoppedBot.ok === true, "bot stop is safe when already stopped");

  const partialSaved = await json("/api/config", {
    method: "POST",
    body: {
      mode: "live",
      redirectUri: "http://localhost:3434/auth/twitch/callback",
      clientId: "fake-client-id"
    }
  });
  assert(partialSaved.config.hasClientId === true, "settings save persists client ID without client secret");
  assert(partialSaved.config.hasClientSecret === false, "partial settings save still reports missing client secret");
  assertSafeConfig(partialSaved.config);

  const saved = await json("/api/config", {
    method: "POST",
    body: {
      mode: "live",
      redirectUri: "http://localhost:3434/auth/twitch/callback",
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      broadcasterLogin: "https://www.twitch.tv/BroadCaster",
      botLogin: "@Bot"
    }
  });
  assert(saved.ok === true, "settings save returns ok");
  assert(saved.config.hasClientId === true, "saved config reports client ID present");
  assert(saved.config.hasClientSecret === true, "saved config reports client secret present");
  assert(saved.config.hasBotUserId === false, "saved config reports bot ID unresolved before OAuth");
  assert(saved.config.hasBroadcasterUserId === false, "saved config reports broadcaster ID unresolved before validation");
  assert(Array.isArray(saved.config.requiredScopes), "safe config reports required scopes");
  assertSafeConfig(saved.config);

  const reloadedConfig = await json("/api/config");
  assert(reloadedConfig.broadcasterLogin === "broadcaster", "settings reload normalized broadcaster login");
  assert(reloadedConfig.botLogin === "bot", "settings reload bot login");
  assertSafeConfig(reloadedConfig);

  writeLocalSecretsFixture({
    mode: "live",
    twitch: {
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      redirectUri: "http://localhost:3434/auth/twitch/callback",
      broadcasterLogin: "broadcaster",
      broadcasterUserId: "broadcaster-id",
      botLogin: "oldbot",
      botUserId: "oldbot-id",
      accessToken: "fake-access-token",
      refreshToken: "fake-refresh-token",
      scopes: ["user:read:chat", "user:write:chat"],
      tokenExpiresAt: "2099-01-01T00:00:00.000Z",
      tokenValidatedAt: "2099-01-01T00:00:00.000Z"
    }
  });
  const changedBotLogin = await json("/api/config", {
    method: "POST",
    body: {
      mode: "live",
      redirectUri: "http://localhost:3434/auth/twitch/callback",
      broadcasterLogin: "broadcaster",
      botLogin: "newbot"
    }
  });
  assert(changedBotLogin.config.botLogin === "newbot", "settings save allows changing bot login");
  assert(changedBotLogin.config.hasAccessToken === false, "changing bot login clears old OAuth token");
  assert(changedBotLogin.config.hasBotUserId === false, "changing bot login clears old bot identity");
  assert(changedBotLogin.config.hasBroadcasterUserId === true, "changing bot login keeps unchanged broadcaster identity");
  assertSafeConfig(changedBotLogin.config);

  writeLocalSecretsFixture({
    mode: "live",
    twitch: {
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      redirectUri: "http://localhost:3434/auth/twitch/callback",
      broadcasterLogin: "broadcaster",
      broadcasterUserId: "broadcaster-id",
      botLogin: "newbot",
      botUserId: "newbot-id",
      accessToken: "fake-access-token",
      refreshToken: "fake-refresh-token",
      scopes: ["user:read:chat", "user:write:chat"],
      tokenExpiresAt: "2099-01-01T00:00:00.000Z",
      tokenValidatedAt: "2099-01-01T00:00:00.000Z"
    }
  });
  const disconnected = await json("/api/auth/twitch/disconnect", { method: "POST" });
  assert(disconnected.config.hasAccessToken === false, "disconnect clears OAuth token");
  assert(disconnected.config.hasBotUserId === false, "disconnect clears bot identity");
  assert(disconnected.config.hasBroadcasterUserId === false, "disconnect clears broadcaster identity");
  assertSafeConfig(disconnected.config);

  const authStart = await fetch(`${baseUrl}/auth/twitch/start`, { redirect: "manual" });
  assert(authStart.status === 302, "OAuth start route exists");
  assert(authStart.headers.get("location")?.startsWith("https://id.twitch.tv/"), "OAuth start redirects to Twitch");
  assert(authStart.headers.get("location")?.includes("force_verify=true"), "OAuth start forces account verification");

  const authCallback = await fetch(`${baseUrl}/auth/twitch/callback?error=access_denied`, {
    redirect: "manual"
  });
  assert(authCallback.status === 302, "OAuth callback route exists");

  const validation = await json("/api/validate", { method: "POST" });
  assert(validation.ok === false, "validation fails clearly without OAuth token");
  assert(Array.isArray(validation.checks), "validation returns checks");

  const chatSend = await json("/api/chat/send", {
    method: "POST",
    body: { message: "hello chat" }
  });
  assert(chatSend.ok === false, "chat send route rejects until validation passes");

  const viewerDenied = await json("/api/command/simulate", {
    method: "POST",
    body: {
      actor: "viewer",
      role: "viewer",
      command: "!gstart codes=1 keyword=enter title=\"Smoke\"",
      echoToChat: true
    }
  });
  assert(viewerDenied.ok === true, "viewer simulated command returns ok envelope");
  assert(viewerDenied.routerResult === "denied", "viewer protected command is denied");
  assert(viewerDenied.echoQueued === false, "denied command does not echo");

  const broadcasterStatus = await json("/api/command/simulate", {
    method: "POST",
    body: { actor: "broadcaster", role: "broadcaster", command: "!gstatus" }
  });
  assert(broadcasterStatus.routerResult === "handled", "broadcaster command routes through CommandRouter");

  const commandStart = await json("/api/command/simulate", {
    method: "POST",
    body: {
      actor: "broadcaster",
      role: "broadcaster",
      command: "!gstart codes=1 keyword=raffle title=\"Chat Announce\""
    }
  });
  assert(commandStart.replies.some((reply) => reply.includes("Type !raffle to enter")), "giveaway start announces entry command");

  const commandEnter = await json("/api/command/simulate", {
    method: "POST",
    body: { actor: "alice", role: "viewer", command: "!raffle" }
  });
  assert(commandEnter.routerResult === "handled", "custom giveaway keyword routes through fallback");
  assert(commandEnter.replies.some((reply) => reply.includes("Thanks alice")), "giveaway entry thanks entrant");

  const duplicateEnter = await json("/api/command/simulate", {
    method: "POST",
    body: { actor: "alice", role: "viewer", command: "!raffle" }
  });
  assert(duplicateEnter.replies.some((reply) => reply.includes("already entered")), "duplicate giveaway entry is acknowledged");

  const commandClose = await json("/api/command/simulate", {
    method: "POST",
    body: { actor: "broadcaster", role: "broadcaster", command: "!gclose" }
  });
  assert(commandClose.replies.some((reply) => reply.includes("Entries closed")), "giveaway close announces entry count");

  const commandDraw = await json("/api/command/simulate", {
    method: "POST",
    body: { actor: "broadcaster", role: "broadcaster", command: "!gdraw 1" }
  });
  assert(commandDraw.replies.some((reply) => reply.includes("Winner: alice")), "giveaway draw announces winner");

  const commandEnd = await json("/api/command/simulate", {
    method: "POST",
    body: { actor: "broadcaster", role: "broadcaster", command: "!gend" }
  });
  assert(commandEnd.replies.some((reply) => reply.includes("Final winner: alice")), "giveaway end announces final winner");

  await expectOk("/api/giveaway/start", {
    title: "Smoke Giveaway",
    keyword: "enter",
    winnerCount: 2
  });
  await expectOk("/api/giveaway/add-entrant", { login: "alice", displayName: "Alice" });
  await expectOk("/api/giveaway/add-entrant", { login: "bob", displayName: "Bob" });
  await expectOk("/api/giveaway/close");
  await expectOk("/api/giveaway/draw", { count: 2 });

  const giveaway = await json("/api/giveaway");
  assert(giveaway.entries.length === 2, "giveaway entrants load");
  assert(giveaway.winners.length === 2, "giveaway winners load");
  assert(giveaway.summary.status === "closed", "giveaway summary loads");

  const firstWinner = giveaway.winners[0]?.login;
  assert(Boolean(firstWinner), "winner login exists");
  await expectOk("/api/giveaway/claim", { username: firstWinner });
  await expectOk("/api/giveaway/deliver", { username: firstWinner });

  const auditLogs = await json("/api/audit-logs");
  assert(auditLogs.logs.length > 0, "audit logs load");

  await expectOk("/api/giveaway/end");
  const lifecycle = await json("/api/giveaway/run-test", {
    method: "POST",
    body: { confirmed: true }
  });
  assert(lifecycle.ok === true, "lifecycle test works");
  await expectOk("/api/giveaway/end");
}

async function assertPortConflictRejects() {
  let rejected = false;

  try {
    await startSetupServer({ port: 3435 });
  } catch (error) {
    rejected = true;
    assert(error.code === "EADDRINUSE", "setup server rejects with EADDRINUSE when port is occupied");
  }

  assert(rejected, "setup server rejects when port is occupied");
}

function writeLocalSecretsFixture(secrets) {
  writeFileSync(join(tempDir, "local.secrets.json"), `${JSON.stringify(secrets, null, 2)}\n`, {
    mode: 0o600
  });
}

async function expectOk(path, body = {}) {
  const result = await json(path, { method: "POST", body });
  assert(result.ok === true, `${path} returns ok`);
  return result;
}

async function text(path) {
  const response = await fetch(`${baseUrl}${path}`);
  assert(response.ok, `${path} returned ${response.status}`);
  return response.text();
}

async function json(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  assert(response.ok, `${path} returned ${response.status}`);
  return response.json();
}

function assertSafeConfig(config) {
  const raw = JSON.stringify(config);
  assert(!("clientSecret" in config), "safe config omits clientSecret");
  assert(!("accessToken" in config), "safe config omits accessToken");
  assert(!("refreshToken" in config), "safe config omits refreshToken");
  assert(!raw.includes("fake-client-secret"), "safe config does not expose saved secret");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Smoke failed: ${message}`);
  }
}
