import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronCli = resolve(root, "node_modules/electron/cli.js");

if (!existsSync(electronCli)) {
  throw new Error("Electron CLI was not found. Run npm install first.");
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const result = spawnSync(
  process.execPath,
  [electronCli, ...(process.argv.slice(2).length ? process.argv.slice(2) : ["."])],
  {
    cwd: root,
    env,
    stdio: "inherit"
  }
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 0);
