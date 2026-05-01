import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const setupPort = 3434;
const setupUrl = `http://127.0.0.1:${setupPort}`;
const releaseDir = resolve("release");
const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const productName = packageJson.build?.productName ?? packageJson.name;
const version = packageJson.version ?? "0.0.0";
const artifactBase = `${productName}-${version}-mac-${process.arch}-unsigned`;
const zipPath = join(releaseDir, `${artifactBase}.zip`);
const checksumPath = join(releaseDir, `${artifactBase}.zip.sha256`);
const manifestPath = join(releaseDir, `${artifactBase}.json`);
const tempDir = mkdtempSync(join(tmpdir(), "vaexcore-tester-artifact-"));
const extractDir = join(tempDir, "extracted");
const userDataDir = join(tempDir, "user-data");
const scenario = process.argv.includes("--preserve-data") ? "preserve-data" : "clean-install";
const require = createRequire(import.meta.url);

let child;

if (process.platform !== "darwin") {
  throw new Error("Tester artifact smoke must run on macOS.");
}

try {
  await runSmoke();
  console.log(scenario === "preserve-data" ? "tester update smoke passed" : "tester artifact smoke passed");
} finally {
  await stopChild();
  rmSync(tempDir, { recursive: true, force: true });
}

async function runSmoke() {
  assert(existsSync(zipPath), `unsigned zip exists at ${zipPath}; run npm run app:zip first`);
  assert(existsSync(checksumPath), "checksum exists");
  assert(existsSync(manifestPath), "manifest exists");

  await assertPortAvailable(setupPort);
  await assertChecksum();

  execFileSync("ditto", ["-x", "-k", zipPath, extractDir], { stdio: "inherit" });

  const appPath = join(extractDir, `${productName}.app`);
  const executablePath = join(appPath, "Contents/MacOS", productName);
  assert(existsSync(executablePath), "extracted app executable exists");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert(manifest.releaseType === "unsigned-tester", "manifest marks unsigned tester release");
  assert(manifest.notarized === false, "manifest marks artifact as not notarized");
  assert(manifest.signing === "ad-hoc", "manifest marks ad-hoc signing");

  if (scenario === "preserve-data") {
    seedExistingAppData();
  }

  const env = { ...process.env, VAEXCORE_APP_USER_DATA: userDataDir };
  delete env.ELECTRON_RUN_AS_NODE;

  child = spawn(executablePath, [], {
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const logs = captureProcessLogs(child);

  await waitForHttp("/", logs);

  const shell = await text("/");
  assert(shell.includes("/ui/app.js"), "setup shell loads static UI");

  const appJs = await text("/ui/app.js");
  assert(appJs.includes("Setup Guide"), "setup guide code is present in tester artifact");
  assert(appJs.includes("Diagnostics"), "diagnostics UI code is present in tester artifact");
  assert(appJs.includes("Copy support bundle"), "support bundle UI code is present in tester artifact");
  assert(appJs.includes("About This Build"), "build/version diagnostics UI is present in tester artifact");
  assert(appJs.includes("Manual updates should replace only VaexCore.app"), "update-safe diagnostics note is present in tester artifact");

  const diagnostics = await json("/api/diagnostics");
  assert(diagnostics.app.runtime === "electron", "diagnostics reports Electron runtime");
  assert(diagnostics.app.electron, "diagnostics reports Electron version");
  assert(diagnostics.paths.configDir === userDataDir, "tester artifact uses isolated app user data");
  assert(diagnostics.paths.databaseUrl === "file:<local sqlite path>", "diagnostics redacts database URL details");
  assert(diagnostics.database.ok === true, "tester artifact database opens");
  assert(diagnostics.database.driver === "better-sqlite3", "tester artifact uses better-sqlite3");
  assert(diagnostics.setupUi.appJs === true, "tester artifact sees app.js");
  assert(diagnostics.setupUi.stylesCss === true, "tester artifact sees styles.css");

  if (scenario === "clean-install") {
    assert(diagnostics.firstRun.cleanInstall === true, "tester artifact starts as clean install with isolated data");
    assert(diagnostics.firstRun.nextAction === "Open Settings -> Setup Guide.", "clean install points to setup guide");
    assert(diagnostics.readiness.blockers.some((blocker) => blocker.includes("Required Twitch config")), "diagnostics reports missing setup blockers");
  } else {
    await assertExistingAppDataSurvived(diagnostics);
  }

  assertSafeReport(diagnostics);

  const bundle = await json("/api/support-bundle");
  assert(bundle.ok === true, "support bundle route returns ok");
  assert(bundle.bundleVersion === 1, "support bundle has version");
  assert(bundle.diagnostics.app.runtime === "electron", "support bundle reports Electron runtime");
  assert(bundle.diagnostics.paths.configDir === userDataDir, "support bundle keeps isolated app user data");
  assert(Array.isArray(bundle.recovery), "support bundle includes recovery steps");
  assertSafeReport(bundle);
}

function seedExistingAppData() {
  mkdirSync(join(userDataDir, "data"), { recursive: true });
  writeFileSync(join(userDataDir, "local.secrets.json"), `${JSON.stringify({
    mode: "live",
    twitch: {
      clientId: "update-client-id",
      clientSecret: "update-client-secret",
      redirectUri: "http://localhost:3434/auth/twitch/callback",
      broadcasterLogin: "vaexil",
      broadcasterUserId: "update-broadcaster-id",
      botLogin: "vaexcorebot",
      botUserId: "update-bot-id",
      accessToken: "update-access-token-123456",
      refreshToken: "update-refresh-token-123456",
      scopes: ["user:read:chat", "user:write:chat"],
      tokenExpiresAt: "2099-01-01T00:00:00.000Z",
      tokenValidatedAt: "2099-01-01T00:00:00.000Z"
    }
  }, null, 2)}\n`, { mode: 0o600 });

  const Database = require("better-sqlite3");
  const db = new Database(join(userDataDir, "data/vaexcore.sqlite"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_twitch_user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO audit_logs (actor_twitch_user_id, action, target, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run("tester-update-smoke", "tester_update_marker", "existing-app-data", "{}", "2099-01-01T00:00:00.000Z");
  db.close();
}

async function assertExistingAppDataSurvived(diagnostics) {
  assert(diagnostics.firstRun.cleanInstall === false, "existing app data is not treated as a clean install");
  assert(diagnostics.firstRun.setupComplete === true, "existing setup remains complete after update launch");
  assert(diagnostics.readiness.blockers.length === 0, "existing setup has no readiness blockers after update launch");
  assert(diagnostics.config.hasClientId === true, "existing Client ID is preserved");
  assert(diagnostics.config.hasClientSecret === true, "existing Client Secret is preserved");
  assert(diagnostics.config.hasAccessToken === true, "existing OAuth token is preserved");
  assert(diagnostics.config.hasRefreshToken === true, "existing refresh token is preserved");
  assert(diagnostics.config.broadcasterLogin === "vaexil", "existing broadcaster login is preserved");
  assert(diagnostics.config.botLogin === "vaexcorebot", "existing bot login is preserved");

  const config = await json("/api/config");
  assert(config.hasClientId === true, "config route sees existing Client ID");
  assert(config.hasClientSecret === true, "config route sees existing Client Secret");
  assert(config.hasRefreshToken === true, "config route sees existing refresh token");
  assert(config.botLogin === "vaexcorebot", "config route preserves bot login");

  const audit = await json("/api/audit-logs");
  assert(audit.logs.some((log) => log.action === "tester_update_marker"), "existing SQLite audit data survives update launch");
}

async function assertChecksum() {
  const actualSha = await sha256File(zipPath);
  const checksum = readFileSync(checksumPath, "utf8").trim();
  assert(checksum === `${actualSha}  ${basename(zipPath)}`, "checksum file matches zip");
}

function assertPortAvailable(port) {
  return new Promise((resolvePort, reject) => {
    const server = createServer();

    server.once("error", () => {
      reject(new Error(`Port ${port} is already in use. Quit VaexCore or the setup server before running tester artifact smoke.`));
    });
    server.once("listening", () => {
      server.close(resolvePort);
    });
    server.listen(port, "127.0.0.1");
  });
}

function captureProcessLogs(processHandle) {
  const logs = [];
  const push = (source, chunk) => {
    const textChunk = chunk.toString("utf8");
    logs.push(`${source}: ${textChunk}`);
    if (logs.length > 40) {
      logs.shift();
    }
  };

  processHandle.stdout.on("data", (chunk) => push("stdout", chunk));
  processHandle.stderr.on("data", (chunk) => push("stderr", chunk));
  processHandle.on("exit", (code, signal) => {
    push("exit", `code=${code ?? "none"} signal=${signal ?? "none"}`);
  });

  return logs;
}

async function waitForHttp(path, logs) {
  const deadline = Date.now() + 30_000;
  let lastError;

  while (Date.now() < deadline) {
    if (child?.exitCode !== null) {
      throw new Error(`Tester app exited before setup UI was reachable.\n${logs.join("")}`);
    }

    try {
      const response = await fetch(`${setupUrl}${path}`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`${path} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for tester app setup UI. Last error: ${lastError?.message || "unknown"}\n${logs.join("")}`);
}

async function text(path) {
  const response = await fetch(`${setupUrl}${path}`);
  assert(response.ok, `${path} returned ${response.status}`);
  return response.text();
}

async function json(path) {
  const response = await fetch(`${setupUrl}${path}`);
  assert(response.ok, `${path} returned ${response.status}`);
  return response.json();
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function stopChild() {
  if (!child || child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");

  const exited = await waitForExit(5_000);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await waitForExit(5_000);
  }
}

function waitForExit(timeoutMs) {
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => resolveExit(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit(true);
    });
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function assertSafeReport(report) {
  const raw = JSON.stringify(report);
  assert(!raw.includes("client_secret"), "report omits client_secret values");
  assert(!raw.includes("access_token"), "report omits access_token values");
  assert(!raw.includes("refresh_token"), "report omits refresh_token values");
  assert(!raw.includes("update-client-secret"), "report omits seeded client secret");
  assert(!raw.includes("update-access-token-123456"), "report omits seeded access token");
  assert(!raw.includes("update-refresh-token-123456"), "report omits seeded refresh token");
  assert(!raw.includes("Bearer "), "report omits bearer tokens");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Smoke failed: ${message}`);
  }
}
