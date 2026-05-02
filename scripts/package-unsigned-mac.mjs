import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, join, resolve } from "node:path";

const releaseDir = resolve("release");
const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const productName = packageJson.build?.productName ?? packageJson.name;
const artifactProductName = productName.replace(/\s+/g, "-");
const version = packageJson.version ?? "0.0.0";
const appPath = findSinglePackagedApp(releaseDir);
const artifactBase = `${artifactProductName}-${version}-mac-${process.arch}-unsigned`;
const zipPath = join(releaseDir, `${artifactBase}.zip`);
const checksumPath = join(releaseDir, `${artifactBase}.zip.sha256`);
const manifestPath = join(releaseDir, `${artifactBase}.json`);

if (process.platform !== "darwin") {
  throw new Error("Unsigned macOS app packaging must run on macOS.");
}

mkdirSync(releaseDir, { recursive: true });
rmSync(zipPath, { force: true });
rmSync(checksumPath, { force: true });
rmSync(manifestPath, { force: true });

execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
  stdio: "inherit"
});

execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath], {
  stdio: "inherit"
});

const sha256 = await sha256File(zipPath);
const gitCommit = getGitCommit();

writeFileSync(checksumPath, `${sha256}  ${basename(zipPath)}\n`);
writeFileSync(
  manifestPath,
  `${JSON.stringify({
    productName,
    version,
    gitCommit,
    createdAt: new Date().toISOString(),
    releaseType: "unsigned-tester",
    platform: "darwin",
    arch: process.arch,
    notarized: false,
    signing: "ad-hoc",
    gatekeeper: "Unidentified developer warning is expected for testers.",
    app: relativeReleasePath(appPath),
    zip: relativeReleasePath(zipPath),
    sha256
  }, null, 2)}\n`
);

console.log(`unsigned macOS zip: ${relativeReleasePath(zipPath)}`);
console.log(`sha256: ${sha256}`);

function findSinglePackagedApp(dir) {
  const apps = findPackagedApps(dir);

  if (apps.length !== 1) {
    throw new Error(`Expected one packaged ${productName}.app under release/, found ${apps.length}. Run npm run app:build first.`);
  }

  return apps[0];
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

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function getGitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8"
    }).trim();
  } catch {
    return "unknown";
  }
}

function relativeReleasePath(path) {
  return path.replace(`${process.cwd()}/`, "");
}
