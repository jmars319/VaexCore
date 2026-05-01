import type { ChatSource } from "./chatMessage";
import type { ChatMessage } from "./chatMessage";
import type { DbClient } from "../db/client";
import { writeAuditLog } from "./auditLog";

export type FeatureGateMode = "off" | "test" | "live";
export type FeatureKey = "custom_commands" | "timers" | "moderation_filters";

export type FeatureGateDefinition = {
  key: FeatureKey;
  label: string;
  description: string;
  defaultMode: FeatureGateMode;
};

export type FeatureGateState = FeatureGateDefinition & {
  mode: FeatureGateMode;
  updatedAt: string;
  updatedBy: string;
  liveAllowed: boolean;
  testAllowed: boolean;
};

type FeatureGateRow = {
  feature_key: FeatureKey;
  mode: FeatureGateMode;
  updated_at: string;
  updated_by: string;
};

export const featureGateDefinitions: FeatureGateDefinition[] = [
  {
    key: "custom_commands",
    label: "Custom commands",
    description: "User-defined chat commands, aliases, cooldowns, and response variants.",
    defaultMode: "live"
  },
  {
    key: "timers",
    label: "Timers",
    description: "Scheduled or repeating outbound chat messages.",
    defaultMode: "off"
  },
  {
    key: "moderation_filters",
    label: "Moderation filters",
    description: "Local chat moderation filters and enforcement actions.",
    defaultMode: "off"
  }
];

const featureDefinitionsByKey = new Map(
  featureGateDefinitions.map((definition) => [definition.key, definition])
);
const featureModes = new Set<FeatureGateMode>(["off", "test", "live"]);

export const createFeatureGateStore = (db: DbClient) => new FeatureGateStore(db);

export class FeatureGateStore {
  constructor(private readonly db: DbClient) {}

  list(): FeatureGateState[] {
    const rows = this.rowsByKey();

    return featureGateDefinitions.map((definition) => {
      const row = rows.get(definition.key);
      const mode = row?.mode ?? definition.defaultMode;

      return {
        ...definition,
        mode,
        updatedAt: row?.updated_at ?? "",
        updatedBy: row?.updated_by ?? "",
        liveAllowed: mode === "live",
        testAllowed: mode === "live" || mode === "test"
      };
    });
  }

  get(key: FeatureKey) {
    const definition = requireFeatureDefinition(key);
    return this.list().find((gate) => gate.key === definition.key) ?? {
      ...definition,
      mode: definition.defaultMode,
      updatedAt: "",
      updatedBy: "",
      liveAllowed: definition.defaultMode === "live",
      testAllowed: definition.defaultMode === "live" || definition.defaultMode === "test"
    };
  }

  getMode(key: FeatureKey) {
    return this.get(key).mode;
  }

  setMode(key: unknown, mode: unknown, actor: ChatMessage) {
    const definition = requireFeatureDefinition(key);
    const nextMode = normalizeFeatureGateMode(mode);
    const previous = this.get(definition.key);
    const now = timestamp();

    this.db
      .prepare(
        `
          INSERT INTO feature_gates (
            feature_key,
            mode,
            updated_at,
            updated_by
          ) VALUES (
            @featureKey,
            @mode,
            @updatedAt,
            @updatedBy
          )
          ON CONFLICT(feature_key) DO UPDATE SET
            mode = excluded.mode,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by
        `
      )
      .run({
        featureKey: definition.key,
        mode: nextMode,
        updatedAt: now,
        updatedBy: actor.userLogin
      });

    writeAuditLog(this.db, actor, "feature_gate.update", `feature:${definition.key}`, {
      featureKey: definition.key,
      label: definition.label,
      previousMode: previous.mode,
      mode: nextMode
    }, { createdAt: now });

    return this.get(definition.key);
  }

  canUse(key: FeatureKey, source: ChatSource) {
    const mode = this.getMode(key);

    if (mode === "live") {
      return true;
    }

    return mode === "test" && source === "local";
  }

  describeAccess(key: FeatureKey, source: ChatSource) {
    const gate = this.get(key);
    const allowed = this.canUse(key, source);

    return {
      ...gate,
      allowed,
      reason: allowed
        ? `${gate.label} is available in ${gate.mode} mode.`
        : gate.mode === "off"
          ? `${gate.label} is off. Enable test mode for local testing or live mode for Twitch chat.`
          : `${gate.label} is in test mode and will only respond to local simulations.`
    };
  }

  private rowsByKey() {
    const rows = this.db
      .prepare("SELECT * FROM feature_gates")
      .all() as FeatureGateRow[];

    return new Map(rows.map((row) => [row.feature_key, row]));
  }
}

export const normalizeFeatureGateMode = (value: unknown): FeatureGateMode => {
  if (typeof value === "string" && featureModes.has(value as FeatureGateMode)) {
    return value as FeatureGateMode;
  }

  throw new Error("Feature gate mode must be off, test, or live.");
};

export const requireFeatureDefinition = (key: unknown) => {
  if (typeof key === "string" && featureDefinitionsByKey.has(key as FeatureKey)) {
    return featureDefinitionsByKey.get(key as FeatureKey) as FeatureGateDefinition;
  }

  throw new Error("Unknown feature gate.");
};

const timestamp = () => new Date().toISOString();
