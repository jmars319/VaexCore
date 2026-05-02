import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const productName = packageJson.build?.productName ?? packageJson.name;
const version = packageJson.version ?? "0.0.0";
const artifactBase = `${productName}-${version}-mac-${process.arch}-unsigned`;
const releaseDir = resolve("release");
const manifestPath = join(releaseDir, `${artifactBase}.json`);
const handoffPath = join(releaseDir, `${artifactBase}-handoff.md`);

const steps = [
  ["Git release state", ["npm", "run", "release:guard"]],
  ["Release metadata", ["node", "scripts/verify-release-metadata.mjs"]],
  ["Tester guide", ["npm", "run", "smoke:tester-guide"]],
  ["Typecheck", ["npm", "run", "typecheck"]],
  ["Clean install smoke", ["npm", "run", "smoke:clean-install"]],
  ["Diagnostics smoke", ["npm", "run", "smoke:diagnostics"]],
  ["Setup UI smoke", ["npm", "run", "smoke:setup"]],
  ["Custom commands smoke", ["npm", "run", "smoke:commands"]],
  ["Operational guardrails smoke", ["npm", "run", "smoke:guardrails"]],
  ["Timers smoke", ["npm", "run", "smoke:timers"]],
  ["Moderation smoke", ["npm", "run", "smoke:moderation"]],
  ["Bot replacement smoke", ["npm", "run", "smoke:replacement"]],
  ["Token refresh smoke", ["npm", "run", "smoke:token-refresh"]],
  ["Giveaway readiness smoke", ["npm", "run", "smoke:giveaway"]],
  ["Giveaway live rehearsal", ["npm", "run", "smoke:giveaway-live"]],
  ["CLI env smoke", ["npm", "run", "smoke:cli-env"]],
  ["Message queue smoke", ["npm", "run", "smoke:queue"]],
  ["Unsigned release artifact smoke", ["npm", "run", "smoke:unsigned-release"]],
  ["Tester artifact dry run", ["npm", "run", "smoke:tester-artifact"]],
  ["Tester update preservation", ["npm", "run", "smoke:tester-update"]],
  ["Tester handoff", ["npm", "run", "release:handoff"]]
];

for (const [label, command] of steps) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command[0], command.slice(1), {
    stdio: "inherit",
    env: { ...process.env }
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(manifestPath)) {
  throw new Error(`Unsigned release manifest missing: ${manifestPath}`);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

console.log("\nUnsigned release ready:");
console.log(`- zip: ${manifest.zip}`);
console.log(`- checksum: release/${basename(manifest.zip)}.sha256`);
console.log(`- manifest: release/${basename(manifestPath)}`);
console.log(`- handoff: release/${basename(handoffPath)}`);
console.log(`- sha256: ${manifest.sha256}`);
console.log(`- git commit: ${manifest.gitCommit}`);
console.log("- notarized: false");
