import { formatEnvError, loadEnv } from "../config/env";

try {
  const env = loadEnv();

  console.log("VaexCore environment check passed.");
  console.log(`- bot user ID present: ${Boolean(env.twitchBotUserId)}`);
  console.log(`- broadcaster ID present: ${Boolean(env.twitchBroadcasterUserId)}`);
  console.log(`- database URL present: ${Boolean(env.databaseUrl)}`);
  console.log("- required Twitch scopes: user:read:chat user:write:chat");
  console.log(
    "  Scope ownership cannot be verified offline; Twitch will confirm scopes during live startup."
  );
} catch (error) {
  console.error("VaexCore environment check failed:");
  console.error(formatEnvError(error));
  process.exitCode = 1;
}
