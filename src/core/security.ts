export const limits = {
  chatMessageLength: 450,
  commandLength: 450,
  commandNameLength: 32,
  giveawayTitleLength: 80,
  keywordLength: 24,
  loginLength: 25,
  displayNameLength: 50,
  customCommandResponsesMax: 8,
  customCommandAliasesMax: 8,
  customCommandCooldownMaxSeconds: 86_400,
  auditMetadataLength: 2000,
  winnerCountMax: 100,
  requestBodyBytes: 64 * 1024
} as const;

const twitchLoginPattern = /^[a-z0-9_]{1,25}$/;
const keywordPattern = /^[a-z0-9_]{1,24}$/;
const commandNamePattern = /^[a-z0-9_]{1,32}$/;
const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const invisibleCharacters = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const secretKeys = /token|secret|authorization|clientSecret|code|refresh/i;

export class SafeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeInputError";
  }
}

export const sanitizeText = (
  value: unknown,
  options: {
    field: string;
    maxLength: number;
    allowNewlines?: boolean;
    required?: boolean;
  }
) => {
  if (typeof value !== "string") {
    if (options.required) {
      throw new SafeInputError(`${options.field} is required.`);
    }

    return "";
  }

  let text = value
    .normalize("NFKC")
    .replace(controlCharacters, "")
    .replace(invisibleCharacters, "");

  if (!options.allowNewlines) {
    text = text.replace(/[\r\n]+/g, " ");
  }

  text = text.trim().replace(/[ \t]{2,}/g, " ");

  if (!text && options.required) {
    throw new SafeInputError(`${options.field} is required.`);
  }

  if (text.length > options.maxLength) {
    throw new SafeInputError(
      `${options.field} must be ${options.maxLength} characters or less.`
    );
  }

  return text;
};

export const sanitizeCommandText = (value: unknown) =>
  sanitizeText(value, {
    field: "Command text",
    maxLength: limits.commandLength,
    required: true
  });

export const sanitizeChatMessage = (value: unknown) =>
  sanitizeText(value, {
    field: "Chat message",
    maxLength: limits.chatMessageLength,
    required: true
  });

export const sanitizeGiveawayTitle = (value: unknown, fallback = "IOI code giveaway") => {
  const title = sanitizeText(value ?? fallback, {
    field: "Giveaway title",
    maxLength: limits.giveawayTitleLength,
    required: true
  });

  return title || fallback;
};

export const normalizeKeyword = (value: unknown, fallback = "enter") => {
  const keyword = sanitizeText(value ?? fallback, {
    field: "Keyword",
    maxLength: limits.keywordLength,
    required: true
  })
    .replace(/^!/, "")
    .toLowerCase();

  if (!keywordPattern.test(keyword)) {
    throw new SafeInputError("Keyword must use only letters, numbers, or underscores.");
  }

  return keyword;
};

export const normalizeCommandName = (value: unknown, field = "Command name") => {
  const name = sanitizeText(value, {
    field,
    maxLength: limits.commandNameLength,
    required: true
  })
    .replace(/^!/, "")
    .toLowerCase();

  if (!commandNamePattern.test(name)) {
    throw new SafeInputError(`${field} must use only letters, numbers, or underscores.`);
  }

  return name;
};

export const normalizeLogin = (value: unknown, field = "Username") => {
  const login = sanitizeText(value, {
    field,
    maxLength: limits.loginLength,
    required: true
  })
    .replace(/^@/, "")
    .toLowerCase();

  if (!twitchLoginPattern.test(login)) {
    throw new SafeInputError(`${field} must be a Twitch-style login.`);
  }

  return login;
};

export const sanitizeDisplayName = (value: unknown, fallback: string) =>
  sanitizeText(value ?? fallback, {
    field: "Display name",
    maxLength: limits.displayNameLength
  }) || fallback;

export const parseSafeInteger = (
  value: unknown,
  options: { field: string; fallback?: number; min?: number; max?: number } = {
    field: "Number"
  }
) => {
  if (value === undefined || value === null || value === "") {
    if (options.fallback !== undefined) {
      return options.fallback;
    }

    throw new SafeInputError(`${options.field} is required.`);
  }

  const raw = typeof value === "number" ? String(value) : String(value).trim();

  if (!/^\d+$/.test(raw)) {
    throw new SafeInputError(`${options.field} must be a whole number.`);
  }

  const parsed = Number.parseInt(raw, 10);
  const min = options.min ?? 1;
  const max = options.max ?? limits.winnerCountMax;

  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new SafeInputError(`${options.field} must be between ${min} and ${max}.`);
  }

  return parsed;
};

export const redactSecrets = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        secretKeys.test(key) ? "[redacted]" : redactSecrets(item)
      ])
    );
  }

  if (typeof value === "string" && value.length > 120) {
    return `${value.slice(0, 120)}...`;
  }

  return value;
};

export const safeJsonStringify = (metadata: Record<string, unknown>) => {
  const json = JSON.stringify(redactSecrets(metadata));

  if (json.length <= limits.auditMetadataLength) {
    return json;
  }

  return JSON.stringify({
    truncated: true,
    keys: Object.keys(metadata).slice(0, 20)
  });
};

export const safeErrorMessage = (error: unknown, fallback = "Request failed") => {
  if (error instanceof SafeInputError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  }

  return fallback;
};
