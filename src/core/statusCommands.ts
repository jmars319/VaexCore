import { PermissionLevel } from "./permissions";
import type { CommandRouter } from "./commandRouter";
import type { RuntimeStatus } from "./runtimeStatus";
import type { GiveawaysService } from "../modules/giveaways/giveaways.service";

type RegisterStatusCommandsOptions = {
  router: CommandRouter;
  runtimeStatus: RuntimeStatus;
  giveawaysService: GiveawaysService;
};

export const registerStatusCommands = ({
  router,
  runtimeStatus,
  giveawaysService
}: RegisterStatusCommandsOptions) => {
  router.register("vcstatus", PermissionLevel.Moderator, ({ reply }) => {
    const giveaway = giveawaysService.status()?.giveaway.status ?? "none";
    reply(
      `VaexCore ${runtimeStatus.mode}: eventsub=${yesNo(
        runtimeStatus.eventSubConnected
      )}, sub=${yesNo(runtimeStatus.chatSubscriptionActive)}, queue=${yesNo(
        runtimeStatus.messageQueueReady
      )}, giveaway=${giveaway}`
    );
  });
};

const yesNo = (value: boolean) => (value ? "yes" : "no");
