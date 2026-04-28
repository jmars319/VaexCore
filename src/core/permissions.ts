import type { ChatMessageEvent } from "../twitch/types";

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

export const getPermissionLevel = (event: ChatMessageEvent): PermissionLevel => {
  if (event.chatterUserId === event.broadcasterUserId) {
    return PermissionLevel.Admin;
  }

  if (event.badges.some((badge) => badge.set_id === "broadcaster")) {
    return PermissionLevel.Admin;
  }

  if (event.badges.some((badge) => badge.set_id === "moderator")) {
    return PermissionLevel.Moderator;
  }

  return PermissionLevel.Viewer;
};

export const hasPermission = (
  event: ChatMessageEvent,
  requiredLevel: PermissionLevel
) => permissionRank[getPermissionLevel(event)] >= permissionRank[requiredLevel];
