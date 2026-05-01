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

  const initial = await json("/api/moderation");
  assert(initial.ok === true, "moderation route returns ok");
  assert(initial.featureGate.mode === "off", "moderation feature gate defaults off");
  assert(initial.summary.filtersEnabled === 0, "all moderation filters default off");

  const term = await post("/api/moderation/terms", {
    term: "spoiler",
    enabled: true
  });
  assert(term.ok === true, "blocked phrase can be saved");
  assert(term.terms.some((item) => item.term === "spoiler" && item.enabled), "blocked phrase is enabled");

  const saved = await post("/api/moderation/settings", {
    blockedTermsEnabled: true,
    linkFilterEnabled: true,
    capsFilterEnabled: true,
    repeatFilterEnabled: true,
    symbolFilterEnabled: true,
    warningMessage: "@{user}, warning: {reason}",
    capsMinLength: 8,
    capsRatio: 0.75,
    repeatWindowSeconds: 30,
    repeatLimit: 3,
    symbolMinLength: 8,
    symbolRatio: 0.6
  });
  assert(saved.ok === true, "moderation settings save");
  assert(saved.summary.filtersEnabled === 5, "moderation filters can be enabled");

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
  assert(blocked.result.hit.warningMessage.includes("viewer"), "warning message renders user placeholder");

  const link = await post("/api/moderation/simulate", {
    actor: "viewer",
    role: "viewer",
    text: "visit example.com please"
  });
  assert(link.result.hit.filterTypes.includes("link"), "link filter hit is detected");

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

  const command = await post("/api/command/simulate", {
    actor: "viewer",
    role: "viewer",
    command: "!enter spoiler"
  });
  assert(command.moderation?.skipped === true, "!enter is exempt from moderation filters");

  const afterHits = await json("/api/moderation");
  assert(afterHits.hits.length >= 5, "recent moderation hits are listed");

  const audit = await json("/api/audit-logs");
  assert(audit.logs.some((log) => log.action === "moderation.term_create"), "blocked phrase create is audited");
  assert(audit.logs.some((log) => log.action === "moderation.settings_update"), "moderation settings update is audited");
  assert(audit.logs.some((log) => log.action === "moderation.hit"), "moderation hit is audited");
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
