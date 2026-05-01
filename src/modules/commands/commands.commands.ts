import type { CommandRouter } from "../../core/commandRouter";
import type { CustomCommandsService } from "./commands.service";

type RegisterCustomCommandsOptions = {
  router: CommandRouter;
  service: CustomCommandsService;
};

export const registerCustomCommands = ({
  router,
  service
}: RegisterCustomCommandsOptions) => {
  router.registerFallback((context) => service.handle(context));
};
