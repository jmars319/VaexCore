import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const releaseDir = resolve("release");
const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const productName = packageJson.build?.productName ?? packageJson.name;
const version = packageJson.version ?? "0.0.0";
const artifactBase = `${productName}-${version}-mac-${process.arch}-unsigned`;
const zipPath = join(releaseDir, `${artifactBase}.zip`);
const checksumPath = join(releaseDir, `${artifactBase}.zip.sha256`);
const manifestPath = join(releaseDir, `${artifactBase}.json`);
const appPath = findSinglePackagedApp(releaseDir);

if (process.platform !== "darwin") {
  throw new Error("Unsigned macOS release smoke must run on macOS.");
}

assert(existsSync(zipPath), "unsigned zip exists");
assert(existsSync(checksumPath), "checksum exists");
assert(existsSync(manifestPath), "manifest exists");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert(manifest.productName === productName, "manifest product name matches");
assert(manifest.version === version, "manifest version matches");
assert(manifest.gitCommit === currentCommit, "manifest points to current full git commit");
assert(/^[0-9a-f]{40}$/.test(manifest.gitCommit), "manifest uses a full git commit SHA");
assert(manifest.releaseType === "unsigned-tester", "manifest marks unsigned tester release type");
assert(manifest.notarized === false, "manifest marks app as not notarized");
assert(manifest.signing === "ad-hoc", "manifest marks ad-hoc signing");

const actualSha = await sha256File(zipPath);
const checksum = readFileSync(checksumPath, "utf8").trim();
assert(checksum === `${actualSha}  ${basename(zipPath)}`, "checksum file matches zip");
assert(manifest.sha256 === actualSha, "manifest checksum matches zip");

execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
  stdio: "inherit"
});

const listing = execFileSync("unzip", ["-l", zipPath], { encoding: "utf8" });
assert(listing.includes(`${productName}.app/Contents/MacOS/${productName}`), "zip contains app executable");
assert(listing.includes(`${productName}.app/Contents/Resources/app/dist-bundle/setup-server.js`), "zip contains setup server bundle");
assert(listing.includes(`${productName}.app/Contents/Resources/app/dist-bundle/setup-ui/app.js`), "zip contains setup UI app asset");
assert(listing.includes(`${productName}.app/Contents/Resources/app/dist-bundle/setup-ui/styles.css`), "zip contains setup UI styles");
assert(listing.includes(`${productName}.app/Contents/Resources/app/node_modules/better-sqlite3/`), "zip contains better-sqlite3 module");

const plistPath = join(appPath, "Contents/Info.plist");
const bundleName = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleName", plistPath], {
  encoding: "utf8"
}).trim();
assert(bundleName === productName, "Info.plist bundle name matches");

console.log("unsigned release smoke passed");

function findSinglePackagedApp(dir) {
  const apps = findPackagedApps(dir);

  if (apps.length !== 1) {
    throw new Error(`Expected one packaged ${productName}.app under release/, found ${apps.length}. Run npm run app:zip first.`);
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Smoke failed: ${message}`);
  }
}
