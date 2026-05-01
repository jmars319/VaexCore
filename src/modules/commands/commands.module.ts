import type { CommandRouter } from "../../core/commandRouter";
import type { DbClient } from "../../db/client";
import { registerCustomCommands } from "./commands.commands";
import { CustomCommandsService } from "./commands.service";

type CommandsModuleOptions = {
  router: CommandRouter;
  db: DbClient;
};

export const registerCommandsModule = ({ router, db }: CommandsModuleOptions) => {
  const service = new CustomCommandsService(db);
  registerCustomCommands({ router, service });

  return service;
};
