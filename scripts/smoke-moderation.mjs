import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tempDir = mkdtempSync(join(tmpdir(), "vaexcore-moderation-smoke-"));
const smokeDbPath = join(tempDir, "data/vaexcore.sqlite");

process.env.VAEXCORE_CONFIG_DIR = tempDir;
process.env.DATABASE_URL = `file:${smokeDbPath}`;

const { startSetupServer } = await import(
  pathToFileURL(resolve("dist-bundle/setup-server.js")).href
);

const handle = await startSetupServer({ port: 3443 });
const baseUrl = handle.url;

try {
  await runSmoke();
  console.log("moderation smoke passed");
} finally {
  await handle.stop();
  rmSync(tempDir, { recursive: true, force: true });
}

async function runSmoke() {
  const appJs = await text("/ui/app.js");
  assert(appJs.includes("Moderation"), "Moderation tab renders");
  assert(appJs.includes("Run moderation test"), "Moderation tab exposes local test");
  assert(appJs.includes("Save moderation settings"), "Moderation tab exposes settings save");
  assert(appJs.includes("Trusted Roles"), "Moderation tab exposes trusted role exemptions");
  assert(appJs.includes("Allowed Link Domains"), "Moderation tab exposes allowed link domains");
  assert(appJs.includes("Blocked Link Domains"), "Moderation tab exposes blocked link domains");
  assert(appJs.includes("boundary-aware matching"), "Moderation tab explains safer phrase matching");
  assert(appJs.includes("Temporary Link Permits"), "Moderation tab exposes link permits");
  assert(appJs.includes("Timeout seconds"), "Moderation tab exposes timeout duration");
  assert(appJs.includes("Escalation"), "Moderation tab exposes repeat-hit escalation");
  assert(appJs.includes("Bot Shield"), "Moderation tab exposes bot shield");
  assert(appJs.includes("moderator:manage:chat_messages"), "Moderation tab exposes delete scope status");
  assert(appJs.includes("moderator:manage:banned_users"), "Moderation tab exposes timeout scope status");

  const initial = await json("/api/moderation");
  assert(initial.ok === true, "moderation route returns ok");
  assert(initial.featureGate.mode === "off", "moderation feature gate defaults off");
  assert(initial.summary.filtersEnabled === 0, "all moderation filters default off");
  assert(initial.summary.enforcementFilters === 0, "enforcement actions default off");
  assert(initial.settings.blockedTermsAction === "warn", "blocked phrase action defaults warn");
  assert(initial.settings.linkFilterAction === "warn", "link action defaults warn");
  assert(initial.settings.botShieldEnabled === false, "bot shield defaults off");
  assert(initial.settings.botShieldAction === "delete", "bot shield default action is protective when enabled");
  assert(initial.settings.botShieldScoreThreshold === 70, "bot shield score threshold defaults safely");
  assert(initial.summary.botShield === "off", "bot shield summary defaults off");
  assert(initial.settings.timeoutSeconds === 60, "timeout duration defaults safely");
  assert(initial.settings.escalationEnabled === false, "repeat-hit escalation defaults off");
  assert(initial.summary.escalation === "off", "repeat-hit escalation summary defaults off");
  assert(initial.settings.exemptBroadcaster === true, "broadcaster exemption defaults on");
  assert(initial.settings.exemptModerators === true, "moderator exemption defaults on");
  assert(initial.settings.exemptSubscribers === false, "subscriber exemption defaults off");
  assert(initial.enforcement.deleteMessages.available === false, "delete enforcement is unavailable without setup");
  assert(initial.enforcement.timeoutUsers.available === false, "timeout enforcement is unavailable without setup");
  assert(initial.summary.enabledBlockedLinks === 0, "blocked link domains start empty");

  const term = await post("/api/moderation/terms", {
    term: "spoiler",
    enabled: true
  });
  assert(term.ok === true, "blocked phrase can be saved");
  assert(term.terms.some((item) => item.term === "spoiler" && item.enabled), "blocked phrase is enabled");

  const wildcardTerm = await post("/api/moderation/terms", {
    term: "scam*",
    enabled: true
  });
  assert(wildcardTerm.ok === true, "wildcard blocked phrase can be saved");

  const saved = await post("/api/moderation/settings", {
    blockedTermsEnabled: true,
    linkFilterEnabled: true,
    capsFilterEnabled: true,
    repeatFilterEnabled: true,
    symbolFilterEnabled: true,
    botShieldEnabled: true,
    blockedTermsAction: "delete",
    linkFilterAction: "timeout",
    capsFilterAction: "warn",
    repeatFilterAction: "warn",
    symbolFilterAction: "warn",
    botShieldAction: "delete",
    botShieldScoreThreshold: 65,
    timeoutSeconds: 90,
    warningMessage: "@{user}, warning: {reason}",
    capsMinLength: 8,
    capsRatio: 0.75,
    repeatWindowSeconds: 30,
    repeatLimit: 3,
    symbolMinLength: 8,
    symbolRatio: 0.6,
    escalationEnabled: true,
    escalationWindowSeconds: 300,
    escalationDeleteAfter: 2,
    escalationTimeoutAfter: 3,
    exemptBroadcaster: true,
    exemptModerators: true,
    exemptVips: true,
    exemptSubscribers: false
  });
  assert(saved.ok === true, "moderation settings save");
  assert(saved.summary.filtersEnabled === 6, "moderation filters can be enabled");
  assert(saved.summary.enforcementFilters === 3, "delete and timeout actions can be assigned per filter");
  assert(saved.summary.botShield === "65+ delete", "bot shield summary is readable");
  assert(saved.settings.timeoutSeconds === 90, "timeout duration can be saved");
  assert(saved.settings.escalationEnabled === true, "repeat-hit escalation can be enabled");
  assert(saved.summary.escalation === "2/3 in 300s", "repeat-hit escalation summary is readable");
  assert(saved.summary.roleExemptions === 3, "trusted role exemptions are counted");

  const allowedDomain = await post("/api/moderation/allowed-links", {
    domain: "https://example.com/allowed",
    enabled: true
  });
  assert(allowedDomain.ok === true, "allowed link domain can be saved");
  assert(allowedDomain.allowedLinks.some((item) => item.domain === "example.com" && item.enabled), "allowed link domain is normalized");

  const blockedDomain = await post("/api/moderation/blocked-links", {
    domain: "https://blocked.example/path",
    enabled: true
  });
  assert(blockedDomain.ok === true, "blocked link domain can be saved");
  assert(blockedDomain.blockedLinks.some((item) => item.domain === "blocked.example" && item.enabled), "blocked link domain is normalized");

  const offResult = await post("/api/moderation/simulate", {
    actor: "viewer",
    role: "viewer",
    text: "spoiler"
  });
  assert(offResult.result.skipped === true, "feature-gated-off moderation skips");

  const gateTest = await post("/api/feature-gates", {
    key: "moderation_filters",
    mode: "test"
  });
  assert(gateTest.ok === true, "moderation feature gate can enter test mode");

  const blocked = await post("/api/moderation/simulate", {
    actor: "viewer",
    role: "viewer",
    text: "this has a spoiler"
  });
  assert(blocked.result.hit.filterTypes.includes("blocked_term"), "blocked phrase hit is detected");
  assert(blocked.result.hit.action === "delete", "blocked phrase can resolve to delete action");
  assert(blocked.result.hit.matches.some((match) => match.detail.includes("whole-word")), "blocked phrase reports whole-word matching");
  assert(blocked.result.hit.warningMessage.includes("viewer"), "warning message renders user placeholder");
  assert(blocked.enforcementPlan.status === "blocked", "local moderation test explains enforcement block");

  const safeSubstring = await post("/api/moderation/simulate", {
    actor: "viewer",
    role: "viewer",
    text: "this is educational"
  });
  assert(!safeSubstring.result.hit?.filterTypes.includes("blocked_term"), "blocked phrase does not match inside unrelated words");

  const wildcardBlocked = await post("/api/moderation/simulate", {
    actor: "viewer",
    role: "viewer",
    text: "this looks scammy"
  });
  assert(wildcardBlocked.result.hit.filterTypes.includes("blocked_term"), "wildcard blocked phrase detects intentional broad match");

  const moderator = await post("/api/moderation/simulate", {
    actor: "channelmod",
    role: "mod",
    text: "this has a spoiler"
  });
  assert(moderator.result.skipped === true, "trusted moderator role is exempt");

  const link = await post("/api/moderation/simulate", {
    actor: "viewer",
    role: "viewer",
    text: "visit bad-example.net please"
  });
  assert(link.result.hit.filterTypes.includes("link"), "link filter hit is detected");
  assert(link.result.hit.action === "timeout", "link filter can resolve to timeout action");
  assert(link.result.hit.timeoutSeconds === 90, "timeout action reports bounded duration");

  const blockedLink = await post("/api/moderation/simulate", {
    actor: "viewer",
    role: "viewer",
    text: "visit blocked.example please"
  });
  assert(blockedLink.result.hit.filterTypes.includes("link"), "blocked domain hit is detected");
  assert(blockedLink.result.hit.detail.includes("blocked domain"), "blocked domain detail is explicit");

  const allowedLink = await post("/api/moderation/simulate", {
    actor: "viewer",
    role: "viewer",
    text: "visit example.com please"
  });
  assert(!allowedLink.result.hit, "allowed domain does not trigger link filter");
  assert(allowedLink.result.allowedLinks.includes("example.com"), "allowed domain is reported in simulation");

  const botSpam = await post("/api/moderation/simulate", {
    actor: "famebot1234",
    role: "viewer",
    text: "Want to become famous? Buy followers and viewers at example.com"
  });
  assert(botSpam.result.hit.filterTypes.includes("bot_shield"), "bot shield detects likely follower/viewer spam");
  assert(botSpam.result.hit.action === "delete", "bot shield can resolve to delete action without link timeout");
  assert(botSpam.result.botShield.score >= botSpam.result.botShield.threshold, "bot shield reports score and threshold");
  assert(botSpam.result.botShield.firstTimeChatter === true, "bot shield detects first-time chatter context");
  assert(botSpam.result.hit.silent === true, "bot shield silently handles first protective delete");
  assert(botSpam.result.hit.detail.includes("bot shield score"), "bot shield hit detail includes score");

  const legitNewViewer = await post("/api/moderation/simulate", {
    actor: "newviewer",
    role: "viewer",
    text: "first time here, this stream is cool"
  });
  assert(!legitNewViewer.result.hit, "bot shield allows normal first-time chat");
  assert(legitNewViewer.result.botShield.firstTimeChatter === true, "bot shield reports first-time clean chatter");
  assert(legitNewViewer.result.botShield.score < legitNewViewer.result.botShield.threshold, "clear bot shield result still reports score");

  await post("/api/moderation/simulate", { actor: "raidone", role: "viewer", text: "Vaex raid lets go" });
  await post("/api/moderation/simulate", { actor: "raidtwo", role: "viewer", text: "Vaex raid lets go" });
  const raidChatter = await post("/api/moderation/simulate", {
    actor: "raidthree",
    role: "viewer",
    text: "Vaex raid lets go"
  });
  assert(!raidChatter.result.hit, "bot shield allows repeated legit raid chatter");
  assert(raidChatter.result.botShield.reasons.includes("raid-friendly chatter"), "raid-friendly chatter is explained");

  const caps = await post("/api/moderation/simulate", {
    actor: "viewer",
    role: "viewer",
    text: "THIS IS TOO MUCH CAPS"
  });
  assert(caps.result.hit.filterTypes.includes("caps"), "caps filter hit is detected");

  const symbols = await post("/api/moderation/simulate", {
    actor: "viewer",
    role: "viewer",
    text: "!!!!!!!!!!!!"
  });
  assert(symbols.result.hit.filterTypes.includes("symbols"), "symbol filter hit is detected");

  await post("/api/moderation/simulate", { actor: "repeat", role: "viewer", text: "same message" });
  await post("/api/moderation/simulate", { actor: "repeat", role: "viewer", text: "same message" });
  const repeat = await post("/api/moderation/simulate", {
    actor: "repeat",
    role: "viewer",
    text: "same message"
  });
  assert(repeat.result.hit.filterTypes.includes("repeat"), "repeat filter hit is detected");

  const permit = await post("/api/moderation/link-permits", {
    userLogin: "permituser",
    minutes: 5
  });
  assert(permit.ok === true, "temporary link permit can be granted");
  assert(permit.summary.activeLinkPermits >= 1, "active link permit is counted");

  const permittedLink = await post("/api/moderation/simulate", {
    actor: "permituser",
    role: "viewer",
    text: "visit unlisted-link.io"
  });
  assert(!permittedLink.result.hit, "temporary link permit suppresses link warning");
  assert(permittedLink.result.consumedPermit?.userLogin === "permituser", "temporary link permit is reported");

  const command = await post("/api/command/simulate", {
    actor: "viewer",
    role: "viewer",
    command: "!enter spoiler"
  });
  assert(command.moderation?.skipped === true, "!enter is exempt from moderation filters");

  const botShieldOnly = await post("/api/moderation/settings", {
    blockedTermsEnabled: false,
    linkFilterEnabled: false,
    capsFilterEnabled: false,
    repeatFilterEnabled: false,
    symbolFilterEnabled: false,
    botShieldEnabled: true,
    botShieldAction: "delete",
    botShieldScoreThreshold: 70
  });
  assert(botShieldOnly.ok === true, "bot shield can run without basic filters");

  await post("/api/moderation/simulate", { actor: "repeatbot", role: "viewer", text: "limited drop code now" });
  await post("/api/moderation/simulate", { actor: "repeatbot", role: "viewer", text: "limited drop code now" });
  const repeatedBot = await post("/api/moderation/simulate", {
    actor: "repeatbot",
    role: "viewer",
    text: "limited drop code now"
  });
  assert(repeatedBot.result.hit.filterTypes.includes("bot_shield"), "bot shield rate-limits repeated messages");
  assert(repeatedBot.result.hit.detail.includes("rate-limited repeated message"), "bot shield explains repeated-message rate limit");

  await post("/api/moderation/simulate", { actor: "copypaste1", role: "viewer", text: "limited drop code now" });
  await post("/api/moderation/simulate", { actor: "copypaste2", role: "viewer", text: "limited drop code now" });
  const copiedBot = await post("/api/moderation/simulate", {
    actor: "copypaste3",
    role: "viewer",
    text: "limited drop code now"
  });
  assert(copiedBot.result.hit.filterTypes.includes("bot_shield"), "bot shield catches copy/paste patterns across chat");
  assert(copiedBot.result.hit.detail.includes("copy/paste pattern across chat"), "bot shield explains copy/paste pattern");

  const afterHits = await json("/api/moderation");
  assert(afterHits.hits.length >= 5, "recent moderation hits are listed");

  const audit = await json("/api/audit-logs");
  assert(audit.logs.some((log) => log.action === "moderation.term_create"), "blocked phrase create is audited");
  assert(audit.logs.some((log) => log.action === "moderation.settings_update"), "moderation settings update is audited");
  assert(audit.logs.some((log) => log.action === "moderation.allowed_link_create"), "allowed link create is audited");
  assert(audit.logs.some((log) => log.action === "moderation.blocked_link_create"), "blocked link create is audited");
  assert(audit.logs.some((log) => log.action === "moderation.link_permit_create"), "link permit create is audited");
  assert(audit.logs.some((log) => log.action === "moderation.hit"), "moderation hit is audited");

  await runDirectEnforcementSmoke();
}

