import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tempDir = mkdtempSync(join(tmpdir(), "vaexcore-custom-commands-smoke-"));
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
  console.log("custom commands smoke passed");
} finally {
  await handle.stop();
  rmSync(tempDir, { recursive: true, force: true });
}

async function runSmoke() {
  const appJs = await text("/ui/app.js");
  assert(appJs.includes("Command Library"), "Commands tab renders command library");
  assert(appJs.includes("Response variants"), "Commands tab renders response variants");
  assert(appJs.includes("Export commands JSON"), "Commands tab exposes export");
  assert(appJs.includes("Import commands JSON"), "Commands tab exposes import");

  const initial = await json("/api/commands");
  assert(initial.ok === true, "custom command route returns ok");
  assert(initial.summary.total === 0, "custom command list starts empty");
  assert(initial.reservedNames.includes("ping"), "reserved command names are returned");

  const reserved = await post("/api/commands", {
    name: "ping",
    permission: "viewer",
    enabled: true,
    globalCooldownSeconds: 0,
    userCooldownSeconds: 0,
    aliases: [],
    responses: ["should not save"]
  });
  assert(reserved.ok === false, "reserved command names cannot be saved");

  const saved = await expectOk("/api/commands", {
    name: "discord",
    permission: "viewer",
    enabled: true,
    globalCooldownSeconds: 0,
    userCooldownSeconds: 0,
    aliases: ["links", "socials"],
    responses: ["{user}, join Discord at https://example.com", "Discord link for {target}: https://example.com"]
  });
  const discord = saved.commands.find((command) => command.name === "discord");
  assert(Boolean(discord), "custom command is saved");
  assert(discord.aliases.includes("links"), "custom command alias is saved");
  assert(discord.responses.length === 2, "custom command stores response variants");

  const preview = await post("/api/commands/preview", {
    commandId: discord.id,
    actor: "alice",
    role: "viewer",
    rawArgs: "bob"
  });
  assert(preview.ok === true, "custom command preview returns ok");
  assert(preview.response.includes("alice") || preview.response.includes("bob"), "preview renders placeholders");

  const runDirect = await simulate({
    actor: "alice",
    role: "viewer",
    command: "!discord bob"
  });
  assert(runDirect.routerResult === "handled", "custom command direct name is handled");
  assert(runDirect.replies.length === 1, "custom command sends a reply");
  assert(runDirect.replies[0].includes("example.com"), "custom command reply uses saved response");

  const runAlias = await simulate({
    actor: "bob",
    role: "viewer",
    command: "!links alice"
  });
  assert(runAlias.routerResult === "handled", "custom command alias is handled");
  assert(runAlias.replies.length === 1, "custom command alias sends a reply");

  const afterUses = await json("/api/commands");
  const usedDiscord = afterUses.commands.find((command) => command.name === "discord");
  assert(usedDiscord.useCount === 2, "custom command use count increments");
  assert(afterUses.invocations.some((entry) => entry.commandName === "discord"), "custom command usage history is recorded");

  const modOnlySave = await expectOk("/api/commands", {
    name: "modsonly",
    permission: "moderator",
    enabled: true,
    globalCooldownSeconds: 0,
    userCooldownSeconds: 0,
    aliases: [],
    responses: ["Mod command for {user}"]
  });
  const viewerDenied = await simulate({
    actor: "viewer",
    role: "viewer",
    command: "!modsonly"
  });
  assert(viewerDenied.routerResult === "handled", "permission-blocked custom command is consumed quietly");
  assert(viewerDenied.replies.length === 0, "permission-blocked custom command does not reply in chat");
  const modAllowed = await simulate({
    actor: "mod",
    role: "mod",
    command: "!modsonly"
  });
  assert(modAllowed.replies.some((reply) => reply.includes("Mod command")), "moderator can run moderator command");

  const cooldownSave = await expectOk("/api/commands", {
    name: "cool",
    permission: "viewer",
    enabled: true,
    globalCooldownSeconds: 0,
    userCooldownSeconds: 60,
    aliases: [],
    responses: ["cooldown reply"]
  });
  const cool = cooldownSave.commands.find((command) => command.name === "cool");
  const coolFirst = await simulate({ actor: "carol", role: "viewer", command: "!cool" });
  assert(coolFirst.replies.length === 1, "first cooldown command use replies");
  const coolSecond = await simulate({ actor: "carol", role: "viewer", command: "!cool" });
  assert(coolSecond.routerResult === "handled", "cooldown command is still recognized");
  assert(coolSecond.replies.length === 0, "user cooldown suppresses repeated reply");
  const coolOtherUser = await simulate({ actor: "dave", role: "viewer", command: "!cool" });
  assert(coolOtherUser.replies.length === 1, "user cooldown does not block another user");

  const disabled = await post("/api/commands/enable", { id: cool.id, enabled: false });
  assert(disabled.ok === true, "custom command can be disabled");
  const coolDisabled = await simulate({ actor: "erin", role: "viewer", command: "!cool" });
  assert(coolDisabled.routerResult === "unknown", "disabled custom command is ignored");

  const duplicate = await post("/api/commands/duplicate", { id: modOnlySave.command.id });
  assert(duplicate.ok === true, "custom command can be duplicated");
  assert(duplicate.command.name.includes("modsonly_copy"), "duplicate command receives copy name");
  assert(duplicate.command.enabled === false, "duplicate command starts disabled");

  const exported = await json("/api/commands/export");
  assert(exported.version === 1, "custom command export has version");
  assert(exported.commands.some((command) => command.name === "discord"), "export includes saved command");

  const deleted = await post("/api/commands/delete", { id: discord.id });
  assert(deleted.ok === true, "custom command can be deleted");
  const deletedRun = await simulate({ actor: "alice", role: "viewer", command: "!discord" });
  assert(deletedRun.routerResult === "unknown", "deleted command no longer routes");
  const afterDelete = await json("/api/commands");
  assert(afterDelete.invocations.some((entry) => entry.commandName === "discord"), "custom command usage history survives definition delete");

  const imported = await post("/api/commands/import", exported);
  assert(imported.ok === true, "custom command export can be imported");
  assert(imported.commands.some((command) => command.name === "discord"), "import restores command");

  const audit = await json("/api/audit-logs");
  assert(audit.logs.some((log) => log.action === "custom_command.create"), "custom command create audit is written");
  assert(audit.logs.some((log) => log.action === "custom_command.use"), "custom command use audit is written");
  assert(audit.logs.some((log) => log.action === "custom_command.import"), "custom command import audit is written");
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Smoke failed: ${message}`);
  }
}
