import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const tempDir = mkdtempSync(join(tmpdir(), "vaexcore-giveaway-live-smoke-"));
const smokeDbPath = join(tempDir, "data/vaexcore.sqlite");
const serverUrl = pathToFileURL(resolve("dist-bundle/setup-server.js")).href;

process.env.VAEXCORE_CONFIG_DIR = tempDir;
process.env.DATABASE_URL = `file:${smokeDbPath}`;

let handle;
let baseUrl;
let importCounter = 0;

try {
  await startServer();
  await runSmoke();
  console.log("giveaway live smoke passed");
} finally {
  if (handle) {
    await handle.stop();
  }
  rmSync(tempDir, { recursive: true, force: true });
}

async function runSmoke() {
  await verifyUiAndSafetyCopy();
  verifyPrizeSchema();
  await verifyDefaultFeatureGates();
  await verifyCommandCoverageAndFewEntrants();
  await verifyStreamNightFlow();
}

async function verifyUiAndSafetyCopy() {
  const appJs = await text("/ui/app.js");

  assert(appJs.includes("Giveaways"), "Giveaways tab renders");
  assert(appJs.includes("Readiness Checklist"), "readiness checklist renders");
  assert(appJs.includes("Entrants"), "entrants table renders");
  assert(appJs.includes("Winners"), "winners table renders");
  assert(appJs.includes("End giveaway?"), "end giveaway requires confirmation");
  assert(appJs.includes("Reroll this winner?"), "reroll requires confirmation");
  assert(
    appJs.includes("vaexcore console does not store or reveal giveaway prizes. Delivery remains manual."),
    "UI states manual prize delivery"
  );
  assert(appJs.includes("setDisabled(\"gstart\""), "giveaway controls have disabled-state handling");
}

function verifyPrizeSchema() {
  const db = new Database(smokeDbPath);

  try {
    const tables = ["giveaways", "giveaway_entries", "giveaway_winners"];
    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
      assert(columns.length > 0, `${table} exists`);
      assert(!columns.some((name) => /prize|code|secret|token/i.test(name)), `${table} has no prize/code columns`);
    }
  } finally {
    db.close();
  }
}

async function verifyDefaultFeatureGates() {
  const gates = await json("/api/feature-gates");
  const timers = gates.featureGates.find((gate) => gate.key === "timers");
  const moderation = gates.featureGates.find((gate) => gate.key === "moderation_filters");

  assert(timers?.mode === "off", "timers default off");
  assert(moderation?.mode === "off", "moderation filters default off");
}

