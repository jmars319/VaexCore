export type GiveawayStatus = "open" | "closed" | "ended";

export type Giveaway = {
  id: number;
  title: string;
  keyword: string;
  status: GiveawayStatus;
  winner_count: number;
  created_at: string;
  opened_at: string | null;
  closed_at: string | null;
  ended_at: string | null;
};

export type GiveawayEntry = {
  id: number;
  giveaway_id: number;
  twitch_user_id: string;
  login: string;
  display_name: string;
  entered_at: string;
};

export type GiveawayWinner = {
  id: number;
  giveaway_id: number;
  twitch_user_id: string;
  login: string;
  display_name: string;
  drawn_at: string;
  claimed_at: string | null;
  delivered_at: string | null;
  rerolled_at: string | null;
};
