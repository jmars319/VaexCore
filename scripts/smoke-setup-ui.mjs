import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const tempDir = mkdtempSync(join(tmpdir(), "vaexcore-smoke-"));
const smokeDbPath = join(tempDir, "data/vaexcore.sqlite");
process.env.VAEXCORE_CONFIG_DIR = tempDir;
process.env.DATABASE_URL = `file:${smokeDbPath}`;

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
  assert(appJs.includes("Refresh Token"), "settings UI reports refresh-token availability");
  assert(appJs.includes("refresh expired Twitch access tokens automatically"), "setup guide explains automatic token refresh");
  assert(appJs.includes("giveawayDraft"), "giveaway form uses draft state across refreshes");
  assert(appJs.includes("updateGiveawayDraft"), "giveaway inputs preserve operator edits during polling");
  assert(appJs.includes("Outbound Chat History"), "setup UI exposes outbound chat history");
  assert(appJs.includes("Resend last failed"), "setup UI exposes failed outbound resend");
  assert(appJs.includes("Send last call"), "setup UI exposes giveaway last-call operator action");
  assert(appJs.includes("Giveaway Chat Assurance"), "giveaway tab exposes chat assurance state");
  assert(appJs.includes("Critical Failed"), "giveaway tab highlights critical outbound failures");
  assert(appJs.includes("Critical Confirmed"), "giveaway tab distinguishes confirmed critical sends");
  assert(appJs.includes("Queue ID"), "giveaway tab exposes outbound queue identifiers");
  assert(appJs.includes("pendingCritical"), "giveaway tab blocks on pending critical sends");
  assert(appJs.includes("Message Templates"), "giveaway tab exposes local message templates");
  assert(appJs.includes("Reminder Controls"), "giveaway tab exposes timed reminder controls");
  assert(appJs.includes("Post-Giveaway Recap"), "giveaway tab exposes post-giveaway recap");
  assert(appJs.includes("Run preflight"), "dashboard exposes preflight rehearsal");
  assert(appJs.includes("Copy winners"), "winner workflow can copy winners");
  assert(appJs.includes("Mark all delivered"), "winner workflow can bulk mark delivery");
  assert(appJs.includes("Do not continue giveaway operations yet"), "giveaway tab warns on critical announcement gaps");
  assert(appJs.includes("phase-resend"), "giveaway tab exposes phase-level resend controls");
  assert(appJs.includes("shouldWarnBeforeGiveawayAction"), "giveaway actions warn before continuing after critical chat gaps");
  assert(appJs.includes("Live Mode"), "setup UI exposes compact live mode tab");
  assert(appJs.includes("Live Runbook"), "dashboard and live mode expose runbook guidance");
  assert(appJs.includes("Copy incident note"), "runbook can copy incident note");
  assert(appJs.includes("liveRunbookSteps"), "runbook derives next actions from current state");
  assert(appJs.includes("Post-Stream Review"), "audit log exposes post-stream review");
  assert(appJs.includes("Export review JSON"), "post-stream review can export JSON");
  assert(appJs.includes("postStreamReviewData"), "post-stream review derives from local runtime data");
  assert(appJs.includes("Send status to chat"), "live mode can send current giveaway status");
  assert(appJs.includes("Panic Resend"), "live mode exposes panic resend area");
  assert(appJs.includes("Post-Stream Recap"), "live mode exposes post-stream recap copy area");
  assert(appJs.includes("Outbound Failure Logs"), "bot runtime highlights outbound failure logs");
  assert(appJs.includes("Queue Health"), "live mode exposes outbound queue health");
  assert(appJs.includes("Recovery Checklist"), "live mode exposes recovery checklist");
  assert(appJs.includes("Oldest Age"), "queue health shows pending message age");
  assert(appJs.includes("Retry Delay"), "queue health shows retry delay");
  assert(appJs.includes("Send Throttle"), "queue health shows send throttle");
  assert(appJs.includes("Safe To Resend"), "recovery checklist explains resend safety");
  assert(appJs.includes("Category"), "outbound failures show failure categories");
  assert(appJs.includes("Operator Messages"), "chat tools expose operator message presets");
  assert(appJs.includes("Requires confirmation"), "operator message presets identify high-impact sends");
  assert(appJs.includes("Diagnostics"), "setup UI exposes diagnostics tab");
  assert(appJs.includes("Copy diagnostic report"), "diagnostics report can be copied");
  assert(appJs.includes("Copy support bundle"), "diagnostics tab can copy support bundle");
  assert(appJs.includes("First Run And Recovery"), "diagnostics tab exposes first-run recovery");
  const setupServerJs = readFileSync(resolve("dist-bundle/setup-server.js"), "utf8");
  const liveBotJs = readFileSync(resolve("dist-bundle/live-bot.js"), "utf8");
  assert(setupServerJs.includes("/api/diagnostics"), "setup server exposes diagnostics route");
  assert(setupServerJs.includes("/api/support-bundle"), "setup server exposes support bundle route");
  assert(setupServerJs.includes("getDiagnosticsReport"), "setup server builds safe diagnostics reports");
  assert(setupServerJs.includes("getBotStartReadiness"), "setup server gates bot start with readiness checks");
  assert(setupServerJs.includes("outbound_messages"), "setup server persists outbound message history");
  assert(setupServerJs.includes("outboundImportance"), "setup server tracks outbound importance metadata");
  assert(setupServerJs.includes("giveaway_message_templates"), "setup server stores giveaway templates locally");
  assert(setupServerJs.includes("entries open") && setupServerJs.includes("safe to end"), "setup server returns live giveaway state copy");
  assert(setupServerJs.includes("/api/giveaway/status/send"), "setup server can send current giveaway status");
  assert(setupServerJs.includes("/api/giveaway/critical/resend"), "setup server exposes critical giveaway panic resend");
  assert(setupServerJs.includes("queueHealth"), "setup server returns queue health diagnostics");
  assert(setupServerJs.includes("outboundRecovery"), "setup server returns outbound recovery guidance");
  assert(setupServerJs.includes("safeToResend"), "setup server reports resend safety");
  assert(setupServerJs.includes("failureCategory"), "setup server returns outbound failure categories");
  assert(setupServerJs.includes("blockingCritical"), "setup server reports critical delivery guardrails");
  assert(setupServerJs.includes("queueStatus"), "setup server exposes per-phase queue status");
  assert(setupServerJs.includes("rate_limit"), "setup server preserves Twitch rate-limit classification");
  assert(setupServerJs.includes("retryDelayMs"), "setup server reports retry timing");
  assert(setupServerJs.includes("operator_message_templates"), "setup server stores operator message presets locally");
  assert(setupServerJs.includes("/api/operator-messages/send"), "setup server exposes operator message send route");
  assert(setupServerJs.includes("Token refreshed"), "setup server reports automatic token refresh during validation");
  assert(setupServerJs.includes("Twitch token refresh failed"), "setup server can refresh expired Twitch access tokens");
  assert(liveBotJs.includes("giveaway_message_templates"), "standalone bot reads local giveaway templates");
  assert(liveBotJs.includes("outbound_messages"), "standalone bot persists outbound message history");
  assert(liveBotJs.includes('source: "bot"') || liveBotJs.includes("source:'bot'"), "standalone bot writes bot-sourced outbound history");
  assert(liveBotJs.includes("failureCategory"), "standalone bot logs outbound failure categories");
  assert(liveBotJs.includes("Twitch OAuth token refreshed for live bot runtime"), "standalone bot can refresh expired access tokens");
  assert(styles.includes(".tab-panel"), "styles asset loaded");
  assert(styles.includes(".setup-step"), "setup guide styles loaded");
  assert(styles.includes(".runtime-log"), "bot runtime log styles loaded");
  assert(styles.includes(".state-banner"), "live mode state styles loaded");
  assert(styles.includes(".failure-log"), "outbound failure log styles loaded");

  const initialConfig = await json("/api/config");
  assertSafeConfig(initialConfig);
  const initialStatus = await json("/api/status");
  assert(initialStatus.runtime.queueHealth.status === "clear", "queue health starts clear");
  assert(initialStatus.runtime.queueHealth.nextAction.includes("Outbound queue"), "queue health explains next action");
  assert(initialStatus.runtime.outboundRecovery.needed === false, "outbound recovery starts clear");

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

  const operatorMessages = await json("/api/operator-messages");
  assert(operatorMessages.ok === true, "operator message route exists");
  assert(operatorMessages.templates.some((template) => template.id === "technical-pause"), "operator messages include technical pause preset");
  assert(operatorMessages.templates.some((template) => template.requiresConfirmation === true), "operator messages mark high-impact presets");
  const savedOperatorMessages = await json("/api/operator-messages", {
    method: "POST",
    body: {
      templates: {
        thanks: "Appreciate you hanging out tonight."
      }
    }
  });
  assert(
    savedOperatorMessages.templates.some((template) => template.id === "thanks" && template.customized),
    "operator message presets can be customized"
  );
  const unconfirmedOperatorSend = await json("/api/operator-messages/send", {
    method: "POST",
    body: { id: "technical-pause" }
  });
  assert(unconfirmedOperatorSend.ok === false, "high-impact operator message requires confirmation");
  const operatorSendWithoutValidation = await json("/api/operator-messages/send", {
    method: "POST",
    body: { id: "thanks" }
  });
  assert(operatorSendWithoutValidation.ok === false, "operator message send rejects until validation passes");
  const resetOperatorMessages = await json("/api/operator-messages/reset", { method: "POST" });
  assert(
    resetOperatorMessages.templates.every((template) => !template.customized),
    "operator message presets can reset to defaults"
  );

  const preflight = await json("/api/preflight", { method: "POST" });
  assert(Array.isArray(preflight.checks), "preflight returns check list");
  assert(preflight.ok === false, "preflight reports not ready before bot runtime starts");

  const templates = await json("/api/giveaway/templates");
  assert(templates.ok === true, "giveaway template route exists");
  assert(templates.templates.some((template) => template.action === "start"), "giveaway templates include start action");
  assert(templates.placeholders.includes("keyword"), "giveaway templates document placeholders");

  const savedTemplates = await json("/api/giveaway/templates", {
    method: "POST",
    body: {
      templates: {
        start: "Custom start for {title}: !{keyword}"
      }
    }
  });
  assert(
    savedTemplates.templates.some((template) => template.action === "start" && template.customized),
    "giveaway templates can be customized"
  );
  const resetTemplates = await json("/api/giveaway/templates/reset", { method: "POST" });
  assert(
    resetTemplates.templates.every((template) => !template.customized),
    "giveaway templates can reset to defaults"
  );

  const reminder = await json("/api/giveaway/reminder");
  assert(reminder.reminder.enabled === false, "giveaway reminder defaults off");
  const savedReminder = await json("/api/giveaway/reminder", {
    method: "POST",
    body: { enabled: true, intervalMinutes: 2 }
  });
  assert(savedReminder.reminder.enabled === true, "giveaway reminder can be enabled");
  assert(savedReminder.reminder.intervalMinutes === 2, "giveaway reminder stores interval");
  assertReminderSettingsFixture({ enabled: 1, intervalMinutes: 2 });
  const disabledReminder = await json("/api/giveaway/reminder", {
    method: "POST",
    body: { enabled: false, intervalMinutes: 2 }
  });
  assert(disabledReminder.reminder.enabled === false, "giveaway reminder can be disabled");
  assertReminderSettingsFixture({ enabled: 0, intervalMinutes: 2 });

  const outboundInitial = await json("/api/outbound-messages");
  assert(outboundInitial.ok === true, "outbound message history route exists");
  assert(Array.isArray(outboundInitial.messages), "outbound message history returns messages");
  assert("criticalFailed" in outboundInitial.summary, "outbound message summary tracks critical failures");
  const outboundResendEmpty = await json("/api/outbound-messages/resend", { method: "POST" });
  assert(outboundResendEmpty.ok === false, "outbound resend reports no failed message clearly");
  insertExternalOutboundFixture();
  const outboundAfterExternalWrite = await json("/api/outbound-messages");
  assert(
    outboundAfterExternalWrite.messages.some((message) => message.id === "external-bot-outbound"),
    "setup server refreshes outbound history written by standalone bot"
  );
  assert(
    outboundAfterExternalWrite.summary.criticalFailed >= 1,
    "externally written critical outbound failures affect setup summary"
  );
  assert(
    outboundAfterExternalWrite.messages.some((message) => message.failureCategory === "network"),
    "outbound message history returns failure category"
  );
  const statusAfterFailure = await json("/api/status");
  assert(statusAfterFailure.runtime.queueHealth.status === "blocked", "critical outbound failure blocks queue health");
  assert(statusAfterFailure.runtime.outboundRecovery.needed === true, "outbound recovery activates after critical failure");
  assert(statusAfterFailure.runtime.outboundRecovery.safeToResend === false, "outbound recovery blocks resend before validation");
  assert(statusAfterFailure.runtime.outboundRecovery.failureCategory === "network", "outbound recovery explains failure category");
  assert(statusAfterFailure.runtime.outboundRecovery.steps.length > 0, "outbound recovery returns operator steps");
  const panicResendWithoutValidation = await json("/api/giveaway/critical/resend", { method: "POST" });
  assert(panicResendWithoutValidation.ok === false, "panic resend fails clearly until chat is validated");

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
  const startedGiveaway = await json("/api/giveaway");
  assert(startedGiveaway.summary.operatorState === "entries open", "live state shows entries open after start");
  const statusSendWithoutValidation = await json("/api/giveaway/status/send", { method: "POST" });
  assert(statusSendWithoutValidation.ok === false, "status-to-chat fails clearly until chat is validated");
  const missingStartAnnouncement = await json("/api/giveaway");
  assert(missingStartAnnouncement.assurance.available === true, "giveaway assurance is available");
  assert(missingStartAnnouncement.assurance.blockContinue === true, "missing critical announcement blocks continue warning");
  assert(
    missingStartAnnouncement.assurance.phases.some((phase) => phase.id === "start" && phase.status === "missing"),
    "giveaway assurance tracks missing start announcement"
  );
  const resendMissingStart = await json("/api/giveaway/announcement/resend", {
    method: "POST",
    body: { action: "start" }
  });
  assert(resendMissingStart.ok === false, "phase resend fails clearly until chat is validated");
  await expectOk("/api/giveaway/last-call");
  await expectOk("/api/giveaway/add-entrant", { login: "alice", displayName: "Alice" });
  await expectOk("/api/giveaway/add-entrant", { login: "bob", displayName: "Bob" });
  const reminderWithoutChat = await json("/api/giveaway/reminder/send", { method: "POST" });
  assert(reminderWithoutChat.ok === false, "manual giveaway reminder fails clearly without configured chat");
  await expectOk("/api/giveaway/close");
  const closedGiveaway = await json("/api/giveaway");
  assert(closedGiveaway.summary.operatorState === "ready to draw", "live state shows ready to draw after close");
  await expectOk("/api/giveaway/draw", { count: 2 });

  const giveaway = await json("/api/giveaway");
  assert(giveaway.entries.length === 2, "giveaway entrants load");
  assert(giveaway.winners.length === 2, "giveaway winners load");
  assert(giveaway.summary.status === "closed", "giveaway summary loads");
  assert(giveaway.summary.operatorState === "delivery pending", "live state shows delivery pending after draw");

  const firstWinner = giveaway.winners[0]?.login;
  assert(Boolean(firstWinner), "winner login exists");
  await expectOk("/api/giveaway/claim", { username: firstWinner });
  await expectOk("/api/giveaway/deliver", { username: firstWinner });
  await expectOk("/api/giveaway/deliver-all");
  const deliveredState = await json("/api/giveaway");
  assert(deliveredState.summary.undeliveredWinnersCount === 0, "bulk delivery marks remaining winners delivered");
  assert(deliveredState.summary.operatorState === "safe to end", "live state shows safe to end after delivery");

  const auditLogs = await json("/api/audit-logs");
  assert(auditLogs.logs.length > 0, "audit logs load");

  await expectOk("/api/giveaway/end");
  const endedGiveaway = await json("/api/giveaway");
  assert(endedGiveaway.recap.available === true, "post-giveaway recap is available after end");
  assert(endedGiveaway.recap.status === "ended", "post-giveaway recap tracks ended status");
  assert(endedGiveaway.summary.operatorState === "no giveaway", "active giveaway state clears after end");
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

