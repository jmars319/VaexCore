import type { ChatMessage } from "../../core/chatMessage";
import { writeAuditLog } from "../../core/auditLog";
import type { FeatureGateStore } from "../../core/featureGates";
import { getProtectedCommandNames } from "../../core/protectedCommands";
import {
  assertNoSecretLikeContent,
  limits,
  normalizeLogin,
  parseSafeInteger,
  redactSecretText,
  sanitizeChatMessage,
  sanitizeText
} from "../../core/security";
import type { DbClient } from "../../db/client";

const moderationLimits = {
  termLength: 80,
  domainLength: 120,
  detailLength: 180,
  hitLimit: 100,
  linkPermitLimit: 100,
  repeatMemoryMax: 50,
  warningCooldownMs: 60_000,
  timeoutMinSeconds: 10,
  timeoutMaxSeconds: 1200
} as const;

export type ModerationFilterType =
  | "blocked_term"
  | "link"
  | "caps"
  | "repeat"
  | "symbols";

export type ModerationAction = "warn" | "delete" | "timeout";

export type ModerationSettings = {
  blockedTermsEnabled: boolean;
  linkFilterEnabled: boolean;
  capsFilterEnabled: boolean;
  repeatFilterEnabled: boolean;
  symbolFilterEnabled: boolean;
  action: ModerationAction;
  blockedTermsAction: ModerationAction;
  linkFilterAction: ModerationAction;
  capsFilterAction: ModerationAction;
  repeatFilterAction: ModerationAction;
  symbolFilterAction: ModerationAction;
  timeoutSeconds: number;
  warningMessage: string;
  capsMinLength: number;
  capsRatio: number;
  repeatWindowSeconds: number;
  repeatLimit: number;
  symbolMinLength: number;
  symbolRatio: number;
  exemptBroadcaster: boolean;
  exemptModerators: boolean;
  exemptVips: boolean;
  exemptSubscribers: boolean;
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
  action: ModerationAction;
  userKey: string;
  userLogin: string;
  messagePreview: string;
  detail: string;
  createdAt: string;
};

