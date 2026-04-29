import "dotenv/config";
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { z } from "zod";
import { createLogger } from "../core/logger";
import { CommandRouter } from "../core/commandRouter";
import { MessageQueue } from "../core/messageQueue";
import type { ChatMessageEvent } from "../twitch/types";
import { createDbClient } from "../db/client";
import { registerGiveawaysModule } from "../modules/giveaways/giveaways.module";

const localEnvSchema = z.object({
  COMMAND_PREFIX: z.string().min(1).default("!"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  LOCAL_DATABASE_URL: z.string().min(1).default(":memory:")
});

const env = localEnvSchema.parse(process.env);
const logger = createLogger(env.LOG_LEVEL);

const parseLocalLine = (line: string) => {
  const match = /^(?<speaker>[A-Za-z0-9_]+):\s*(?<message>.*)$/.exec(line);
  const speaker = match?.groups?.speaker ?? "broadcaster";
  const message = match?.groups?.message ?? line;
  const normalized = speaker.toLowerCase();

  if (normalized === "mod") {
    return {
      userId: "local-mod",
      login: "mod",
      displayName: "Mod",
      message,
      badges: [{ set_id: "moderator", id: "1", info: "" }]
    };
  }

  if (normalized === "broadcaster") {
    return {
      userId: "local-broadcaster",
      login: "broadcaster",
      displayName: "Broadcaster",
      message,
      badges: [{ set_id: "broadcaster", id: "1", info: "" }]
    };
  }

  return {
    userId: `local-${normalized}`,
    login: normalized,
    displayName: speaker,
    message,
    badges: []
  };
};

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

const db = createDbClient(env.LOCAL_DATABASE_URL);
registerGiveawaysModule({
  router: commandRouter,
  db
});

messageQueue.start();

const rl = createInterface({ input, output });

const shutdown = async () => {
  messageQueue.stop();
  db.close();
  rl.close();
};

process.on("SIGINT", () => {
  void shutdown();
});

console.log("VaexCore local command mode");
console.log(`Type chat messages and press Enter. Current live commands: ${env.COMMAND_PREFIX}ping, ${env.COMMAND_PREFIX}enter, ${env.COMMAND_PREFIX}g*`);
console.log("Optional identity prefix: alice: !enter, mod: !gstatus, broadcaster: !gstart codes=6 keyword=enter");

if (input.isTTY) {
  rl.setPrompt("> ");
  rl.prompt();
}

for await (const text of rl) {
  if (text === "/quit" || text === "/exit") {
    break;
  }

  const parsed = parseLocalLine(text);
  const event: ChatMessageEvent = {
    broadcasterUserId: "local-broadcaster",
    broadcasterLogin: "local",
    broadcasterName: "Local",
    chatterUserId: parsed.userId,
    chatterLogin: parsed.login,
    chatterName: parsed.displayName,
    messageId: crypto.randomUUID(),
    text: parsed.message,
    badges: parsed.badges
  };

  await commandRouter.handle(event);

  if (input.isTTY) {
    rl.prompt();
  }
}

await shutdown();
