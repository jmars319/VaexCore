import type { Logger } from "./logger";
import type { ChatMessage } from "./chatMessage";
import { hasPermission, PermissionLevel } from "./permissions";
import { limits, sanitizeCommandText } from "./security";

type CommandRouterOptions = {
  prefix: string;
  logger: Logger;
  enqueueMessage: (message: string) => void;
  perUserCooldownMs?: number;
  globalBurstLimit?: number;
  globalBurstWindowMs?: number;
};

type CommandHandler = (context: {
  message: ChatMessage;
  args: string[];
  rawArgs: string;
  reply: (message: string) => void;
}) => Promise<void> | void;

type RegisteredCommand = {
  permission: PermissionLevel;
  handler: CommandHandler;
};

export type CommandResult = "ignored" | "unknown" | "denied" | "handled";

export class CommandRouter {
  private readonly commands = new Map<string, RegisteredCommand>();
  private readonly lastUserCommandAt = new Map<string, number>();
  private readonly recentCommandTimes: number[] = [];

  constructor(private readonly options: CommandRouterOptions) {
    this.register("ping", PermissionLevel.Viewer, () => {
      this.options.enqueueMessage("pong");
    });
  }

  register(
    name: string,
    permission: PermissionLevel,
    handler: CommandHandler
  ) {
    this.commands.set(name.toLowerCase(), { permission, handler });
  }

  async handle(message: ChatMessage): Promise<CommandResult> {
    let text: string;

    try {
      text = sanitizeCommandText(message.text);
    } catch {
      this.options.logger.warn(
        { userLogin: message.userLogin, source: message.source },
        "Malformed command input ignored"
      );
      return "ignored";
    }

    if (!text.startsWith(this.options.prefix)) {
      return "ignored";
    }

    const commandText = text.slice(this.options.prefix.length).trim();
    const [rawName, ...args] = commandText.split(/\s+/);
    const name = rawName?.toLowerCase();

    if (!name) {
      return "ignored";
    }

    if (this.isRateLimited(message, name)) {
      return "denied";
    }

    const command = this.commands.get(name);

    if (!command) {
      this.options.logger.debug({ command: name }, "Unknown command ignored");
      return "unknown";
    }

    this.options.logger.info(
      {
        command: name,
        userLogin: message.userLogin,
        source: message.source
      },
      "Command received"
    );

    if (!hasPermission(message, command.permission)) {
      this.options.logger.warn(
        {
          command: name,
          userLogin: message.userLogin,
          requiredPermission: command.permission,
          source: message.source
        },
        "Command denied"
      );
      return "denied";
    }

    this.options.logger.info(
      {
        command: name,
        userLogin: message.userLogin,
        source: message.source
      },
      "Command allowed"
    );

    const rawArgs = commandText.slice(name.length).trim().slice(0, limits.commandLength);
    try {
      await command.handler({
        message,
        args,
        rawArgs,
        reply: (replyMessage) => this.options.enqueueMessage(replyMessage)
      });
    } catch (error) {
      const replyMessage = error instanceof Error ? error.message : "Command failed";
      this.options.logger.error(
        { error, command: name, userLogin: message.userLogin },
        "Command failed"
      );
      this.options.enqueueMessage(replyMessage);
    }

    return "handled";
  }

  private isRateLimited(message: ChatMessage, command: string) {
    const now = Date.now();
    const globalWindowMs = this.options.globalBurstWindowMs ?? 2000;
    const globalLimit = this.options.globalBurstLimit ?? 30;

    while (
      this.recentCommandTimes.length > 0 &&
      this.recentCommandTimes[0] !== undefined &&
      now - this.recentCommandTimes[0] > globalWindowMs
    ) {
      this.recentCommandTimes.shift();
    }

    if (this.recentCommandTimes.length >= globalLimit) {
      this.options.logger.warn({ command }, "Global command burst limit hit");
      return true;
    }

    const cooldownMs = command === "enter"
      ? Math.max(this.options.perUserCooldownMs ?? 750, 1500)
      : this.options.perUserCooldownMs ?? 750;
    const userKey = message.userId || message.userLogin;
    const last = this.lastUserCommandAt.get(userKey) ?? 0;

    if (now - last < cooldownMs) {
      this.options.logger.debug(
        { command, userLogin: message.userLogin },
        "Per-user command cooldown hit"
      );
      return true;
    }

    this.lastUserCommandAt.set(userKey, now);
    this.recentCommandTimes.push(now);
    return false;
  }
}