function insertExternalOutboundFixture() {
  const db = new Database(smokeDbPath);
  const now = new Date().toISOString();

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
        retry_after_ms,
        next_attempt_at,
        queue_depth,
        category,
        action,
        importance,
        giveaway_id,
        resent_from
      ) VALUES (
        @id,
        @source,
        @status,
        @message,
        @attempts,
        @queuedAt,
        @updatedAt,
        @reason,
        @failureCategory,
        @retryAfterMs,
        @nextAttemptAt,
        @queueDepth,
        @category,
        @action,
        @importance,
        @giveawayId,
        @resentFrom
      )
    `
  ).run({
    id: "external-bot-outbound",
    source: "bot",
    status: "failed",
    message: "Giveaway started: External Smoke. Type !enter to enter. Winners: 1.",
    attempts: 4,
    queuedAt: now,
    updatedAt: now,
    reason: "external standalone bot write",
    failureCategory: "network",
    retryAfterMs: null,
    nextAttemptAt: null,
    queueDepth: null,
    category: "giveaway",
    action: "start",
    importance: "critical",
    giveawayId: null,
    resentFrom: null
  });
  db.close();
}

function assertReminderSettingsFixture(expected) {
  const db = new Database(smokeDbPath, { readonly: true });
  const row = db.prepare("SELECT enabled, interval_minutes FROM giveaway_reminder_settings WHERE id = 1").get();
  db.close();

  assert(Boolean(row), "giveaway reminder settings are persisted");
  assert(row.enabled === expected.enabled, "giveaway reminder enabled state persists");
  assert(row.interval_minutes === expected.intervalMinutes, "giveaway reminder interval persists");
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
