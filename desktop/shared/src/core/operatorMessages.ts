import type { DbClient } from "../db/client";
import { limits, sanitizeChatMessage } from "./security";

export type OperatorMessageTemplateId =
  | "welcome"
  | "brb"
  | "giveaway-soon"
  | "giveaway-reminder"
  | "manual-delivery"
  | "technical-pause"
  | "ending-soon"
  | "raid-transition"
  | "thanks";

type OperatorMessageTemplateDefinition = {
  id: OperatorMessageTemplateId;
  label: string;
  description: string;
  defaultTemplate: string;
  requiresConfirmation: boolean;
};

type OperatorMessageTemplateRow = {
  id: OperatorMessageTemplateId;
  template: string;
  updated_at: string;
};

export const operatorMessageTemplateDefinitions: OperatorMessageTemplateDefinition[] = [
  {
    id: "welcome",
    label: "Welcome",
    description: "A simple opener for stream start or a fresh wave of chat.",
    defaultTemplate: "Welcome in. Grab a spot, say hi, and enjoy the stream.",
    requiresConfirmation: false
  },
  {
    id: "brb",
    label: "BRB",
    description: "A calm hold message when the stream steps away briefly.",
    defaultTemplate: "Taking a quick break. I will be right back.",
    requiresConfirmation: false
  },
  {
    id: "giveaway-soon",
    label: "Giveaway starting soon",
    description: "A neutral heads-up before a giveaway opens.",
    defaultTemplate: "Giveaway coming up soon. Watch chat for the entry command when it opens.",
    requiresConfirmation: false
  },
  {
    id: "giveaway-reminder",
    label: "Giveaway reminder",
    description: "A manual reminder that does not change giveaway state.",
    defaultTemplate: "Giveaway reminder: check the current chat instructions to enter.",
    requiresConfirmation: true
  },
  {
    id: "manual-delivery",
    label: "Manual delivery",
    description: "Clarifies that prize delivery is handled manually.",
    defaultTemplate: "Prize delivery is manual. Winners will be handled after the draw.",
    requiresConfirmation: true
  },
  {
    id: "technical-pause",
    label: "Technical pause",
    description: "Use only when chat needs to know stream operations are paused.",
    defaultTemplate: "Quick technical pause. Thanks for holding while I check something.",
    requiresConfirmation: true
  },
  {
    id: "ending-soon",
    label: "Ending soon",
    description: "A light closing notice before wrapping the stream.",
    defaultTemplate: "We are getting close to wrapping up. Thanks for being here tonight.",
    requiresConfirmation: false
  },
  {
    id: "raid-transition",
    label: "Raid transition",
    description: "A controlled handoff message before sending chat elsewhere.",
    defaultTemplate: "Raid coming up soon. Keep it respectful and bring good energy.",
    requiresConfirmation: true
  },
  {
    id: "thanks",
    label: "Thanks",
    description: "A low-risk closing or appreciation message.",
    defaultTemplate: "Thanks for hanging out tonight.",
    requiresConfirmation: false
  }
];

const definitionsById = new Map(
  operatorMessageTemplateDefinitions.map((definition) => [definition.id, definition])
);

export const createOperatorMessageTemplateStore = (db: DbClient) =>
  new OperatorMessageTemplateStore(db);

export class OperatorMessageTemplateStore {
  constructor(private readonly db: DbClient) {}

  list() {
    const rows = this.rowsById();

    return operatorMessageTemplateDefinitions.map((definition) => {
      const row = rows.get(definition.id);
      return {
        ...definition,
        template: row?.template ?? definition.defaultTemplate,
        customized: Boolean(row),
        updatedAt: row?.updated_at ?? ""
      };
    });
  }

  find(id: unknown) {
    const normalized = normalizeOperatorMessageTemplateId(id);

    if (!normalized) {
      return undefined;
    }

    return this.list().find((template) => template.id === normalized);
  }

  save(input: unknown) {
    const updates = normalizeOperatorTemplateUpdates(input);
    const now = new Date().toISOString();

    for (const [id, template] of Object.entries(updates)) {
      this.db
        .prepare(
          `
            INSERT INTO operator_message_templates (id, template, updated_at)
            VALUES (@id, @template, @updatedAt)
            ON CONFLICT(id) DO UPDATE SET
              template = excluded.template,
              updated_at = excluded.updated_at
          `
        )
        .run({ id, template, updatedAt: now });
    }

    return this.list();
  }

  reset(ids?: unknown) {
    if (!Array.isArray(ids) || ids.length === 0) {
      this.db.prepare("DELETE FROM operator_message_templates").run();
      return this.list();
    }

    for (const id of normalizeOperatorMessageTemplateIds(ids)) {
      this.db.prepare("DELETE FROM operator_message_templates WHERE id = ?").run(id);
    }

    return this.list();
  }

  private rowsById() {
    const rows = this.db
      .prepare("SELECT * FROM operator_message_templates")
      .all() as OperatorMessageTemplateRow[];

    return new Map(rows.map((row) => [row.id, row]));
  }
}

export const normalizeOperatorMessageTemplateId = (
  id: unknown
): OperatorMessageTemplateId | undefined =>
  typeof id === "string" && definitionsById.has(id as OperatorMessageTemplateId)
    ? id as OperatorMessageTemplateId
    : undefined;

const normalizeOperatorMessageTemplateIds = (ids: unknown[]) =>
  ids
    .map(normalizeOperatorMessageTemplateId)
    .filter((id): id is OperatorMessageTemplateId => Boolean(id));

const normalizeOperatorTemplateUpdates = (input: unknown) => {
  const body = input as { templates?: Record<string, unknown> };
  const rawUpdates = body.templates && typeof body.templates === "object"
    ? body.templates
    : input as Record<string, unknown>;
  const updates: Partial<Record<OperatorMessageTemplateId, string>> = {};

  for (const [rawId, rawTemplate] of Object.entries(rawUpdates ?? {})) {
    const id = normalizeOperatorMessageTemplateId(rawId);

    if (!id || rawTemplate === undefined) {
      continue;
    }

    updates[id] = sanitizeChatMessage(rawTemplate);

    if (updates[id].length > limits.chatMessageLength) {
      throw new Error("Operator message template is too long.");
    }
  }

  return updates;
};
