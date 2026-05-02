import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const electronMain = readFileSync(resolve("desktop/shared/electron/main.cjs"), "utf8");

assert(packageJson.scripts["app:build"] === "npm run app:build:mac", "default app build remains macOS");
assert(packageJson.scripts["app:dev"] === "npm run build && node scripts/run-electron-app.mjs .", "desktop dev launch uses cross-platform Electron wrapper");
assert(packageJson.scripts["app:build:mac"]?.includes("--mac dir"), "macOS build script targets app directory");
assert(packageJson.scripts["app:build:windows"]?.includes("--win dir"), "Windows build script targets unpacked app directory");
assert(packageJson.scripts["app:build:windows"]?.includes("desktop/windows/scripts/install-electron-better-sqlite3.mjs"), "Windows build repairs native sqlite module");
assert(packageJson.scripts["smoke:desktop-platforms"] === "node scripts/verify-desktop-platform-config.mjs", "desktop platform smoke script is registered");

const files = packageJson.build?.files ?? [];
assert(files.includes("desktop/macOS/assets/icon.icns"), "macOS icon is packaged");
assert(files.includes("desktop/windows/assets/icon.ico"), "Windows icon is packaged");
assert(packageJson.build?.mac?.icon === "desktop/macOS/assets/icon.icns", "macOS builder icon is configured");
assert(packageJson.build?.win?.icon === "desktop/windows/assets/icon.ico", "Windows builder icon is configured");
assert(hasTarget(packageJson.build?.win?.target, "nsis"), "Windows NSIS target is configured");
assert(hasTarget(packageJson.build?.win?.target, "portable"), "Windows portable target is configured");
assert(packageJson.build?.nsis?.oneClick === false, "Windows installer uses guided install mode");

assert(existsSync(resolve("desktop/windows/assets/icon.ico")), "Windows icon asset exists");
assert(existsSync(resolve("desktop/windows/scripts/install-electron-better-sqlite3.mjs")), "Windows sqlite packaging script exists");
assert(existsSync(resolve("scripts/run-electron-app.mjs")), "cross-platform Electron app wrapper exists");
assert(existsSync(resolve("scripts/run-electron-builder.mjs")), "cross-platform electron-builder wrapper exists");
assert(electronMain.includes("resolveWindowIconPath"), "Electron main process resolves platform icon dynamically");
assert(electronMain.includes("desktop/windows/assets/icon.ico"), "Electron main process can load Windows icon");
assert(electronMain.includes("netstat -ano | findstr"), "Electron startup recovery uses Windows port hint");

console.log("desktop platform config passed");

function hasTarget(targets = [], name) {
  return targets.some((target) =>
    typeof target === "string"
      ? target === name
      : target?.target === name
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Desktop platform config failed: ${message}`);
  }
}
