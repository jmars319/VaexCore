import { PermissionLevel } from "../core/permissions";
import type { CommandRouter } from "../core/commandRouter";
import type { Logger } from "../core/logger";
import {
  loadStudioIntegrationConfig,
  StudioClient
} from "./client";
import { sanitizeText } from "../core/security";

type RegisterStudioCommandsOptions = {
  router: CommandRouter;
  logger: Logger;
};

export const registerStudioCommands = ({
  router,
  logger
}: RegisterStudioCommandsOptions) => {
  const config = loadStudioIntegrationConfig();
  const client = new StudioClient(config);

  router.register("vcstudio", PermissionLevel.Moderator, async ({ reply }) => {
    if (!config.enabled) {
      reply("Studio integration is off. Set VAEXCORE_STUDIO_INTEGRATION=true to enable it.");
      return;
    }

    try {
      const health = await client.health();
      reply(`Studio connected: ${health.service} ${health.version}`);
    } catch (error) {
      logger.warn({ error }, "Studio health check failed");
      reply("Studio is not reachable from vaexcore console.");
    }
  });

  router.register("vcmark", PermissionLevel.Moderator, async ({
    message,
    rawArgs,
    reply
  }) => {
    if (!config.enabled) {
      reply("Studio marker integration is off.");
      return;
    }

    const label = markerLabel(rawArgs, message.userDisplayName);

    try {
      await client.createMarker(label);
      reply(`Studio marker created: ${label}`);
    } catch (error) {
      logger.warn({ error, label }, "Studio marker creation failed");
      reply("Studio marker could not be created.");
    }
  });
};

const markerLabel = (rawArgs: string, displayName: string) => {
  const fallback = `chat marker from ${displayName}`;
  return sanitizeText(rawArgs || fallback, {
    field: "Studio marker label",
    maxLength: 120,
    required: true
  });
};
