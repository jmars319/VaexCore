import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const productName = packageJson.build?.productName ?? packageJson.name;
const electronBuilderBin = resolve("node_modules/.bin/electron-builder");
const apps = findPackagedApps(resolve("release"));

if (apps.length !== 1) {
  throw new Error(`Expected one packaged ${productName}.app, found ${apps.length}.`);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

execFileSync(electronBuilderBin, ["--mac", "dmg", "--prepackaged", apps[0]], {
  env,
  stdio: "inherit"
});

function findPackagedApps(dir) {
  if (!existsSync(dir)) {
    return [];
  }

  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory() && entry.name === `${productName}.app`) {
      results.push(path);
    } else if (entry.isDirectory()) {
      results.push(...findPackagedApps(path));
    }
  }

  return results;
}
