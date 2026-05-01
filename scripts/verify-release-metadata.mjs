import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const version = packageJson.version;
const changelog = readText("CHANGELOG.md");
const readme = readText("README.md");
const testerGuide = readText("TESTER_GUIDE.md");

assert(
  typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version),
  "package.json version must be semver-like"
);
assert(changelog.includes(`## ${version}`), `CHANGELOG.md must contain a section for ${version}`);
assert(changelog.includes("Milestone 29"), "CHANGELOG.md must mention Milestone 29");
assert(changelog.includes("Milestone 28"), "CHANGELOG.md must mention Milestone 28");
assert(changelog.includes("Milestone 26"), "CHANGELOG.md must mention Milestone 26");
assert(changelog.includes("unsigned"), "CHANGELOG.md must document unsigned release state");
assert(readme.includes("Unsigned Tester Builds"), "README must document unsigned tester builds");
assert(readme.includes("Known Limitations"), "README must document known limitations");
assert(readme.includes("release:unsigned"), "README must document npm run release:unsigned");
assert(readme.includes("TESTER_GUIDE.md"), "README must link to TESTER_GUIDE.md");
assert(testerGuide.includes("unsigned") && testerGuide.includes("not notarized"), "tester guide must explain unsigned/not-notarized builds");
assert(testerGuide.includes("Copy support bundle"), "tester guide must explain support bundle handoff");
assert(readme.includes("smoke:tester-artifact"), "README must document tester artifact smoke");
assert(readme.includes("smoke:tester-update"), "README must document tester update smoke");
assert(testerGuide.includes("tester artifact dry run"), "tester guide must mention tester artifact dry run");
assert(testerGuide.includes("Updating VaexCore"), "tester guide must explain manual updates");
assert(packageJson.scripts?.["release:unsigned"], "package.json must define release:unsigned");
assert(packageJson.scripts?.["release:check"], "package.json must define release:check");
assert(packageJson.scripts?.["smoke:tester-guide"], "package.json must define smoke:tester-guide");
assert(packageJson.scripts?.["smoke:tester-artifact"], "package.json must define smoke:tester-artifact");
assert(packageJson.scripts?.["smoke:tester-update"], "package.json must define smoke:tester-update");

console.log(`release metadata ok for ${packageJson.name}@${version}`);

function readText(path) {
  const absolute = resolve(path);
  assert(existsSync(absolute), `${path} must exist`);
  return readFileSync(absolute, "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Release metadata check failed: ${message}`);
  }
}
