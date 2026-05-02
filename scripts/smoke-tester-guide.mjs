import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const guidePath = resolve("TESTER_GUIDE.md");
const readmePath = resolve("README.md");

assert(existsSync(guidePath), "TESTER_GUIDE.md exists");

const guide = readFileSync(guidePath, "utf8");
const readme = readFileSync(readmePath, "utf8");

const requiredGuideText = [
  "unsigned",
  "not notarized",
  "Open Anyway",
  "Updating vaexcore console",
  "Do not delete",
  "Settings -> Setup Guide",
  "Bot Replacement Test",
  "Local Bot Rehearsal",
  "Copy support bundle",
  "client secrets, access tokens, and refresh tokens",
  "Port 3434 Is Busy",
  "Invalid Token",
  "Wrong Bot Account",
  "SQLite Fallback",
  "Do not put prize codes into vaexcore console"
];

for (const text of requiredGuideText) {
  assert(guide.includes(text), `TESTER_GUIDE.md mentions ${text}`);
}

assert(readme.includes("TESTER_GUIDE.md"), "README links to tester guide");
assert(!guide.includes("notarized build"), "tester guide does not imply notarized distribution");

console.log("tester guide smoke passed");

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Tester guide smoke failed: ${message}`);
  }
}
