import { formatEnvError, loadEnv } from "../config/env";
import { execFileSync } from "node:child_process";

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

  console.log("VaexCore environment check passed.");
  console.log(`- git repository present: ${gitReady}`);
  if (!gitReady) {
    console.log("  Git was not initialized automatically. See README Git Hygiene.");
  }
  console.log(`- mode: ${env.mode}`);
  console.log(`- database URL present: ${Boolean(env.databaseUrl)}`);

  if (env.mode === "live") {
    console.log(`- bot user ID present: ${Boolean(env.twitchBotUserId)}`);
    console.log(`- broadcaster ID present: ${Boolean(env.twitchBroadcasterUserId)}`);
    console.log("- required Twitch scopes: user:read:chat user:write:chat");
    console.log(
      "  Scope ownership cannot be verified offline; Twitch will confirm scopes during live startup."
    );
  } else {
    console.log("- local readiness: Twitch credentials are not required.");
    console.log("- use npm run dev:local for fake users and stdin command testing.");
  }
} catch (error) {
  console.error("VaexCore environment check failed:");
  console.error(formatEnvError(error));
  process.exitCode = 1;
}