export type ModerationAllowedLink = {
  id: number;
  domain: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ModerationLinkPermit = {
  id: number;
  userLogin: string;
  expiresAt: string;
  usedAt: string;
  createdAt: string;
  createdBy: string;
  active: boolean;
};

type ModerationSettingsRow = {
  blocked_terms_enabled: number;
  link_filter_enabled: number;
  caps_filter_enabled: number;
  repeat_filter_enabled: number;
  symbol_filter_enabled: number;
  action: ModerationAction;
  blocked_terms_action: ModerationAction;
  link_filter_action: ModerationAction;
  caps_filter_action: ModerationAction;
  repeat_filter_action: ModerationAction;
  symbol_filter_action: ModerationAction;
  timeout_seconds: number;
  warning_message: string;
  caps_min_length: number;
  caps_ratio: number;
  repeat_window_seconds: number;
  repeat_limit: number;
  symbol_min_length: number;
  symbol_ratio: number;
  exempt_broadcaster: number;
  exempt_moderators: number;
  exempt_vips: number;
  exempt_subscribers: number;
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
  action: ModerationAction;
  user_key: string;
  user_login: string;
  message_preview: string;
  detail: string;
  created_at: string;
};

type ModerationAllowedLinkRow = {
  id: number;
  domain: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type ModerationLinkPermitRow = {
  id: number;
  user_login: string;
  expires_at: string;
  used_at: string;
  created_at: string;
  created_by: string;
};

type ModerationMemoryEntry = {
  normalizedText: string;
  at: number;
};

export type ModerationEvaluation = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  allowedLinks?: string[];
  consumedPermit?: {
    id: number;
    userLogin: string;
    expiresAt: string;
  };
  hit?: {
    filterTypes: ModerationFilterType[];
    action: ModerationAction;
    filterActions: Array<{
      filterType: ModerationFilterType;
      action: ModerationAction;
    }>;
    detail: string;
    warningMessage: string;
    timeoutSeconds?: number;
  };
};

export type ModerationEnforcementCapabilities = {
  canDeleteMessages: boolean;
  canTimeoutUsers: boolean;
  deleteUnavailableReason?: string;
  timeoutUnavailableReason?: string;
};

export type ModerationEnforcementPlan =
  | {
      status: "skipped" | "blocked";
      action: ModerationAction;
      reason: string;
      durationSeconds?: number;
    }
  | {
      status: "ready";
      action: "delete" | "timeout";
      reason: string;
      durationSeconds?: number;
    };

export type ModerationEnforcementOutcome = {
  action: ModerationAction;
  status: "skipped" | "blocked" | "succeeded" | "failed";
  reason: string;
  durationSeconds?: number;
  statusCode?: number;
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
    const allowedLinks = this.listAllowedLinks();
    const linkPermits = this.listLinkPermits(25);

    return {
      ok: true,
      settings,
      terms,
      allowedLinks,
      linkPermits,
      hits,
      featureGate: this.options.featureGates.get("moderation_filters"),
      summary: {
        terms: terms.length,
        enabledTerms: terms.filter((term) => term.enabled).length,
        allowedLinks: allowedLinks.length,
        enabledAllowedLinks: allowedLinks.filter((link) => link.enabled).length,
        activeLinkPermits: linkPermits.filter((permit) => permit.active).length,
        roleExemptions: enabledExemptionNames(settings).length,
        filtersEnabled: [
          settings.blockedTermsEnabled,
          settings.linkFilterEnabled,
          settings.capsFilterEnabled,
          settings.repeatFilterEnabled,
          settings.symbolFilterEnabled
        ].filter(Boolean).length,
        enforcementFilters: enabledEnforcementFilterNames(settings).length,
        timeoutSeconds: settings.timeoutSeconds,
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
      blockedTermsAction: normalizeModerationAction(
        body.blockedTermsAction ?? current.blockedTermsAction,
        current.blockedTermsAction
      ),
      linkFilterAction: normalizeModerationAction(
        body.linkFilterAction ?? current.linkFilterAction,
        current.linkFilterAction
      ),
      capsFilterAction: normalizeModerationAction(
        body.capsFilterAction ?? current.capsFilterAction,
        current.capsFilterAction
      ),
      repeatFilterAction: normalizeModerationAction(
        body.repeatFilterAction ?? current.repeatFilterAction,
        current.repeatFilterAction
      ),
      symbolFilterAction: normalizeModerationAction(
        body.symbolFilterAction ?? current.symbolFilterAction,
        current.symbolFilterAction
      ),
      timeoutSeconds: parseSafeInteger(body.timeoutSeconds, {
        field: "Timeout seconds",
        fallback: current.timeoutSeconds,
        min: moderationLimits.timeoutMinSeconds,
        max: moderationLimits.timeoutMaxSeconds
      }),
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
      exemptBroadcaster: booleanValue(body.exemptBroadcaster, current.exemptBroadcaster),
      exemptModerators: booleanValue(body.exemptModerators, current.exemptModerators),
      exemptVips: booleanValue(body.exemptVips, current.exemptVips),
      exemptSubscribers: booleanValue(body.exemptSubscribers, current.exemptSubscribers),
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
            blocked_terms_action,
            link_filter_action,
            caps_filter_action,
            repeat_filter_action,
            symbol_filter_action,
            timeout_seconds,
            warning_message,
            caps_min_length,
            caps_ratio,
            repeat_window_seconds,
            repeat_limit,
            symbol_min_length,
            symbol_ratio,
            exempt_broadcaster,
            exempt_moderators,
            exempt_vips,
            exempt_subscribers,
            updated_at
          ) VALUES (
            1,
            @blockedTermsEnabled,
            @linkFilterEnabled,
            @capsFilterEnabled,
            @repeatFilterEnabled,
            @symbolFilterEnabled,
            'warn',
            @blockedTermsAction,
            @linkFilterAction,
            @capsFilterAction,
            @repeatFilterAction,
            @symbolFilterAction,
            @timeoutSeconds,
            @warningMessage,
            @capsMinLength,
            @capsRatio,
            @repeatWindowSeconds,
            @repeatLimit,
            @symbolMinLength,
            @symbolRatio,
            @exemptBroadcaster,
            @exemptModerators,
            @exemptVips,
            @exemptSubscribers,
            @updatedAt
          )
          ON CONFLICT(id) DO UPDATE SET
            blocked_terms_enabled = excluded.blocked_terms_enabled,
            link_filter_enabled = excluded.link_filter_enabled,
            caps_filter_enabled = excluded.caps_filter_enabled,
            repeat_filter_enabled = excluded.repeat_filter_enabled,
            symbol_filter_enabled = excluded.symbol_filter_enabled,
            action = excluded.action,
            blocked_terms_action = excluded.blocked_terms_action,
            link_filter_action = excluded.link_filter_action,
            caps_filter_action = excluded.caps_filter_action,
            repeat_filter_action = excluded.repeat_filter_action,
            symbol_filter_action = excluded.symbol_filter_action,
            timeout_seconds = excluded.timeout_seconds,
            warning_message = excluded.warning_message,
            caps_min_length = excluded.caps_min_length,
            caps_ratio = excluded.caps_ratio,
            repeat_window_seconds = excluded.repeat_window_seconds,
            repeat_limit = excluded.repeat_limit,
            symbol_min_length = excluded.symbol_min_length,
            symbol_ratio = excluded.symbol_ratio,
            exempt_broadcaster = excluded.exempt_broadcaster,
            exempt_moderators = excluded.exempt_moderators,
            exempt_vips = excluded.exempt_vips,
            exempt_subscribers = excluded.exempt_subscribers,
            updated_at = excluded.updated_at
        `
      )
      .run({
        blockedTermsEnabled: settings.blockedTermsEnabled ? 1 : 0,
        linkFilterEnabled: settings.linkFilterEnabled ? 1 : 0,
        capsFilterEnabled: settings.capsFilterEnabled ? 1 : 0,
        repeatFilterEnabled: settings.repeatFilterEnabled ? 1 : 0,
        symbolFilterEnabled: settings.symbolFilterEnabled ? 1 : 0,
        blockedTermsAction: settings.blockedTermsAction,
        linkFilterAction: settings.linkFilterAction,
        capsFilterAction: settings.capsFilterAction,
        repeatFilterAction: settings.repeatFilterAction,
        symbolFilterAction: settings.symbolFilterAction,
        timeoutSeconds: settings.timeoutSeconds,
        warningMessage: settings.warningMessage,
        capsMinLength: settings.capsMinLength,
        capsRatio: settings.capsRatio,
        repeatWindowSeconds: settings.repeatWindowSeconds,
        repeatLimit: settings.repeatLimit,
        symbolMinLength: settings.symbolMinLength,
        symbolRatio: settings.symbolRatio,
        exemptBroadcaster: settings.exemptBroadcaster ? 1 : 0,
        exemptModerators: settings.exemptModerators ? 1 : 0,
        exemptVips: settings.exemptVips ? 1 : 0,
        exemptSubscribers: settings.exemptSubscribers ? 1 : 0,
        updatedAt: settings.updatedAt
      });

    writeAuditLog(this.db, actor, "moderation.settings_update", "moderation:settings", {
      filtersEnabled: enabledFilterNames(settings),
      roleExemptions: enabledExemptionNames(settings),
      enforcementFilters: enabledEnforcementFilterNames(settings),
      timeoutSeconds: settings.timeoutSeconds
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

  listAllowedLinks(): ModerationAllowedLink[] {
    return (this.db
      .prepare(
        `
          SELECT *
          FROM moderation_allowed_links
          ORDER BY domain ASC
        `
      )
      .all() as ModerationAllowedLinkRow[]).map(allowedLinkFromRow);
  }

  saveAllowedLink(input: unknown, actor: ChatMessage) {
    const body = input as { id?: number; domain?: unknown; enabled?: unknown };
    const existing = body.id ? this.requireAllowedLinkRow(Number(body.id)) : undefined;
    const domain = normalizeAllowedDomain(body.domain ?? existing?.domain);
    const enabled = body.enabled === undefined
      ? existing ? existing.enabled === 1 : true
      : Boolean(body.enabled);
    const now = timestamp();
    const current = this.findAllowedLink(domain);

    if (current && current.id !== existing?.id) {
      throw new Error(`Allowed domain "${domain}" already exists.`);
    }

    if (existing) {
      this.db
        .prepare(
          `
            UPDATE moderation_allowed_links
            SET domain = @domain,
                enabled = @enabled,
                updated_at = @updatedAt
            WHERE id = @id
          `
        )
        .run({ id: existing.id, domain, enabled: enabled ? 1 : 0, updatedAt: now });
    } else {
      this.db
        .prepare(
          `
            INSERT INTO moderation_allowed_links (domain, enabled, created_at, updated_at)
            VALUES (@domain, @enabled, @createdAt, @updatedAt)
          `
        )
        .run({ domain, enabled: enabled ? 1 : 0, createdAt: now, updatedAt: now });
    }

    const saved = this.findAllowedLink(domain);

    writeAuditLog(
      this.db,
      actor,
      existing ? "moderation.allowed_link_update" : "moderation.allowed_link_create",
      `moderation_allowed_link:${saved?.id ?? domain}`,
      {
        domain,
        enabled
      }
    );

    return this.getState();
  }

  setAllowedLinkEnabled(id: number, enabled: boolean, actor: ChatMessage) {
    const row = this.requireAllowedLinkRow(id);
    const now = timestamp();

    this.db
      .prepare(
        `
          UPDATE moderation_allowed_links
          SET enabled = @enabled,
              updated_at = @updatedAt
          WHERE id = @id
        `
      )
      .run({ id, enabled: enabled ? 1 : 0, updatedAt: now });

    writeAuditLog(
      this.db,
      actor,
      enabled ? "moderation.allowed_link_enable" : "moderation.allowed_link_disable",
      `moderation_allowed_link:${id}`,
      {
        domain: row.domain
      }
    );

    return this.getState();
  }

  deleteAllowedLink(id: number, actor: ChatMessage) {
    const row = this.requireAllowedLinkRow(id);

    this.db.prepare("DELETE FROM moderation_allowed_links WHERE id = ?").run(id);
    writeAuditLog(this.db, actor, "moderation.allowed_link_delete", `moderation_allowed_link:${id}`, {
      domain: row.domain
    });

    return this.getState();
  }

  listLinkPermits(limit = 25): ModerationLinkPermit[] {
    const safeLimit = parseSafeInteger(limit, {
      field: "Moderation link permit limit",
      fallback: 25,
      min: 1,
      max: moderationLimits.linkPermitLimit
    });

    return (this.db
      .prepare(
        `
          SELECT *
          FROM moderation_link_permits
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `
      )
      .all(safeLimit) as ModerationLinkPermitRow[]).map(linkPermitFromRow);
  }

  grantLinkPermit(input: unknown, actor: ChatMessage) {
    const body = input as { userLogin?: unknown; minutes?: unknown };
    const userLogin = normalizeLogin(body.userLogin, "Permitted username");
    const minutes = parseSafeInteger(body.minutes, {
      field: "Permit minutes",
      fallback: 5,
      min: 1,
      max: 120
    });
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + minutes * 60_000).toISOString();

    this.db
      .prepare(
        `
          INSERT INTO moderation_link_permits (
            user_login,
            expires_at,
            used_at,
            created_at,
            created_by
          ) VALUES (
            @userLogin,
            @expiresAt,
            '',
            @createdAt,
            @createdBy
          )
        `
      )
      .run({
        userLogin,
        expiresAt,
        createdAt,
        createdBy: actor.userLogin
      });

    writeAuditLog(this.db, actor, "moderation.link_permit_create", `moderation_link_permit:${userLogin}`, {
      userLogin,
      minutes,
      expiresAt
    }, { createdAt });

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
    options: { record?: boolean; consumePermits?: boolean } = {}
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

    if (this.isExemptRole(message, settings)) {
      this.trackRepeatMemory(message);
      return { ok: true, skipped: true, reason: "Trusted chat role is exempt from moderation filters." };
    }

    const { matches, allowedLinks, consumedPermit } = this.findMatches(message, settings, options);

    this.trackRepeatMemory(message);

    if (matches.length === 0) {
      return {
        ok: true,
        allowedLinks: allowedLinks.length ? allowedLinks : undefined,
        consumedPermit
      };
    }

    const detail = sanitizeText(matches.map((match) => match.detail).join("; "), {
      field: "Moderation detail",
      maxLength: moderationLimits.detailLength
    });
    const filterActions = matches.map((match) => ({
      filterType: match.type,
      action: match.action
    }));
    const action = strongestAction(filterActions.map((match) => match.action));
    const warningMessage = renderWarning(settings.warningMessage, message, detail);

    if (options.record !== false) {
      this.recordHit(message, matches.map((match) => match.type), action, detail, warningMessage);
    }

    return {
      ok: true,
      allowedLinks: allowedLinks.length ? allowedLinks : undefined,
      consumedPermit,
      hit: {
        filterTypes: matches.map((match) => match.type),
        action,
        filterActions,
        detail,
        warningMessage,
        timeoutSeconds: action === "timeout" ? settings.timeoutSeconds : undefined
      }
    };
  }

  planEnforcement(
    message: ChatMessage,
    hit: NonNullable<ModerationEvaluation["hit"]>,
    capabilities: ModerationEnforcementCapabilities
  ): ModerationEnforcementPlan {
    if (hit.action === "warn") {
      return {
        status: "skipped",
        action: "warn",
        reason: "Filter action is warn only."
      };
    }

    if (message.source !== "eventsub") {
      return {
        status: "blocked",
        action: hit.action,
        reason: "Enforcement only runs for live Twitch chat messages."
      };
    }

    if (message.isBroadcaster || message.isMod) {
      return {
        status: "blocked",
        action: hit.action,
        reason: "Broadcaster and moderator messages are never deleted or timed out by filters."
      };
    }

    if (hit.action === "delete") {
      if (!message.id) {
        return {
          status: "blocked",
          action: "delete",
          reason: "Twitch message ID was missing."
        };
      }

      if (!capabilities.canDeleteMessages) {
        return {
          status: "blocked",
          action: "delete",
          reason: capabilities.deleteUnavailableReason ?? "Delete scope is unavailable."
        };
      }

      return {
        status: "ready",
        action: "delete",
        reason: "Delete scope and message ID are available."
      };
    }

    if (!message.userId) {
      return {
        status: "blocked",
        action: "timeout",
        reason: "Twitch user ID was missing.",
        durationSeconds: hit.timeoutSeconds
      };
    }

    if (!capabilities.canTimeoutUsers) {
      return {
        status: "blocked",
        action: "timeout",
        reason: capabilities.timeoutUnavailableReason ?? "Timeout scope is unavailable.",
        durationSeconds: hit.timeoutSeconds
      };
    }

    return {
      status: "ready",
      action: "timeout",
      reason: "Timeout scope and user ID are available.",
      durationSeconds: hit.timeoutSeconds
    };
  }

  recordEnforcement(
    message: ChatMessage,
    hit: NonNullable<ModerationEvaluation["hit"]>,
    outcome: ModerationEnforcementOutcome
  ) {
    const now = timestamp();
    writeAuditLog(this.db, message, `moderation.${outcome.action}_${outcome.status}`, `moderation:${outcome.action}`, {
      filterTypes: hit.filterTypes,
      action: outcome.action,
      status: outcome.status,
      reason: sanitizeText(outcome.reason, {
        field: "Moderation enforcement reason",
        maxLength: moderationLimits.detailLength
      }),
      userLogin: message.userLogin,
      messageId: message.id ?? "",
      durationSeconds: outcome.durationSeconds,
      statusCode: outcome.statusCode,
      detail: hit.detail,
      messagePreview: messagePreview(message.text)
    }, { createdAt: now });
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

  private findMatches(
    message: ChatMessage,
    settings: ModerationSettings,
    options: { consumePermits?: boolean }
  ) {
    const text = message.text.trim();
    const lower = text.toLowerCase();
    const matches: Array<{
      type: ModerationFilterType;
      action: ModerationAction;
      detail: string;
    }> = [];
    const allowedLinks: string[] = [];
    let consumedPermit: ModerationEvaluation["consumedPermit"] | undefined;

    if (settings.blockedTermsEnabled) {
      const term = this.enabledTerms().find((entry) => lower.includes(entry.term.toLowerCase()));

      if (term) {
        matches.push({
          type: "blocked_term",
          action: settings.blockedTermsAction,
          detail: `blocked term: ${term.term}`
        });
      }
    }

    if (settings.linkFilterEnabled) {
      const linkResult = this.inspectLinks(message, options.consumePermits !== false);
      allowedLinks.push(...linkResult.allowed);
      consumedPermit = linkResult.consumedPermit;

      if (linkResult.blocked.length) {
        matches.push({
          type: "link",
          action: settings.linkFilterAction,
          detail: `link detected: ${linkResult.blocked.join(", ")}`
        });
      }
    }

    if (settings.capsFilterEnabled && isExcessiveCaps(text, settings)) {
      matches.push({ type: "caps", action: settings.capsFilterAction, detail: "excessive caps" });
    }

    if (settings.repeatFilterEnabled && this.isRepeatedMessage(message, settings)) {
      matches.push({ type: "repeat", action: settings.repeatFilterAction, detail: "repeated message" });
    }

    if (settings.symbolFilterEnabled && isExcessiveSymbols(text, settings)) {
      matches.push({ type: "symbols", action: settings.symbolFilterAction, detail: "excessive symbols" });
    }

    return { matches, allowedLinks, consumedPermit };
  }

  private enabledTerms() {
    return this.listTerms().filter((term) => term.enabled);
  }

  private enabledAllowedLinks() {
    return this.listAllowedLinks().filter((link) => link.enabled);
  }

  private recordHit(
    message: ChatMessage,
    filterTypes: ModerationFilterType[],
    action: ModerationAction,
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
            @action,
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
        action,
        userKey: userKey(message),
        userLogin: message.userLogin,
        messagePreview: preview,
        detail,
        createdAt: now
      });

    writeAuditLog(this.db, message, "moderation.hit", `moderation:${filterTypes.join(",")}`, {
      filterTypes,
      action,
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

  private inspectLinks(message: ChatMessage, consumePermit: boolean) {
    const domains = unique(findLinkDomains(message.text));

    if (!domains.length) {
      return {
        allowed: [],
        blocked: [],
        consumedPermit: undefined
      };
    }

    const allowedEntries = this.enabledAllowedLinks();
    const allowed = domains.filter((domain) =>
      allowedEntries.some((entry) => domainMatchesAllowed(domain, entry.domain))
    );
    const stillBlocked = domains.filter((domain) => !allowed.includes(domain));

    if (!stillBlocked.length) {
      return {
        allowed,
        blocked: [],
        consumedPermit: undefined
      };
    }

    const permit = this.activeLinkPermit(message.userLogin);

    if (!permit) {
      return {
        allowed,
        blocked: stillBlocked,
        consumedPermit: undefined
      };
    }

    let consumedPermit: ModerationEvaluation["consumedPermit"] | undefined = {
      id: permit.id,
      userLogin: permit.user_login,
      expiresAt: permit.expires_at
    };

    if (consumePermit) {
      consumedPermit = this.consumeLinkPermit(permit, message);
    }

    return {
      allowed,
      blocked: [],
      consumedPermit
    };
  }

  private activeLinkPermit(userLogin: string) {
    const login = normalizeLogin(userLogin, "Username");
    return this.db
      .prepare(
        `
          SELECT *
          FROM moderation_link_permits
          WHERE user_login = ?
            AND used_at = ''
            AND expires_at > ?
          ORDER BY expires_at DESC, id DESC
          LIMIT 1
        `
      )
      .get(login, timestamp()) as ModerationLinkPermitRow | undefined;
  }

  private consumeLinkPermit(permit: ModerationLinkPermitRow, message: ChatMessage) {
    const usedAt = timestamp();

    this.db
      .prepare(
        `
          UPDATE moderation_link_permits
          SET used_at = @usedAt
          WHERE id = @id
            AND used_at = ''
        `
      )
      .run({ id: permit.id, usedAt });

    writeAuditLog(this.db, message, "moderation.link_permit_consume", `moderation_link_permit:${permit.id}`, {
      userLogin: permit.user_login,
      messagePreview: messagePreview(message.text)
    }, { createdAt: usedAt });

    return {
      id: permit.id,
      userLogin: permit.user_login,
      expiresAt: permit.expires_at
    };
  }

  private isExemptRole(message: ChatMessage, settings: ModerationSettings) {
    if (message.isBroadcaster && settings.exemptBroadcaster) {
      return true;
    }

    if (message.isMod && settings.exemptModerators) {
      return true;
    }

    if (message.isVip && settings.exemptVips) {
      return true;
    }

    return message.isSubscriber && settings.exemptSubscribers;
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

  private requireAllowedLinkRow(id: number) {
    const row = this.db
      .prepare("SELECT * FROM moderation_allowed_links WHERE id = ?")
      .get(id) as ModerationAllowedLinkRow | undefined;

    if (!row) {
      throw new Error(`Allowed domain #${id} was not found.`);
    }

    return row;
  }

  private findAllowedLink(domain: string) {
    const row = this.db
      .prepare("SELECT * FROM moderation_allowed_links WHERE domain = ?")
      .get(domain) as ModerationAllowedLinkRow | undefined;

    return row ? allowedLinkFromRow(row) : undefined;
  }
}