async function verifyCommandCoverageAndFewEntrants() {
  const ghelp = await simulate({ actor: "broadcaster", role: "broadcaster", command: "!ghelp" });
  assert(ghelp.routerResult === "handled", "!ghelp is handled");
  assert(ghelp.replies.some((reply) => reply.includes("!gstart")), "!ghelp lists giveaway commands");

  const noStatus = await simulate({ actor: "broadcaster", role: "broadcaster", command: "!gstatus" });
  assert(noStatus.routerResult === "handled", "!gstatus is handled with no active giveaway");
  assert(noStatus.replies.some((reply) => reply.includes("No active giveaway")), "!gstatus reports no active giveaway");

  const viewerStart = await simulate({
    actor: "viewer",
    role: "viewer",
    command: '!gstart codes=3 keyword=enter title="Denied"'
  });
  assert(viewerStart.routerResult === "denied", "viewer cannot start giveaway from chat");

  const commandStart = await simulate({
    actor: "broadcaster",
    role: "broadcaster",
    command: '!gstart codes=3 keyword=enter title="Few Entrants"'
  });
  assert(commandStart.routerResult === "handled", "!gstart starts giveaway from chat");
  assert(commandStart.replies.some((reply) => reply.includes("Type !enter to enter")), "!gstart announces entry keyword");

  await expectEntry("alice");
  await expectEntry("bob");
  const duplicate = await simulate({ actor: "alice", role: "viewer", command: "!enter" });
  assert(duplicate.replies.some((reply) => reply.includes("already entered")), "duplicate !enter is acknowledged");

  const status = await simulate({ actor: "broadcaster", role: "broadcaster", command: "!gstatus" });
  assert(status.replies.some((reply) => reply.includes("2 entries")), "!gstatus reports entry count");

  const close = await simulate({ actor: "broadcaster", role: "broadcaster", command: "!gclose" });
  assert(close.routerResult === "handled", "!gclose closes giveaway");
  assert(close.replies.some((reply) => reply.includes("Entries closed")), "!gclose announces close");

  const draw = await simulate({ actor: "broadcaster", role: "broadcaster", command: "!gdraw 3" });
  assert(draw.routerResult === "handled", "!gdraw is handled");
  assert(draw.replies.some((reply) => reply.includes("only 2/3 eligible")), "fewer entrants than requested winners is explicit");

  let state = await json("/api/giveaway");
  assert(state.summary.enoughEntrantsForFullDraw === false, "readiness reports insufficient entrants");
  assert(state.summary.undeliveredWinnersCount === 2, "undelivered winners are tracked");
  assert(state.summary.endWarnings.some((warning) => warning.includes("not marked delivered")), "end warns about undelivered winners");

  const rerollTarget = activeWinners(state)[0]?.login;
  assert(Boolean(rerollTarget), "winner is available for !greroll");
  const reroll = await simulate({ actor: "broadcaster", role: "broadcaster", command: `!greroll ${rerollTarget}` });
  assert(reroll.routerResult === "handled", "!greroll is handled");
  assert(reroll.replies.some((reply) => reply.includes("was rerolled")), "!greroll announces reroll");

  state = await json("/api/giveaway");
  const remaining = activeWinners(state)[0]?.login;
  assert(Boolean(remaining), "active winner remains after no-replacement reroll");

  const claim = await simulate({ actor: "broadcaster", role: "broadcaster", command: `!gclaim ${remaining}` });
  assert(claim.routerResult === "handled", "!gclaim is handled");
  assert(claim.replies.some((reply) => reply.includes("marked claimed")), "!gclaim announces claim");

  const deliver = await simulate({ actor: "broadcaster", role: "broadcaster", command: `!gdeliver ${remaining}` });
  assert(deliver.routerResult === "handled", "!gdeliver is handled");
  assert(deliver.replies.some((reply) => reply.includes("marked delivered")), "!gdeliver announces delivery");

  const end = await simulate({ actor: "broadcaster", role: "broadcaster", command: "!gend" });
  assert(end.routerResult === "handled", "!gend is handled");
  assert(end.replies.some((reply) => reply.includes("Giveaway ended")), "!gend announces end");

  state = await json("/api/giveaway");
  assert(state.summary.status === "none", "chat-command scenario ends cleanly");
}

