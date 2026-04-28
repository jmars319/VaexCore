export type TwitchAuthOptions = {
  clientId: string;
  accessToken: string;
};

export const createTwitchHeaders = ({ clientId, accessToken }: TwitchAuthOptions) => ({
  Authorization: `Bearer ${accessToken}`,
  "Client-Id": clientId,
  "Content-Type": "application/json"
});
