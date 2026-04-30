import { PermissionLevel } from "../../core/permissions";
import type { CommandRouter } from "../../core/commandRouter";
import type { MessageQueueMetadata } from "../../core/messageQueue";
import type { RuntimeStatus } from "../../core/runtimeStatus";
import {
  limits,
  normalizeKeyword,
  normalizeLogin,
  parseSafeInteger,
  sanitizeGiveawayTitle
} from "../../core/security";
import type { GiveawaysService } from "./giveaways.service";
import {
  giveawayClosedMessage,
  giveawayDrawMessage,
  giveawayDuplicateEntryMessage,
  giveawayEndMessage,
  giveawayEntryMessage,
  giveawayRerollMessage,
  giveawayStartMessage
} from "./giveaways.messages";

type RegisterGiveawayCommandsOptions = {
  router: CommandRouter;
  service: GiveawaysService;
  runtimeStatus?: RuntimeStatus;
};

export const registerGiveawayCommands = ({
  router,
  service,
  runtimeStatus
}: RegisterGiveawayCommandsOptions) => {
  router.register("ghelp", PermissionLevel.Moderator, ({ reply }) => {
    reply(
      'Giveaway: !gstart codes=6 keyword=enter title="..." | viewers enter with !keyword | !gclose | !gdraw 6 | !greroll user | !gclaim user | !gdeliver user | !gend'
    );
  });

  router.register("enter", PermissionLevel.Viewer, ({ message, reply }) => {
    handleEntryCommand({ message, keyword: "enter", reply, service });
  });

  router.registerFallback(({ message, name, reply }) => {
    const status = service.status();

    if (!status || status.giveaway.status !== "open" || name !== status.giveaway.keyword) {
      return false;
    }

    handleEntryCommand({ message, keyword: name, reply, service });
    return true;
  });

  router.register("gstart", PermissionLevel.Moderator, ({ message, rawArgs, reply }) => {
    if (
      runtimeStatus?.mode === "live" &&
      (!runtimeStatus.eventSubConnected || !runtimeStatus.chatSubscriptionActive)
    ) {
      reply("Bot not ready");
      return;
    }

    const options = parseOptions(rawArgs);
    const winnerCount = parsePositiveInteger(options.codes);
    const keyword = options.keyword ? normalizeKeyword(options.keyword) : undefined;

    if (!winnerCount || !keyword) {
      reply('Usage: !gstart codes=6 keyword=enter title="IOI code giveaway"');
      return;
    }

    const giveaway = service.start({
      actor: message,
      winnerCount,
      keyword,
      title: sanitizeGiveawayTitle(options.title, "Untitled giveaway")
    });

    reply(giveawayStartMessage(giveaway), giveawayMessageMetadata("start", giveaway.id, "critical"));
  });

  router.register("gstatus", PermissionLevel.Moderator, ({ reply }) => {
    const status = service.status();

    if (!status) {
      reply("No active giveaway.");
      return;
    }

    reply(
      `G#${status.giveaway.id} ${status.giveaway.status}: ${status.entries} entries, ${status.activeWinners}/${status.giveaway.winner_count} winners.`
    );
  });

  router.register("gclose", PermissionLevel.Moderator, ({ message, reply }) => {
    const giveaway = service.close(message);
    reply(
      giveawayClosedMessage(giveaway, service.countEntriesForGiveaway(giveaway.id)),
      giveawayMessageMetadata("close", giveaway.id, "critical")
    );
  });

  router.register("gdraw", PermissionLevel.Moderator, ({ message, args, reply }) => {
    const allowOpen = args.includes("--allow-open");
    const countArg = args.find((arg) => !arg.startsWith("--"));
    const requestedCount = countArg ? parsePositiveInteger(countArg) : undefined;
    const result = service.draw(message, requestedCount, { allowOpen });

    reply(giveawayDrawMessage(result), giveawayMessageMetadata("draw", result.giveaway.id, "critical"));
  });

  router.register("greroll", PermissionLevel.Moderator, ({ message, args, reply }) => {
    const username = args[0] ? normalizeLogin(args[0]) : undefined;

    if (!username) {
      reply("Usage: !greroll username");
      return;
    }

    const result = service.reroll(message, username);

    reply(giveawayRerollMessage(result), giveawayMessageMetadata("reroll", result.giveaway.id, "important"));
  });

  router.register("gclaim", PermissionLevel.Moderator, ({ message, args, reply }) => {
    const username = args[0] ? normalizeLogin(args[0]) : undefined;

    if (!username) {
      reply("Usage: !gclaim username");
      return;
    }

    const result = service.claim(message, username);
    reply(`${result.winner.display_name} marked claimed.`, giveawayMessageMetadata("claim", result.giveaway.id));
  });

  router.register("gdeliver", PermissionLevel.Moderator, ({ message, args, reply }) => {
    const username = args[0] ? normalizeLogin(args[0]) : undefined;

    if (!username) {
      reply("Usage: !gdeliver username");
      return;
    }

    const result = service.deliver(message, username);
    reply(`${result.winner.display_name} marked delivered.`, giveawayMessageMetadata("deliver", result.giveaway.id));
  });

  router.register("gend", PermissionLevel.Moderator, ({ message, reply }) => {
    const giveaway = service.end(message);
    reply(
      giveawayEndMessage(giveaway, service.getWinnersForGiveaway(giveaway.id)),
      giveawayMessageMetadata("end", giveaway.id, "critical")
    );
  });
};

const handleEntryCommand = (input: {
  message: Parameters<GiveawaysService["enter"]>[0];
  keyword: string;
  reply: (message: string, metadata?: MessageQueueMetadata) => void;
  service: GiveawaysService;
}) => {
  if (!input.message.userId || !input.message.userLogin) {
    return;
  }

  const result = input.service.enter(input.message, input.keyword);

  if (result.status === "entered") {
    input.reply(giveawayEntryMessage({
      giveaway: result.giveaway,
      displayName: result.displayName,
      entryCount: result.entryCount
    }), giveawayMessageMetadata("entry", result.giveaway.id));
    return;
  }

  if (result.status === "duplicate") {
    input.reply(giveawayDuplicateEntryMessage({
      giveaway: result.giveaway,
      displayName: result.displayName,
      entryCount: result.entryCount
    }), giveawayMessageMetadata("duplicate-entry", result.giveaway.id));
  }
};

const giveawayMessageMetadata = (
  action: string,
  giveawayId: number,
  importance: MessageQueueMetadata["importance"] = "normal"
): MessageQueueMetadata => ({
  category: "giveaway",
  action,
  importance,
  giveawayId
});

const parsePositiveInteger = (value: string | undefined) => {
  if (!value) {
    return undefined;
  }

  return parseSafeInteger(value, {
    field: "Winner count",
    min: 1,
    max: limits.winnerCountMax
  });
};

const parseOptions = (rawArgs: string) => {
  const options: Record<string, string> = {};
  const pattern = /(\w+)=("([^"]*)"|'([^']*)'|(\S+))/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(rawArgs))) {
    const key = match[1];
    const value = match[3] ?? match[4] ?? match[5];

    if (key && value !== undefined) {
      options[key] = value;
    }
  }

  return options;
};
