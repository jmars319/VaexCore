import { PermissionLevel } from "../../core/permissions";
import type { CommandRouter } from "../../core/commandRouter";
import type { GiveawaysService } from "./giveaways.service";

type RegisterGiveawayCommandsOptions = {
  router: CommandRouter;
  service: GiveawaysService;
};

export const registerGiveawayCommands = ({
  router,
  service
}: RegisterGiveawayCommandsOptions) => {
  router.register("enter", PermissionLevel.Viewer, ({ event }) => {
    const result = service.enter(event, "enter");

    if (result.status === "entered") {
      return;
    }

    if (result.status === "duplicate") {
      return;
    }
  });

  router.register("gstart", PermissionLevel.Moderator, ({ event, rawArgs, reply }) => {
    const options = parseOptions(rawArgs);
    const winnerCount = parsePositiveInteger(options.codes);
    const keyword = options.keyword?.replace(/^!/, "").toLowerCase();

    if (!winnerCount || !keyword) {
      reply('Usage: !gstart codes=6 keyword=enter title="IOI code giveaway"');
      return;
    }

    const giveaway = service.start({
      actor: event,
      winnerCount,
      keyword,
      title: options.title ?? "Untitled giveaway"
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
      `Giveaway #${status.giveaway.id} is ${status.giveaway.status}: ${status.entries} entries, ${status.activeWinners}/${status.giveaway.winner_count} winners, ${status.rerolledWinners} rerolled.`
    );
  });

  router.register("gclose", PermissionLevel.Moderator, ({ event, reply }) => {
    const giveaway = service.close(event);
    reply(`Giveaway closed: ${giveaway.title}.`);
  });

  router.register("gdraw", PermissionLevel.Moderator, ({ event, args, reply }) => {
    const requestedCount = args[0] ? parsePositiveInteger(args[0]) : undefined;
    const result = service.draw(event, requestedCount);

    if (result.winners.length === 0) {
      reply("No eligible winners available.");
      return;
    }

    reply(
      `Winner${result.winners.length === 1 ? "" : "s"}: ${result.winners
        .map((winner) => winner.display_name)
        .join(", ")}`
    );
  });

  router.register("greroll", PermissionLevel.Moderator, ({ event, args, reply }) => {
    const username = args[0];

    if (!username) {
      reply("Usage: !greroll username");
      return;
    }

    const result = service.reroll(event, username);

    if (!result.replacement) {
      reply(`${result.rerolled.display_name} was rerolled. No eligible replacement remains.`);
      return;
    }

    reply(
      `${result.rerolled.display_name} was rerolled. Replacement: ${result.replacement.display_name}.`
    );
  });

  router.register("gend", PermissionLevel.Moderator, ({ event, reply }) => {
    const giveaway = service.end(event);
    reply(`Giveaway ended: ${giveaway.title}.`);
  });
};

const parsePositiveInteger = (value: string | undefined) => {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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
