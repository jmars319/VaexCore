import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tempDir = mkdtempSync(join(tmpdir(), "vaexcore-nightbot-smoke-"));
const smokeDbPath = join(tempDir, "data/vaexcore.sqlite");

process.env.VAEXCORE_CONFIG_DIR = tempDir;
process.env.DATABASE_URL = `file:${smokeDbPath}`;

const { startSetupServer } = await import(
  pathToFileURL(resolve("dist-bundle/setup-server.js")).href
);

const handle = await startSetupServer({ port: 3446 });
const baseUrl = handle.url;

try {
  await runSmoke();
  console.log("nightbot replacement smoke passed");
} finally {
  await handle.stop();
  rmSync(tempDir, { recursive: true, force: true });
}

async function runSmoke() {
  const appJs = await text("/ui/app.js");
  assert(appJs.includes("Stream Night Presets"), "stream presets are visible");
  assert(appJs.includes("Starter Commands"), "command starter presets are visible");
  assert(appJs.includes("Preset Starters"), "timer starter presets are visible");
  assert(appJs.includes("Allowed Link Domains"), "moderation allowlist is visible");

  const initial = await json("/api/stream-presets");
  assert(initial.presets.some((preset) => preset.id === "nightbot-replacement"), "Nightbot replacement preset exists");

  const rehearsal = await post("/api/stream-presets/apply", { id: "nightbot-rehearsal" });
  assert(rehearsal.ok === true, "Nightbot rehearsal preset applies");
  assert(gateMode(rehearsal, "custom_commands") === "live", "commands are live in rehearsal preset");
  assert(gateMode(rehearsal, "timers") === "test", "timers are test-only in rehearsal preset");
  assert(gateMode(rehearsal, "moderation_filters") === "test", "moderation is test-only in rehearsal preset");

  const commandPreset = await post("/api/commands/preset", { id: "socials" });
  assert(commandPreset.ok === true, "social command preset can be created");
  const socials = commandPreset.commands.find((command) => command.name === "socials");
  assert(socials?.enabled === false, "command preset starts disabled");

  const enabledCommand = await post("/api/commands/enable", { id: socials.id, enabled: true });
  assert(enabledCommand.ok === true, "starter command can be enabled explicitly");
  const commandRun = await post("/api/command/simulate", {
    actor: "viewer",
    role: "viewer",
    command: "!socials"
  });
  assert(commandRun.routerResult === "handled", "starter command routes after enabling");
  assert(commandRun.replies.some((reply) => reply.includes("example.com")), "starter command replies");

  const timerPreset = await post("/api/timers/preset", { id: "schedule" });
  assert(timerPreset.ok === true, "timer preset can be created");
  const scheduleTimer = timerPreset.timers.find((timer) => timer.name === "Stream schedule");
  assert(scheduleTimer?.enabled === false, "timer preset starts disabled");

  const enabledTimer = await post("/api/timers/enable", { id: scheduleTimer.id, enabled: true });
  assert(enabledTimer.ok === true, "timer can be enabled explicitly");
  assert(enabledTimer.readiness.ok === false, "timer delivery remains blocked outside live-ready state");

  const blockedPhrase = await post("/api/moderation/terms", {
    term: "spoiler",
    enabled: true
  });
  assert(blockedPhrase.ok === true, "moderation blocked phrase can be saved");
  const moderationSettings = await post("/api/moderation/settings", {
    blockedTermsEnabled: true,
    linkFilterEnabled: true,
    warningMessage: "@{user}, warning: {reason}"
  });
  assert(moderationSettings.ok === true, "moderation settings can be saved");
  const moderationHit = await post("/api/moderation/simulate", {
    actor: "viewer",
    role: "viewer",
    text: "spoiler"
  });
  assert(moderationHit.result.hit.filterTypes.includes("blocked_term"), "moderation detects blocked phrase in rehearsal");

  const unconfirmedLive = await post("/api/stream-presets/apply", { id: "nightbot-replacement" });
  assert(unconfirmedLive.ok === false, "live replacement preset requires confirmation");
  const livePreset = await post("/api/stream-presets/apply", {
    id: "nightbot-replacement",
    confirmed: true
  });
  assert(livePreset.ok === true, "confirmed Nightbot replacement preset applies");
  assert(gateMode(livePreset, "timers") === "live", "timers move to live after confirmation");
  assert(gateMode(livePreset, "moderation_filters") === "live", "moderation moves to live after confirmation");

  const protectedEnter = await post("/api/command/simulate", {
    actor: "viewer",
    role: "viewer",
    command: "!enter spoiler example.com"
  });
  assert(protectedEnter.moderation?.skipped === true, "protected !enter stays moderation-exempt");

  const audit = await json("/api/audit-logs");
  assert(audit.logs.some((log) => log.action === "stream_preset.apply"), "stream preset apply is audited");
  assert(audit.logs.some((log) => log.action === "custom_command.create"), "starter command create is audited");
  assert(audit.logs.some((log) => log.action === "timer.create"), "timer preset create is audited");
  assert(audit.logs.some((log) => log.action === "moderation.hit"), "moderation hit is audited");
}

function gateMode(result, key) {
  return result.featureGates.find((gate) => gate.key === key)?.mode;
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
