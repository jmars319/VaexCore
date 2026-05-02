import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configDir = process.env.VAEXCORE_CONFIG_DIR || defaultAppConfigDir();
const databaseUrl =
  process.env.DATABASE_URL || `file:${join(configDir, "data/vaexcore.sqlite")}`;
const env = {
  ...process.env,
  VAEXCORE_CONFIG_DIR: configDir,
  DATABASE_URL: databaseUrl
};

delete env.ELECTRON_RUN_AS_NODE;

console.log(`Using vaexcore console app config: ${configDir}`);
console.log("Starting live bot runtime. Keep this terminal open while vaexcore console is live.");

const child = spawn(
  process.execPath,
  [join(root, "node_modules/tsx/dist/cli.mjs"), "src/index.ts"],
  {
    cwd: root,
    env,
    stdio: "inherit"
  }
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

function defaultAppConfigDir() {
  if (platform() === "darwin") {
    const legacyConfigDir = join(homedir(), "Library/Application Support/VaexCore");
    return existsSync(legacyConfigDir)
      ? legacyConfigDir
      : join(homedir(), "Library/Application Support/vaexcore console");
  }

  if (platform() === "win32") {
    const appDataDir = process.env.APPDATA || join(homedir(), "AppData/Roaming");
    const legacyConfigDir = join(appDataDir, "VaexCore");
    return existsSync(legacyConfigDir)
      ? legacyConfigDir
      : join(appDataDir, "vaexcore console");
  }

  const baseConfigDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const legacyConfigDir = join(baseConfigDir, "VaexCore");
  return existsSync(legacyConfigDir)
    ? legacyConfigDir
    : join(baseConfigDir, "vaexcore console");
}
