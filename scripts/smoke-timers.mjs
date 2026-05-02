import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tempDir = mkdtempSync(join(tmpdir(), "vaexcore-timers-smoke-"));
const smokeDbPath = join(tempDir, "data/vaexcore.sqlite");

process.env.VAEXCORE_CONFIG_DIR = tempDir;
process.env.DATABASE_URL = `file:${smokeDbPath}`;

const { startSetupServer } = await import(
  pathToFileURL(resolve("dist-bundle/setup-server.js")).href
);

const smokeLogger = {
  fatal() {},
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
  silent() {},
  child() {
    return smokeLogger;
  }
};

const handle = await startSetupServer({ port: 3442 });
const baseUrl = handle.url;
let stopped = false;

try {
  await runApiSmoke();
  await handle.stop();
  stopped = true;
  await runSchedulerSmoke();
  console.log("timers smoke passed");
} finally {
  if (!stopped) {
    await handle.stop();
  }
  rmSync(tempDir, { recursive: true, force: true });
}

async function runApiSmoke() {
  const appJs = await text("/ui/app.js");
  assert(appJs.includes("Timers"), "Timers tab renders");
  assert(appJs.includes("Save timer"), "Timers tab exposes save");
  assert(appJs.includes("Send now"), "Timers tab exposes manual send");
  assert(appJs.includes("Preset Starters"), "Timers tab exposes presets");
  assert(appJs.includes("Export timers JSON"), "Timers tab exposes export");
  assert(appJs.includes("Import timers JSON"), "Timers tab exposes import");
  assert(appJs.includes("Chat messages required"), "Timers tab exposes activity threshold");

  const initial = await json("/api/timers");
  assert(initial.ok === true, "timer route returns ok");
  assert(initial.featureGate.mode === "off", "timers feature gate defaults off");
  assert(initial.summary.total === 0, "timer list starts empty");
  assert(initial.summary.waitingForActivity === 0, "timer activity waiting summary starts empty");
  assert(initial.presets.some((preset) => preset.id === "discord"), "timer presets are returned");
  assert(initial.presets.some((preset) => preset.minChatMessages > 0), "timer presets include activity thresholds");
  assert(initial.readiness.checks.some((check) => check.name === "Feature gate"), "timer readiness includes gate detail");

  const preset = await post("/api/timers/preset", {
    id: "schedule"
  });
  assert(preset.ok === true, "timer preset can create a timer");
  assert(preset.timer.enabled === false, "timer preset starts disabled");
  assert(preset.timer.minChatMessages > 0, "timer preset applies activity threshold");

  const exported = await json("/api/timers/export");
  assert(exported.version === 2, "timer export has activity-aware version");
  assert(exported.timers.some((timer) => timer.name === "Stream schedule"), "timer export includes preset timer");
  assert(exported.timers.some((timer) => timer.minChatMessages > 0), "timer export includes activity threshold");

  const imported = await post("/api/timers/import", {
    timers: [{
      name: "Imported reminder",
      message: "Imported timer message",
      intervalMinutes: 10,
      minChatMessages: 4,
      enabled: false
    }]
  });
  assert(imported.ok === true, "timer import succeeds");
  assert(imported.timers.some((timer) => timer.name === "Imported reminder"), "timer import saves timer");
  assert(imported.timers.some((timer) => timer.name === "Imported reminder" && timer.minChatMessages === 4), "timer import saves activity threshold");

  const tooFast = await post("/api/timers", {
    name: "Too fast",
    message: "This should not save.",
    intervalMinutes: 1,
    enabled: true
  });
  assert(tooFast.ok === false, "timers enforce minimum interval");

  const secret = await post("/api/timers", {
    name: "Leaky",
    message: "Bearer should-not-save",
    intervalMinutes: 5,
    enabled: false
  });
  assert(secret.ok === false, "timers reject obvious secret-bearing messages");

  const saved = await post("/api/timers", {
    name: "Discord reminder",
    message: "Join Discord at https://example.com",
    intervalMinutes: 5,
    minChatMessages: 3,
    enabled: false
  });
  assert(saved.ok === true, "timer saves");
  assert(saved.timer.enabled === false, "timer starts disabled");
  assert(saved.timer.minChatMessages === 3, "timer saves chat activity threshold");

  const enabled = await post("/api/timers/enable", {
    id: saved.timer.id,
    enabled: true
  });
  assert(enabled.ok === true, "timer can be enabled");
  assert(enabled.timer.enabled === true, "timer enabled state persists");
  assert(Boolean(enabled.timer.nextFireAt), "enabled timer has next fire time");

  const gateTest = await post("/api/feature-gates", {
    key: "timers",
    mode: "test"
  });
  assert(gateTest.ok === true, "timers feature gate can enter test mode");

  const sendBlocked = await post("/api/timers/send-now", {
    id: saved.timer.id
  });
  assert(sendBlocked.ok === false, "test-mode timer does not send to Twitch");
  assert(sendBlocked.error.includes("test mode"), "blocked timer send explains feature gate");

  const afterBlocked = await json("/api/timers");
  const blockedTimer = afterBlocked.timers.find((timer) => timer.id === saved.timer.id);
  assert(blockedTimer.lastStatus === "blocked", "blocked manual timer send records status");

  const audit = await json("/api/audit-logs");
  assert(audit.logs.some((log) => log.action === "timer.create"), "timer create is audited");
  assert(audit.logs.some((log) => log.action === "timer.enable"), "timer enable is audited");
  assert(audit.logs.some((log) => log.action === "feature_gate.update"), "timer feature gate update is audited");
  assert(!JSON.stringify(audit).includes("should-not-save"), "timer audit output does not leak rejected secret content");
}

