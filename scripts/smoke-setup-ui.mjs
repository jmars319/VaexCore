import { mkdtempSync, rmSync } from "node:fs";
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
  const shell = await text("/");
  assert(shell.includes("/ui/app.js"), "setup shell references app.js");
  assert(shell.includes("/ui/styles.css"), "setup shell references styles.css");

  const appJs = await text("/ui/app.js");
  const styles = await text("/ui/styles.css");
  assert(appJs.includes("CommandRouter") === false, "browser UI does not duplicate router logic");
  assert(appJs.includes("Dashboard") && appJs.includes("Giveaways"), "browser UI has tabs");
  assert(styles.includes(".tab-panel"), "styles asset loaded");

  const initialConfig = await json("/api/config");
  assertSafeConfig(initialConfig);

  const saved = await json("/api/config", {
    method: "POST",
    body: {
      mode: "live",
      redirectUri: "http://localhost:3434/auth/twitch/callback",
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      broadcasterLogin: "broadcaster",
      botLogin: "bot"
    }
  });
  assert(saved.ok === true, "settings save returns ok");
  assert(saved.config.hasClientId === true, "saved config reports client ID present");
  assert(saved.config.hasClientSecret === true, "saved config reports client secret present");
  assertSafeConfig(saved.config);

  const reloadedConfig = await json("/api/config");
  assert(reloadedConfig.broadcasterLogin === "broadcaster", "settings reload broadcaster login");
  assert(reloadedConfig.botLogin === "bot", "settings reload bot login");
  assertSafeConfig(reloadedConfig);

  const authStart = await fetch(`${baseUrl}/auth/twitch/start`, { redirect: "manual" });
  assert(authStart.status === 302, "OAuth start route exists");
  assert(authStart.headers.get("location")?.startsWith("https://id.twitch.tv/"), "OAuth start redirects to Twitch");

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
