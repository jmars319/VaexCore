import type { CommandRouter } from "../../core/commandRouter";
import type { Logger } from "../../core/logger";
import type { DbClient } from "../../db/client";
import { registerGiveawayCommands } from "./giveaways.commands";
import { GiveawaysService } from "./giveaways.service";

type GiveawaysModuleOptions = {
  router: CommandRouter;
  db: DbClient;
  logger: Logger;
};

export const registerGiveawaysModule = ({ router, db, logger }: GiveawaysModuleOptions) => {
  const service = new GiveawaysService({ db, logger });
  registerGiveawayCommands({ router, service });

  return service;
};
