import type { Giveaway, GiveawayWinner } from "./giveaways.types";

const maxWinnerNamesInChat = 8;

export const giveawayStartMessage = (giveaway: Giveaway) =>
  `Giveaway started: ${giveaway.title}. Type !${giveaway.keyword} to enter. Winners: ${giveaway.winner_count}.`;

export const giveawayEntryMessage = (input: {
  giveaway: Giveaway;
  displayName: string;
  entryCount: number;
}) =>
  `Thanks ${input.displayName}, you're entered in ${input.giveaway.title}. Entries: ${input.entryCount}.`;

export const giveawayDuplicateEntryMessage = (input: {
  giveaway: Giveaway;
  displayName: string;
  entryCount: number;
}) =>
  `${input.displayName}, you're already entered in ${input.giveaway.title}. Entries: ${input.entryCount}.`;

export const giveawayClosedMessage = (giveaway: Giveaway, entryCount: number) =>
  `Entries closed for ${giveaway.title}. ${entryCount} ${entryCount === 1 ? "entry" : "entries"}. Drawing soon.`;

export const giveawayLastCallMessage = (giveaway: Giveaway, entryCount: number) =>
  `Last call for ${giveaway.title}: type !${giveaway.keyword} to enter. Current entries: ${entryCount}.`;

export const giveawayDrawMessage = (input: {
  winners: GiveawayWinner[];
  requestedCount: number;
}) => {
  if (input.winners.length === 0) {
    return "No eligible winners available.";
  }

  const partial =
    input.winners.length < input.requestedCount
      ? ` (only ${input.winners.length}/${input.requestedCount} eligible)`
      : "";

  return `Winner${input.winners.length === 1 ? "" : "s"}${partial}: ${formatWinnerNames(input.winners)}`;
};

export const giveawayRerollMessage = (input: {
  rerolled: GiveawayWinner;
  replacement?: GiveawayWinner;
}) => {
  if (!input.replacement) {
    return `${input.rerolled.display_name} was rerolled. No eligible replacement remains.`;
  }

  return `${input.rerolled.display_name} was rerolled. Replacement: ${input.replacement.display_name}.`;
};

export const giveawayEndMessage = (giveaway: Giveaway, winners: GiveawayWinner[]) => {
  const activeWinners = winners.filter((winner) => !winner.rerolled_at);

  if (activeWinners.length === 0) {
    return `Giveaway ended: ${giveaway.title}. No winners were drawn.`;
  }

  return `Giveaway ended: ${giveaway.title}. Final winner${activeWinners.length === 1 ? "" : "s"}: ${formatWinnerNames(activeWinners, 5)}.`;
};

const formatWinnerNames = (winners: GiveawayWinner[], maxNames = maxWinnerNamesInChat) => {
  const shown = winners.slice(0, maxNames);
  const remaining = winners.length - shown.length;
  const names = shown.map((winner) => winner.display_name).join(", ");

  return remaining > 0 ? `${names}, +${remaining} more` : names;
};
