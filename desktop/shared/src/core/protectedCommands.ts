import { normalizeCommandName } from "./security";

export type ProtectedCommandOwner = "core" | "status" | "giveaway";

export type ProtectedCommandDefinition = {
  name: string;
  owner: ProtectedCommandOwner;
  description: string;
};

export const protectedCommandDefinitions: ProtectedCommandDefinition[] = [
  {
    name: "ping",
    owner: "core",
    description: "Confirms the outbound chat queue and Twitch Send Chat Message path."
  },
  {
    name: "vcstatus",
    owner: "status",
    description: "Reports vaexcore console runtime, EventSub, queue, and giveaway status."
  },
  {
    name: "enter",
    owner: "giveaway",
    description: "Default giveaway entry command."
  },
  {
    name: "ghelp",
    owner: "giveaway",
    description: "Lists giveaway operator chat commands."
  },
  {
    name: "gstart",
    owner: "giveaway",
    description: "Starts a giveaway."
  },
  {
    name: "gstatus",
    owner: "giveaway",
    description: "Reports active giveaway state."
  },
  {
    name: "gclose",
    owner: "giveaway",
    description: "Closes giveaway entries."
  },
  {
    name: "gdraw",
    owner: "giveaway",
    description: "Draws giveaway winners."
  },
  {
    name: "greroll",
    owner: "giveaway",
    description: "Rerolls an active giveaway winner."
  },
  {
    name: "gclaim",
    owner: "giveaway",
    description: "Marks a giveaway winner as claimed."
  },
  {
    name: "gdeliver",
    owner: "giveaway",
    description: "Marks a giveaway winner as delivered."
  },
  {
    name: "gend",
    owner: "giveaway",
    description: "Ends the active giveaway."
  }
];

const protectedCommandNameSet = new Set(
  protectedCommandDefinitions.map((definition) => definition.name)
);

export const getProtectedCommandNames = () =>
  [...protectedCommandNameSet].sort();

export const getProtectedCommandDefinitions = () =>
  [...protectedCommandDefinitions].sort((a, b) => a.name.localeCompare(b.name));

export const isProtectedCommandName = (value: unknown) => {
  try {
    return protectedCommandNameSet.has(normalizeCommandName(value));
  } catch {
    return false;
  }
};

export const assertNotProtectedCommandName = (value: unknown, field = "Command name") => {
  const name = normalizeCommandName(value, field);

  if (protectedCommandNameSet.has(name)) {
    throw new Error(`!${name} is protected by vaexcore console.`);
  }

  return name;
};
