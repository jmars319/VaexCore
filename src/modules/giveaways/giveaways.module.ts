import type { CommandRouter } from "../../core/commandRouter";
import type { DbClient } from "../../db/client";
import { registerGiveawayCommands } from "./giveaways.commands";
import { GiveawaysService } from "./giveaways.service";

type GiveawaysModuleOptions = {
  router: CommandRouter;
  db: DbClient;
};

export const registerGiveawaysModule = ({ router, db }: GiveawaysModuleOptions) => {
  const service = new GiveawaysService(db);
  registerGiveawayCommands({ router, service });

  return service;
};
