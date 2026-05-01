import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const productName = packageJson.build?.productName ?? packageJson.name;
const version = packageJson.version ?? "0.0.0";
const artifactBase = `${productName}-${version}-mac-${process.arch}-unsigned`;
const releaseDir = resolve("release");
const manifestPath = join(releaseDir, `${artifactBase}.json`);

const steps = [
  ["Release metadata", ["node", "scripts/verify-release-metadata.mjs"]],
  ["Tester guide", ["npm", "run", "smoke:tester-guide"]],
  ["Typecheck", ["npm", "run", "typecheck"]],
  ["Clean install smoke", ["npm", "run", "smoke:clean-install"]],
  ["Diagnostics smoke", ["npm", "run", "smoke:diagnostics"]],
  ["Setup UI smoke", ["npm", "run", "smoke:setup"]],
  ["Token refresh smoke", ["npm", "run", "smoke:token-refresh"]],
  ["Giveaway readiness smoke", ["npm", "run", "smoke:giveaway"]],
  ["CLI env smoke", ["npm", "run", "smoke:cli-env"]],
  ["Message queue smoke", ["npm", "run", "smoke:queue"]],
  ["Unsigned release artifact smoke", ["npm", "run", "smoke:unsigned-release"]]
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
console.log(`- sha256: ${manifest.sha256}`);
console.log("- notarized: false");
