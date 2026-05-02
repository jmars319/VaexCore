import { cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const source = resolve("desktop/shared/src/setup/ui");
const sharedAssets = resolve("desktop/shared/assets");
const destination = resolve("dist-bundle/setup-ui");

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });
cpSync(resolve(sharedAssets, "logo.jpg"), resolve(destination, "logo.jpg"));
