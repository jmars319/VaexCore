import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tempDir = mkdtempSync(join(tmpdir(), "vaexcore-guardrails-smoke-"));
const smokeDbPath = join(tempDir, "data/vaexcore.sqlite");

process.env.VAEXCORE_CONFIG_DIR = tempDir;
process.env.DATABASE_URL = `file:${smokeDbPath}`;

const { startSetupServer } = await import(
  pathToFileURL(resolve("dist-bundle/setup-server.js")).href
);

const handle = await startSetupServer({ port: 3441 });
const baseUrl = handle.url;
let stopped = false;

try {
  await runApiSmoke();
  await handle.stop();
  stopped = true;
  await runDirectGuardrailSmoke();
  console.log("operational guardrails smoke passed");
} finally {
  if (!stopped) {
    await handle.stop();
  }
  rmSync(tempDir, { recursive: true, force: true });
}

async function runApiSmoke() {
  const appJs = await text("/ui/app.js");
  assert(appJs.includes("Feature Gate"), "operator UI exposes feature gates");
  assert(appJs.includes("setFeatureGate"), "operator UI can update feature gates");

  const gates = await json("/api/feature-gates");
  const customGate = gates.featureGates.find((gate) => gate.key === "custom_commands");
  const timersGate = gates.featureGates.find((gate) => gate.key === "timers");
  assert(customGate?.mode === "live", "custom commands default to live after M31");
  assert(timersGate?.mode === "off", "future timers default to off");

  const testGate = await post("/api/feature-gates", {
    key: "custom_commands",
    mode: "test"
  });
  assert(testGate.ok === true, "feature gate update succeeds");
  assert(testGate.featureGate.mode === "test", "custom commands can be moved to test mode");

  const secretResponse = await post("/api/commands", {
    name: "leaky",
    permission: "viewer",
    enabled: true,
    globalCooldownSeconds: 0,
    userCooldownSeconds: 0,
    aliases: [],
    responses: ["Bearer should-not-save"]
  });
  assert(secretResponse.ok === false, "custom commands reject obvious secret-bearing responses");

  const protectedAlias = await post("/api/commands", {
    name: "guard",
    permission: "viewer",
    enabled: true,
    globalCooldownSeconds: 0,
    userCooldownSeconds: 0,
    aliases: ["gstart"],
    responses: ["guarded response"]
  });
  assert(protectedAlias.ok === false, "custom command aliases cannot use protected built-ins");

  const saved = await post("/api/commands", {
    name: "guard",
    permission: "viewer",
    enabled: true,
    globalCooldownSeconds: 0,
    userCooldownSeconds: 0,
    aliases: ["safealias"],
    responses: ["guarded response for {user}"]
  });
  assert(saved.ok === true, "guardrail smoke command saves");
  assert(saved.reservedNames.includes("gstart"), "protected command registry feeds custom command validation");
  assert(saved.featureGate.mode === "test", "custom command API reports the active feature gate");

  const simulated = await post("/api/command/simulate", {
    actor: "viewer",
    role: "viewer",
    command: "!guard"
  });
  assert(simulated.routerResult === "handled", "test-mode custom command handles local simulation");
  assert(simulated.replies.length === 1, "test-mode custom command replies locally");

  const diagnostics = await json("/api/diagnostics");
  assert(diagnostics.featureGates.some((gate) => gate.key === "custom_commands" && gate.mode === "test"), "diagnostics include feature gate state");
  assert(diagnostics.checks.some((check) => check.name === "Feature gates"), "diagnostics include feature gate check");

  const bundle = await json("/api/support-bundle");
  assert(bundle.featureGates.some((gate) => gate.key === "custom_commands"), "support bundle includes feature gates");

  const audit = await json("/api/audit-logs");
  assert(audit.logs.some((log) => log.action === "feature_gate.update"), "feature gate changes are audited");
  assert(!JSON.stringify(audit).includes("should-not-save"), "audit route does not leak rejected secret content");
}

async function runDirectGuardrailSmoke() {
  const { createDbClient } = await import(pathToFileURL(resolve("desktop/shared/src/db/client.ts")).href);
  const { createFeatureGateStore } = await import(pathToFileURL(resolve("desktop/shared/src/core/featureGates.ts")).href);
  const { writeAuditLog, getRecentAuditLogs } = await import(pathToFileURL(resolve("desktop/shared/src/core/auditLog.ts")).href);
  const { CustomCommandsService } = await import(pathToFileURL(resolve("desktop/shared/src/modules/commands/commands.service.ts")).href);

  const db = createDbClient(`file:${smokeDbPath}`);
  const featureGates = createFeatureGateStore(db);
  const commands = new CustomCommandsService(db, { featureGates });

  try {
    assert(featureGates.getMode("custom_commands") === "test", "feature gate mode persists in SQLite");

    const blockedReplies = [];
    const blocked = await commands.handle({
      message: chatActor({ source: "eventsub", text: "!guard" }),
      name: "guard",
      args: [],
      rawArgs: "",
      reply: (message) => blockedReplies.push(message)
    });
    assert(blocked === true, "test-mode custom command is still recognized in live chat");
    assert(blockedReplies.length === 0, "test-mode custom command does not reply to live chat");

    featureGates.setMode("custom_commands", "live", chatActor({ source: "local", text: "!gate" }));
    const liveReplies = [];
    const live = await commands.handle({
      message: chatActor({ source: "eventsub", text: "!guard" }),
      name: "guard",
      args: [],
      rawArgs: "",
      reply: (message) => liveReplies.push(message)
    });
    assert(live === true, "live-mode custom command is handled");
    assert(liveReplies.length === 1, "live-mode custom command can reply to Twitch chat");

    for (let index = 0; index < 5; index += 1) {
      writeAuditLog(
        db,
        chatActor({ source: "local", text: "!audit" }),
        "guardrail.audit_test",
        `target:${index}`,
        { accessToken: `secret-${index}`, note: `entry ${index}` },
        {
          createdAt: new Date(Date.now() + index).toISOString(),
          retention: { maxEntries: 3, maxAgeDays: 365 }
        }
      );
    }

    const auditLogs = getRecentAuditLogs(db, 10);
    assert(auditLogs.length <= 3, "audit retention caps stored rows");
    assert(!JSON.stringify(auditLogs).includes("secret-"), "audit metadata is redacted on read");
  } finally {
    db.close();
  }
}

function chatActor({ source, text }) {
  return {
    id: `${source}-${Date.now()}`,
    text,
    userId: `${source}-viewer`,
    userLogin: "viewer",
    userDisplayName: "Viewer",
    broadcasterUserId: "broadcaster",
    badges: [],
    isBroadcaster: false,
    isMod: false,
    isVip: false,
    isSubscriber: false,
    source,
    receivedAt: new Date()
  };
}

async function post(path, body = {}) {
  return json(path, { method: "POST", body });
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Smoke failed: ${message}`);
  }
}
