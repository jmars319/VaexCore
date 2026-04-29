import { PermissionLevel } from "../../core/permissions";
import type { CommandRouter } from "../../core/commandRouter";
import type { RuntimeStatus } from "../../core/runtimeStatus";
import {
  limits,
  normalizeKeyword,
  normalizeLogin,
  parseSafeInteger,
  sanitizeGiveawayTitle
} from "../../core/security";
import type { GiveawaysService } from "./giveaways.service";

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
      'Giveaway: !gstart codes=6 keyword=enter title="..." | !gclose | !gdraw 6 | !greroll user | !gclaim user | !gdeliver user | !gend'
    );
  });

  router.register("enter", PermissionLevel.Viewer, ({ message }) => {
    if (!message.userId || !message.userLogin) {
      return;
    }

    const result = service.enter(message, "enter");

    if (result.status === "entered") {
      return;
    }

    if (result.status === "duplicate") {
      return;
    }
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

    reply(
      `Giveaway started: ${giveaway.title}. Type !${giveaway.keyword} to enter. Winners: ${giveaway.winner_count}.`
    );
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
    reply(`Giveaway closed: ${giveaway.title}.`);
  });

  router.register("gdraw", PermissionLevel.Moderator, ({ message, args, reply }) => {
    const allowOpen = args.includes("--allow-open");
    const countArg = args.find((arg) => !arg.startsWith("--"));
    const requestedCount = countArg ? parsePositiveInteger(countArg) : undefined;
    const result = service.draw(message, requestedCount, { allowOpen });

    if (result.winners.length === 0) {
      reply("No eligible winners available.");
      return;
    }

    const partial =
      result.winners.length < result.requestedCount
        ? ` (only ${result.winners.length}/${result.requestedCount} eligible)`
        : "";

    reply(
      `Winner${result.winners.length === 1 ? "" : "s"}${partial}: ${result.winners
        .map((winner) => winner.display_name)
        .join(", ")}`
    );
  });

  router.register("greroll", PermissionLevel.Moderator, ({ message, args, reply }) => {
    const username = args[0] ? normalizeLogin(args[0]) : undefined;

    if (!username) {
      reply("Usage: !greroll username");
      return;
    }

    const result = service.reroll(message, username);

    if (!result.replacement) {
      reply(`${result.rerolled.display_name} was rerolled. No eligible replacement remains.`);
      return;
    }

    reply(
      `${result.rerolled.display_name} was rerolled. Replacement: ${result.replacement.display_name}.`
    );
  });

  router.register("gclaim", PermissionLevel.Moderator, ({ message, args, reply }) => {
    const username = args[0] ? normalizeLogin(args[0]) : undefined;

    if (!username) {
      reply("Usage: !gclaim username");
      return;
    }

    const result = service.claim(message, username);
    reply(`${result.winner.display_name} marked claimed.`);
  });

  router.register("gdeliver", PermissionLevel.Moderator, ({ message, args, reply }) => {
    const username = args[0] ? normalizeLogin(args[0]) : undefined;

    if (!username) {
      reply("Usage: !gdeliver username");
      return;
    }

    const result = service.deliver(message, username);
    reply(`${result.winner.display_name} marked delivered.`);
  });

  router.register("gend", PermissionLevel.Moderator, ({ message, reply }) => {
    const giveaway = service.end(message);
    reply(`Giveaway ended: ${giveaway.title}.`);
  });
};

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