async function runSchedulerSmoke() {
  const { createDbClient } = await import(pathToFileURL(resolve("desktop/shared/src/db/client.ts")).href);
  const { createFeatureGateStore } = await import(pathToFileURL(resolve("desktop/shared/src/core/featureGates.ts")).href);
  const { getRecentAuditLogs } = await import(pathToFileURL(resolve("desktop/shared/src/core/auditLog.ts")).href);
  const { TimersService } = await import(pathToFileURL(resolve("desktop/shared/src/modules/timers/timers.service.ts")).href);
  const { TimerScheduler, isTimerActivityMessage } = await import(pathToFileURL(resolve("desktop/shared/src/modules/timers/timers.runtime.ts")).href);

  const db = createDbClient(`file:${smokeDbPath}`);
  const featureGates = createFeatureGateStore(db);
  const service = new TimersService(db);
  const actor = chatActor();
  const queued = [];
  let ready = true;
  const scheduler = new TimerScheduler({
    service,
    featureGates,
    logger: smokeLogger,
    enqueue: (message, metadata) => {
      const id = `timer-out-${queued.length + 1}`;
      queued.push({ id, message, metadata });
      return id;
    },
    readiness: () => ready
      ? { ok: true, reason: "ready" }
      : { ok: false, reason: "not live-ready" },
    tickMs: 60_000
  });

  try {
    const timer = service.saveTimer({
      name: "Schedule",
      message: "Scheduled message",
      intervalMinutes: 5,
      enabled: true
    }, actor);
    forceDue(db, timer.id);

    await scheduler.runDueTimers(new Date());
    assert(queued.length === 0, "feature-gated off timer does not queue");

    featureGates.setMode("timers", "test", actor);
    await scheduler.runDueTimers(new Date());
    assert(queued.length === 0, "test-mode timer does not queue");

    featureGates.setMode("timers", "live", actor);
    ready = false;
    await scheduler.runDueTimers(new Date());
    assert(queued.length === 0, "not-live-ready timer does not queue");
    assert(service.requireTimer(timer.id).lastStatus === "blocked", "not-live-ready timer records blocked status");

    forceDue(db, timer.id);
    ready = true;
    const now = new Date();
    await scheduler.runDueTimers(now);
    assert(queued.length === 1, "live-ready timer queues once");
    assert(service.requireTimer(timer.id).fireCount === 1, "timer fire count increments");

    await scheduler.runDueTimers(now);
    assert(queued.length === 1, "timer does not spam when run twice before next fire time");

    const activityTimer = service.saveTimer({
      name: "Activity timer",
      message: "Activity-aware message",
      intervalMinutes: 5,
      minChatMessages: 2,
      enabled: true
    }, actor);
    forceDue(db, activityTimer.id);
    await scheduler.runDueTimers(new Date());
    assert(queued.length === 1, "activity-gated timer waits for chat before queuing");
    assert(service.getActivityBlockedTimers(new Date()).some((item) => item.id === activityTimer.id), "activity-gated timer is listed as waiting for chat");

    ready = false;
    scheduler.recordChatActivity(chatActor({ source: "eventsub", text: "preflight chat", userLogin: "viewer0", userId: "viewer-0" }));
    assert(service.requireTimer(activityTimer.id).chatMessagesSinceLastFire === 0, "activity-gated timer does not count before timer readiness");

    ready = true;
    assert(isTimerActivityMessage(chatActor({ source: "eventsub", text: "regular chat", userLogin: "viewer1", userId: "viewer-1" }), { botUserId: "bot-user", commandPrefix: "!" }), "regular eventsub chat counts toward timers");
    assert(!isTimerActivityMessage(chatActor({ source: "local", text: "regular chat", userLogin: "viewer1", userId: "viewer-1" }), { botUserId: "bot-user", commandPrefix: "!" }), "local simulated chat does not count toward live timers");
    assert(!isTimerActivityMessage(chatActor({ source: "eventsub", text: "!enter", userLogin: "viewer1", userId: "viewer-1" }), { botUserId: "bot-user", commandPrefix: "!" }), "command-prefixed chat does not count toward timers");
    assert(!isTimerActivityMessage(chatActor({ source: "eventsub", text: "bot echo", userLogin: "bot", userId: "bot-user" }), { botUserId: "bot-user", commandPrefix: "!" }), "bot self-messages do not count toward timers");

    scheduler.recordChatActivity(chatActor({ source: "eventsub", text: "regular chat", userLogin: "viewer1", userId: "viewer-1" }));
    await scheduler.runDueTimers(new Date());
    assert(queued.length === 1, "activity-gated timer waits until threshold is met");
    assert(service.requireTimer(activityTimer.id).chatMessagesSinceLastFire === 1, "timer records first chat activity");

    scheduler.recordChatActivity(chatActor({ source: "eventsub", text: "more regular chat", userLogin: "viewer2", userId: "viewer-2" }));
    await scheduler.runDueTimers(new Date());
    assert(queued.length === 2, "activity-gated timer queues after chat threshold");
    assert(service.requireTimer(activityTimer.id).chatMessagesSinceLastFire === 0, "timer resets activity after queue");

    const audit = getRecentAuditLogs(db, 20);
    assert(audit.some((log) => log.action === "timer.create"), "direct timer create is audited");
  } finally {
    scheduler.stop();
    db.close();
  }
}

function forceDue(db, id) {
  db.prepare("UPDATE timers SET next_fire_at = ? WHERE id = ?").run(
    new Date(Date.now() - 1000).toISOString(),
    id
  );
}

function chatActor(overrides = {}) {
  const userLogin = overrides.userLogin || "timer-smoke";
  return {
    id: "timer-smoke",
    text: overrides.text || "!timer",
    userId: overrides.userId || "timer-smoke",
    userLogin,
    userDisplayName: userLogin,
    broadcasterUserId: "timer-broadcaster",
    badges: ["broadcaster"],
    isBroadcaster: true,
    isMod: true,
    isVip: false,
    isSubscriber: false,
    source: overrides.source || "local",
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
