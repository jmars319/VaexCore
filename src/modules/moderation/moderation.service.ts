import type { ChatMessage } from "../../core/chatMessage";
import { writeAuditLog } from "../../core/auditLog";
import type { FeatureGateStore } from "../../core/featureGates";
import { getProtectedCommandNames } from "../../core/protectedCommands";
import {
  assertNoSecretLikeContent,
  limits,
  parseSafeInteger,
  redactSecretText,
  sanitizeChatMessage,
  sanitizeText
} from "../../core/security";
import type { DbClient } from "../../db/client";

const moderationLimits = {
  termLength: 80,
  detailLength: 180,
  hitLimit: 100,
  repeatMemoryMax: 50,
  warningCooldownMs: 60_000
} as const;

export type ModerationFilterType =
  | "blocked_term"
  | "link"
  | "caps"
  | "repeat"
  | "symbols";

export type ModerationSettings = {
  blockedTermsEnabled: boolean;
  linkFilterEnabled: boolean;
  capsFilterEnabled: boolean;
  repeatFilterEnabled: boolean;
  symbolFilterEnabled: boolean;
  action: "warn";
  warningMessage: string;
  capsMinLength: number;
  capsRatio: number;
  repeatWindowSeconds: number;
  repeatLimit: number;
  symbolMinLength: number;
  symbolRatio: number;
  updatedAt: string;
};

