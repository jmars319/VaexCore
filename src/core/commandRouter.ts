import type { Logger } from "./logger";
import type { ChatMessage } from "./chatMessage";
import { hasPermission, PermissionLevel } from "./permissions";

type CommandRouterOptions = {
  prefix: string;
  logger: Logger;
  enqueueMessage: (message: string) => void;
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

export class CommandRouter {
  private readonly commands = new Map<string, RegisteredCommand>();

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

  async handle(message: ChatMessage) {
    const text = message.text.trim();

    if (!text.startsWith(this.options.prefix)) {
      return;
    }

    const commandText = text.slice(this.options.prefix.length).trim();
    const [rawName, ...args] = commandText.split(/\s+/);
    const name = rawName?.toLowerCase();

    if (!name) {
      return;
    }

    const command = this.commands.get(name);

    if (!command) {
      this.options.logger.debug({ command: name }, "Unknown command ignored");
      return;
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
      return;
    }

    this.options.logger.info(
      {
        command: name,
        userLogin: message.userLogin,
        source: message.source
      },
      "Command allowed"
    );

    const rawArgs = commandText.slice(name.length).trim();
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
  }
}