async function verifyStreamNightFlow() {
  const protectedName = await post("/api/commands", {
    name: "gstart",
    permission: "viewer",
    enabled: true,
    globalCooldownSeconds: 0,
    userCooldownSeconds: 0,
    aliases: [],
    responses: ["should not save"]
  });
  assert(protectedName.ok === false, "custom commands cannot override giveaway commands");

  const protectedAlias = await post("/api/commands", {
    name: "tonight",
    permission: "viewer",
    enabled: true,
    globalCooldownSeconds: 0,
    userCooldownSeconds: 0,
    aliases: ["gdraw"],
    responses: ["should not save"]
  });
  assert(protectedAlias.ok === false, "custom command aliases cannot shadow giveaway commands");

  const start = await expectOk("/api/giveaway/start", {
    title: "M35 Stream Night",
    keyword: "enter",
    winnerCount: 3
  });
  assert(start.state.summary.status === "open", "UI/API start opens giveaway");
  assert(start.state.assurance.blockContinue === true, "missing start announcement is visible when chat is not configured");
  assert(start.state.assurance.nextAction.includes("Start announcement"), "start assurance gives next action");

  const timer = await post("/api/timers", {
    name: "Interference check",
    message: "Timer message should not touch giveaway state",
    intervalMinutes: 5,
    enabled: true
  });
  assert(timer.ok === true, "timer can exist without changing giveaway state");
  assert(timer.featureGate.mode === "off", "timer gate remains off during giveaway rehearsal");
  const timerSend = await post("/api/timers/send-now", { id: timer.timer.id });
  assert(timerSend.ok === false, "timer send is blocked while feature gate is off");

  await expectOk("/api/moderation/terms", { term: "enter", enabled: true });
  const moderationSettings = await expectOk("/api/moderation/settings", {
    blockedTermsEnabled: true,
    linkFilterEnabled: true,
    capsFilterEnabled: true,
    repeatFilterEnabled: true,
    symbolFilterEnabled: true,
    warningMessage: "@{user}, moderation warning: {reason}",
    capsMinLength: 8,
    capsRatio: 0.75,
    repeatWindowSeconds: 30,
    repeatLimit: 3,
    symbolMinLength: 8,
    symbolRatio: 0.6
  });
  assert(moderationSettings.featureGate.mode === "off", "moderation settings do not enable the feature gate by default");
  await expectOk("/api/feature-gates", { key: "moderation_filters", mode: "test" });

  for (const entrant of ["alice", "bob", "carol", "dave", "erin"]) {
    const entry = await simulate({ actor: entrant, role: "viewer", command: "!enter" });
    assert(entry.routerResult === "handled", `${entrant} enters with !enter`);
    assert(entry.moderation?.skipped === true, "!enter is exempt from moderation filters");
    assert(entry.replies.some((reply) => reply.includes(`Thanks ${entrant}`)), `${entrant} entry is acknowledged`);
  }

  const duplicate = await simulate({ actor: "alice", role: "viewer", command: "!enter" });
  assert(duplicate.replies.some((reply) => reply.includes("already entered")), "duplicate entrant is ignored");
  assert(duplicate.moderation?.skipped === true, "duplicate !enter remains moderation-exempt");

  let state = await json("/api/giveaway");
  assert(state.entries.length === 5, "five unique entrants are tracked");
  assert(state.summary.entryCount === 5, "entry summary shows five entrants");
  assert(state.summary.operatorState === "entries open", "operator state shows entries open");

  await restartServer();
  state = await json("/api/giveaway");
  assert(state.summary.status === "open", "active giveaway persists after restart");
  assert(state.entries.length === 5, "entrants persist after restart");

  const protectedCommand = await simulate({ actor: "broadcaster", role: "broadcaster", command: "!gstatus enter" });
  assert(protectedCommand.routerResult === "handled", "protected giveaway command remains handled");
  assert(protectedCommand.moderation?.skipped === true, "protected giveaway command is moderation-exempt");

  const close = await expectOk("/api/giveaway/close");
  assert(close.state.summary.status === "closed", "UI/API close closes entries");
  assert(close.state.summary.operatorState === "ready to draw", "closed giveaway is ready to draw");

  const draw = await expectOk("/api/giveaway/draw", { count: 3 });
  assert(draw.result.winners.length === 3, "draw selects three winners");
  state = await json("/api/giveaway");
  assert(activeWinners(state).length === 3, "winners table has three active winners");
  assert(state.summary.operatorState === "delivery pending", "operator state shows delivery pending");

  const rerollTarget = activeWinners(state)[0]?.login;
  assert(Boolean(rerollTarget), "winner is available for reroll");
  const reroll = await expectOk("/api/giveaway/reroll", { username: rerollTarget });
  assert(Boolean(reroll.result.replacement), "reroll selects a replacement when eligible entrants remain");

  state = await json("/api/giveaway");
  assert(activeWinners(state).length === 3, "active winner count remains three after reroll");
  assert(state.summary.rerolledCount === 1, "reroll is tracked in summary");

  insertOutboundFixture({
    id: "m35-failed-draw",
    status: "failed",
    action: "draw",
    importance: "critical",
    giveawayId: state.giveaway.id,
    message: "Winners: placeholder",
    reason: "simulated send failure",
    failureCategory: "network"
  });
  state = await json("/api/giveaway");
  assert(state.assurance.summary.failedCritical === 1, "failed critical giveaway delivery is visible");
  assert(state.assurance.nextAction.includes("Resend failed Draw announcement"), "failed delivery gives recovery action");

  for (const winner of activeWinners(state)) {
    await expectOk("/api/giveaway/claim", { username: winner.login });
    await expectOk("/api/giveaway/deliver", { username: winner.login });
  }

  state = await json("/api/giveaway");
  assert(state.summary.undeliveredWinnersCount === 0, "all active winners are delivered");
  assert(state.summary.safeToEnd === true, "giveaway is safe to end after delivery");

  const end = await expectOk("/api/giveaway/end");
  assert(end.state.summary.status === "none", "end clears active giveaway");
  assert(end.state.recap.available === true, "post-giveaway recap is available");
  assert(end.state.recap.pendingDeliveryCount === 0, "recap shows no pending delivery");

  const outbound = await json("/api/outbound-messages");
  assert(outbound.messages.some((message) => message.id === "m35-failed-draw"), "giveaway outbound history keeps failed delivery");
  assert(!outbound.messages.some((message) => message.message.includes("Timer message should not touch giveaway state")), "timer message did not enter outbound history");

  const audit = await json("/api/audit-logs");
  for (const action of [
    "giveaway.start",
    "giveaway.close",
    "giveaway.draw",
    "giveaway.reroll",
    "giveaway.claim",
    "giveaway.deliver",
    "giveaway.end"
  ]) {
    assert(audit.logs.some((log) => log.action === action), `${action} audit log is written`);
  }

  const finalState = await json("/api/giveaway");
  assert(finalState.summary.status === "none", "stream-night rehearsal finishes with no active giveaway");
}