const defaultSettings = (): ModerationSettings => ({
  blockedTermsEnabled: false,
  linkFilterEnabled: false,
  capsFilterEnabled: false,
  repeatFilterEnabled: false,
  symbolFilterEnabled: false,
  action: "warn",
  blockedTermsAction: "warn",
  linkFilterAction: "warn",
  capsFilterAction: "warn",
  repeatFilterAction: "warn",
  symbolFilterAction: "warn",
  timeoutSeconds: 60,
  warningMessage: "@{user}, please keep chat within channel guidelines.",
  capsMinLength: 20,
  capsRatio: 0.75,
  repeatWindowSeconds: 30,
  repeatLimit: 3,
  symbolMinLength: 12,
  symbolRatio: 0.6,
  exemptBroadcaster: true,
  exemptModerators: true,
  exemptVips: false,
  exemptSubscribers: false,
  updatedAt: ""
});

const settingsFromRow = (row: ModerationSettingsRow): ModerationSettings => ({
  blockedTermsEnabled: row.blocked_terms_enabled === 1,
  linkFilterEnabled: row.link_filter_enabled === 1,
  capsFilterEnabled: row.caps_filter_enabled === 1,
  repeatFilterEnabled: row.repeat_filter_enabled === 1,
  symbolFilterEnabled: row.symbol_filter_enabled === 1,
  action: "warn",
  blockedTermsAction: normalizeStoredModerationAction(row.blocked_terms_action),
  linkFilterAction: normalizeStoredModerationAction(row.link_filter_action),
  capsFilterAction: normalizeStoredModerationAction(row.caps_filter_action),
  repeatFilterAction: normalizeStoredModerationAction(row.repeat_filter_action),
  symbolFilterAction: normalizeStoredModerationAction(row.symbol_filter_action),
  timeoutSeconds: clampTimeoutSeconds(row.timeout_seconds),
  warningMessage: row.warning_message,
  capsMinLength: row.caps_min_length,
  capsRatio: row.caps_ratio,
  repeatWindowSeconds: row.repeat_window_seconds,
  repeatLimit: row.repeat_limit,
  symbolMinLength: row.symbol_min_length,
  symbolRatio: row.symbol_ratio,
  exemptBroadcaster: row.exempt_broadcaster === 1,
  exemptModerators: row.exempt_moderators === 1,
  exemptVips: row.exempt_vips === 1,
  exemptSubscribers: row.exempt_subscribers === 1,
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

const allowedLinkFromRow = (row: ModerationAllowedLinkRow): ModerationAllowedLink => ({
  id: row.id,
  domain: row.domain,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const linkPermitFromRow = (row: ModerationLinkPermitRow): ModerationLinkPermit => ({
  id: row.id,
  userLogin: row.user_login,
  expiresAt: row.expires_at,
  usedAt: row.used_at,
  createdAt: row.created_at,
  createdBy: row.created_by,
  active: !row.used_at && new Date(row.expires_at).getTime() > Date.now()
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

const normalizeAllowedDomain = (value: unknown) => {
  let domain = sanitizeText(value, {
    field: "Allowed domain",
    maxLength: moderationLimits.domainLength,
    required: true
  }).toLowerCase();

  assertNoSecretLikeContent(domain, "Allowed domain");
  domain = domain.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0] ?? "";
  domain = domain.replace(/:\d+$/, "").trim();

  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    throw new Error("Allowed domain must be a valid domain, such as example.com.");
  }

  return domain;
};

const normalizeWarningMessage = (value: unknown) => {
  const message = sanitizeChatMessage(value);
  assertNoSecretLikeContent(message, "Moderation warning");
  return message;
};

const booleanValue = (value: unknown, fallback: boolean) =>
  value === undefined ? fallback : Boolean(value);

const moderationActions = new Set<ModerationAction>(["warn", "delete", "timeout"]);

const normalizeModerationAction = (value: unknown, fallback: ModerationAction) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "string" && moderationActions.has(value as ModerationAction)) {
    return value as ModerationAction;
  }

  throw new Error("Moderation action must be warn, delete, or timeout.");
};

const normalizeStoredModerationAction = (value: unknown): ModerationAction =>
  normalizeModerationAction(value, "warn");

const clampTimeoutSeconds = (value: unknown) => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return 60;
  }

  return Math.min(
    moderationLimits.timeoutMaxSeconds,
    Math.max(moderationLimits.timeoutMinSeconds, Math.trunc(parsed))
  );
};

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

