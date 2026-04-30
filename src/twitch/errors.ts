export const explainTwitchHttpError = async (
  response: Response,
  context: "eventsub_chat_subscription" | "send_chat_message",
  alreadyReadBody?: string
) => {
  const body = alreadyReadBody ?? await response.text();
  const hint = getHint(response.status, context);

  return new Error(`${hint}\nTwitch response: ${response.status} ${body}`);
};

const getHint = (
  status: number,
  context: "eventsub_chat_subscription" | "send_chat_message"
) => {
  if (context === "eventsub_chat_subscription") {
    if (status === 401 || status === 403) {
      return [
        "Failed to create EventSub chat subscription.",
        "Check that TWITCH_USER_ACCESS_TOKEN is a bot user access token with user:read:chat.",
        "Also verify TWITCH_CLIENT_ID matches the token, TWITCH_BOT_USER_ID is the token owner, and TWITCH_BROADCASTER_USER_ID is the channel owner."
      ].join(" ");
    }

    return "Failed to create EventSub chat subscription.";
  }

  if (status === 401 || status === 403) {
    return [
      "Failed to send Twitch chat message.",
      "Check that TWITCH_USER_ACCESS_TOKEN is a bot user access token with user:write:chat.",
      "Also verify TWITCH_BOT_USER_ID is the sender ID for that token."
    ].join(" ");
  }

  if (status === 429) {
    return "Twitch rejected the outbound chat message for rate limiting. VaexCore queues at 1 message per second, but Twitch may apply broader account or channel limits.";
  }

  return "Failed to send Twitch chat message.";
};
