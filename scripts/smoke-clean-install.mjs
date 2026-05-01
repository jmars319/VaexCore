import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tempDir = mkdtempSync(join(tmpdir(), "vaexcore-clean-install-smoke-"));
const smokeDbPath = join(tempDir, "data/vaexcore.sqlite");

process.env.VAEXCORE_CONFIG_DIR = tempDir;
process.env.DATABASE_URL = `file:${smokeDbPath}`;

const { startSetupServer } = await import(
  pathToFileURL(resolve("dist-bundle/setup-server.js")).href
);

const handle = await startSetupServer({ port: 3439 });
const baseUrl = handle.url;

try {
  await runSmoke();
  console.log("clean install smoke passed");
} finally {
  await handle.stop();
  rmSync(tempDir, { recursive: true, force: true });
}

async function runSmoke() {
  const shell = await text("/");
  assert(shell.includes("/ui/app.js"), "setup shell loads static UI");

  const config = await json("/api/config");
  assert(config.redirectUri === "http://localhost:3434/auth/twitch/callback", "clean install uses default redirect");
  assert(config.hasClientId === false, "clean install starts without client ID");
  assert(config.hasAccessToken === false, "clean install starts disconnected");
  assertSafePayload(config);

  const diagnostics = await json("/api/diagnostics");
  assert(diagnostics.ok === false, "clean install diagnostics report setup blockers");
  assert(diagnostics.firstRun.cleanInstall === true, "diagnostics detects clean install");
  assert(diagnostics.firstRun.nextAction.includes("Setup Guide"), "first-run next action points to setup guide");
  assert(diagnostics.firstRun.recoverySteps.length >= 3, "first-run recovery steps are present");
  assert(diagnostics.database.ok === true, "clean install database initializes");
  assert(diagnostics.setupUi.appJs === true, "clean install diagnostics sees UI assets");
  assertSafePayload(diagnostics);

  const blockedStart = await json("/api/bot/start", { method: "POST" });
  assert(blockedStart.ok === false, "bot start is blocked on clean install");
  assert(blockedStart.nextAction || blockedStart.error, "blocked bot start explains next action");
  assert(Array.isArray(blockedStart.checks), "blocked bot start returns readiness checks");
  assert(blockedStart.diagnostics.firstRun.cleanInstall === true, "blocked bot start includes diagnostics");
  assertSafePayload(blockedStart);

  const bundle = await json("/api/support-bundle");
  assert(bundle.ok === true, "support bundle route returns ok");
  assert(bundle.bundleVersion === 1, "support bundle has version");
  assert(bundle.diagnostics.firstRun.cleanInstall === true, "support bundle includes diagnostics");
  assert(Array.isArray(bundle.recent.botLogs), "support bundle includes bot logs array");
  assertSafePayload(bundle);
}

async function text(path) {
  const response = await fetch(`${baseUrl}${path}`);
  assert(response.ok, `${path} returned ${response.status}`);
  return response.text();
}

async function json(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET"
  });
  assert(response.ok, `${path} returned ${response.status}`);
  return response.json();
}

function assertSafePayload(payload) {
  const raw = JSON.stringify(payload);
  assert(!raw.includes("client_secret="), "payload does not expose client_secret parameter");
  assert(!raw.includes("access_token="), "payload does not expose access_token parameter");
  assert(!raw.includes("refresh_token="), "payload does not expose refresh_token parameter");
  assert(!raw.includes("Bearer "), "payload does not expose bearer tokens");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Smoke failed: ${message}`);
  }
}
