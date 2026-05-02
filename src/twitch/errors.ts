export const explainTwitchHttpError = async (
  response: Response,
  context: TwitchHttpErrorContext,
  alreadyReadBody?: string
) => {
  const body = alreadyReadBody ?? await response.text();
  const hint = getHint(response.status, context);

  return new Error(`${hint}\nTwitch response: ${response.status} ${body}`);
};

const getHint = (
  status: number,
  context: TwitchHttpErrorContext
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

  if (context === "moderation_delete") {
    if (status === 401 || status === 403) {
      return [
        "Failed to delete Twitch chat message.",
        "Reconnect Twitch with moderator:manage:chat_messages and verify the bot account moderates the channel."
      ].join(" ");
    }

    return "Failed to delete Twitch chat message.";
  }

  if (context === "moderation_timeout") {
    if (status === 401 || status === 403) {
      return [
        "Failed to timeout Twitch chat user.",
        "Reconnect Twitch with moderator:manage:banned_users and verify the bot account moderates the channel."
      ].join(" ");
    }

    return "Failed to timeout Twitch chat user.";
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

type TwitchHttpErrorContext =
  | "eventsub_chat_subscription"
  | "send_chat_message"
  | "moderation_delete"
  | "moderation_timeout";
