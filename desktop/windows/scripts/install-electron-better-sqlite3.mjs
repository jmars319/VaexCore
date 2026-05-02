import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

if (process.platform !== "win32") {
  throw new Error("Windows native module packaging must run on Windows.");
}

const releaseDir = resolve("release");
const electronPackage = JSON.parse(
  readFileSync(resolve("node_modules/electron/package.json"), "utf8")
);
const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const electronVersion = electronPackage.version;
const productName = packageJson.build?.productName ?? packageJson.name;
const prebuildInstallBin = resolve("node_modules/prebuild-install/bin.js");

if (!existsSync(prebuildInstallBin)) {
  throw new Error("prebuild-install was not found in node_modules.");
}

const apps = findPackagedApps(releaseDir);

if (apps.length === 0) {
  throw new Error("No packaged Windows app directory was found under release/.");
}

for (const appPath of apps) {
  const moduleDir = join(
    appPath,
    "resources/app/node_modules/better-sqlite3"
  );

  if (!existsSync(moduleDir)) {
    throw new Error(`Packaged better-sqlite3 module not found: ${moduleDir}`);
  }

  rmSync(join(moduleDir, "build"), { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [
      prebuildInstallBin,
      "--runtime",
      "electron",
      "--target",
      electronVersion,
      "--arch",
      process.arch,
      "--platform",
      process.platform
    ],
    { cwd: moduleDir, stdio: "inherit" }
  );

  probePackagedBetterSqlite(appPath);
}

function findPackagedApps(dir) {
  if (!existsSync(dir)) {
    return [];
  }

  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory() && /win.*-unpacked$/i.test(entry.name)) {
      results.push(path);
    } else if (entry.isDirectory()) {
      results.push(...findPackagedApps(path));
    }
  }

  return results;
}

function probePackagedBetterSqlite(appPath) {
  const binaryPath = join(appPath, `${productName}.exe`);
  const appPackagePath = join(appPath, "resources/app/package.json");

  if (!existsSync(binaryPath)) {
    throw new Error(`Packaged Windows executable not found: ${binaryPath}`);
  }

  const expression = [
    "const { createRequire } = require('node:module');",
    `const appRequire = createRequire(${JSON.stringify(appPackagePath)});`,
    "const Database = appRequire('better-sqlite3');",
    "const db = new Database(':memory:');",
    "db.close();",
    "console.log('packaged better-sqlite3 ok', process.versions.modules);"
  ].join(" ");

  execFileSync(binaryPath, ["-e", expression], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit"
  });
}
