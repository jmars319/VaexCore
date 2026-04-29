export type ChatSource = "eventsub" | "local";

export type ChatMessage = {
  id?: string;
  text: string;
  userId: string;
  userLogin: string;
  userDisplayName: string;
  broadcasterUserId: string;
  badges: string[];
  isBroadcaster: boolean;
  isMod: boolean;
  isVip: boolean;
  isSubscriber: boolean;
  source: ChatSource;
  receivedAt: Date;
};
