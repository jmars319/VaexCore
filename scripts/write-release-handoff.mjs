import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const productName = packageJson.build?.productName ?? packageJson.name;
const version = packageJson.version ?? "0.0.0";
const artifactBase = `${productName}-${version}-mac-${process.arch}-unsigned`;
const releaseDir = resolve("release");
const manifestPath = join(releaseDir, `${artifactBase}.json`);
const checksumPath = join(releaseDir, `${artifactBase}.zip.sha256`);
const handoffPath = join(releaseDir, `${artifactBase}-handoff.md`);

assert(existsSync(manifestPath), `release manifest missing: ${manifestPath}`);
assert(existsSync(checksumPath), `checksum file missing: ${checksumPath}`);

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const checksum = readFileSync(checksumPath, "utf8").trim();

writeFileSync(handoffPath, `${[
  `# ${productName} ${version} Unsigned Tester Handoff`,
  "",
  "Share these files together:",
  "",
  `- ${basename(manifest.zip)}`,
  `- ${basename(checksumPath)}`,
  `- ${basename(manifestPath)}`,
  "- TESTER_GUIDE.md",
  "",
  "Checksum:",
  "",
  "```bash",
  `shasum -a 256 -c ${basename(checksumPath)}`,
  "```",
  "",
  "Build details:",
  "",
  `- Git commit: ${manifest.gitCommit}`,
  `- SHA-256: ${manifest.sha256}`,
  `- Platform: ${manifest.platform} ${manifest.arch}`,
  `- Signing: ${manifest.signing}`,
  `- Notarized: ${manifest.notarized}`,
  "",
  "Tester install/update notes:",
  "",
  "- This build is unsigned, ad-hoc signed, and not notarized.",
  "- First launch may require right-click Open or Privacy & Security -> Open Anyway.",
  "- For updates, quit VaexCore and replace only VaexCore.app.",
  "- Do not delete ~/Library/Application Support/VaexCore unless intentionally resetting local setup.",
  "- If anything fails, open Diagnostics and click Copy support bundle.",
  "",
  `Checksum file contents: ${checksum}`,
  ""
].join("\n")}\n`);

console.log(`release handoff: ${relativeReleasePath(handoffPath)}`);

function relativeReleasePath(path) {
  return path.replace(`${process.cwd()}/`, "");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Release handoff failed: ${message}`);
  }
}
