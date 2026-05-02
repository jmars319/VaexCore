import type { CommandRouter } from "../../core/commandRouter";
import type { Logger } from "../../core/logger";
import type { RuntimeStatus } from "../../core/runtimeStatus";
import type { DbClient } from "../../db/client";
import { registerGiveawayCommands } from "./giveaways.commands";
import { GiveawaysService } from "./giveaways.service";
import { createGiveawayTemplateStore } from "./giveaways.templates";

type GiveawaysModuleOptions = {
  router: CommandRouter;
  db: DbClient;
  logger: Logger;
  runtimeStatus?: RuntimeStatus;
};

export const registerGiveawaysModule = ({
  router,
  db,
  logger,
  runtimeStatus
}: GiveawaysModuleOptions) => {
  const service = new GiveawaysService({ db, logger });
  const templates = createGiveawayTemplateStore(db);
  registerGiveawayCommands({ router, service, runtimeStatus, messages: templates });

  return service;
};
