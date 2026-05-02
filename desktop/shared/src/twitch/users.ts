import { createTwitchHeaders, type TwitchAuthOptions } from "./auth";

export type TwitchUser = {
  id: string;
  login: string;
  display_name: string;
};

export const getTwitchUserByLogin = async (
  auth: TwitchAuthOptions,
  login: string
): Promise<TwitchUser | undefined> => {
  const params = new URLSearchParams({ login });
  const response = await fetch(`https://api.twitch.tv/helix/users?${params}`, {
    headers: createTwitchHeaders(auth)
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Twitch user ${login}: ${response.status}`);
  }

  const body = (await response.json()) as { data: TwitchUser[] };
  return body.data[0];
};
