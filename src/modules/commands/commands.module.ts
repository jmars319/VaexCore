import type { CommandRouter } from "../../core/commandRouter";
import type { FeatureGateStore } from "../../core/featureGates";
import type { DbClient } from "../../db/client";
import { registerCustomCommands } from "./commands.commands";
import { CustomCommandsService } from "./commands.service";

type CommandsModuleOptions = {
  router: CommandRouter;
  db: DbClient;
  featureGates?: FeatureGateStore;
};

export const registerCommandsModule = ({ router, db, featureGates }: CommandsModuleOptions) => {
  const service = new CustomCommandsService(db, { featureGates });
  registerCustomCommands({ router, service });

  return service;
};
