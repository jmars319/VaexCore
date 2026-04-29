export type RuntimeStatus = {
  mode: "local" | "live";
  eventSubConnected: boolean;
  chatSubscriptionActive: boolean;
  messageQueueReady: boolean;
  outboundHealthy: boolean;
  liveChatConfirmed: boolean;
  firstChatReceived: boolean;
  sessionId?: string;
};

export const createRuntimeStatus = (mode: RuntimeStatus["mode"]): RuntimeStatus => ({
  mode,
  eventSubConnected: mode === "local",
  chatSubscriptionActive: mode === "local",
  messageQueueReady: false,
  outboundHealthy: true,
  liveChatConfirmed: mode === "local",
  firstChatReceived: mode === "local"
});