async function runDirectEnforcementSmoke() {
  const directDir = mkdtempSync(join(tmpdir(), "vaexcore-moderation-direct-"));
  const directDbPath = join(directDir, "data/vaexcore.sqlite");
  const { createDbClient } = await import(pathToFileURL(resolve("desktop/shared/src/db/client.ts")).href);
  const { createFeatureGateStore } = await import(pathToFileURL(resolve("desktop/shared/src/core/featureGates.ts")).href);
  const { ModerationService } = await import(pathToFileURL(resolve("desktop/shared/src/modules/moderation/moderation.module.ts")).href);
  const db = createDbClient(`file:${directDbPath}`);
  const featureGates = createFeatureGateStore(db);
  const actor = chatMessage({
    id: "msg-1",
    userId: "user-1",
    userLogin: "viewer",
    text: "visit blocked.example"
  });

  try {
    featureGates.setMode("moderation_filters", "live", chatMessage({ userLogin: "operator", text: "!setup" }));
    const service = new ModerationService(db, { featureGates, commandPrefix: "!" });
    service.saveSettings({
      linkFilterEnabled: true,
      linkFilterAction: "timeout",
      timeoutSeconds: 120
    }, chatMessage({ userLogin: "operator", text: "!setup" }));

    const evaluation = service.evaluate(actor);
    assert(evaluation.hit?.action === "timeout", "direct service resolves timeout action");

    const missingScope = service.planEnforcement(actor, evaluation.hit, {
      canDeleteMessages: false,
      canTimeoutUsers: false,
      timeoutUnavailableReason: "missing timeout scope"
    });
    assert(missingScope.status === "blocked", "timeout enforcement blocks without scope");
    assert(missingScope.reason.includes("missing timeout scope"), "missing-scope reason is actionable");

    const ready = service.planEnforcement(actor, evaluation.hit, {
      canDeleteMessages: false,
      canTimeoutUsers: true
    });
    assert(ready.status === "ready", "timeout enforcement is ready with scope and user ID");
    assert(ready.durationSeconds === 120, "timeout plan preserves configured duration");

    const protectedCommand = service.evaluate(chatMessage({
      id: "msg-2",
      userId: "user-2",
      userLogin: "viewer",
      text: "!enter blocked.example"
    }));
    assert(protectedCommand.skipped === true, "protected giveaway entry remains enforcement-exempt");

    service.saveSettings({
      linkFilterEnabled: true,
      linkFilterAction: "warn",
      escalationEnabled: true,
      escalationWindowSeconds: 300,
      escalationDeleteAfter: 2,
      escalationTimeoutAfter: 3,
      timeoutSeconds: 120
    }, chatMessage({ userLogin: "operator", text: "!setup" }));
    const escalationActor = chatMessage({
      id: "msg-escalation-1",
      userId: "user-escalation",
      userLogin: "escalating",
      text: "visit repeated.example"
    });
    const firstEscalationHit = service.evaluate(escalationActor);
    const secondEscalationHit = service.evaluate({
      ...escalationActor,
      id: "msg-escalation-2"
    });
    const thirdEscalationHit = service.evaluate({
      ...escalationActor,
      id: "msg-escalation-3"
    });
    assert(firstEscalationHit.hit?.action === "warn", "escalation starts with base warn action");
    assert(secondEscalationHit.hit?.action === "delete", "second recent hit escalates to delete");
    assert(secondEscalationHit.hit?.escalation?.hitsInWindow === 2, "delete escalation reports hit count");
    assert(thirdEscalationHit.hit?.action === "timeout", "third recent hit escalates to timeout");
    assert(thirdEscalationHit.hit?.timeoutSeconds === 120, "timeout escalation preserves configured timeout duration");

    service.recordEnforcement(actor, evaluation.hit, {
      action: "timeout",
      status: "blocked",
      reason: "missing timeout scope",
      durationSeconds: 120
    });
    const auditRows = db.prepare("SELECT action FROM audit_logs").all();
    assert(auditRows.some((row) => row.action === "moderation.timeout_blocked"), "blocked enforcement is audited");
  } finally {
    db.close();
    rmSync(directDir, { recursive: true, force: true });
  }
}

function chatMessage(overrides = {}) {
  const userLogin = overrides.userLogin || "viewer";
  return {
    id: overrides.id || "local-message",
    text: overrides.text || "hello",
    userId: overrides.userId || `id-${userLogin}`,
    userLogin,
    userDisplayName: userLogin,
    broadcasterUserId: "broadcaster-id",
    badges: [],
    isBroadcaster: false,
    isMod: false,
    isVip: false,
    isSubscriber: false,
    source: overrides.source || "eventsub",
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
