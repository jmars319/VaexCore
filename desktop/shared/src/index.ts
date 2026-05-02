import { formatEnvError, loadEnv } from "./config/env";
import { createLogger } from "./core/logger";
import { ConsoleBot } from "./core/bot";

let env: ReturnType<typeof loadEnv>;

try {
  env = loadEnv();
} catch (error) {
  console.error("vaexcore console could not start because .env is invalid:");
  console.error(formatEnvError(error));
  process.exit(1);
}

const logger = createLogger(env.logLevel);

if (env.mode !== "live") {
  logger.error(
    { mode: env.mode },
    "npm run dev starts the live Twitch bot. Use npm run dev:local for local mode."
  );
  process.exit(1);
}

const bot = new ConsoleBot({ env, logger });

const shutdown = async (signal: NodeJS.Signals) => {
  logger.info({ signal }, "Shutting down vaexcore console");
  await bot.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await bot.start();
} catch (error) {
  logger.error({ error }, "vaexcore console failed during startup");
  await bot.stop();
  process.exit(1);
}
