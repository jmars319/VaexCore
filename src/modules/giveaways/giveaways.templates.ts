import type { DbClient } from "../../db/client";
import { limits, sanitizeChatMessage, sanitizeText } from "../../core/security";
import type { Giveaway, GiveawayWinner } from "./giveaways.types";
import {
  defaultGiveawayMessageRenderer,
  formatWinnerNames,
  type GiveawayMessageRenderer
} from "./giveaways.messages";

export type GiveawayTemplateAction =
  | "start"
  | "entry"
  | "duplicate-entry"
  | "last-call"
  | "reminder"
  | "close"
  | "draw"
  | "reroll"
  | "end";

type GiveawayTemplateDefinition = {
  action: GiveawayTemplateAction;
  label: string;
  description: string;
  defaultTemplate: string;
};

type GiveawayTemplateRow = {
  action: GiveawayTemplateAction;
  template: string;
  updated_at: string;
};

type TemplateVariables = Record<string, string | number | undefined | null>;

export const giveawayTemplateDefinitions: GiveawayTemplateDefinition[] = [
  {
    action: "start",
    label: "Start",
    description: "Sent when the giveaway opens.",
    defaultTemplate: "Giveaway started: {title}. Type !{keyword} to enter. Winners: {winnerCount}."
  },
  {
    action: "entry",
    label: "Entry",
    description: "Sent when someone enters successfully.",
    defaultTemplate: "Thanks {displayName}, you're entered in {title}. Entries: {entryCount}."
  },
  {
    action: "duplicate-entry",
    label: "Duplicate entry",
    description: "Sent when someone tries to enter twice.",
    defaultTemplate: "{displayName}, you're already entered in {title}. Entries: {entryCount}."
  },
  {
    action: "last-call",
    label: "Last call",
    description: "Sent manually before entries close.",
    defaultTemplate: "Last call for {title}: type !{keyword} to enter. Current entries: {entryCount}."
  },
  {
    action: "reminder",
    label: "Timed reminder",
    description: "Sent on the reminder interval while entries are open.",
    defaultTemplate: "Reminder: {title} is open. Type !{keyword} to enter. Current entries: {entryCount}."
  },
  {
    action: "close",
    label: "Close",
    description: "Sent when entries close.",
    defaultTemplate: "Entries closed for {title}. {entryCount} entries. Drawing soon."
  },
  {
    action: "draw",
    label: "Draw",
    description: "Sent when winners are drawn.",
    defaultTemplate: "Winner{winnerPlural}{partial}: {winners}"
  },
  {
    action: "reroll",
    label: "Reroll",
    description: "Sent when a winner is rerolled.",
    defaultTemplate: "{rerolled} was rerolled. Replacement: {replacement}."
  },
  {
    action: "end",
    label: "End",
    description: "Sent when the giveaway ends.",
    defaultTemplate: "Giveaway ended: {title}. Final winner{winnerPlural}: {winners}."
  }
];

const definitionsByAction = new Map(
  giveawayTemplateDefinitions.map((definition) => [definition.action, definition])
);

export const createGiveawayTemplateStore = (db: DbClient) =>
  new GiveawayTemplateStore(db);

export class GiveawayTemplateStore implements GiveawayMessageRenderer {
  constructor(private readonly db: DbClient) {}

  list() {
    const rows = this.rowsByAction();

    return giveawayTemplateDefinitions.map((definition) => {
      const row = rows.get(definition.action);
      return {
        ...definition,
        template: row?.template ?? definition.defaultTemplate,
        customized: Boolean(row),
        updatedAt: row?.updated_at ?? ""
      };
    });
  }

  save(input: unknown) {
    const updates = normalizeTemplateUpdates(input);
    const now = new Date().toISOString();

    for (const [action, template] of Object.entries(updates)) {
      this.db
        .prepare(
          `
            INSERT INTO giveaway_message_templates (action, template, updated_at)
            VALUES (@action, @template, @updatedAt)
            ON CONFLICT(action) DO UPDATE SET
              template = excluded.template,
              updated_at = excluded.updated_at
          `
        )
        .run({ action, template, updatedAt: now });
    }

    return this.list();
  }

  reset(actions?: unknown) {
    if (!Array.isArray(actions) || actions.length === 0) {
      this.db.prepare("DELETE FROM giveaway_message_templates").run();
      return this.list();
    }

    const selectedActions = normalizeTemplateActions(actions);

    for (const action of selectedActions) {
      this.db.prepare("DELETE FROM giveaway_message_templates WHERE action = ?").run(action);
    }

    return this.list();
  }

  start(giveaway: Giveaway) {
    return this.render("start", giveawayVariables(giveaway), () =>
      defaultGiveawayMessageRenderer.start(giveaway)
    );
  }

  entry(input: {
    giveaway: Giveaway;
    displayName: string;
    entryCount: number;
  }) {
    return this.render("entry", {
      ...giveawayVariables(input.giveaway),
      displayName: input.displayName,
      entryCount: input.entryCount
    }, () => defaultGiveawayMessageRenderer.entry(input));
  }