const enabledExemptionNames = (settings: ModerationSettings) => [
  settings.exemptBroadcaster ? "broadcaster" : undefined,
  settings.exemptModerators ? "moderators" : undefined,
  settings.exemptVips ? "vips" : undefined,
  settings.exemptSubscribers ? "subscribers" : undefined
].filter(Boolean);

const enabledEnforcementFilterNames = (settings: ModerationSettings) => [
  settings.blockedTermsEnabled && settings.blockedTermsAction !== "warn"
    ? `blocked_terms:${settings.blockedTermsAction}`
    : undefined,
  settings.linkFilterEnabled && settings.linkFilterAction !== "warn"
    ? `links:${settings.linkFilterAction}`
    : undefined,
  settings.capsFilterEnabled && settings.capsFilterAction !== "warn"
    ? `caps:${settings.capsFilterAction}`
    : undefined,
  settings.repeatFilterEnabled && settings.repeatFilterAction !== "warn"
    ? `repeat:${settings.repeatFilterAction}`
    : undefined,
  settings.symbolFilterEnabled && settings.symbolFilterAction !== "warn"
    ? `symbols:${settings.symbolFilterAction}`
    : undefined
].filter(Boolean);

const actionRank: Record<ModerationAction, number> = {
  warn: 0,
  delete: 1,
  timeout: 2
};

const strongestAction = (actions: ModerationAction[]): ModerationAction =>
  actions.reduce<ModerationAction>(
    (strongest, action) => actionRank[action] > actionRank[strongest] ? action : strongest,
    "warn"
  );

const findLinkDomains = (text: string) => {
  const matches = text.matchAll(
    /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?:\/[^\s]*)?/gi
  );

  return [...matches]
    .map((match) => normalizeMatchedDomain(match[1] ?? ""))
    .filter(Boolean);
};

const normalizeMatchedDomain = (domain: string) =>
  domain.toLowerCase().replace(/^www\./, "");

const unique = <T>(items: T[]) => [...new Set(items)];

const domainMatchesAllowed = (domain: string, allowedDomain: string) =>
  domain === allowedDomain || domain.endsWith(`.${allowedDomain}`);

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
