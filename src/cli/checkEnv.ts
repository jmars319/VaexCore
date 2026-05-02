import { formatEnvError, loadEnv } from "../config/env";
import { getLocalSecretsPath } from "../config/localSecrets";
import { resolveDatabasePath } from "../db/client";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const isGitRepo = () => {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
};

try {
  const env = loadEnv();
  const gitReady = isGitRepo();

  console.log("vaexcore console environment check passed.");
  console.log(`- app version: ${getPackageVersion()}`);
  console.log(`- runtime: cli`);
  console.log(`- git repository present: ${gitReady}`);
  if (!gitReady) {
    console.log("  Git was not initialized automatically. See README Git Hygiene.");
  }
  console.log(`- mode: ${env.mode}`);
  console.log(`- database URL present: ${Boolean(env.databaseUrl)}`);
  console.log(`- database path: ${resolveDatabasePath(env.databaseUrl)}`);
  console.log(`- local config path: ${getLocalSecretsPath()}`);

  if (env.mode === "live") {
    console.log(`- bot user ID present: ${Boolean(env.twitchBotUserId)}`);
    console.log(`- broadcaster ID present: ${Boolean(env.twitchBroadcasterUserId)}`);
    console.log(
      `- token auto-refresh: ${env.twitchAutoRefreshAvailable ? "available" : "not configured"}`
    );
    if (env.twitchSecretsBootstrapped) {
      console.log("- local OAuth store updated from refresh-capable configuration.");
    }
    if (!env.twitchAutoRefreshAvailable) {
      console.log(
        "  Add TWITCH_CLIENT_SECRET and TWITCH_REFRESH_TOKEN, or use Settings -> Setup Guide, so CLI startup can refresh expired Twitch access tokens."
      );
    }
    console.log("- required Twitch scopes: user:read:chat user:write:chat");
    console.log(
      "  Scope ownership cannot be verified offline; Twitch will confirm scopes during live startup."
    );
  } else {
    console.log("- local readiness: Twitch credentials are not required.");
    console.log("- use npm run dev:local for fake users and stdin command testing.");
  }
} catch (error) {
  console.error("vaexcore console environment check failed:");
  console.error(formatEnvError(error));
  process.exitCode = 1;
}

function getPackageVersion() {
  try {
    const parsed = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      version?: string;
    };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
