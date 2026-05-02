import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tempDir = mkdtempSync(join(tmpdir(), "vaexcore-diagnostics-smoke-"));
const smokeDbPath = join(tempDir, "data/vaexcore.sqlite");

process.env.VAEXCORE_CONFIG_DIR = tempDir;
process.env.DATABASE_URL = `file:${smokeDbPath}`;

writeLocalSecretsFixture({
  mode: "live",
  twitch: {
    clientId: "diagnostics-client-id",
    clientSecret: "diagnostics-client-secret",
    redirectUri: "http://localhost:3434/auth/twitch/callback",
    broadcasterLogin: "vaexil",
    broadcasterUserId: "broadcaster-id",
    botLogin: "vaexcorebot",
    botUserId: "bot-id",
    accessToken: "diagnostics-access-token",
    refreshToken: "diagnostics-refresh-token",
    scopes: ["user:read:chat", "user:write:chat"],
    tokenExpiresAt: "2099-01-01T00:00:00.000Z",
    tokenValidatedAt: "2099-01-01T00:00:00.000Z"
  }
});

const { startSetupServer } = await import(
  pathToFileURL(resolve("dist-bundle/setup-server.js")).href
);

const handle = await startSetupServer({ port: 3438 });
const baseUrl = handle.url;

try {
  await runSmoke();
  console.log("diagnostics smoke passed");
} finally {
  await handle.stop();
  rmSync(tempDir, { recursive: true, force: true });
}

async function runSmoke() {
  const shell = await text("/");
  assert(shell.includes("/ui/app.js"), "setup shell loads static UI");

  const diagnostics = await json("/api/diagnostics");
  assert(diagnostics.ok === true, "diagnostics returns ok when core blockers are clear");
  assert(diagnostics.app.version, "diagnostics includes app version");
  assert(diagnostics.app.runtime, "diagnostics includes runtime kind");
  assert(diagnostics.paths.configDir === tempDir, "diagnostics includes config path");
  assert(diagnostics.paths.databaseUrl === "file:<local sqlite path>", "diagnostics redacts database URL details");
  assert(diagnostics.paths.databasePath.endsWith("vaexcore.sqlite"), "diagnostics includes database path");
  assert(diagnostics.database.ok === true, "diagnostics probes database");
  assert(diagnostics.database.driver === "better-sqlite3", "diagnostics reports better-sqlite3 driver");
  assert(diagnostics.setupUi.appJs === true, "diagnostics sees app.js");
  assert(diagnostics.setupUi.stylesCss === true, "diagnostics sees styles.css");
  assert(diagnostics.setupUi.logoJpg === true, "diagnostics sees logo.jpg");
  assert(diagnostics.config.hasRefreshToken === true, "diagnostics reports refresh availability");
  assert(Array.isArray(diagnostics.checks), "diagnostics returns checks");
  assert(diagnostics.checks.some((check) => check.name === "OAuth refresh" && check.ok), "diagnostics checks OAuth refresh");
  assert(diagnostics.readiness.warnings.some((warning) => warning.includes("Bot runtime")), "diagnostics warns when bot is stopped");
  assert(diagnostics.firstRun.cleanInstall === false, "diagnostics does not mark configured app as clean install");
  assert(diagnostics.firstRun.setupComplete === true, "diagnostics reports setup complete");
  assertSafeDiagnostics(diagnostics);

  const bundle = await json("/api/support-bundle");
  assert(bundle.ok === true, "support bundle route returns ok");
  assert(bundle.bundleVersion === 1, "support bundle has version");
  assert(bundle.diagnostics.config.hasRefreshToken === true, "support bundle includes safe diagnostics");
  assert(Array.isArray(bundle.recent.outbound), "support bundle includes outbound history");
  assert(Array.isArray(bundle.recent.audit), "support bundle includes audit history");
  assertSafeDiagnostics(bundle);
}

async function text(path) {
  const response = await fetch(`${baseUrl}${path}`);
  assert(response.ok, `${path} returned ${response.status}`);
  return response.text();
}

async function json(path) {
  const response = await fetch(`${baseUrl}${path}`);
  assert(response.ok, `${path} returned ${response.status}`);
  return response.json();
}

function writeLocalSecretsFixture(secrets) {
  writeFileSync(join(tempDir, "local.secrets.json"), `${JSON.stringify(secrets, null, 2)}\n`, {
    mode: 0o600
  });
}

function assertSafeDiagnostics(report) {
  const raw = JSON.stringify(report);
  const config = report.config || report.diagnostics?.config || {};
  assert(!("clientSecret" in config), "safe config omits clientSecret");
  assert(!("accessToken" in config), "safe config omits accessToken");
  assert(!("refreshToken" in config), "safe config omits refreshToken");
  assert(!raw.includes("diagnostics-client-secret"), "diagnostics does not expose client secret");
  assert(!raw.includes("diagnostics-access-token"), "diagnostics does not expose access token");
  assert(!raw.includes("diagnostics-refresh-token"), "diagnostics does not expose refresh token");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Smoke failed: ${message}`);
  }
}
