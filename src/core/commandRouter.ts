import type { Logger } from "./logger";
import type { ChatMessageEvent } from "../twitch/types";
import { hasPermission, PermissionLevel } from "./permissions";

type CommandRouterOptions = {
  prefix: string;
  logger: Logger;
  enqueueMessage: (message: string) => void;
};

type CommandHandler = (context: {
  event: ChatMessageEvent;
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

  async handle(event: ChatMessageEvent) {
    const text = event.text.trim();

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

    if (!hasPermission(event, command.permission)) {
      this.options.logger.warn(
        {
          command: name,
          chatter: event.chatterLogin,
          requiredPermission: command.permission
        },
        "Command denied"
      );
      return;
    }

    this.options.logger.info(
      { command: name, chatter: event.chatterLogin },
      "Command received"
    );

    const rawArgs = commandText.slice(name.length).trim();
    try {
      await command.handler({
        event,
        args,
        rawArgs,
        reply: (message) => this.options.enqueueMessage(message)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Command failed";
      this.options.logger.error(
        { error, command: name, chatter: event.chatterLogin },
        "Command failed"
      );
      this.options.enqueueMessage(message);
    }
  }
}
