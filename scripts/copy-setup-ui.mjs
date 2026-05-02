import { cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const source = resolve("desktop/shared/src/setup/ui");
const destination = resolve("dist-bundle/setup-ui");

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });
