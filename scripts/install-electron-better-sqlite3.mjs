import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

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
  throw new Error("No packaged VaexCore.app bundle was found under release/.");
}

for (const appPath of apps) {
  const moduleDir = join(
    appPath,
    "Contents/Resources/app/node_modules/better-sqlite3"
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

  resignPackagedApp(appPath);
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

    if (entry.isDirectory() && entry.name === `${productName}.app`) {
      results.push(path);
    } else if (entry.isDirectory()) {
      results.push(...findPackagedApps(path));
    }
  }

  return results;
}

function probePackagedBetterSqlite(appPath) {
  if (process.platform !== "darwin") {
    return;
  }

  const binaryPath = join(appPath, "Contents/MacOS", productName);
  const appPackagePath = join(appPath, "Contents/Resources/app/package.json");
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

function resignPackagedApp(appPath) {
  if (process.platform !== "darwin") {
    return;
  }

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit"
  });
  execFileSync(
    "codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", appPath],
    { stdio: "inherit" }
  );
}
