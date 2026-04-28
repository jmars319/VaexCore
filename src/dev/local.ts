import "dotenv/config";
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { z } from "zod";
import { createLogger } from "../core/logger";
import { CommandRouter } from "../core/commandRouter";
import { MessageQueue } from "../core/messageQueue";
import type { ChatMessageEvent } from "../twitch/types";

const localEnvSchema = z.object({
  COMMAND_PREFIX: z.string().min(1).default("!"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info")
});

const env = localEnvSchema.parse(process.env);
const logger = createLogger(env.LOG_LEVEL);

const messageQueue = new MessageQueue({
  logger,
  send: async (message) => {
    console.log(`[queued outbound] ${message}`);
  }
});

const commandRouter = new CommandRouter({
  prefix: env.COMMAND_PREFIX,
  logger,
  enqueueMessage: (message) => messageQueue.enqueue(message)
});

messageQueue.start();

const rl = createInterface({ input, output });

const shutdown = async () => {
  messageQueue.stop();
  rl.close();
};

process.on("SIGINT", () => {
  void shutdown();
});

console.log("VaexCore local command mode");
console.log(`Type chat messages and press Enter. Current live command: ${env.COMMAND_PREFIX}ping`);

if (input.isTTY) {
  rl.setPrompt("> ");
  rl.prompt();
}

for await (const text of rl) {
  if (text === "/quit" || text === "/exit") {
    break;
  }

  const event: ChatMessageEvent = {
    broadcasterUserId: "local-broadcaster",
    broadcasterLogin: "local",
    broadcasterName: "Local",
    chatterUserId: "local-chatter",
    chatterLogin: "localuser",
    chatterName: "LocalUser",
    messageId: crypto.randomUUID(),
    text,
    badges: []
  };

  await commandRouter.handle(event);

  if (input.isTTY) {
    rl.prompt();
  }
}

await shutdown();