  duplicateEntry(input: {
    giveaway: Giveaway;
    displayName: string;
    entryCount: number;
  }) {
    return this.render("duplicate-entry", {
      ...giveawayVariables(input.giveaway),
      displayName: input.displayName,
      entryCount: input.entryCount
    }, () => defaultGiveawayMessageRenderer.duplicateEntry(input));
  }

  lastCall(giveaway: Giveaway, entryCount: number) {
    return this.render("last-call", {
      ...giveawayVariables(giveaway),
      entryCount
    }, () => defaultGiveawayMessageRenderer.lastCall(giveaway, entryCount));
  }

  reminder(giveaway: Giveaway, entryCount: number) {
    return this.render("reminder", {
      ...giveawayVariables(giveaway),
      entryCount
    }, () => defaultGiveawayMessageRenderer.reminder(giveaway, entryCount));
  }

  close(giveaway: Giveaway, entryCount: number) {
    return this.render("close", {
      ...giveawayVariables(giveaway),
      entryCount
    }, () => defaultGiveawayMessageRenderer.close(giveaway, entryCount));
  }

  draw(input: {
    winners: GiveawayWinner[];
    requestedCount: number;
  }) {
    const drawnCount = input.winners.length;
    const partial =
      drawnCount > 0 && drawnCount < input.requestedCount
        ? ` (only ${drawnCount}/${input.requestedCount} eligible)`
        : "";

    return this.render("draw", {
      winners: drawnCount > 0 ? formatWinnerNames(input.winners) : "no eligible winners",
      winnerPlural: drawnCount === 1 ? "" : "s",
      drawnCount,
      requestedCount: input.requestedCount,
      partial
    }, () => defaultGiveawayMessageRenderer.draw(input));
  }

  reroll(input: {
    rerolled: GiveawayWinner;
    replacement?: GiveawayWinner;
  }) {
    return this.render("reroll", {
      rerolled: input.rerolled.display_name,
      replacement: input.replacement?.display_name ?? "no eligible replacement remains"
    }, () => defaultGiveawayMessageRenderer.reroll(input));
  }

  end(giveaway: Giveaway, winners: GiveawayWinner[]) {
    const activeWinners = winners.filter((winner) => !winner.rerolled_at);

    return this.render("end", {
      ...giveawayVariables(giveaway),
      winners: activeWinners.length > 0 ? formatWinnerNames(activeWinners, 5) : "no winners were drawn",
      winnerPlural: activeWinners.length === 1 ? "" : "s",
      drawnCount: activeWinners.length
    }, () => defaultGiveawayMessageRenderer.end(giveaway, winners));
  }

  private render(
    action: GiveawayTemplateAction,
    variables: TemplateVariables,
    fallback: () => string
  ) {
    const template = this.customTemplate(action);

    if (!template) {
      return fallback();
    }

    return sanitizeChatMessage(renderTemplate(template, variables));
  }

  private customTemplate(action: GiveawayTemplateAction) {
    return (this.db
      .prepare("SELECT template FROM giveaway_message_templates WHERE action = ?")
      .get(action) as { template: string } | undefined)?.template;
  }

  private rowsByAction() {
    const rows = this.db
      .prepare("SELECT * FROM giveaway_message_templates")
      .all() as GiveawayTemplateRow[];

    return new Map(rows.map((row) => [row.action, row]));
  }
}

const giveawayVariables = (giveaway: Giveaway) => ({
  title: giveaway.title,
  keyword: giveaway.keyword,
  winnerCount: giveaway.winner_count
});

const renderTemplate = (template: string, variables: TemplateVariables) =>
  template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_match, key: string) =>
    String(variables[key] ?? "")
  );

const normalizeTemplateUpdates = (input: unknown) => {
  const body = input as { templates?: Record<string, unknown> };
  const rawUpdates = body.templates && typeof body.templates === "object"
    ? body.templates
    : (input as Record<string, unknown>);
  const updates: Partial<Record<GiveawayTemplateAction, string>> = {};

  for (const [rawAction, rawTemplate] of Object.entries(rawUpdates ?? {})) {
    const action = normalizeTemplateAction(rawAction);

    if (!action || rawTemplate === undefined) {
      continue;
    }

    updates[action] = sanitizeText(rawTemplate, {
      field: `${definitionsByAction.get(action)?.label ?? action} template`,
      maxLength: limits.chatMessageLength,
      required: true
    });
  }

  return updates;
};

const normalizeTemplateActions = (actions: unknown) => {
  if (!Array.isArray(actions)) {
    return [];
  }

  return actions
    .map((action) => typeof action === "string" ? normalizeTemplateAction(action) : undefined)
    .filter((action): action is GiveawayTemplateAction => Boolean(action));
};

const normalizeTemplateAction = (action: string) =>
  definitionsByAction.has(action as GiveawayTemplateAction)
    ? action as GiveawayTemplateAction
    : undefined;