export type ModerationTerm = {
  id: number;
  term: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ModerationHit = {
  id: number;
  filterType: string;
  action: "warn";
  userKey: string;
  userLogin: string;
  messagePreview: string;
  detail: string;
  createdAt: string;
};

type ModerationSettingsRow = {
  blocked_terms_enabled: number;
  link_filter_enabled: number;
  caps_filter_enabled: number;
  repeat_filter_enabled: number;
  symbol_filter_enabled: number;
  action: "warn";
  warning_message: string;
  caps_min_length: number;
  caps_ratio: number;
  repeat_window_seconds: number;
  repeat_limit: number;
  symbol_min_length: number;
  symbol_ratio: number;
  updated_at: string;
};

type ModerationTermRow = {
  id: number;
  term: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type ModerationHitRow = {
  id: number;
  filter_type: string;
  action: "warn";
  user_key: string;
  user_login: string;
  message_preview: string;
  detail: string;
  created_at: string;
};

type ModerationMemoryEntry = {
  normalizedText: string;
  at: number;
};

export type ModerationEvaluation = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  hit?: {
    filterTypes: ModerationFilterType[];
    action: "warn";
    detail: string;
    warningMessage: string;
  };
};

export class ModerationService {
  private readonly recentByUser = new Map<string, ModerationMemoryEntry[]>();
  private readonly lastWarningAt = new Map<string, number>();

  constructor(
    private readonly db: DbClient,
    private readonly options: {
      featureGates: FeatureGateStore;
      commandPrefix?: string;
      exemptCommandNames?: () => string[];
    }
  ) {}

  getState() {
    const terms = this.listTerms();
    const hits = this.getRecentHits(50);
    const settings = this.getSettings();

    return {
      ok: true,
      settings,
      terms,
      hits,
      featureGate: this.options.featureGates.get("moderation_filters"),
      summary: {
        terms: terms.length,
        enabledTerms: terms.filter((term) => term.enabled).length,
        filtersEnabled: [
          settings.blockedTermsEnabled,
          settings.linkFilterEnabled,
          settings.capsFilterEnabled,
          settings.repeatFilterEnabled,
          settings.symbolFilterEnabled
        ].filter(Boolean).length,
        hits: hits.length
      }
    };
  }

  getSettings(): ModerationSettings {
    const row = this.db
      .prepare("SELECT * FROM moderation_settings WHERE id = 1")
      .get() as ModerationSettingsRow | undefined;

    if (!row) {
      return defaultSettings();
    }

    return settingsFromRow(row);
  }

  saveSettings(input: unknown, actor: ChatMessage) {
    const current = this.getSettings();
    const body = input as Partial<Record<keyof ModerationSettings, unknown>>;
    const settings: ModerationSettings = {
      blockedTermsEnabled: booleanValue(body.blockedTermsEnabled, current.blockedTermsEnabled),
      linkFilterEnabled: booleanValue(body.linkFilterEnabled, current.linkFilterEnabled),
      capsFilterEnabled: booleanValue(body.capsFilterEnabled, current.capsFilterEnabled),
      repeatFilterEnabled: booleanValue(body.repeatFilterEnabled, current.repeatFilterEnabled),
      symbolFilterEnabled: booleanValue(body.symbolFilterEnabled, current.symbolFilterEnabled),
      action: "warn",
      warningMessage: normalizeWarningMessage(body.warningMessage ?? current.warningMessage),
      capsMinLength: parseSafeInteger(body.capsMinLength, {
        field: "Caps minimum length",
        fallback: current.capsMinLength,
        min: 5,
        max: limits.chatMessageLength
      }),
      capsRatio: ratioValue(body.capsRatio, current.capsRatio, "Caps ratio"),
      repeatWindowSeconds: parseSafeInteger(body.repeatWindowSeconds, {
        field: "Repeat window",
        fallback: current.repeatWindowSeconds,
        min: 5,
        max: 600
      }),
      repeatLimit: parseSafeInteger(body.repeatLimit, {
        field: "Repeat limit",
        fallback: current.repeatLimit,
        min: 2,
        max: 20
      }),
      symbolMinLength: parseSafeInteger(body.symbolMinLength, {
        field: "Symbol minimum length",
        fallback: current.symbolMinLength,
        min: 5,
        max: limits.chatMessageLength
      }),
      symbolRatio: ratioValue(body.symbolRatio, current.symbolRatio, "Symbol ratio"),
      updatedAt: timestamp()
    };

    this.db
      .prepare(
        `
          INSERT INTO moderation_settings (
            id,
            blocked_terms_enabled,
            link_filter_enabled,
            caps_filter_enabled,
            repeat_filter_enabled,
            symbol_filter_enabled,
            action,
            warning_message,
            caps_min_length,
            caps_ratio,
            repeat_window_seconds,
            repeat_limit,
            symbol_min_length,
            symbol_ratio,
            updated_at
          ) VALUES (
            1,
            @blockedTermsEnabled,
            @linkFilterEnabled,
            @capsFilterEnabled,
            @repeatFilterEnabled,
            @symbolFilterEnabled,
            'warn',
            @warningMessage,
            @capsMinLength,
            @capsRatio,
            @repeatWindowSeconds,
            @repeatLimit,
            @symbolMinLength,
            @symbolRatio,
            @updatedAt
          )
          ON CONFLICT(id) DO UPDATE SET
            blocked_terms_enabled = excluded.blocked_terms_enabled,
            link_filter_enabled = excluded.link_filter_enabled,
            caps_filter_enabled = excluded.caps_filter_enabled,
            repeat_filter_enabled = excluded.repeat_filter_enabled,
            symbol_filter_enabled = excluded.symbol_filter_enabled,
            action = excluded.action,
            warning_message = excluded.warning_message,
            caps_min_length = excluded.caps_min_length,
            caps_ratio = excluded.caps_ratio,
            repeat_window_seconds = excluded.repeat_window_seconds,
            repeat_limit = excluded.repeat_limit,
            symbol_min_length = excluded.symbol_min_length,
            symbol_ratio = excluded.symbol_ratio,
            updated_at = excluded.updated_at
        `
      )
      .run({
        blockedTermsEnabled: settings.blockedTermsEnabled ? 1 : 0,
        linkFilterEnabled: settings.linkFilterEnabled ? 1 : 0,
        capsFilterEnabled: settings.capsFilterEnabled ? 1 : 0,
        repeatFilterEnabled: settings.repeatFilterEnabled ? 1 : 0,
        symbolFilterEnabled: settings.symbolFilterEnabled ? 1 : 0,
        warningMessage: settings.warningMessage,
        capsMinLength: settings.capsMinLength,
        capsRatio: settings.capsRatio,
        repeatWindowSeconds: settings.repeatWindowSeconds,
        repeatLimit: settings.repeatLimit,
        symbolMinLength: settings.symbolMinLength,
        symbolRatio: settings.symbolRatio,
        updatedAt: settings.updatedAt
      });

    writeAuditLog(this.db, actor, "moderation.settings_update", "moderation:settings", {
      filtersEnabled: enabledFilterNames(settings)
    });

    return this.getState();
  }

  listTerms(): ModerationTerm[] {
    return (this.db
      .prepare(
        `
          SELECT *
          FROM moderation_blocked_terms
          ORDER BY term ASC
        `
      )
      .all() as ModerationTermRow[]).map(termFromRow);
  }

  saveTerm(input: unknown, actor: ChatMessage) {
    const body = input as { id?: number; term?: unknown; enabled?: unknown };
    const existing = body.id ? this.requireTermRow(Number(body.id)) : undefined;
    const term = normalizeBlockedTerm(body.term ?? existing?.term);
    const enabled = body.enabled === undefined
      ? existing ? existing.enabled === 1 : true
      : Boolean(body.enabled);
    const now = timestamp();
    const current = this.findTerm(term);

    if (current && current.id !== existing?.id) {
      throw new Error(`Blocked term "${term}" already exists.`);
    }

    if (existing) {
      this.db
        .prepare(
          `
            UPDATE moderation_blocked_terms
            SET term = @term,
                enabled = @enabled,
                updated_at = @updatedAt
            WHERE id = @id
          `
        )
        .run({ id: existing.id, term, enabled: enabled ? 1 : 0, updatedAt: now });
    } else {
      this.db
        .prepare(
          `
            INSERT INTO moderation_blocked_terms (term, enabled, created_at, updated_at)
            VALUES (@term, @enabled, @createdAt, @updatedAt)
          `
        )
        .run({ term, enabled: enabled ? 1 : 0, createdAt: now, updatedAt: now });
    }

    const saved = this.findTerm(term);

    writeAuditLog(
      this.db,
      actor,
      existing ? "moderation.term_update" : "moderation.term_create",
      `moderation_term:${saved?.id ?? term}`,
      {
        term,
        enabled
      }
    );

    return this.getState();
  }

  setTermEnabled(id: number, enabled: boolean, actor: ChatMessage) {
    const row = this.requireTermRow(id);
    const now = timestamp();

    this.db
      .prepare(
        `
          UPDATE moderation_blocked_terms
          SET enabled = @enabled,
              updated_at = @updatedAt
          WHERE id = @id
        `
      )
      .run({ id, enabled: enabled ? 1 : 0, updatedAt: now });

    writeAuditLog(
      this.db,
      actor,
      enabled ? "moderation.term_enable" : "moderation.term_disable",
      `moderation_term:${id}`,
      {
        term: row.term
      }
    );

    return this.getState();
  }

  deleteTerm(id: number, actor: ChatMessage) {
    const row = this.requireTermRow(id);

    this.db.prepare("DELETE FROM moderation_blocked_terms WHERE id = ?").run(id);
    writeAuditLog(this.db, actor, "moderation.term_delete", `moderation_term:${id}`, {
      term: row.term
    });

    return this.getState();
  }

  getRecentHits(limit = 50): ModerationHit[] {
    const safeLimit = parseSafeInteger(limit, {
      field: "Moderation hit limit",
      fallback: 50,
      min: 1,
      max: moderationLimits.hitLimit
    });

    return (this.db
      .prepare(
        `
          SELECT *
          FROM moderation_hits
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `
      )
      .all(safeLimit) as ModerationHitRow[]).map(hitFromRow);
  }

  evaluate(
    message: ChatMessage,
    options: { record?: boolean } = {}
  ): ModerationEvaluation {
    const gate = this.options.featureGates.describeAccess("moderation_filters", message.source);

    if (!gate.allowed) {
      return { ok: true, skipped: true, reason: gate.reason };
    }

    if (this.isExemptCommand(message.text)) {
      this.trackRepeatMemory(message);
      return { ok: true, skipped: true, reason: "Protected command or giveaway entry is exempt." };
    }

    const settings = this.getSettings();
    const matches = this.findMatches(message, settings);

    this.trackRepeatMemory(message);

    if (matches.length === 0) {
      return { ok: true };
    }

    const detail = sanitizeText(matches.map((match) => match.detail).join("; "), {
      field: "Moderation detail",
      maxLength: moderationLimits.detailLength
    });
    const warningMessage = renderWarning(settings.warningMessage, message, detail);

    if (options.record !== false) {
      this.recordHit(message, matches.map((match) => match.type), detail, warningMessage);
    }

    return {
      ok: true,
      hit: {
        filterTypes: matches.map((match) => match.type),
        action: "warn",
        detail,
        warningMessage
      }
    };
  }

  shouldWarn(message: ChatMessage, filterTypes: ModerationFilterType[]) {
    const key = `${userKey(message)}:${filterTypes.join(",")}`;
    const now = Date.now();
    const last = this.lastWarningAt.get(key) ?? 0;

    if (now - last < moderationLimits.warningCooldownMs) {
      return false;
    }

    this.lastWarningAt.set(key, now);
    return true;
  }

  private findMatches(message: ChatMessage, settings: ModerationSettings) {
    const text = message.text.trim();
    const lower = text.toLowerCase();
    const matches: Array<{ type: ModerationFilterType; detail: string }> = [];

    if (settings.blockedTermsEnabled) {
      const term = this.enabledTerms().find((entry) => lower.includes(entry.term.toLowerCase()));

      if (term) {
        matches.push({ type: "blocked_term", detail: `blocked term: ${term.term}` });
      }
    }

    if (settings.linkFilterEnabled && containsLink(text)) {
      matches.push({ type: "link", detail: "link detected" });
    }

    if (settings.capsFilterEnabled && isExcessiveCaps(text, settings)) {
      matches.push({ type: "caps", detail: "excessive caps" });
    }

    if (settings.repeatFilterEnabled && this.isRepeatedMessage(message, settings)) {
      matches.push({ type: "repeat", detail: "repeated message" });
    }

    if (settings.symbolFilterEnabled && isExcessiveSymbols(text, settings)) {
      matches.push({ type: "symbols", detail: "excessive symbols" });
    }

    return matches;
  }

  private enabledTerms() {
    return this.listTerms().filter((term) => term.enabled);
  }

  private recordHit(
    message: ChatMessage,
    filterTypes: ModerationFilterType[],
    detail: string,
    warningMessage: string
  ) {
    const now = timestamp();
    const preview = messagePreview(message.text);

    this.db
      .prepare(
        `
          INSERT INTO moderation_hits (
            filter_type,
            action,
            user_key,
            user_login,
            message_preview,
            detail,
            created_at
          ) VALUES (
            @filterType,
            'warn',
            @userKey,
            @userLogin,
            @messagePreview,
            @detail,
            @createdAt
          )
        `
      )
      .run({
        filterType: filterTypes.join(","),
        userKey: userKey(message),
        userLogin: message.userLogin,
        messagePreview: preview,
        detail,
        createdAt: now
      });

    writeAuditLog(this.db, message, "moderation.hit", `moderation:${filterTypes.join(",")}`, {
      filterTypes,
      action: "warn",
      userLogin: message.userLogin,
      detail,
      messagePreview: preview,
      warningPreview: messagePreview(warningMessage)
    }, { createdAt: now });
  }

  private isRepeatedMessage(message: ChatMessage, settings: ModerationSettings) {
    const normalizedText = normalizeRepeatText(message.text);

    if (!normalizedText) {
      return false;
    }

    const now = Date.now();
    const cutoff = now - settings.repeatWindowSeconds * 1000;
    const entries = (this.recentByUser.get(userKey(message)) ?? [])
      .filter((entry) => entry.at >= cutoff);
    const repeats = entries.filter((entry) => entry.normalizedText === normalizedText).length;

    return repeats + 1 >= settings.repeatLimit;
  }

  private trackRepeatMemory(message: ChatMessage) {
    const normalizedText = normalizeRepeatText(message.text);

    if (!normalizedText) {
      return;
    }

    const entries = this.recentByUser.get(userKey(message)) ?? [];
    entries.push({ normalizedText, at: Date.now() });
    this.recentByUser.set(userKey(message), entries.slice(-moderationLimits.repeatMemoryMax));
  }

  private isExemptCommand(text: string) {
    const prefix = this.options.commandPrefix ?? "!";
    const trimmed = text.trim();

    if (!trimmed.startsWith(prefix)) {
      return false;
    }

    const command = trimmed.slice(prefix.length).split(/\s+/)[0]?.toLowerCase();

    if (!command) {
      return false;
    }

    const exempt = new Set([
      ...getProtectedCommandNames(),
      ...(this.options.exemptCommandNames?.() ?? []).map((item) => item.toLowerCase())
    ]);

    return exempt.has(command);
  }

  private requireTermRow(id: number) {
    const row = this.db
      .prepare("SELECT * FROM moderation_blocked_terms WHERE id = ?")
      .get(id) as ModerationTermRow | undefined;

    if (!row) {
      throw new Error(`Blocked term #${id} was not found.`);
    }

    return row;
  }

  private findTerm(term: string) {
    const row = this.db
      .prepare("SELECT * FROM moderation_blocked_terms WHERE term = ?")
      .get(term) as ModerationTermRow | undefined;

    return row ? termFromRow(row) : undefined;
  }
}

const defaultSettings = (): ModerationSettings => ({
  blockedTermsEnabled: false,
  linkFilterEnabled: false,
  capsFilterEnabled: false,
  repeatFilterEnabled: false,
  symbolFilterEnabled: false,
  action: "warn",
  warningMessage: "@{user}, please keep chat within channel guidelines.",
  capsMinLength: 20,
  capsRatio: 0.75,
  repeatWindowSeconds: 30,
  repeatLimit: 3,
  symbolMinLength: 12,
  symbolRatio: 0.6,
  updatedAt: ""
});

const settingsFromRow = (row: ModerationSettingsRow): ModerationSettings => ({
  blockedTermsEnabled: row.blocked_terms_enabled === 1,
  linkFilterEnabled: row.link_filter_enabled === 1,
  capsFilterEnabled: row.caps_filter_enabled === 1,
  repeatFilterEnabled: row.repeat_filter_enabled === 1,
  symbolFilterEnabled: row.symbol_filter_enabled === 1,
  action: "warn",
  warningMessage: row.warning_message,
  capsMinLength: row.caps_min_length,
  capsRatio: row.caps_ratio,
  repeatWindowSeconds: row.repeat_window_seconds,
  repeatLimit: row.repeat_limit,
  symbolMinLength: row.symbol_min_length,
  symbolRatio: row.symbol_ratio,
  updatedAt: row.updated_at
});

const termFromRow = (row: ModerationTermRow): ModerationTerm => ({
  id: row.id,
  term: row.term,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const hitFromRow = (row: ModerationHitRow): ModerationHit => ({
  id: row.id,
  filterType: row.filter_type,
  action: row.action,
  userKey: row.user_key,
  userLogin: row.user_login,
  messagePreview: row.message_preview,
  detail: row.detail,
  createdAt: row.created_at
});

const normalizeBlockedTerm = (value: unknown) => {
  const term = sanitizeText(value, {
    field: "Blocked phrase",
    maxLength: moderationLimits.termLength,
    required: true
  }).toLowerCase();
  assertNoSecretLikeContent(term, "Blocked phrase");
  return term;
};

const normalizeWarningMessage = (value: unknown) => {
  const message = sanitizeChatMessage(value);
  assertNoSecretLikeContent(message, "Moderation warning");
  return message;
};

const booleanValue = (value: unknown, fallback: boolean) =>
  value === undefined ? fallback : Boolean(value);

const ratioValue = (value: unknown, fallback: number, field: string) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > 1) {
    throw new Error(`${field} must be between 0.1 and 1.`);
  }

  return parsed;
};

const enabledFilterNames = (settings: ModerationSettings) => [
  settings.blockedTermsEnabled ? "blocked_terms" : undefined,
  settings.linkFilterEnabled ? "links" : undefined,
  settings.capsFilterEnabled ? "caps" : undefined,
  settings.repeatFilterEnabled ? "repeat" : undefined,
  settings.symbolFilterEnabled ? "symbols" : undefined
].filter(Boolean);

const containsLink = (text: string) =>
  /\b(?:https?:\/\/|www\.|discord\.gg\/|[\w-]+\.(?:com|net|org|gg|tv|io|co)\b)/i.test(text);

const isExcessiveCaps = (text: string, settings: ModerationSettings) => {
  const letters = [...text].filter((char) => /[a-z]/i.test(char));

  if (letters.length < settings.capsMinLength) {
    return false;
  }

  const uppercase = letters.filter((char) => char === char.toUpperCase()).length;
  return uppercase / letters.length >= settings.capsRatio;
};

const isExcessiveSymbols = (text: string, settings: ModerationSettings) => {
  const visible = text.replace(/\s+/g, "");

  if (visible.length < settings.symbolMinLength) {
    return false;
  }

  const symbolCount = [...visible].filter((char) => /[^\p{L}\p{N}_]/u.test(char)).length;
  return symbolCount / visible.length >= settings.symbolRatio || /([^\p{L}\p{N}\s_])\1{7,}/u.test(text);
};

const normalizeRepeatText = (text: string) =>
  text.trim().replace(/\s+/g, " ").toLowerCase().slice(0, limits.chatMessageLength);

const renderWarning = (template: string, message: ChatMessage, reason: string) =>
  sanitizeChatMessage(
    template
      .replace(/\{user\}/g, message.userDisplayName || message.userLogin)
      .replace(/\{login\}/g, message.userLogin)
      .replace(/\{reason\}/g, reason)
  );

const messagePreview = (message: string) =>
  redactSecretText(message).slice(0, 180);

const userKey = (message: ChatMessage) => message.userId || message.userLogin;

const timestamp = () => new Date().toISOString();