async function expectEntry(actor) {
  const result = await simulate({ actor, role: "viewer", command: "!enter" });
  assert(result.routerResult === "handled", `${actor} !enter is handled`);
  assert(result.replies.some((reply) => reply.includes(`Thanks ${actor}`)), `${actor} entry is acknowledged`);
  return result;
}

async function startServer() {
  const port = 3444 + importCounter;
  const module = await import(`${serverUrl}?m35=${importCounter}`);
  importCounter += 1;
  handle = await module.startSetupServer({ port });
  baseUrl = handle.url;
}

async function restartServer() {
  await handle.stop();
  handle = undefined;
  await startServer();
}

async function simulate(body) {
  const result = await post("/api/command/simulate", body);
  assert(result.ok === true, "command simulate returns ok envelope");
  return result;
}

async function expectOk(path, body = {}) {
  const result = await post(path, body);
  assert(result.ok === true, `${path} returns ok`);
  return result;
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

function activeWinners(state) {
  return (state.winners || []).filter((winner) => !winner.rerolled_at);
}

function insertOutboundFixture(record) {
  const db = new Database(smokeDbPath);
  const now = new Date().toISOString();

  try {
    db.prepare(
      `
        INSERT INTO outbound_messages (
          id,
          source,
          status,
          message,
          attempts,
          queued_at,
          updated_at,
          reason,
          failure_category,
          category,
          action,
          importance,
          giveaway_id
        ) VALUES (
          @id,
          'setup',
          @status,
          @message,
          @attempts,
          @queuedAt,
          @updatedAt,
          @reason,
          @failureCategory,
          'giveaway',
          @action,
          @importance,
          @giveawayId
        )
      `
    ).run({
      ...record,
      attempts: record.attempts ?? 1,
      queuedAt: now,
      updatedAt: now,
      reason: record.reason ?? "",
      failureCategory: record.failureCategory ?? "none"
    });
  } finally {
    db.close();
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Giveaway live smoke failed: ${message}`);
  }
}
