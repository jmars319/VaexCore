import type { ChatMessage } from "./chatMessage";

export enum PermissionLevel {
  Viewer = "viewer",
  Moderator = "moderator",
  Broadcaster = "broadcaster",
  Admin = "admin"
}

const permissionRank: Record<PermissionLevel, number> = {
  [PermissionLevel.Viewer]: 0,
  [PermissionLevel.Moderator]: 1,
  [PermissionLevel.Broadcaster]: 2,
  [PermissionLevel.Admin]: 3
};

export const getPermissionLevel = (message: ChatMessage): PermissionLevel => {
  if (message.isBroadcaster) {
    return PermissionLevel.Admin;
  }

  if (message.isMod) {
    return PermissionLevel.Moderator;
  }

  return PermissionLevel.Viewer;
};

export const hasPermission = (
  message: ChatMessage,
  requiredLevel: PermissionLevel
) => permissionRank[getPermissionLevel(message)] >= permissionRank[requiredLevel];
