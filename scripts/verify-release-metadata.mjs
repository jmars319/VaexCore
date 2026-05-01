import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const version = packageJson.version;
const changelog = readText("CHANGELOG.md");
const readme = readText("README.md");

assert(
  typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version),
  "package.json version must be semver-like"
);
assert(changelog.includes(`## ${version}`), `CHANGELOG.md must contain a section for ${version}`);
assert(changelog.includes("Milestone 26"), "CHANGELOG.md must mention Milestone 26");
assert(changelog.includes("unsigned"), "CHANGELOG.md must document unsigned release state");
assert(readme.includes("Unsigned Tester Builds"), "README must document unsigned tester builds");
assert(readme.includes("Known Limitations"), "README must document known limitations");
assert(readme.includes("release:unsigned"), "README must document npm run release:unsigned");
assert(packageJson.scripts?.["release:unsigned"], "package.json must define release:unsigned");
assert(packageJson.scripts?.["release:check"], "package.json must define release:check");

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
