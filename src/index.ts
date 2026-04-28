import { formatEnvError, loadEnv } from "./config/env";
import { createLogger } from "./core/logger";
import { VaexCoreBot } from "./core/bot";

let env: ReturnType<typeof loadEnv>;

try {
  env = loadEnv();
} catch (error) {
  console.error("VaexCore could not start because .env is invalid:");
  console.error(formatEnvError(error));
  process.exit(1);
}

const logger = createLogger(env.logLevel);

const bot = new VaexCoreBot({ env, logger });

const shutdown = async (signal: NodeJS.Signals) => {
  logger.info({ signal }, "Shutting down VaexCore");
  await bot.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await bot.start();
} catch (error) {
  logger.error({ error }, "VaexCore failed during startup");
  await bot.stop();
  process.exit(1);
}
