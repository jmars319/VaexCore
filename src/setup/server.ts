import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { URL } from "node:url";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLogger } from "../core/logger";
import type { ChatMessage } from "../core/chatMessage";
import { CommandRouter } from "../core/commandRouter";
import {
  MessageQueue,
  type MessageQueueEventStatus,
  type MessageQueueMetadata
} from "../core/messageQueue";
import { createOperatorMessageTemplateStore } from "../core/operatorMessages";
import {
  classifyOutboundMessage,
  createOutboundHistory,
  isOutboundCategory,
  isOutboundFailureCategory,
  isOutboundImportance,
  isPendingOutboundStatus,
  type OutboundMessageRecord
} from "../core/outboundHistory";
import {
  createFeatureGateStore,
  type FeatureGateState,
  type FeatureGateMode,
  type FeatureKey
} from "../core/featureGates";
import { createRuntimeStatus } from "../core/runtimeStatus";
import { registerCommandsModule } from "../modules/commands/commands.module";
import {
  CustomCommandsService,
  getReservedCustomCommandNames
} from "../modules/commands/commands.service";
import {
  limits,
  normalizeCommandName,
  normalizeKeyword,
  normalizeLogin as normalizeTwitchLogin,
  parseSafeInteger,
  redactSecrets,
  redactSecretText,
  safeErrorMessage,
  sanitizeChatMessage,
  sanitizeCommandText,
  sanitizeDisplayName,
  sanitizeGiveawayTitle,
  sanitizeText
} from "../core/security";
import { createDbClient, resolveDatabasePath } from "../db/client";
import { registerGiveawayCommands } from "../modules/giveaways/giveaways.commands";
import { formatWinnerNames } from "../modules/giveaways/giveaways.messages";
import { GiveawaysService } from "../modules/giveaways/giveaways.service";
import { createGiveawayTemplateStore } from "../modules/giveaways/giveaways.templates";
import {
  defaultRedirectUri,
  getLocalSecretsPath,
  readLocalSecrets,
  writeLocalSecrets,
  type LocalSecrets
} from "../config/localSecrets";
import { TwitchChatSender } from "../twitch/sendMessage";
import {
  getTwitchUserByLogin,
  requiredTwitchScopes,
  validateToken
} from "../twitch/validate";
import {
  getTokenExpiresAt,
  refreshStoredTwitchToken,
  type TwitchOAuthTokenResponse,
  validateStoredTwitchToken
} from "../twitch/tokenManager";

export type SetupServerHandle = {
  url: string;
  stop: () => Promise<void>;
};

const host = "127.0.0.1";
const defaultPort = 3434;
const queueStaleWarningMs = 30_000;
const databaseUrl = process.env.DATABASE_URL ?? "file:./data/vaexcore.sqlite";
const logger = createLogger("info");
const oauthStates = new Map<string, number>();
const db = createDbClient(databaseUrl);
const giveawaysService = new GiveawaysService({ db, logger });
const featureGates = createFeatureGateStore(db);
const customCommandsService = new CustomCommandsService(db, { featureGates });
const giveawayTemplates = createGiveawayTemplateStore(db);
const operatorMessages = createOperatorMessageTemplateStore(db);
const setupRuntimeStatus = createRuntimeStatus("local");
const outboundHistory = createOutboundHistory(db);
const chatQueue = new MessageQueue({
  logger,
  send: async (message) => sendConfiguredChatMessage(message),
  onEvent: (event) => outboundHistory.record({
    ...event,
    source: "setup"
  })
});
chatQueue.start();
setupRuntimeStatus.messageQueueReady = chatQueue.isReady();
const botProcess = createBotProcessState();
const giveawayReminder = createGiveawayReminderState();

export const startSetupServer = async (options: { port?: number } = {}) => {
  const port = options.port ?? defaultPort;
  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      logger.error({ error: redactSecrets(error) }, "Setup request failed");
      sendJson(response, 500, {
        ok: false,
        error: safeErrorMessage(error, "Setup request failed")
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  logger.info(
    { url: `http://localhost:${port}`, secretsPath: getLocalSecretsPath() },
    "VaexCore setup server started"
  );

  scheduleGiveawayReminder();

  return {
    url: `http://localhost:${port}`,
    stop: async () => {
      clearGiveawayReminderTimer();
      await stopBotProcess({ force: true });
      await chatQueue.drain(3000);
      chatQueue.stop();
      db.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } satisfies SetupServerHandle;
};

const route = async (request: IncomingMessage, response: ServerResponse) => {
  if (!isLocalRequest(request)) {
    sendText(response, 403, "VaexCore setup is local-only.");
    return;
  }

  if (!isAllowedHost(request.headers.host)) {
    sendText(response, 403, "VaexCore setup only accepts localhost requests.");
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && url.pathname === "/") {
    sendHtml(response, setupShellHtml);
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/ui/")) {
    sendStaticUiAsset(response, url.pathname);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, getSafeConfig());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/config") {
    const body = await readJson(request);
    const saved = saveConfig(body);
    sendJson(response, 200, { ok: true, config: saved });
    return;
  }

  if (request.method === "GET" && url.pathname === "/auth/twitch/start") {
    redirectToTwitch(response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/twitch/disconnect") {
    sendJson(response, 200, { ok: true, config: disconnectTwitch() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/auth/twitch/callback") {
    await handleTwitchCallback(url, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/validate") {
    sendJson(response, 200, await validateSetup());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/test-send") {
    sendJson(response, 200, await sendTestMessage());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    sendJson(response, 200, await getOperatorStatus());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/diagnostics") {
    sendJson(response, 200, getDiagnosticsReport());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/support-bundle") {
    sendJson(response, 200, getSupportBundle());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/feature-gates") {
    sendJson(response, 200, getFeatureGates());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/feature-gates") {
    const body = (await readJson(request)) as { key?: FeatureKey; mode?: FeatureGateMode };
    sendJson(response, 200, setFeatureGate(body));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/preflight") {
    sendJson(response, 200, await runPreflightCheck());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/bot/start") {
    sendJson(response, 200, await startBotProcess());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/bot/stop") {
    sendJson(response, 200, await stopBotProcess());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/chat/send") {
    const body = (await readJson(request)) as { message?: string };
    sendJson(response, 200, await enqueueChatMessage(body.message));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/operator-messages") {
    sendJson(response, 200, getOperatorMessages());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/operator-messages") {
    const body = await readJson(request);
    sendJson(response, 200, saveOperatorMessages(body));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/operator-messages/reset") {
    const body = (await readJson(request)) as { ids?: string[] };
    sendJson(response, 200, resetOperatorMessages(body.ids));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/operator-messages/send") {
    const body = (await readJson(request)) as { id?: string; confirmed?: boolean };
    sendJson(response, 200, await sendOperatorMessage(body));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/commands") {
    sendJson(response, 200, getCustomCommands());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/commands") {
    const body = await readJson(request);
    sendJson(response, 200, saveCustomCommand(body));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/commands/enable") {
    const body = (await readJson(request)) as { id?: number; enabled?: boolean };
    sendJson(response, 200, setCustomCommandEnabled(body));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/commands/duplicate") {
    const body = (await readJson(request)) as { id?: number };
    sendJson(response, 200, duplicateCustomCommand(body.id));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/commands/delete") {
    const body = (await readJson(request)) as { id?: number };
    sendJson(response, 200, deleteCustomCommand(body.id));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/commands/export") {
    sendJson(response, 200, customCommandsService.exportCommands());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/commands/import") {
    const body = await readJson(request);
    sendJson(response, 200, importCustomCommands(body));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/commands/preview") {
    const body = await readJson(request);
    sendJson(response, 200, previewCustomCommand(body));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/outbound-messages") {
    sendJson(response, 200, getOutboundMessages());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/outbound-messages/resend") {
    const body = (await readJson(request)) as { id?: string };
    sendJson(response, 200, await resendOutboundMessage(body.id));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/giveaway") {
    sendJson(response, 200, getGiveawayState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/giveaway/announcement/resend") {
    const body = (await readJson(request)) as { action?: string };
    sendJson(response, 200, await resendGiveawayAnnouncement(body.action));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/giveaway/critical/resend") {
    sendJson(response, 200, await resendCriticalGiveawayMessage());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/giveaway/status/send") {
    sendJson(response, 200, await sendCurrentGiveawayStatus());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/giveaway/templates") {
    sendJson(response, 200, getGiveawayTemplates());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/giveaway/templates") {
    const body = await readJson(request);
    sendJson(response, 200, saveGiveawayTemplates(body));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/giveaway/templates/reset") {
    const body = (await readJson(request)) as { actions?: string[] };
    sendJson(response, 200, resetGiveawayTemplates(body.actions));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/giveaway/reminder") {
    sendJson(response, 200, getGiveawayReminder());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/giveaway/reminder") {
    const body = await readJson(request);
    sendJson(response, 200, setGiveawayReminder(body));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/giveaway/reminder/send") {
    sendJson(response, 200, sendGiveawayReminderNow());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/giveaway/start") {
    const body = (await readJson(request)) as {
      title?: string;
      keyword?: string;
      winnerCount?: number;
      echoToChat?: boolean;
    };
    const title = sanitizeGiveawayTitle(body.title);
    const keyword = normalizeKeyword(body.keyword);
    const winnerCount = parseSafeInteger(body.winnerCount, {
      field: "Winner count",
      fallback: 6,
      min: 1,
      max: limits.winnerCountMax
    });
    sendJson(response, 200, runGiveawayAction(() => {
      const giveaway = giveawaysService.start({
        actor: localUiActor,
        title,
        keyword,
        winnerCount
      });
      return { giveaway };
    }, {
      echoToChat: Boolean(body.echoToChat),
      echoCommand: `!gstart codes=${winnerCount} keyword=${keyword} title="${title.replace(/"/g, "'")}"`,
      announcements: ({ giveaway }) =>
        giveawayAnnouncement(giveawayTemplates.start(giveaway), "start", giveaway.id, "critical")
    }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/giveaway/close") {
    const body = (await readJson(request)) as { echoToChat?: boolean };
    sendJson(response, 200, runGiveawayAction(() => ({
      giveaway: giveawaysService.close(localUiActor)
    }), {
      echoToChat: Boolean(body.echoToChat),
      echoCommand: "!gclose",
      announcements: ({ giveaway }) =>
        giveawayAnnouncement(
          giveawayTemplates.close(giveaway, giveawaysService.countEntriesForGiveaway(giveaway.id)),
          "close",
          giveaway.id,
          "critical"
        )
    }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/giveaway/last-call") {
    sendJson(response, 200, runGiveawayAction(() => {
      const status = giveawaysService.status();

      if (!status || status.giveaway.status !== "open") {
        throw new Error("Last call is only available while entries are open.");
      }

      return {
        giveaway: status.giveaway,
        entryCount: status.entries
      };
    }, {
      announcements: ({ giveaway, entryCount }) =>
        giveawayAnnouncement(
          giveawayTemplates.lastCall(giveaway, entryCount),
          "last-call",
          giveaway.id,
          "critical"
        )
    }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/giveaway/draw") {
    const body = (await readJson(request)) as { count?: number; echoToChat?: boolean };
    const count = parseSafeInteger(body.count, {
      field: "Winner count",
      fallback: 6,
      min: 1,
      max: limits.winnerCountMax
    });
    sendJson(response, 200, runGiveawayAction(() => ({
      result: giveawaysService.draw(localUiActor, count)
    }), {
      echoToChat: Boolean(body.echoToChat),
      echoCommand: `!gdraw ${count}`,
      announcements: ({ result }) =>
        giveawayAnnouncement(giveawayTemplates.draw(result), "draw", result.giveaway.id, "critical")
    }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/giveaway/reroll") {
    const body = (await readJson(request)) as { username?: string; echoToChat?: boolean };
    sendJson(response, 200, runGiveawayAction(() => ({
      result: giveawaysService.reroll(localUiActor, requireUsername(body.username))
    }), {
      echoToChat: Boolean(body.echoToChat),
      echoCommand: body.username ? `!greroll ${requireUsername(body.username)}` : undefined,
      announcements: ({ result }) =>
        giveawayAnnouncement(giveawayTemplates.reroll(result), "reroll", result.giveaway.id, "important")
    }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/giveaway/claim") {
    const body = (await readJson(request)) as { username?: string; echoToChat?: boolean };
    sendJson(response, 200, runGiveawayAction(() => ({
      result: giveawaysService.claim(localUiActor, requireUsername(body.username))
    }), {
      echoToChat: Boolean(body.echoToChat),
      echoCommand: body.username ? `!gclaim ${requireUsername(body.username)}` : undefined
    }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/giveaway/deliver") {
    const body = (await readJson(request)) as { username?: string; echoToChat?: boolean };
    sendJson(response, 200, runGiveawayAction(() => ({
      result: giveawaysService.deliver(localUiActor, requireUsername(body.username))
    }), {
      echoToChat: Boolean(body.echoToChat),
      echoCommand: body.username ? `!gdeliver ${requireUsername(body.username)}` : undefined
    }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/giveaway/deliver-all") {
    sendJson(response, 200, runGiveawayAction(() => ({
      result: giveawaysService.deliverAll(localUiActor)
    })));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/giveaway/end") {
    const body = (await readJson(request)) as { echoToChat?: boolean };
    sendJson(response, 200, runGiveawayAction(() => ({
      giveaway: giveawaysService.end(localUiActor)
    }), {
      echoToChat: Boolean(body.echoToChat),
      echoCommand: "!gend",
      announcements: ({ giveaway }) =>
        giveawayAnnouncement(
          giveawayTemplates.end(giveaway, giveawaysService.getWinnersForGiveaway(giveaway.id)),
          "end",
          giveaway.id,
          "critical"
        )
    }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/giveaway/add-entrant") {
    const body = (await readJson(request)) as {
      login?: string;
      displayName?: string;
      echoToChat?: boolean;
    };
    sendJson(response, 200, runGiveawayAction(() => ({
      result: giveawaysService.addSimulatedEntrant(
        simulatedChatActor,
        createLocalChatMessage({
          login: requireUsername(body.login),
          displayName: sanitizeDisplayName(body.displayName, requireUsername(body.login)),
          role: "viewer",
          text: "!enter"
        })
      )
    }), {
      echoToChat: Boolean(body.echoToChat),
      echoCommand: "!enter",
      announcements: ({ result }) =>
        result.status === "entered"
          ? giveawayAnnouncement(
              giveawayTemplates.entry({
                giveaway: result.giveaway,
                displayName: result.displayName,
                entryCount: result.entryCount
              }),
              "entry",
              result.giveaway.id
            )
          : undefined
    }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/command/simulate") {
    const body = (await readJson(request)) as {
      actor?: string;
      role?: "viewer" | "mod" | "broadcaster";
      command?: string;
      echoToChat?: boolean;
    };
    sendJson(response, 200, await simulateCommand(body));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/giveaway/run-test") {
    const body = (await readJson(request)) as { echoToChat?: boolean; confirmed?: boolean };
    sendJson(response, 200, runLocalLifecycleTest({
      echoToChat: Boolean(body.echoToChat),
      confirmed: Boolean(body.confirmed)
    }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/audit-logs") {
    sendJson(response, 200, {
      ok: true,
      logs: giveawaysService.getRecentAuditLogs(100)
    });
    return;
  }

  sendJson(response, 404, { ok: false, error: "Not found" });
};

const getSafeConfig = () => {
  const secrets = readLocalSecrets();
  const twitch = secrets.twitch;

  return {
    mode: secrets.mode,
    hasClientId: Boolean(twitch.clientId),
    hasClientSecret: Boolean(twitch.clientSecret),
    hasAccessToken: Boolean(twitch.accessToken),
    hasRefreshToken: Boolean(twitch.refreshToken),
    hasBroadcasterUserId: Boolean(twitch.broadcasterUserId),
    hasBotUserId: Boolean(twitch.botUserId),
    broadcasterLogin: twitch.broadcasterLogin ?? "",
    botLogin: twitch.botLogin ?? "",
    redirectUri: twitch.redirectUri ?? defaultRedirectUri,
    requiredScopes: requiredTwitchScopes,
    scopes: twitch.scopes,
    tokenExpiresAt: twitch.tokenExpiresAt ?? "",
    tokenValidatedAt: twitch.tokenValidatedAt ?? "",
    token: twitch.accessToken ? maskToken(twitch.accessToken) : ""
  };
};

const saveConfig = (body: unknown) => {
  const input = body as Record<string, string>;
  const existing = readLocalSecrets();
  const redirectUri = sanitizeRedirectUri(input.redirectUri);
  const clientId = valueOrExisting(
    sanitizeOptionalText(input.clientId, "Client ID", 120),
    existing.twitch.clientId
  );
  const clientSecret = valueOrExisting(
    sanitizeOptionalText(input.clientSecret, "Client secret", 200),
    existing.twitch.clientSecret
  );
  const broadcasterLogin = valueOrExistingLogin(
    input,
    "broadcasterLogin",
    existing.twitch.broadcasterLogin
  );
  const botLogin = valueOrExistingLogin(input, "botLogin", existing.twitch.botLogin);
  const appConfigChanged =
    clientId !== existing.twitch.clientId ||
    clientSecret !== existing.twitch.clientSecret ||
    redirectUri !== (existing.twitch.redirectUri ?? defaultRedirectUri);
  const broadcasterChanged = broadcasterLogin !== existing.twitch.broadcasterLogin;
  const botChanged = botLogin !== existing.twitch.botLogin;
  const twitch: LocalSecrets["twitch"] = {
    ...existing.twitch,
    clientId,
    clientSecret,
    redirectUri,
    broadcasterLogin,
    botLogin
  };

  if (appConfigChanged || botChanged) {
    Object.assign(twitch, clearTwitchAuthorization(twitch));
  }

  if (appConfigChanged || broadcasterChanged) {
    twitch.broadcasterUserId = undefined;
    twitch.tokenValidatedAt = undefined;
  }

  const next: LocalSecrets = {
    mode: input.mode === "local" ? "local" : "live",
    twitch
  };

  writeLocalSecrets(next);
  return getSafeConfig();
};

const disconnectTwitch = () => {
  const secrets = readLocalSecrets();
  writeLocalSecrets({
    ...secrets,
    twitch: clearTwitchAuthorization(secrets.twitch, { clearBroadcasterIdentity: true })
  });
  return getSafeConfig();
};

const redirectToTwitch = (response: ServerResponse) => {
  const secrets = readLocalSecrets();
  const twitch = secrets.twitch;

  if (!twitch.clientId || !twitch.clientSecret) {
    redirect(response, "/?error=missing_client_credentials");
    return;
  }

  const state = randomBytes(16).toString("hex");
  oauthStates.set(state, Date.now() + 10 * 60 * 1000);

  const authorizeUrl = new URL("https://id.twitch.tv/oauth2/authorize");
  authorizeUrl.searchParams.set("client_id", twitch.clientId);
  authorizeUrl.searchParams.set("redirect_uri", twitch.redirectUri ?? defaultRedirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", requiredTwitchScopes.join(" "));
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("force_verify", "true");

  redirect(response, authorizeUrl.toString());
};

const handleTwitchCallback = async (url: URL, response: ServerResponse) => {
  const error = url.searchParams.get("error");

  if (error) {
    redirect(response, `/?error=${encodeURIComponent(error)}`);
    return;
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state || !consumeOauthState(state)) {
    redirect(response, "/?error=invalid_oauth_state");
    return;
  }

  const secrets = readLocalSecrets();
  const twitch = secrets.twitch;

  if (!twitch.clientId || !twitch.clientSecret) {
    redirect(response, "/?error=missing_client_credentials");
    return;
  }

  const tokens = await exchangeCode({
    code,
    clientId: twitch.clientId,
    clientSecret: twitch.clientSecret,
    redirectUri: twitch.redirectUri ?? defaultRedirectUri
  });
  const validation = await validateToken(tokens.access_token);
  const expiresAt = getTokenExpiresAt(tokens.expires_in);
  const tokenLogin = normalizeTwitchLogin(validation.login);
  const configuredBotLogin = twitch.botLogin
    ? normalizeTwitchLogin(twitch.botLogin)
    : undefined;
  const tokenMatchesConfiguredBot =
    !configuredBotLogin || configuredBotLogin === tokenLogin;

  if (!tokenMatchesConfiguredBot) {
    writeLocalSecrets({
      ...secrets,
      twitch: clearTwitchAuthorization(twitch)
    });
    const params = new URLSearchParams({
      error: "wrong_bot_account",
      connected_login: tokenLogin,
      expected_login: configuredBotLogin ?? ""
    });
    redirect(response, `/?${params.toString()}`);
    return;
  }

  writeLocalSecrets({
    ...secrets,
    twitch: {
      ...twitch,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      scopes: validation.scopes,
      tokenExpiresAt: expiresAt,
      tokenValidatedAt: new Date().toISOString(),
      botLogin: configuredBotLogin || tokenLogin,
      botUserId: tokenMatchesConfiguredBot ? validation.user_id : undefined
    }
  });

  redirect(response, "/?connected=1");
};

const validateSetup = async () => {
  const secrets = readLocalSecrets();
  const twitch = secrets.twitch;
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  const fail = (name: string, detail: string) => checks.push({ name, ok: false, detail });
  const pass = (name: string, detail: string) => checks.push({ name, ok: true, detail });

  if (!twitch.clientId || !twitch.clientSecret) {
    fail("Twitch app credentials", "Client ID and client secret are required.");
    return { ok: false, checks };
  }

  if (!twitch.accessToken) {
    fail("OAuth token", "Click Connect Twitch first.");
    return { ok: false, checks };
  }

  let validated: Awaited<ReturnType<typeof validateStoredTwitchToken>>;

  try {
    validated = await validateStoredTwitchToken({ secrets, logger });
  } catch (error) {
    const detail = safeErrorMessage(
      error,
      "Twitch token validation failed. Reconnect Twitch and try again."
    );
    fail("OAuth token", detail);
    return { ok: false, checks, error: detail };
  }

  const activeSecrets = validated.secrets;
  const activeTwitch = validated.twitch;
  const token = validated.token;
  const activeAccessToken = activeTwitch.accessToken;
  const activeClientId = activeTwitch.clientId ?? twitch.clientId;

  if (!activeClientId || !activeAccessToken) {
    fail("OAuth token", "Validated Twitch token was not available after refresh.");
    return { ok: false, checks };
  }

  pass(
    validated.refreshed ? "Token refreshed" : "Token valid",
    validated.refreshed
      ? `Access token refreshed for ${token.login}.`
      : `Token belongs to ${token.login}.`
  );

  if (token.client_id !== activeClientId) {
    fail("Twitch app", "OAuth token belongs to a different Twitch application.");
  } else {
    pass("Twitch app", "OAuth token matches the saved Client ID.");
  }

  const missingScopes = requiredTwitchScopes.filter(
    (scope) => !token.scopes.includes(scope)
  );

  if (missingScopes.length > 0) {
    fail("Required scopes", `Missing: ${missingScopes.join(", ")}.`);
  } else {
    pass("Required scopes", token.scopes.join(", "));
  }

  const botLogin = activeTwitch.botLogin ?? twitch.botLogin;
  const broadcasterLogin = activeTwitch.broadcasterLogin ?? twitch.broadcasterLogin;
  const botUser = botLogin
    ? await getTwitchUserByLogin(
        { clientId: activeClientId, accessToken: activeAccessToken },
        botLogin
      )
    : undefined;
  const broadcasterUser = broadcasterLogin
    ? await getTwitchUserByLogin(
        { clientId: activeClientId, accessToken: activeAccessToken },
        broadcasterLogin
      )
    : undefined;

  if (!botUser) {
    fail("Bot identity", "Bot login was not found.");
  } else if (botUser.id !== token.user_id) {
    fail(
      "Bot identity",
      `OAuth token belongs to ${token.login}, but bot login resolves to ${botUser.login}.`
    );
  } else {
    pass("Bot identity", `${botUser.login} (${botUser.id})`);
  }

  if (!broadcasterUser) {
    fail("Broadcaster identity", "Broadcaster login was not found.");
  } else {
    pass("Broadcaster identity", `${broadcasterUser.login} (${broadcasterUser.id})`);
  }

  const setupOk = checks.every((check) => check.ok);
  const nextTwitch: LocalSecrets["twitch"] = {
    ...activeTwitch,
    scopes: token.scopes,
    tokenValidatedAt: setupOk ? new Date().toISOString() : undefined,
    botUserId: undefined,
    broadcasterUserId: undefined
  };

  if (botUser && botUser.id === token.user_id) {
    nextTwitch.botLogin = botUser.login;
    nextTwitch.botUserId = botUser.id;
  }

  if (broadcasterUser) {
    nextTwitch.broadcasterLogin = broadcasterUser.login;
    nextTwitch.broadcasterUserId = broadcasterUser.id;
  }

  writeLocalSecrets({
    ...activeSecrets,
    twitch: nextTwitch
  });

  return { ok: setupOk, checks };
};

const sendTestMessage = async () => {
  const validation = await validateSetup();

  if (!validation.ok) {
    return {
      ok: false,
      checks: validation.checks,
      error: "Validation must pass before sending a test message."
    };
  }

  const secrets = readLocalSecrets();
  const twitch = secrets.twitch;

  if (
    !twitch.clientId ||
    !twitch.accessToken ||
    !twitch.broadcasterUserId ||
    !twitch.botUserId
  ) {
    return { ok: false, error: "Setup is missing resolved Twitch IDs." };
  }

  const result = await sendConfiguredChatMessage("VaexCore setup test.");
  const structured = typeof result === "string" ? { status: result } : result;
  return {
    ok: structured.status === "sent",
    error: structured.status === "sent" ? undefined : structured.reason || "Test chat message was not sent.",
    failureCategory: structured.failureCategory
  };
};

const getOperatorStatus = async () => {
  let config = getSafeConfig();
  let tokenValid = false;
  let requiredScopesPresent = false;
  let tokenRefreshed = false;

  try {
    const secrets = readLocalSecrets();
    const validation = secrets.twitch.accessToken
      ? await validateStoredTwitchToken({ secrets, logger })
      : undefined;
    const token = validation?.token;
    tokenRefreshed = Boolean(validation?.refreshed);
    tokenValid = Boolean(token);
    requiredScopesPresent = token
      ? requiredTwitchScopes.every((scope) => token.scopes.includes(scope))
      : false;
    if (tokenRefreshed) {
      config = getSafeConfig();
    }
  } catch {
    tokenValid = false;
    requiredScopesPresent = false;
  }

  const giveaway = giveawaysService.getOperatorState();
  const queue = chatQueue.snapshot();
  const outbound = outboundHistory.summary();
  const featureGateStates = featureGates.list();

  return {
    ok: true,
    config,
    runtime: {
      mode: config.mode,
      botLogin: config.botLogin,
      broadcasterLogin: config.broadcasterLogin,
      tokenValid,
      tokenRefreshed,
      requiredScopesPresent,
      botProcess: getBotProcessSnapshot(),
      eventSubConnected: botProcess.eventSubConnected,
      chatSubscriptionActive: botProcess.chatSubscriptionActive,
      queueReady: chatQueue.isReady(),
      queue,
      queueHealth: summarizeQueueHealth(queue, outbound),
      outboundChat: outbound,
      outboundRecovery: summarizeOutboundRecovery(),
      liveChatConfirmed: botProcess.liveChatConfirmed,
      note: botProcess.child
        ? "Live bot runtime is managed by this setup console."
        : "Start the live bot runtime from Dashboard or Settings to receive chat commands."
    },
    featureGates: featureGateStates,
    giveaway: summarizeGiveawayState(giveaway)
  };
};

const runPreflightCheck = async () => {
  const status = await getOperatorStatus();
  const runtime = status.runtime;
  const giveawayState = getGiveawayState();
  const assurance = giveawayState.assurance;
  const outbound = outboundHistory.summary();
  const checks = [
    {
      name: "Twitch setup",
      ok: isSafeConfigComplete(),
      detail: isSafeConfigComplete()
        ? "Required local Twitch fields are present."
        : "Open Settings -> Setup Guide and complete credentials, usernames, OAuth, and validation."
    },
    {
      name: "Token and scopes",
      ok: runtime.tokenValid && runtime.requiredScopesPresent,
      detail: runtime.tokenValid && runtime.requiredScopesPresent
        ? "OAuth token is valid and required chat scopes are present."
        : "Run Validate Setup after connecting Twitch."
    },
    {
      name: "Setup queue",
      ok: runtime.queueReady,
      detail: runtime.queueReady
        ? "Outbound setup queue is ready."
        : "Restart the setup console if queue readiness does not recover."
    },
    {
      name: "Bot runtime",
      ok: Boolean(runtime.botProcess.running),
      detail: runtime.botProcess.running
        ? `Bot process is ${runtime.botProcess.status}.`
        : "Start bot process from Dashboard."
    },
    {
      name: "EventSub chat listener",
      ok: runtime.eventSubConnected && runtime.chatSubscriptionActive,
      detail: runtime.eventSubConnected && runtime.chatSubscriptionActive
        ? "Chat subscription is active."
        : "Wait for the bot process to connect to EventSub and create the chat subscription."
    },
    {
      name: "Live chat confirmation",
      ok: runtime.liveChatConfirmed,
      detail: runtime.liveChatConfirmed
        ? "Live chat has responded to !ping."
        : "Type !ping in Twitch chat after the bot starts."
    },
    {
      name: "Critical outbound failures",
      ok: outbound.criticalFailed === 0 && !assurance.blockContinue,
      detail: outbound.criticalFailed === 0 && !assurance.blockContinue
        ? "No critical giveaway chat failures are currently tracked."
        : assurance.nextAction || "Resend failed critical giveaway messages before continuing."
    },
    {
      name: "Giveaway controls",
      ok: giveawayState.summary.status === "none" || giveawayState.summary.status === "open" || giveawayState.summary.status === "closed",
      detail: giveawayState.summary.status === "none"
        ? "No active giveaway; start controls are ready."
        : `Giveaway is ${giveawayState.summary.status}; next action: ${giveawayState.summary.status === "open" ? "close entries before drawing" : "draw or finish delivery"}.`
    }
  ];
  const failed = checks.find((check) => !check.ok);

  return {
    ok: checks.every((check) => check.ok),
    checks,
    nextAction: failed?.detail ?? "Giveaway controls ready.",
    summary: giveawayState.summary
  };
};

type DiagnosticCheck = {
  name: string;
  ok: boolean;
  severity: "blocker" | "warning" | "info";
  detail: string;
};

const getDiagnosticsReport = () => {
  const generatedAt = new Date().toISOString();
  const packageInfo = getPackageInfo();
  const config = getSafeConfig();
  const database = getDatabaseDiagnostics();
  const queue = chatQueue.snapshot();
  const outbound = outboundHistory.summary();
  const giveaway = giveawaysService.getOperatorState();
  const giveawayState = getGiveawayState();
  const commands = customCommandsService.listCommands();
  const featureGateStates = featureGates.list();
  const queueHealth = summarizeQueueHealth(queue, outbound);
  const setupUi = getSetupUiDiagnostics();
  const botSnapshot = getBotProcessSnapshot();
  const firstRun = getFirstRunStatus({ config, database, setupUi });
  const checks = getDiagnosticChecks({
    config,
    database,
    setupUi,
    queue,
    queueHealth,
    outbound,
    giveawayState,
    botSnapshot,
    featureGates: featureGateStates
  });
  const blockers = checks.filter((check) => !check.ok && check.severity === "blocker");
  const warnings = checks.filter((check) => !check.ok && check.severity === "warning");

  return {
    ok: blockers.length === 0,
    generatedAt,
    app: {
      name: packageInfo.name,
      version: packageInfo.version,
      runtime: getRuntimeKind(),
      node: process.versions.node,
      electron: process.versions.electron ?? "",
      platform: process.platform,
      arch: process.arch
    },
    paths: {
      configDir: dirname(getLocalSecretsPath()),
      secretsPath: getLocalSecretsPath(),
      databaseUrl: safeDatabaseUrl(databaseUrl),
      databasePath: resolveDatabasePath(databaseUrl),
      setupUiDir: getSetupUiDir()
    },
    setupUi,
    firstRun,
    config,
    database,
    runtime: {
      botProcess: botSnapshot,
      eventSubConnected: botProcess.eventSubConnected,
      chatSubscriptionActive: botProcess.chatSubscriptionActive,
      liveChatConfirmed: botProcess.liveChatConfirmed,
      queueReady: chatQueue.isReady(),
      queue,
      queueHealth,
      outboundChat: outbound
    },
    giveaway: summarizeGiveawayState(giveaway),
    customCommands: {
      featureGate: featureGates.get("custom_commands"),
      total: commands.length,
      enabled: commands.filter((command) => command.enabled).length,
      disabled: commands.filter((command) => !command.enabled).length,
      aliases: commands.reduce((total, command) => total + command.aliases.length, 0),
      uses: commands.reduce((total, command) => total + command.useCount, 0)
    },
    featureGates: featureGateStates,
    readiness: {
      status: blockers.length > 0 ? "not_ready" : warnings.length > 0 ? "attention" : "ready",
      blockers: blockers.map((check) => `${check.name}: ${check.detail}`),
      warnings: warnings.map((check) => `${check.name}: ${check.detail}`),
      nextAction: blockers[0]?.detail ?? warnings[0]?.detail ?? "Diagnostics are clear."
    },
    checks
  };
};

const getSupportBundle = () => {
  const diagnostics = getDiagnosticsReport();
  const outbound = outboundHistory.list().slice(0, 50).map((record) => ({
    id: record.id,
    source: record.source,
    status: record.status,
    category: record.category,
    action: record.action,
    importance: record.importance,
    attempts: record.attempts,
    queuedAt: record.queuedAt,
    updatedAt: record.updatedAt,
    reason: safeSupportText(record.reason),
    failureCategory: record.failureCategory,
    retryAfterMs: record.retryAfterMs,
    nextAttemptAt: record.nextAttemptAt,
    queueDepth: record.queueDepth,
    giveawayId: record.giveawayId,
    messagePreview: safeSupportText(record.message).slice(0, 180)
  }));
  const audit = giveawaysService.getRecentAuditLogs(50).map((log) => ({
    id: log.id,
    actor: log.actor_twitch_user_id,
    action: log.action,
    target: log.target,
    createdAt: log.created_at,
    metadata: safeAuditMetadata(log.metadata_json)
  }));
  const customCommandInvocations = customCommandsService.getRecentInvocations(50).map((entry) => ({
    id: entry.id,
    commandName: entry.commandName,
    aliasUsed: entry.aliasUsed,
    userLogin: entry.userLogin,
    createdAt: entry.createdAt,
    responsePreview: safeSupportText(entry.responseText).slice(0, 180)
  }));
  const botLogs = getBotProcessSnapshot().recentLogs.slice(-40).map(safeSupportText);

  return {
    ok: true,
    bundleVersion: 1,
    generatedAt: new Date().toISOString(),
    note: "Secret-safe local support bundle. Twitch client secrets, access tokens, and refresh tokens are not included.",
    diagnostics,
    featureGates: featureGates.list(),
    recent: {
      botLogs,
      outbound,
      audit,
      customCommandInvocations
    },
    recovery: diagnostics.firstRun.recoverySteps
  };
};

const getDiagnosticChecks = (input: {
  config: ReturnType<typeof getSafeConfig>;
  database: ReturnType<typeof getDatabaseDiagnostics>;
  setupUi: ReturnType<typeof getSetupUiDiagnostics>;
  queue: ReturnType<MessageQueue["snapshot"]>;
  queueHealth: ReturnType<typeof summarizeQueueHealth>;
  outbound: ReturnType<typeof outboundHistory.summary>;
  giveawayState: ReturnType<typeof getGiveawayState>;
  botSnapshot: ReturnType<typeof getBotProcessSnapshot>;
  featureGates: FeatureGateState[];
}): DiagnosticCheck[] => [
  {
    name: "Setup UI assets",
    ok: input.setupUi.appJs && input.setupUi.stylesCss,
    severity: "blocker",
    detail: input.setupUi.appJs && input.setupUi.stylesCss
      ? "Static setup UI assets are present."
      : "Rebuild VaexCore so setup UI assets are available."
  },
  {
    name: "Database",
    ok: input.database.ok,
    severity: "blocker",
    detail: input.database.ok
      ? `${input.database.driver} responded to SELECT 1.`
      : input.database.error || "Database did not respond."
  },
  {
    name: "better-sqlite3",
    ok: input.database.driver === "better-sqlite3",
    severity: "warning",
    detail: input.database.driver === "better-sqlite3"
      ? "Native better-sqlite3 is active."
      : "Using SQLite fallback; rebuild the app package if this appears in Electron."
  },
  {
    name: "Required Twitch config",
    ok: isSafeConfigComplete(),
    severity: "blocker",
    detail: isSafeConfigComplete()
      ? "Required Twitch config fields are present."
      : "Open Settings -> Setup Guide and complete missing Twitch fields."
  },
  {
    name: "OAuth refresh",
    ok: input.config.hasClientSecret && input.config.hasRefreshToken,
    severity: "warning",
    detail: input.config.hasClientSecret && input.config.hasRefreshToken
      ? "Token refresh is available."
      : "Reconnect Twitch or add refresh-capable CLI config to enable automatic token refresh."
  },
  {
    name: "Validated identities",
    ok: input.config.hasBotUserId && input.config.hasBroadcasterUserId,
    severity: "blocker",
    detail: input.config.hasBotUserId && input.config.hasBroadcasterUserId
      ? "Bot and broadcaster identities are resolved."
      : "Run Validate Setup after connecting Twitch."
  },
  {
    name: "Outbound queue",
    ok: input.queue.ready && input.queueHealth.status !== "blocked",
    severity: "blocker",
    detail: input.queue.ready && input.queueHealth.status !== "blocked"
      ? "Outbound queue is ready."
      : input.queueHealth.nextAction
  },
  {
    name: "Critical giveaway chat",
    ok: input.outbound.criticalFailed === 0 && !input.giveawayState.assurance.blockContinue,
    severity: "blocker",
    detail: input.outbound.criticalFailed === 0 && !input.giveawayState.assurance.blockContinue
      ? "No blocking critical giveaway chat issue is tracked."
      : input.giveawayState.assurance.nextAction || "Resolve critical giveaway chat delivery before continuing."
  },
  {
    name: "Bot runtime",
    ok: Boolean(input.botSnapshot.running),
    severity: "warning",
    detail: input.botSnapshot.running
      ? `Bot process is ${input.botSnapshot.status}.`
      : "Start Bot when you are ready for live chat commands."
  },
  {
    name: "Live chat confirmation",
    ok: botProcess.liveChatConfirmed,
    severity: "warning",
    detail: botProcess.liveChatConfirmed
      ? "Live chat confirmation has been observed."
      : "Type !ping in chat after starting the bot."
  },
  {
    name: "Feature gates",
    ok: true,
    severity: "info",
    detail: input.featureGates
      .map((gate) => `${gate.label}: ${gate.mode}`)
      .join("; ")
  }
];

const getFirstRunStatus = (input: {
  config: ReturnType<typeof getSafeConfig>;
  database: ReturnType<typeof getDatabaseDiagnostics>;
  setupUi: ReturnType<typeof getSetupUiDiagnostics>;
}) => {
  const configFilePresent = existsSync(getLocalSecretsPath());
  const missingConfig = missingSafeConfigFields(input.config);
  const identitiesResolved = input.config.hasBotUserId && input.config.hasBroadcasterUserId;
  const cleanInstall = !configFilePresent && !input.config.hasClientId && !input.config.hasAccessToken;
  const blockers = [
    !input.setupUi.appJs || !input.setupUi.stylesCss
      ? "Setup UI assets are missing; rebuild VaexCore."
      : undefined,
    !input.database.ok
      ? "SQLite did not respond; rebuild or reset the local app data folder."
      : undefined,
    missingConfig.length > 0
      ? `Missing Twitch setup fields: ${missingConfig.join(", ")}.`
      : undefined,
    missingConfig.length === 0 && !identitiesResolved
      ? "Twitch identities are not validated; run Validate Setup."
      : undefined
  ].filter(Boolean) as string[];
  const warnings = [
    input.database.driver !== "better-sqlite3"
      ? "SQLite fallback is active; rebuild the packaged app if this appears in Electron."
      : undefined,
    input.config.hasClientSecret && !input.config.hasRefreshToken
      ? "Automatic token refresh is not available; reconnect Twitch to store a refresh token."
      : undefined
  ].filter(Boolean) as string[];

  const nextAction = cleanInstall
    ? "Open Settings -> Setup Guide."
    : blockers[0]
    ?? warnings[0]
    ?? "Start Bot when you are ready.";

  return {
    cleanInstall,
    configFilePresent,
    setupComplete: missingConfig.length === 0 && identitiesResolved,
    missingConfig,
    blockers,
    warnings,
    nextAction,
    recoverySteps: firstRunRecoverySteps({
      cleanInstall,
      blockers,
      warnings,
      configFilePresent,
      databaseOk: input.database.ok,
      setupUiOk: input.setupUi.appJs && input.setupUi.stylesCss
    })
  };
};

const missingSafeConfigFields = (config: ReturnType<typeof getSafeConfig>) => {
  const missing: string[] = [];
  if (!config.hasClientId) missing.push("Client ID");
  if (!config.hasClientSecret) missing.push("Client Secret");
  if (!config.redirectUri) missing.push("Redirect URI");
  if (!config.broadcasterLogin) missing.push("Broadcaster Login");
  if (!config.botLogin) missing.push("Bot Login");
  if (!config.hasAccessToken) missing.push("Twitch OAuth");
  return missing;
};

const firstRunRecoverySteps = (input: {
  cleanInstall: boolean;
  blockers: string[];
  warnings: string[];
  configFilePresent: boolean;
  databaseOk: boolean;
  setupUiOk: boolean;
}) => {
  if (input.cleanInstall) {
    return [
      "Open Settings -> Setup Guide.",
      "Create or reuse a Twitch Developer application.",
      "Save credentials and usernames, then Connect Twitch.",
      "Run Validate Setup, Send test message, then Start Bot."
    ];
  }

  if (!input.setupUiOk) {
    return ["Run npm run build, then reopen VaexCore or rerun npm run setup."];
  }

  if (!input.databaseOk) {
    return [
      "Quit VaexCore.",
      "Back up the local app data folder if needed.",
      "Rebuild the app; reset the local data folder only if SQLite remains unhealthy."
    ];
  }

  if (input.blockers.length > 0) {
    return [
      "Open Settings -> Setup Guide.",
      "Complete the missing setup item shown in Diagnostics.",
      "Run Validate Setup before starting the bot."
    ];
  }

  if (input.warnings.length > 0) {
    return [
      "Review the warning before going live.",
      "If token refresh is missing, reconnect Twitch.",
      "If SQLite fallback appears in Electron, rebuild the packaged app."
    ];
  }

  return ["Start Bot, then type !ping in Twitch chat to confirm live chat."];
};

const getDatabaseDiagnostics = () => {
  try {
    const row = db.prepare("SELECT 1 AS ok").get() as { ok?: unknown } | undefined;
    const ok = row?.ok === 1;

    return {
      ok,
      driver: db.pragma ? "better-sqlite3" : "node:sqlite fallback",
      path: resolveDatabasePath(databaseUrl),
      error: ok ? "" : "Unexpected SELECT 1 result."
    };
  } catch (error) {
    return {
      ok: false,
      driver: db.pragma ? "better-sqlite3" : "node:sqlite fallback",
      path: resolveDatabasePath(databaseUrl),
      error: safeErrorMessage(error, "Database probe failed.")
    };
  }
};

const getSetupUiDiagnostics = () => {
  const dir = getSetupUiDir();
  return {
    dir,
    appJs: existsSync(join(dir, "app.js")),
    stylesCss: existsSync(join(dir, "styles.css"))
  };
};

const getPackageInfo = () => {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), "package.json"),
    resolve(currentDir, "..", "package.json"),
    resolve(currentDir, "..", "..", "package.json")
  ];

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: string;
          version?: string;
        };
        return {
          name: parsed.name ?? "vaexcore",
          version: parsed.version ?? "unknown"
        };
      }
    } catch {
      continue;
    }
  }

  return { name: "vaexcore", version: "unknown" };
};

const getRuntimeKind = () => {
  if (process.versions.electron) {
    return "electron";
  }

  return dirname(fileURLToPath(import.meta.url)).includes("dist-bundle")
    ? "bundled-node"
    : "source-tsx";
};

const safeDatabaseUrl = (value: string) => {
  if (value === ":memory:") {
    return value;
  }

  if (value.startsWith("file:")) {
    return "file:<local sqlite path>";
  }

  return "<local sqlite path>";
};

const safeAuditMetadata = (raw: string) => {
  try {
    return redactSecrets(JSON.parse(raw));
  } catch {
    return safeSupportText(raw);
  }
};

const safeSupportText = (value: unknown) =>
  redactSecretText(String(value ?? ""));

const summarizeQueueHealth = (
  queue: ReturnType<MessageQueue["snapshot"]>,
  outbound: ReturnType<typeof outboundHistory.summary>
) => {
  const blockers = [
    !queue.ready ? "Outbound queue is not running." : undefined,
    queue.oldestAgeMs > queueStaleWarningMs
      ? `Oldest queued message has waited ${formatDuration(queue.oldestAgeMs)}.`
      : undefined,
    queue.rateLimitDelayMs > 0
      ? `Outbound queue is waiting ${formatDuration(queue.rateLimitDelayMs)} for the send throttle.`
      : undefined,
    outbound.criticalFailed > 0
      ? `${outbound.criticalFailed} critical outbound message(s) failed.`
      : undefined
  ].filter(Boolean) as string[];
  const status = !queue.ready || outbound.criticalFailed > 0
    ? "blocked"
    : blockers.length || queue.processing || queue.queued > 0 || queue.rateLimitDelayMs > 0 || queue.retryDelayMs > 0
      ? "watch"
      : "clear";
  const nextAction = !queue.ready
    ? "Restart the setup console if queue readiness does not recover."
    : outbound.criticalFailed > 0
      ? "Use panic resend or phase resend after confirming chat missed the message."
      : queue.retryDelayMs > 0
        ? `Waiting ${formatDuration(queue.retryDelayMs)} before the next retry.`
        : queue.rateLimitDelayMs > 0
          ? `Waiting ${formatDuration(queue.rateLimitDelayMs)} for the outbound send throttle.`
          : queue.oldestAgeMs > queueStaleWarningMs
            ? "Wait for the queue to flush or restart the bot if the age keeps rising."
            : queue.queued > 0 || queue.processing
              ? "Wait for queued chat messages to send."
              : "Outbound queue clear.";

  return {
    status,
    blockers,
    nextAction,
    stale: queue.oldestAgeMs > queueStaleWarningMs,
    oldestAgeMs: queue.oldestAgeMs,
    oldestAge: formatDuration(queue.oldestAgeMs),
    oldestAction: queue.oldestAction,
    oldestImportance: queue.oldestImportance,
    nextAttemptAt: queue.nextAttemptAt,
    retryDelayMs: queue.retryDelayMs,
    retryDelay: formatDuration(queue.retryDelayMs),
    rateLimited: queue.rateLimitDelayMs > 0,
    rateLimitedUntil: queue.rateLimitedUntil,
    rateLimitDelayMs: queue.rateLimitDelayMs,
    rateLimitDelay: formatDuration(queue.rateLimitDelayMs),
    pending: queue.queued,
    processing: queue.processing,
    maxAttempts: queue.maxAttempts,
    rateLimitedPending: outbound.rateLimited
  };
};

const summarizeOutboundRecovery = () => {
  const latestCritical = latestFailedCriticalGiveawayMessage();
  const latestFailed = latestCritical ?? outboundHistory.latestFailed();

  if (!latestFailed) {
    return {
      needed: false,
      severity: "clear",
      safeToResend: false,
      nextAction: "No outbound recovery needed.",
      steps: ["Keep monitoring Live Mode during giveaway transitions."]
    };
  }

  const safeToResend = canSendConfiguredChat();
  const critical = latestFailed.importance === "critical";

  return {
    needed: true,
    severity: critical ? "critical" : "warning",
    safeToResend,
    id: latestFailed.id,
    category: latestFailed.category,
    action: latestFailed.action,
    importance: latestFailed.importance,
    failureCategory: latestFailed.failureCategory,
    reason: latestFailed.reason || "No failure reason recorded.",
    updatedAt: latestFailed.updatedAt,
    attempts: latestFailed.attempts,
    giveawayId: latestFailed.giveawayId,
    nextAction: outboundRecoveryNextAction(latestFailed, safeToResend),
    steps: outboundRecoverySteps(latestFailed, safeToResend)
  };
};

const outboundRecoveryNextAction = (
  latestFailed: OutboundMessageRecord,
  safeToResend: boolean
) => {
  if (!safeToResend) {
    return latestFailed.failureCategory === "auth" || latestFailed.failureCategory === "config"
      ? "Fix Twitch setup and run Validate Setup before resending outbound chat."
      : "Run Validate Setup before resending outbound chat.";
  }

  if (latestFailed.failureCategory === "rate_limit") {
    return "Wait for the queue to clear, then resend only if Twitch chat missed the message.";
  }

  if (latestFailed.importance === "critical") {
    return "Use panic resend or phase resend if Twitch chat did not receive this critical message.";
  }

  return "Use resend if the message is still useful.";
};

const outboundRecoverySteps = (
  latestFailed: OutboundMessageRecord,
  safeToResend: boolean
) => {
  const categorySteps: Record<OutboundMessageRecord["failureCategory"], string> = {
    none: "No failure category was recorded.",
    config: "Open Settings and complete missing Twitch IDs or credentials.",
    auth: "Reconnect Twitch with the bot account and required chat scopes.",
    rate_limit: "Wait for Twitch rate limiting to clear before retrying.",
    twitch_rejected: "Check the message and Twitch response before retrying.",
    network: "Confirm local network connectivity before retrying.",
    timeout: "Retry after Twitch/network latency settles.",
    unknown: "Review the failure reason before retrying."
  };

  return [
    categorySteps[latestFailed.failureCategory],
    "Check Twitch chat for the original message.",
    safeToResend ? "Resend only if the message is missing or still relevant." : "Run Validate Setup before resending.",
    latestFailed.importance === "critical"
      ? "Use Live Mode -> Panic Resend for the latest failed critical giveaway message."
      : "Use Outbound Chat History -> Resend for this message.",
    "Watch Queue Health until pending messages clear."
  ];
};

const formatDuration = (ageMs: number) => {
  if (!Number.isFinite(ageMs) || ageMs <= 0) {
    return "0s";
  }

  const seconds = Math.round(ageMs / 1000);

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
};

const isSafeConfigComplete = () => {
  const config = getSafeConfig();
  return Boolean(
    config.hasClientId &&
    config.hasClientSecret &&
    config.hasAccessToken &&
    config.hasBroadcasterUserId &&
    config.hasBotUserId &&
    config.tokenValidatedAt
  );
};

type GiveawayReminderState = {
  enabled: boolean;
  intervalMinutes: number;
  lastSentAt: string;
  nextSendAt: string;
  lastError: string;
  timer: NodeJS.Timeout | undefined;
};

type GiveawayReminderSettingsRow = {
  enabled: number;
  interval_minutes: number;
  last_sent_at: string;
};

function createGiveawayReminderState(): GiveawayReminderState {
  const saved = readGiveawayReminderSettings();
  return {
    enabled: saved.enabled,
    intervalMinutes: saved.intervalMinutes,
    lastSentAt: saved.lastSentAt,
    nextSendAt: saved.enabled ? nextGiveawayReminderAt(saved.intervalMinutes) : "",
    lastError: "",
    timer: undefined
  };
}

const getGiveawayReminder = () => {
  const status = giveawaysService.status();
  return {
    ok: true,
    reminder: {
      enabled: giveawayReminder.enabled,
      intervalMinutes: giveawayReminder.intervalMinutes,
      lastSentAt: giveawayReminder.lastSentAt,
      nextSendAt: giveawayReminder.nextSendAt,
      lastError: giveawayReminder.lastError,
      openGiveaway: Boolean(status?.giveaway.status === "open"),
      giveawayTitle: status?.giveaway.title ?? ""
    }
  };
};

const setGiveawayReminder = (body: unknown) => {
  const input = body as { enabled?: boolean; intervalMinutes?: number | string };
  const intervalMinutes = parseSafeInteger(input.intervalMinutes ?? giveawayReminder.intervalMinutes, {
    field: "Reminder interval",
    min: 2,
    max: 60
  });
  const intervalChanged = intervalMinutes !== giveawayReminder.intervalMinutes;

  giveawayReminder.enabled = Boolean(input.enabled);
  giveawayReminder.intervalMinutes = intervalMinutes;
  giveawayReminder.lastError = "";

  if (!giveawayReminder.enabled) {
    giveawayReminder.nextSendAt = "";
    clearGiveawayReminderTimer();
    persistGiveawayReminderSettings();
    return getGiveawayReminder();
  }

  if (intervalChanged || !giveawayReminder.nextSendAt) {
    giveawayReminder.nextSendAt = nextGiveawayReminderAt(intervalMinutes);
  }

  persistGiveawayReminderSettings();
  scheduleGiveawayReminder();
  return getGiveawayReminder();
};

const sendGiveawayReminderNow = () => {
  const result = queueGiveawayReminderAnnouncement({ manual: true });

  if (result.ok) {
    giveawayReminder.lastSentAt = new Date().toISOString();
    giveawayReminder.lastError = "";
    persistGiveawayReminderSettings();
    if (giveawayReminder.enabled) {
      giveawayReminder.nextSendAt = nextGiveawayReminderAt(giveawayReminder.intervalMinutes);
      scheduleGiveawayReminder();
    }
  } else {
    giveawayReminder.lastError = result.error ?? "Reminder was not queued.";
  }

  return {
    ...getGiveawayReminder(),
    ...result
  };
};

const queueGiveawayReminderAnnouncement = (options: { manual?: boolean } = {}) => {
  const status = giveawaysService.status();

  if (!status || status.giveaway.status !== "open") {
    if (!options.manual) {
      return {
        ok: true,
        queued: false,
        skipped: true,
        reason: "No open giveaway."
      };
    }

    return {
      ok: false,
      error: "Reminder requires an open giveaway."
    };
  }

  const queued = maybeQueueGiveawayAnnouncements(
    giveawayAnnouncement(
      giveawayTemplates.reminder(status.giveaway, status.entries),
      "reminder",
      status.giveaway.id,
      "important"
    )
  );

  if (!queued) {
    return {
      ok: false,
      error: "Reminder could not queue because chat is not fully configured."
    };
  }

  return {
    ok: true,
    queued: true
  };
};

const scheduleGiveawayReminder = () => {
  clearGiveawayReminderTimer();

  if (!giveawayReminder.enabled) {
    return;
  }

  const nextAt = Date.parse(giveawayReminder.nextSendAt);
  const delayMs = Number.isFinite(nextAt)
    ? Math.max(1000, nextAt - Date.now())
    : giveawayReminder.intervalMinutes * 60 * 1000;

  giveawayReminder.timer = setTimeout(() => {
    giveawayReminder.timer = undefined;
    const result = queueGiveawayReminderAnnouncement();

    if (result.ok && result.queued) {
      giveawayReminder.lastSentAt = new Date().toISOString();
      giveawayReminder.lastError = "";
      persistGiveawayReminderSettings();
    } else if (!result.ok) {
      giveawayReminder.lastError = result.error ?? "Reminder was not queued.";
      logger.warn({ error: giveawayReminder.lastError }, "Giveaway reminder was not queued");
    }

    giveawayReminder.nextSendAt = nextGiveawayReminderAt(giveawayReminder.intervalMinutes);
    scheduleGiveawayReminder();
  }, delayMs);
  giveawayReminder.timer.unref?.();
};

const clearGiveawayReminderTimer = () => {
  if (!giveawayReminder.timer) {
    return;
  }

  clearTimeout(giveawayReminder.timer);
  giveawayReminder.timer = undefined;
};

function readGiveawayReminderSettings() {
  const row = db
    .prepare("SELECT enabled, interval_minutes, last_sent_at FROM giveaway_reminder_settings WHERE id = 1")
    .get() as GiveawayReminderSettingsRow | undefined;
  const interval = Number(row?.interval_minutes ?? 10);

  return {
    enabled: row?.enabled === 1,
    intervalMinutes: Number.isInteger(interval) && interval >= 2 && interval <= 60
      ? interval
      : 10,
    lastSentAt: row?.last_sent_at ?? ""
  };
}

function persistGiveawayReminderSettings() {
  db.prepare(
    `
      INSERT INTO giveaway_reminder_settings (
        id,
        enabled,
        interval_minutes,
        last_sent_at,
        updated_at
      ) VALUES (
        1,
        @enabled,
        @intervalMinutes,
        @lastSentAt,
        @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        enabled = excluded.enabled,
        interval_minutes = excluded.interval_minutes,
        last_sent_at = excluded.last_sent_at,
        updated_at = excluded.updated_at
    `
  ).run({
    enabled: giveawayReminder.enabled ? 1 : 0,
    intervalMinutes: giveawayReminder.intervalMinutes,
    lastSentAt: giveawayReminder.lastSentAt,
    updatedAt: new Date().toISOString()
  });
}

function nextGiveawayReminderAt(intervalMinutes: number) {
  return new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString();
}

type BotProcessState = {
  child: ChildProcess | undefined;
  status: "stopped" | "starting" | "running" | "stopping" | "exited" | "failed";
  pid: number | undefined;
  startedAt: string;
  stoppedAt: string;
  exitCode: number | null | undefined;
  signal: NodeJS.Signals | string | null | undefined;
  eventSubConnected: boolean;
  chatSubscriptionActive: boolean;
  liveChatConfirmed: boolean;
  lastError: string;
  recentLogs: string[];
  stdoutBuffer: string;
  stderrBuffer: string;
};

function createBotProcessState(): BotProcessState {
  return {
    child: undefined,
    status: "stopped",
    pid: undefined,
    startedAt: "",
    stoppedAt: "",
    exitCode: undefined,
    signal: undefined,
    eventSubConnected: false,
    chatSubscriptionActive: false,
    liveChatConfirmed: false,
    lastError: "",
    recentLogs: [],
    stdoutBuffer: "",
    stderrBuffer: ""
  };
}

const startBotProcess = async () => {
  if (botProcess.child && !botProcess.child.killed) {
    return { ok: true, alreadyRunning: true, botProcess: getBotProcessSnapshot() };
  }

  const validation = await validateSetup();
  const startReadiness = getBotStartReadiness(validation.checks);

  if (!validation.ok || !startReadiness.ok) {
    const failed = startReadiness.checks.find((check) => !check.ok);
    return {
      ok: false,
      error: failed?.detail || "Resolve readiness blockers before starting the live bot.",
      nextAction: failed?.detail || "Run Validate Setup before starting the bot.",
      checks: startReadiness.checks,
      diagnostics: getDiagnosticsReport(),
      botProcess: getBotProcessSnapshot()
    };
  }

  let command: ReturnType<typeof getBotRuntimeCommand>;

  try {
    command = getBotRuntimeCommand();
  } catch (error) {
    const detail = safeErrorMessage(error, "Unable to find VaexCore live bot entrypoint.");
    return {
      ok: false,
      error: detail,
      nextAction: "Run npm run build, then try Start Bot again.",
      checks: [
        ...startReadiness.checks,
        { name: "Bot runtime entrypoint", ok: false, detail }
      ],
      diagnostics: getDiagnosticsReport(),
      botProcess: getBotProcessSnapshot()
    };
  }

  resetBotProcessForStart();

  const child = spawn(command.executable, command.args, {
    cwd: command.cwd,
    env: getBotRuntimeEnv(),
    stdio: ["ignore", "pipe", "pipe"]
  });

  botProcess.child = child;
  botProcess.pid = child.pid;
  botProcess.status = "starting";
  appendBotLog("system", `Starting live bot process: ${command.display}`);

  child.stdout.on("data", (chunk: Buffer) => handleBotOutput("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => handleBotOutput("stderr", chunk));
  child.once("spawn", () => {
    botProcess.status = "running";
  });
  child.once("error", (error) => {
    botProcess.status = "failed";
    botProcess.lastError = safeErrorMessage(error, "Bot process failed to start.");
    appendBotLog("error", botProcess.lastError);
  });
  child.once("exit", (code, signal) => {
    flushBotOutput();
    botProcess.child = undefined;
    botProcess.pid = undefined;
    botProcess.stoppedAt = new Date().toISOString();
    botProcess.exitCode = code;
    botProcess.signal = signal;
    botProcess.eventSubConnected = false;
    botProcess.chatSubscriptionActive = false;
    botProcess.status = botProcess.status === "stopping" ? "stopped" : code === 0 ? "exited" : "failed";
    if (code !== 0 && botProcess.status === "failed") {
      botProcess.lastError = `Bot process exited with code ${code ?? "unknown"}.`;
    }
    appendBotLog("system", `Live bot process ${botProcess.status}.`);
  });

  return {
    ok: true,
    started: true,
    nextAction: "Wait for EventSub, then type !ping in Twitch chat.",
    checks: startReadiness.checks,
    botProcess: getBotProcessSnapshot()
  };
};

const getBotStartReadiness = (validationChecks: Array<{ name: string; ok: boolean; detail: string }>) => {
  const queue = chatQueue.snapshot();
  const checks = [
    ...validationChecks,
    {
      name: "Outbound queue",
      ok: queue.ready,
      detail: queue.ready
        ? "Outbound queue is ready."
        : "Restart the setup console if queue readiness does not recover."
    }
  ];

  return {
    ok: checks.every((check) => check.ok),
    checks
  };
};

const stopBotProcess = async (options: { force?: boolean } = {}) => {
  const child = botProcess.child;

  if (!child) {
    return { ok: true, alreadyStopped: true, botProcess: getBotProcessSnapshot() };
  }

  botProcess.status = "stopping";
  appendBotLog("system", "Stopping live bot process.");
  child.kill("SIGTERM");

  const stopped = await waitForBotExit(child, options.force ? 1500 : 10000);

  if (!stopped && options.force) {
    child.kill("SIGKILL");
    await waitForBotExit(child, 1500);
  }

  return { ok: true, stopped: true, botProcess: getBotProcessSnapshot() };
};

const waitForBotExit = (child: ChildProcess, timeoutMs: number) =>
  new Promise<boolean>((resolve) => {
    if (!botProcess.child || botProcess.child !== child) {
      resolve(true);
      return;
    }

    const timeout = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });

const resetBotProcessForStart = () => {
  botProcess.status = "starting";
  botProcess.pid = undefined;
  botProcess.startedAt = new Date().toISOString();
  botProcess.stoppedAt = "";
  botProcess.exitCode = undefined;
  botProcess.signal = undefined;
  botProcess.eventSubConnected = false;
  botProcess.chatSubscriptionActive = false;
  botProcess.liveChatConfirmed = false;
  botProcess.lastError = "";
  botProcess.recentLogs = [];
  botProcess.stdoutBuffer = "";
  botProcess.stderrBuffer = "";
};

const getBotProcessSnapshot = () => ({
  status: botProcess.status,
  running: Boolean(botProcess.child),
  pid: botProcess.pid,
  startedAt: botProcess.startedAt,
  stoppedAt: botProcess.stoppedAt,
  exitCode: botProcess.exitCode,
  signal: botProcess.signal,
  eventSubConnected: botProcess.eventSubConnected,
  chatSubscriptionActive: botProcess.chatSubscriptionActive,
  liveChatConfirmed: botProcess.liveChatConfirmed,
  lastError: botProcess.lastError,
  recentLogs: botProcess.recentLogs.slice(-20)
});

const getBotRuntimeCommand = () => {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = resolve(currentDir, "../..");
  const bundledRoot = resolve(currentDir, "..");
  const sourceIndex = join(sourceRoot, "src/index.ts");
  const tsxCli = join(sourceRoot, "node_modules/tsx/dist/cli.mjs");
  const bundledIndex = join(currentDir, "live-bot.js");

  if (currentDir.endsWith(join("src", "setup")) && existsSync(sourceIndex) && existsSync(tsxCli)) {
    return {
      executable: process.execPath,
      args: [tsxCli, "src/index.ts"],
      cwd: sourceRoot,
      display: "tsx src/index.ts"
    };
  }

  if (existsSync(bundledIndex)) {
    return {
      executable: process.execPath,
      args: [bundledIndex],
      cwd: bundledRoot,
      display: "node dist-bundle/live-bot.js"
    };
  }

  if (existsSync(sourceIndex) && existsSync(tsxCli)) {
    return {
      executable: process.execPath,
      args: [tsxCli, "src/index.ts"],
      cwd: sourceRoot,
      display: "tsx src/index.ts"
    };
  }

  throw new Error("Unable to find VaexCore live bot entrypoint.");
};

const getBotRuntimeEnv = () => {
  const configDir = dirname(getLocalSecretsPath());
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VAEXCORE_MODE: "live",
    VAEXCORE_CONFIG_DIR: configDir,
    DATABASE_URL: process.env.DATABASE_URL || `file:${join(configDir, "data/vaexcore.sqlite")}`
  };

  if (process.versions.electron) {
    env.ELECTRON_RUN_AS_NODE = "1";
  } else {
    delete env.ELECTRON_RUN_AS_NODE;
  }

  return env;
};

const handleBotOutput = (stream: "stdout" | "stderr", chunk: Buffer) => {
  const key = stream === "stdout" ? "stdoutBuffer" : "stderrBuffer";
  botProcess[key] += chunk.toString("utf8");
  const parts = botProcess[key].split(/\r?\n/);
  botProcess[key] = parts.pop() ?? "";

  for (const line of parts) {
    processBotLog(stream, line);
  }
};

const flushBotOutput = () => {
  if (botProcess.stdoutBuffer) {
    processBotLog("stdout", botProcess.stdoutBuffer);
    botProcess.stdoutBuffer = "";
  }
  if (botProcess.stderrBuffer) {
    processBotLog("stderr", botProcess.stderrBuffer);
    botProcess.stderrBuffer = "";
  }
};

const processBotLog = (stream: "stdout" | "stderr" | "system" | "error", rawLine: string) => {
  const line = rawLine.trim();
  if (!line) return;

  updateBotStatusFromLog(line);
  appendBotLog(stream, line);
};

const appendBotLog = (stream: string, line: string) => {
  const safeLine = redactSecretText(line);
  botProcess.recentLogs.push(`${new Date().toISOString()} ${stream}: ${safeLine}`);

  if (botProcess.recentLogs.length > 100) {
    botProcess.recentLogs.splice(0, botProcess.recentLogs.length - 100);
  }
};

const updateBotStatusFromLog = (line: string) => {
  try {
    const parsed = JSON.parse(line) as {
      msg?: string;
      operatorEvent?: string;
      code?: number;
      reason?: unknown;
      message?: unknown;
      outboundMessageId?: unknown;
      outboundStatus?: unknown;
      attempts?: unknown;
      attempt?: unknown;
      queued?: unknown;
      outboundCategory?: unknown;
      outboundAction?: unknown;
      outboundImportance?: unknown;
      failureCategory?: unknown;
      retryAfterMs?: unknown;
      nextAttemptAt?: unknown;
      giveawayId?: unknown;
      resentFrom?: unknown;
    };
    const msg = parsed.msg ?? "";
    const operatorEvent = parsed.operatorEvent ?? "";

    const outboundMessageId =
      typeof parsed.outboundMessageId === "string" ? parsed.outboundMessageId : "";
    const outboundStatus =
      typeof parsed.outboundStatus === "string" && isOutboundStatus(parsed.outboundStatus)
        ? parsed.outboundStatus
        : undefined;

    if (outboundMessageId && outboundStatus) {
      outboundHistory.record({
        id: outboundMessageId,
        source: "bot",
        status: outboundStatus,
        message: typeof parsed.message === "string" ? parsed.message : undefined,
        attempts: parseOptionalNumber(parsed.attempts ?? parsed.attempt),
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
        failureCategory: typeof parsed.failureCategory === "string" && isOutboundFailureCategory(parsed.failureCategory)
          ? parsed.failureCategory
          : undefined,
        retryAfterMs: parseOptionalNumber(parsed.retryAfterMs),
        nextAttemptAt: typeof parsed.nextAttemptAt === "string" ? parsed.nextAttemptAt : undefined,
        queueDepth: parseOptionalNumber(parsed.queued),
        metadata: {
          category: typeof parsed.outboundCategory === "string" && isOutboundCategory(parsed.outboundCategory)
            ? parsed.outboundCategory
            : undefined,
          action: typeof parsed.outboundAction === "string" ? parsed.outboundAction : undefined,
          importance: typeof parsed.outboundImportance === "string" && isOutboundImportance(parsed.outboundImportance)
            ? parsed.outboundImportance
            : undefined,
          giveawayId: parseOptionalNumber(parsed.giveawayId),
          resentFrom: typeof parsed.resentFrom === "string" ? parsed.resentFrom : undefined
        }
      });
    }

    if (msg === "EventSub WebSocket opened" || msg === "Startup checklist: EventSub connected") {
      botProcess.eventSubConnected = true;
    }
    if (operatorEvent === "chat subscription created" || msg === "Startup checklist: chat subscription created") {
      botProcess.chatSubscriptionActive = true;
    }
    if (msg === "LIVE CHAT CONFIRMED") {
      botProcess.liveChatConfirmed = true;
    }
    if (msg === "EventSub WebSocket closed") {
      botProcess.eventSubConnected = false;
      botProcess.chatSubscriptionActive = false;
    }
    if (line.includes("failed") || line.includes("error")) {
      botProcess.lastError = msg || line;
    }
  } catch {
    if (line.includes("LIVE CHAT CONFIRMED")) {
      botProcess.liveChatConfirmed = true;
    }
  }
};

const isOutboundStatus = (value: string): value is MessageQueueEventStatus =>
  ["queued", "sending", "retrying", "sent", "failed"].includes(value);

const parseOptionalNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const enqueueChatMessage = async (
  message: string | undefined,
  metadata: MessageQueueMetadata = {}
) => {
  const text = sanitizeChatMessage(message);

  const validation = await validateSetup();

  if (!validation.ok) {
    return {
      ok: false,
      error: "Validation must pass before sending chat messages.",
      checks: validation.checks
    };
  }

  const outboundMessageId = chatQueue.enqueue(text, metadata);
  return { ok: true, queued: true, outboundMessageId };
};

const getOperatorMessages = () => ({
  ok: true,
  templates: operatorMessages.list()
});

const saveOperatorMessages = (body: unknown) => ({
  ...getOperatorMessages(),
  templates: operatorMessages.save(body)
});

const resetOperatorMessages = (ids: unknown) => ({
  ...getOperatorMessages(),
  templates: operatorMessages.reset(ids)
});

const sendOperatorMessage = async (body: { id?: string; confirmed?: boolean }) => {
  const template = operatorMessages.find(body.id);

  if (!template) {
    return {
      ...getOperatorMessages(),
      ok: false,
      error: "Unknown operator message preset."
    };
  }

  if (template.requiresConfirmation && body.confirmed !== true) {
    return {
      ...getOperatorMessages(),
      ok: false,
      error: `${template.label} requires confirmation before sending.`
    };
  }

  const result = await enqueueChatMessage(template.template, {
    category: "operator",
    action: template.id,
    importance: template.requiresConfirmation ? "important" : "normal"
  });

  return {
    ...getOperatorMessages(),
    ...result,
    sentPreset: template.id
  };
};

const getFeatureGates = () => ({
  ok: true,
  featureGates: featureGates.list()
});

const setFeatureGate = (body: { key?: FeatureKey; mode?: FeatureGateMode }) => {
  try {
    const featureGate = featureGates.setMode(body.key, body.mode, localUiActor);

    return {
      ...getFeatureGates(),
      ok: true,
      featureGate
    };
  } catch (error) {
    return {
      ...getFeatureGates(),
      ok: false,
      error: safeErrorMessage(error, "Feature gate update failed")
    };
  }
};

const getCustomCommands = () => {
  const commands = customCommandsService.listCommands();
  const invocations = customCommandsService.getRecentInvocations(50);

  return {
    ok: true,
    commands,
    invocations,
    reservedNames: getCustomCommandReservedNames(),
    featureGate: featureGates.get("custom_commands"),
    summary: {
      total: commands.length,
      enabled: commands.filter((command) => command.enabled).length,
      disabled: commands.filter((command) => !command.enabled).length,
      aliases: commands.reduce((total, command) => total + command.aliases.length, 0),
      uses: commands.reduce((total, command) => total + command.useCount, 0)
    }
  };
};

const saveCustomCommand = (body: unknown) => {
  try {
    const command = customCommandsService.saveCommand(body as Record<string, unknown>, localUiActor, {
      reservedNames: getCustomCommandReservedNames()
    });
    return {
      ...getCustomCommands(),
      ok: true,
      command
    };
  } catch (error) {
    return {
      ...getCustomCommands(),
      ok: false,
      error: safeErrorMessage(error, "Custom command save failed")
    };
  }
};

const setCustomCommandEnabled = (body: { id?: number; enabled?: boolean }) => {
  try {
    const command = customCommandsService.setEnabled(
      parseSafeInteger(body.id, { field: "Command ID", min: 1, max: Number.MAX_SAFE_INTEGER }),
      Boolean(body.enabled),
      localUiActor
    );
    return {
      ...getCustomCommands(),
      ok: true,
      command
    };
  } catch (error) {
    return {
      ...getCustomCommands(),
      ok: false,
      error: safeErrorMessage(error, "Custom command update failed")
    };
  }
};

const duplicateCustomCommand = (id: number | undefined) => {
  try {
    const command = customCommandsService.duplicateCommand(
      parseSafeInteger(id, { field: "Command ID", min: 1, max: Number.MAX_SAFE_INTEGER }),
      localUiActor
    );
    return {
      ...getCustomCommands(),
      ok: true,
      command
    };
  } catch (error) {
    return {
      ...getCustomCommands(),
      ok: false,
      error: safeErrorMessage(error, "Custom command duplicate failed")
    };
  }
};

const deleteCustomCommand = (id: number | undefined) => {
  try {
    const deleted = customCommandsService.deleteCommand(
      parseSafeInteger(id, { field: "Command ID", min: 1, max: Number.MAX_SAFE_INTEGER }),
      localUiActor
    );
    return {
      ...getCustomCommands(),
      ok: true,
      deleted
    };
  } catch (error) {
    return {
      ...getCustomCommands(),
      ok: false,
      error: safeErrorMessage(error, "Custom command delete failed")
    };
  }
};

const importCustomCommands = (body: unknown) => {
  try {
    const commands = customCommandsService.importCommands(body, localUiActor, {
      reservedNames: getCustomCommandReservedNames()
    });
    return {
      ...getCustomCommands(),
      ok: true,
      imported: commands.length
    };
  } catch (error) {
    return {
      ...getCustomCommands(),
      ok: false,
      error: safeErrorMessage(error, "Custom command import failed")
    };
  }
};

const previewCustomCommand = (body: unknown) => {
  try {
    const input = body as {
      commandId?: number;
      responseText?: unknown;
      actor?: string;
      role?: "viewer" | "mod" | "broadcaster";
      rawArgs?: unknown;
    };
    const actor = createLocalChatMessage({
      login: input.actor || "viewer",
      role: input.role ?? "viewer",
      text: "!preview"
    });
    return {
      ok: true,
      response: customCommandsService.preview({
        commandId: input.commandId,
        responseText: input.responseText,
        actor,
        rawArgs: input.rawArgs
      })
    };
  } catch (error) {
    return {
      ok: false,
      error: safeErrorMessage(error, "Custom command preview failed")
    };
  }
};

const getCustomCommandReservedNames = () => {
  const names = new Set(getReservedCustomCommandNames());
  const active = giveawaysService.status()?.giveaway.keyword;

  if (active) {
    names.add(normalizeCommandName(active));
  }

  return [...names].sort();
};

const getOutboundMessages = () => ({
  ok: true,
  summary: outboundHistory.summary(),
  messages: outboundHistory.list()
});

const resendOutboundMessage = async (id: string | undefined) => {
  const record = outboundHistory.find(id) ?? outboundHistory.latestFailed();

  if (!record) {
    const outbound = getOutboundMessages();
    return {
      ...outbound,
      ok: false,
      error: "No failed outbound message is available to resend."
    };
  }

  const result = await enqueueChatMessage(record.message, {
    category: record.category,
    action: record.action,
    importance: record.importance,
    giveawayId: record.giveawayId,
    resentFrom: record.id
  });

  if (result.ok && typeof result.outboundMessageId === "string") {
    outboundHistory.markResent(record.id, result.outboundMessageId);
  }

  const outbound = getOutboundMessages();

  return {
    ...outbound,
    ...result,
    resentFrom: record.id
  };
};

const resendGiveawayAnnouncement = async (action: string | undefined) => {
  const phase = getGiveawayAnnouncementPhase(action);

  if (!phase) {
    return {
      ...getGiveawayState(),
      ok: false,
      error: "Unknown giveaway announcement phase."
    };
  }

  const state = giveawaysService.getLatestGiveawayState();

  if (!state.giveaway) {
    return {
      ...getGiveawayState(),
      ok: false,
      error: "No giveaway is available for announcement resend."
    };
  }

  const existing = latestOutboundForActions(state.giveaway.id, phase.actions);
  const announcement = existing
    ? {
        message: existing.message,
        metadata: {
          category: "giveaway" as const,
          action: existing.action || phase.actions[0],
          importance: existing.importance,
          giveawayId: state.giveaway.id,
          resentFrom: existing.id
        },
        resentFrom: existing.id
      }
    : buildGiveawayAnnouncementForPhase(phase, state);

  if (!announcement) {
    return {
      ...getGiveawayState(),
      ok: false,
      error: `Cannot reconstruct the ${phase.label} announcement from current giveaway state.`
    };
  }

  const result = await enqueueChatMessage(announcement.message, announcement.metadata);
  const resentFrom = "resentFrom" in announcement ? announcement.resentFrom : undefined;

  if (result.ok && resentFrom && typeof result.outboundMessageId === "string") {
    outboundHistory.markResent(resentFrom, result.outboundMessageId);
  }

  return {
    ...getGiveawayState(),
    ...result,
    action: phase.actions[0],
    resentFrom
  };
};

const resendCriticalGiveawayMessage = async () => {
  const record = latestFailedCriticalGiveawayMessage();

  if (!record) {
    return {
      ...getGiveawayState(),
      ok: false,
      error: "No failed critical giveaway message is available for panic resend."
    };
  }

  const result = await resendOutboundMessage(record.id);

  return {
    ...getGiveawayState(),
    ...result,
    resentAction: record.action,
    resentFrom: record.id
  };
};

const latestFailedCriticalGiveawayMessage = () => {
  const state = giveawaysService.getLatestGiveawayState();
  const currentGiveawayId = state.giveaway?.id;
  const failedCritical = outboundHistory.list().filter(
    (message) =>
      message.category === "giveaway" &&
      message.importance === "critical" &&
      message.status === "failed"
  );

  if (currentGiveawayId !== undefined) {
    const currentFailure = failedCritical.find(
      (message) => Number(message.giveawayId) === Number(currentGiveawayId)
    );

    if (currentFailure) {
      return currentFailure;
    }
  }

  return failedCritical[0];
};

const sendCurrentGiveawayStatus = async () => {
  const state = giveawaysService.getLatestGiveawayState();
  const message = buildGiveawayStatusMessage(state);

  if (!state.giveaway || !message) {
    return {
      ...getGiveawayState(),
      ok: false,
      error: "No giveaway is available for a status message."
    };
  }

  const result = await enqueueChatMessage(message, {
    category: "giveaway",
    action: "status",
    importance: "normal",
    giveawayId: state.giveaway.id
  });

  return {
    ...getGiveawayState(),
    ...result,
    message
  };
};

const sendConfiguredChatMessage = async (message: string) => {
  const secrets = readLocalSecrets();
  const twitch = secrets.twitch;

  if (
    !twitch.clientId ||
    !twitch.accessToken ||
    !twitch.broadcasterUserId ||
    !twitch.botUserId
  ) {
    return {
      status: "failed" as const,
      failureCategory: "config" as const,
      reason: "Setup is missing resolved Twitch IDs."
    };
  }

  const result = await createSetupChatSender(twitch).send(message);
  const structured = typeof result === "string" ? { status: result } : result;

  if (structured.status !== "failed" || structured.failureCategory !== "auth") {
    return result;
  }

  try {
    const refreshed = await refreshStoredTwitchToken({
      secrets,
      expectedClientId: twitch.clientId,
      expectedBotUserId: twitch.botUserId,
      expectedBotLogin: twitch.botLogin,
      logger
    });

    logger.warn(
      { failureCategory: structured.failureCategory },
      "Outbound chat auth failed; token refreshed and message will be retried once"
    );

    return createSetupChatSender(refreshed.twitch).send(message);
  } catch (error) {
    return {
      status: "failed" as const,
      failureCategory: "auth" as const,
      reason: safeErrorMessage(error, "Twitch token refresh failed. Reconnect Twitch.")
    };
  }
};

const createSetupChatSender = (twitch: LocalSecrets["twitch"]) => {
  if (
    !twitch.clientId ||
    !twitch.accessToken ||
    !twitch.broadcasterUserId ||
    !twitch.botUserId
  ) {
    throw new Error("Setup is missing resolved Twitch IDs.");
  }

  return new TwitchChatSender({
    clientId: twitch.clientId,
    accessToken: twitch.accessToken,
    broadcasterId: twitch.broadcasterUserId,
    senderId: twitch.botUserId,
    logger
  });
};

const getGiveawayTemplates = () => ({
  ok: true,
  templates: giveawayTemplates.list(),
  placeholders: [
    "title",
    "keyword",
    "winnerCount",
    "entryCount",
    "displayName",
    "winners",
    "winnerPlural",
    "drawnCount",
    "requestedCount",
    "partial",
    "rerolled",
    "replacement"
  ]
});

const saveGiveawayTemplates = (body: unknown) => ({
  ...getGiveawayTemplates(),
  templates: giveawayTemplates.save(body)
});

const resetGiveawayTemplates = (actions: unknown) => ({
  ...getGiveawayTemplates(),
  templates: giveawayTemplates.reset(actions)
});

type GiveawayAnnouncementPhase = {
  id: string;
  label: string;
  actions: [string, ...string[]];
  importance: NonNullable<MessageQueueMetadata["importance"]>;
  requiredWhen: (state: ReturnType<GiveawaysService["getLatestGiveawayState"]>) => boolean;
};

const giveawayAnnouncementPhases: GiveawayAnnouncementPhase[] = [
  {
    id: "start",
    label: "Start",
    actions: ["start"],
    importance: "critical",
    requiredWhen: (state) => Boolean(state.giveaway)
  },
  {
    id: "reminder",
    label: "Reminder / Last call",
    actions: ["reminder", "last-call"],
    importance: "important",
    requiredWhen: () => false
  },
  {
    id: "close",
    label: "Close",
    actions: ["close"],
    importance: "critical",
    requiredWhen: (state) =>
      state.giveaway?.status === "closed" || state.giveaway?.status === "ended"
  },
  {
    id: "draw",
    label: "Draw",
    actions: ["draw"],
    importance: "critical",
    requiredWhen: (state) => state.counts.activeWinners > 0
  },
  {
    id: "end",
    label: "End",
    actions: ["end"],
    importance: "critical",
    requiredWhen: (state) => state.giveaway?.status === "ended"
  }
];

const getGiveawayAnnouncementPhase = (action: string | undefined) => {
  if (!action) {
    return undefined;
  }

  return giveawayAnnouncementPhases.find(
    (phase) => phase.id === action || phase.actions.includes(action)
  );
};

const getGiveawayState = () => {
  const state = giveawaysService.getOperatorState();
  const latest = giveawaysService.getLatestGiveawayState();
  const assurance = summarizeGiveawayAssurance(latest);
  return {
    ok: true,
    ...state,
    summary: summarizeGiveawayState(state),
    recap: summarizeGiveawayRecap(latest, assurance),
    assurance
  };
};

const summarizeGiveawayState = (
  state: ReturnType<GiveawaysService["getOperatorState"]>
) => {
  const activeWinners = state.winners.filter((winner) => !winner.rerolled_at);
  const undeliveredWinnersCount = activeWinners.filter(
    (winner) => !winner.delivered_at
  ).length;
  const winnerCount = state.giveaway?.winner_count ?? 6;
  const liveState = giveawayLiveState(state, activeWinners, undeliveredWinnersCount);

  return {
    status: state.giveaway?.status ?? "none",
    title: state.giveaway?.title ?? "",
    keyword: state.giveaway?.keyword ?? "enter",
    winnerCount,
    entryCount: state.counts.entries,
    winnersDrawn: state.counts.activeWinners,
    rerolledCount: state.counts.rerolledWinners,
    enoughEntrantsForFullDraw: state.counts.entries >= winnerCount,
    undeliveredWinnersCount,
    operatorState: liveState.label,
    operatorStateDetail: liveState.detail,
    operatorStateTone: liveState.tone,
    safeToEnd: liveState.safeToEnd,
    canSendStatus: Boolean(state.giveaway),
    manualCodeDeliveryRequired: Boolean(state.giveaway),
    endWarnings: [
      state.giveaway?.status === "open" ? "Giveaway is still open." : undefined,
      undeliveredWinnersCount > 0
        ? `${undeliveredWinnersCount} winner(s) are not marked delivered.`
        : undefined
    ].filter(Boolean)
  };
};

const giveawayLiveState = (
  state: ReturnType<GiveawaysService["getOperatorState"]>,
  activeWinners: ReturnType<GiveawaysService["getOperatorState"]>["winners"],
  undeliveredWinnersCount: number
) => {
  const giveaway = state.giveaway;

  if (!giveaway) {
    return {
      label: "no giveaway",
      detail: "Start a giveaway when stream operations are ready.",
      tone: "muted",
      safeToEnd: false
    };
  }

  if (giveaway.status === "open") {
    return {
      label: "entries open",
      detail: `Viewers enter with !${giveaway.keyword}. Close entries before drawing.`,
      tone: "ok",
      safeToEnd: false
    };
  }

  if (giveaway.status === "closed" && activeWinners.length === 0) {
    return {
      label: "ready to draw",
      detail: `${state.counts.entries} entr${state.counts.entries === 1 ? "y" : "ies"} recorded. Draw winners when ready.`,
      tone: "ok",
      safeToEnd: false
    };
  }

  if (giveaway.status === "ended") {
    return {
      label: "giveaway ended",
      detail: undeliveredWinnersCount > 0
        ? `${undeliveredWinnersCount} winner(s) were still pending delivery at end.`
        : "Post-stream recap is ready.",
      tone: undeliveredWinnersCount > 0 ? "warn" : "ok",
      safeToEnd: false
    };
  }

  if (undeliveredWinnersCount > 0) {
    return {
      label: "delivery pending",
      detail: `${undeliveredWinnersCount} active winner(s) still need manual delivery.`,
      tone: "warn",
      safeToEnd: false
    };
  }

  return {
    label: "safe to end",
    detail: "Active winners are marked delivered.",
    tone: "ok",
    safeToEnd: true
  };
};

const summarizeGiveawayAssurance = (
  state: ReturnType<GiveawaysService["getLatestGiveawayState"]>
) => {
  if (!state.giveaway) {
    return {
      available: false,
      blockContinue: false,
      phases: [],
      summary: {
        sent: 0,
        resent: 0,
        pending: 0,
        failed: 0,
        requiredCritical: 0,
        confirmedCritical: 0,
        pendingCritical: 0,
        missingCritical: 0,
        failedCritical: 0,
        blockingCritical: 0
      },
      nextAction: "Start a giveaway."
    };
  }

  const messages = giveawayOutboundMessagesFor(state.giveaway.id);
  const phases = giveawayAnnouncementPhases.map((phase) =>
    summarizeGiveawayPhase(phase, state, messages)
  );
  const failedCritical = phases.filter(
    (phase) => phase.importance === "critical" && phase.status === "failed"
  );
  const missingCritical = phases.filter(
    (phase) => phase.importance === "critical" && phase.status === "missing"
  );
  const pendingCritical = phases.filter(
    (phase) => phase.importance === "critical" && phase.status === "pending"
  );
  const requiredCritical = phases.filter(
    (phase) => phase.importance === "critical" && phase.required
  );
  const confirmedCritical = requiredCritical.filter((phase) => phase.status === "sent");
  const failed = messages.filter((message) => message.status === "failed");
  const pending = messages.filter((message) => isPendingOutboundStatus(message.status));
  const sent = messages.filter((message) => message.status === "sent");
  const resent = messages.filter((message) => message.status === "resent");
  const blockingCritical = [...failedCritical, ...missingCritical, ...pendingCritical];
  const blockContinue = blockingCritical.length > 0;
  const nextAction =
    failedCritical[0]
      ? `Resend failed ${failedCritical[0].label} announcement before continuing.`
      : missingCritical[0]
        ? `Send missing ${missingCritical[0].label} announcement before continuing.`
        : pendingCritical[0]
          ? `Wait for ${pendingCritical[0].label} announcement to send.`
          : "Giveaway chat assurance is clear.";

  return {
    available: true,
    giveawayId: state.giveaway.id,
    blockContinue,
    phases,
    summary: {
      sent: sent.length,
      resent: resent.length,
      pending: pending.length,
      failed: failed.length,
      requiredCritical: requiredCritical.length,
      confirmedCritical: confirmedCritical.length,
      pendingCritical: pendingCritical.length,
      missingCritical: missingCritical.length,
      failedCritical: failedCritical.length,
      blockingCritical: blockingCritical.length
    },
    latestBlocking: blockingCritical[0]
      ? {
          label: blockingCritical[0].label,
          status: blockingCritical[0].status,
          queueStatus: blockingCritical[0].queueStatus,
          action: blockingCritical[0].action,
          reason: blockingCritical[0].reason
        }
      : undefined,
    nextAction,
    latestFailure: failed[0]
      ? {
          action: failed[0].action,
          failureCategory: failed[0].failureCategory,
          reason: failed[0].reason,
          updatedAt: failed[0].updatedAt
        }
      : undefined
  };
};

const summarizeGiveawayPhase = (
  phase: GiveawayAnnouncementPhase,
  state: ReturnType<GiveawaysService["getLatestGiveawayState"]>,
  messages: OutboundMessageRecord[]
) => {
  const latest = latestOutboundForActions(state.giveaway?.id, phase.actions, messages);
  const required = phase.requiredWhen(state);
  const status = latest
    ? phaseStatusFromOutbound(latest)
    : required
      ? "missing"
      : "not-reached";
  const blocksContinue = phase.importance === "critical" &&
    required &&
    (status === "failed" || status === "missing" || status === "pending");

  return {
    id: phase.id,
    label: phase.label,
    action: latest?.action || phase.actions[0],
    importance: latest?.importance || phase.importance,
    required,
    status,
    queueStatus: latest?.status ?? status,
    outboundMessageId: latest?.id ?? "",
    attempts: latest?.attempts ?? 0,
    message: latest?.message ?? "",
    reason: latest?.reason ?? "",
    failureCategory: latest?.failureCategory ?? "none",
    retryAfterMs: latest?.retryAfterMs ?? 0,
    nextAttemptAt: latest?.nextAttemptAt ?? "",
    queueDepth: latest?.queueDepth ?? 0,
    updatedAt: latest?.updatedAt ?? "",
    ageMs: latest?.updatedAt ? Date.now() - Date.parse(latest.updatedAt) : 0,
    age: latest?.updatedAt ? formatDuration(Date.now() - Date.parse(latest.updatedAt)) : "",
    blocksContinue,
    canSend: status === "failed" || status === "missing",
    safeToResend: (status === "failed" || status === "missing") && canSendConfiguredChat(),
    deliveryDetail: giveawayPhaseDeliveryDetail(phase, status, latest),
    recovery: giveawayPhaseRecoveryText(phase, status)
  };
};

const phaseStatusFromOutbound = (message: OutboundMessageRecord) => {
  if (message.status === "failed") return "failed";
  if (isPendingOutboundStatus(message.status)) return "pending";
  if (message.status === "sent" || message.status === "resent") return "sent";
  return message.status;
};

const giveawayPhaseDeliveryDetail = (
  phase: GiveawayAnnouncementPhase,
  status: string,
  latest: OutboundMessageRecord | undefined
) => {
  if (!latest) {
    return status === "missing"
      ? `${phase.label} announcement has no outbound record.`
      : `${phase.label} announcement is not required yet.`;
  }

  if (latest.status === "sent") {
    return `Send confirmed at ${latest.updatedAt}.`;
  }

  if (latest.status === "resent") {
    return `Resent as a replacement at ${latest.updatedAt}.`;
  }

  if (latest.status === "queued") {
    return "Queued; wait for send confirmation before continuing.";
  }

  if (latest.status === "sending") {
    return "Sending now; wait for confirmation before continuing.";
  }

  if (latest.status === "retrying") {
    return latest.nextAttemptAt
      ? `Retry scheduled at ${latest.nextAttemptAt}.`
      : "Retrying after a send failure.";
  }

  if (latest.status === "failed") {
    return latest.reason || "Send failed.";
  }

  return `${phase.label} announcement status: ${latest.status}.`;
};

const giveawayPhaseRecoveryText = (
  phase: GiveawayAnnouncementPhase,
  status: string
) => {
  if (status === "failed") {
    return `Resend the ${phase.label} announcement if chat missed it.`;
  }

  if (status === "missing") {
    return `Send the missing ${phase.label} announcement before continuing.`;
  }

  if (status === "pending") {
    return `Wait for the ${phase.label} announcement to leave the outbound queue.`;
  }

  if (status === "sent") {
    return `${phase.label} announcement is covered.`;
  }

  return "No recovery action needed yet.";
};

const summarizeGiveawayRecap = (
  state: ReturnType<GiveawaysService["getLatestGiveawayState"]>,
  assurance = summarizeGiveawayAssurance(state)
) => {
  if (!state.giveaway) {
    return {
      available: false
    };
  }

  const activeWinners = state.winners.filter((winner) => !winner.rerolled_at);
  const deliveredWinners = activeWinners.filter((winner) => winner.delivered_at);
  const pendingDelivery = activeWinners.filter((winner) => !winner.delivered_at);
  const messages = outboundHistory.list().filter(
    (message) =>
      message.category === "giveaway" &&
      Number(message.giveawayId) === Number(state.giveaway?.id)
  );
  const criticalMessages = messages.filter((message) => message.importance === "critical");
  const failedMessages = messages.filter((message) => message.status === "failed");

  return {
    available: true,
    id: state.giveaway.id,
    title: state.giveaway.title,
    status: state.giveaway.status,
    entryCount: state.counts.entries,
    activeWinnerCount: activeWinners.length,
    deliveredWinnerCount: deliveredWinners.length,
    pendingDeliveryCount: pendingDelivery.length,
    rerolledCount: state.counts.rerolledWinners,
    criticalMessageCount: criticalMessages.length,
    failedMessageCount: failedMessages.length,
    criticalFailedCount: criticalMessages.filter((message) => message.status === "failed").length,
    sentMessageCount: assurance.summary.sent,
    resentMessageCount: assurance.summary.resent,
    pendingMessageCount: assurance.summary.pending,
    requiredCriticalCount: assurance.summary.requiredCritical,
    confirmedCriticalCount: assurance.summary.confirmedCritical,
    pendingCriticalCount: assurance.summary.pendingCritical,
    missingCriticalCount: assurance.summary.missingCritical,
    blockingCriticalCount: assurance.summary.blockingCritical,
    winners: activeWinners.map((winner) => ({
      login: winner.login,
      displayName: winner.display_name,
      delivered: Boolean(winner.delivered_at)
    }))
  };
};

const giveawayOutboundMessagesFor = (giveawayId: number | undefined) =>
  outboundHistory.list().filter(
    (message) =>
      message.category === "giveaway" &&
      giveawayId !== undefined &&
      Number(message.giveawayId) === Number(giveawayId)
  );

const latestOutboundForActions = (
  giveawayId: number | undefined,
  actions: readonly string[],
  messages = giveawayOutboundMessagesFor(giveawayId)
) =>
  messages.find(
    (message) =>
      actions.includes(message.action) &&
      giveawayId !== undefined &&
      Number(message.giveawayId) === Number(giveawayId)
  );

const buildGiveawayAnnouncementForPhase = (
  phase: GiveawayAnnouncementPhase,
  state: ReturnType<GiveawaysService["getLatestGiveawayState"]>
) => {
  const giveaway = state.giveaway;

  if (!giveaway) {
    return undefined;
  }

  const action = phase.actions[0];
  const activeWinners = state.winners.filter((winner) => !winner.rerolled_at);
  const message =
    action === "start"
      ? giveawayTemplates.start(giveaway)
      : action === "reminder"
        ? giveawayTemplates.reminder(giveaway, state.counts.entries)
        : action === "close" && (giveaway.status === "closed" || giveaway.status === "ended")
          ? giveawayTemplates.close(giveaway, state.counts.entries)
          : action === "draw" && activeWinners.length > 0
            ? giveawayTemplates.draw({
                winners: activeWinners,
                requestedCount: Math.max(activeWinners.length, giveaway.winner_count)
              })
            : action === "end" && giveaway.status === "ended"
              ? giveawayTemplates.end(giveaway, state.winners)
              : undefined;

  if (!message) {
    return undefined;
  }

  return {
    message,
    metadata: {
      category: "giveaway" as const,
      action,
      importance: phase.importance,
      giveawayId: giveaway.id
    }
  };
};

const buildGiveawayStatusMessage = (
  state: ReturnType<GiveawaysService["getLatestGiveawayState"]>
) => {
  const giveaway = state.giveaway;

  if (!giveaway) {
    return undefined;
  }

  const activeWinners = state.winners.filter((winner) => !winner.rerolled_at);
  const pendingDelivery = activeWinners.filter((winner) => !winner.delivered_at);

  if (giveaway.status === "open") {
    return `Giveaway status: entries open for ${giveaway.title}. Type !${giveaway.keyword} to enter. Entries: ${state.counts.entries}. Winners: ${giveaway.winner_count}.`;
  }

  if (giveaway.status === "closed" && activeWinners.length === 0) {
    return `Giveaway status: entries closed for ${giveaway.title}. ${state.counts.entries} entr${state.counts.entries === 1 ? "y" : "ies"}. Ready to draw.`;
  }

  if (activeWinners.length === 0) {
    return `Giveaway status: ${giveaway.title} is ${giveaway.status}. No winners have been drawn.`;
  }

  const winnerText = formatWinnerNames(activeWinners, 5);
  const deliveryText = pendingDelivery.length > 0
    ? `Delivery pending for ${pendingDelivery.length}.`
    : "All active winners are marked delivered.";
  const prefix = giveaway.status === "ended"
    ? "Final giveaway status"
    : "Giveaway status";

  return `${prefix}: ${giveaway.title}. Winner${activeWinners.length === 1 ? "" : "s"}: ${winnerText}. ${deliveryText}`;
};

const runGiveawayAction = <TResult extends Record<string, unknown>>(
  action: () => TResult,
  options: {
    echoToChat?: boolean;
    echoCommand?: string;
    announcements?: (result: TResult) => GiveawayAnnouncement | GiveawayAnnouncement[] | string | string[] | undefined;
  } = {}
) => {
  try {
    const result = action();
    const echoQueued = maybeEchoCommand(options.echoToChat, options.echoCommand);
    const announcementsQueued = maybeQueueGiveawayAnnouncements(
      options.announcements?.(result)
    );

    return {
      ok: true,
      ...result,
      echoQueued,
      announcementsQueued,
      state: getGiveawayState()
    };
  } catch (error) {
    return {
      ok: false,
      error: safeErrorMessage(error, "Giveaway action failed"),
      state: getGiveawayState()
    };
  }
};

type GiveawayAnnouncement = {
  message: string;
  metadata: MessageQueueMetadata;
};

const giveawayAnnouncement = (
  message: string,
  action: string,
  giveawayId: number,
  importance: MessageQueueMetadata["importance"] = "normal"
): GiveawayAnnouncement => ({
  message,
  metadata: {
    category: "giveaway",
    action,
    importance,
    giveawayId
  }
});

const maybeQueueGiveawayAnnouncements = (
  messages: GiveawayAnnouncement | GiveawayAnnouncement[] | string | string[] | undefined
) => {
  const list = (Array.isArray(messages) ? messages : [messages]).filter(isGiveawayAnnouncementInput);

  if (list.length === 0 || !canSendConfiguredChat()) {
    return false;
  }

  let queued = false;

  for (const item of list) {
    try {
      const message = typeof item === "string" ? item : item.message;
      const metadata = typeof item === "string" ? classifyOutboundMessage(item) : item.metadata;
      const text = sanitizeChatMessage(message);
      chatQueue.enqueue(text, metadata);
      queued = true;
    } catch (error) {
      logger.warn({ error }, "Giveaway chat announcement rejected");
    }
  }

  if (queued) {
    logger.info({ count: list.length }, "Giveaway chat announcement queued");
  }

  return queued;
};

const isGiveawayAnnouncementInput = (
  item: GiveawayAnnouncement | string | undefined
): item is GiveawayAnnouncement | string => Boolean(item);

const canSendConfiguredChat = () => {
  const twitch = readLocalSecrets().twitch;

  return Boolean(
    twitch.clientId &&
    twitch.accessToken &&
    twitch.broadcasterUserId &&
    twitch.botUserId
  );
};

const maybeEchoCommand = (echoToChat: boolean | undefined, command: string | undefined) => {
  let text: string;

  try {
    text = command ? sanitizeCommandText(command) : "";
  } catch (error) {
    logger.warn({ error }, "Operator command echo rejected");
    return false;
  }

  if (!echoToChat || !text) {
    return false;
  }

  try {
    chatQueue.enqueue(text);
    logger.info({ command: text }, "Operator command echo queued");
    return true;
  } catch (error) {
    logger.warn({ error, command: text }, "Operator command echo failed to queue");
    return false;
  }
};

const localUiActor: ChatMessage = {
  id: "local-ui",
  text: "",
  userId: "local-ui",
  userLogin: "local-ui",
  userDisplayName: "Local UI",
  broadcasterUserId: "local-ui",
  badges: ["broadcaster"],
  isBroadcaster: true,
  isMod: true,
  isVip: false,
  isSubscriber: false,
  source: "local",
  receivedAt: new Date()
};

const simulatedChatActor: ChatMessage = {
  ...localUiActor,
  id: "simulated-chat",
  userId: "simulated-chat",
  userLogin: "simulated-chat",
  userDisplayName: "Simulated Chat"
};

const createLocalChatMessage = (input: {
  login: string;
  displayName?: string;
  role: "viewer" | "mod" | "broadcaster";
  text: string;
}): ChatMessage => {
  const login = requireUsername(input.login);
  const isBroadcaster = input.role === "broadcaster";
  const isMod = input.role === "mod" || isBroadcaster;

  return {
    id: `local-${login}-${Date.now()}`,
    text: sanitizeCommandText(input.text),
    userId: `local-${login}`,
    userLogin: login,
    userDisplayName: sanitizeDisplayName(input.displayName, login),
    broadcasterUserId: "local-broadcaster",
    badges: isBroadcaster ? ["broadcaster"] : isMod ? ["moderator"] : [],
    isBroadcaster,
    isMod,
    isVip: false,
    isSubscriber: false,
    source: "local",
    receivedAt: new Date()
  };
};

const simulateCommand = async (body: {
  actor?: string;
  role?: "viewer" | "mod" | "broadcaster";
  command?: string;
  echoToChat?: boolean;
}) => {
  let command: string;

  try {
    command = sanitizeCommandText(body.command);
  } catch (error) {
    return {
      ok: false,
      error: safeErrorMessage(error, "Command text is required."),
      state: getGiveawayState()
    };
  }

  const replies: string[] = [];
  const router = new CommandRouter({
    prefix: "!",
    logger,
    enqueueMessage: (message) => replies.push(message)
  });
  registerGiveawayCommands({
    router,
    service: giveawaysService,
    runtimeStatus: setupRuntimeStatus,
    messages: giveawayTemplates
  });
  registerCommandsModule({
    router,
    db,
    featureGates
  });

  try {
    const actor = createLocalChatMessage({
      login: body.actor || "viewer",
      role: body.role ?? "viewer",
      text: command
    });

    const routerResult = await router.handle(actor);
    const echoQueued = routerResult === "handled"
      ? maybeEchoCommand(body.echoToChat, command)
      : false;

    return {
      ok: true,
      replies,
      routerResult,
      echoQueued,
      state: getGiveawayState()
    };
  } catch (error) {
    return {
      ok: false,
      error: safeErrorMessage(error, "Simulated command failed"),
      replies,
      state: getGiveawayState()
    };
  }
};

const runLocalLifecycleTest = (options: { echoToChat: boolean; confirmed: boolean }) =>
  runGiveawayAction(() => {
    if (!options.confirmed) {
      throw new Error("Confirm before running the local lifecycle test.");
    }

    if (giveawaysService.status()) {
      throw new Error("End the active giveaway before running the local lifecycle test.");
    }

    const giveaway = giveawaysService.start({
      actor: localUiActor,
      title: "Community Giveaway",
      keyword: "enter",
      winnerCount: 6
    });

    for (const login of ["alice", "bob", "carol", "dave", "erin", "frank"]) {
      giveawaysService.addSimulatedEntrant(
        simulatedChatActor,
        createLocalChatMessage({
          login,
          role: "viewer",
          text: "!enter"
        })
      );
    }

    giveawaysService.close(localUiActor);
    const draw = giveawaysService.draw(localUiActor, 6);
    const firstWinner = draw.winners[0];

    if (firstWinner) {
      giveawaysService.claim(localUiActor, firstWinner.login);
      giveawaysService.deliver(localUiActor, firstWinner.login);
    }

    maybeEchoCommand(
      options.echoToChat,
      '!gstart codes=6 keyword=enter title="Community Giveaway"'
    );
    maybeEchoCommand(options.echoToChat, "!gclose");
    maybeEchoCommand(options.echoToChat, "!gdraw 6");

    if (firstWinner) {
      maybeEchoCommand(options.echoToChat, `!gclaim ${firstWinner.login}`);
      maybeEchoCommand(options.echoToChat, `!gdeliver ${firstWinner.login}`);
    }

    return { giveaway, draw };
  });

const requireUsername = (username: string | undefined) =>
  normalizeTwitchLogin(username, "Username");

const exchangeCode = async (input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<TwitchOAuthTokenResponse & { refresh_token: string }> => {
  const params = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri
  });
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Twitch OAuth exchange failed: ${response.status} ${body}`);
  }

  const tokens = (await response.json()) as Partial<TwitchOAuthTokenResponse>;

  if (!tokens.access_token || !tokens.refresh_token || !tokens.expires_in) {
    throw new Error("Twitch OAuth exchange did not return usable access and refresh tokens.");
  }

  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
    scope: tokens.scope ?? [],
    token_type: tokens.token_type ?? "bearer"
  };
};

const readJson = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;

    if (totalBytes > limits.requestBodyBytes) {
      throw new Error("Request body is too large.");
    }

    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
};

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, {
    ...securityHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
};

const sendHtml = (response: ServerResponse, html: string) => {
  response.writeHead(200, {
    ...securityHeaders,
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(html);
};

const sendStaticUiAsset = (response: ServerResponse, pathname: string) => {
  const fileName = pathname.replace(/^\/ui\//, "");

  if (!/^[a-z0-9.-]+$/i.test(fileName)) {
    sendText(response, 404, "Not found");
    return;
  }

  const filePath = join(getSetupUiDir(), fileName);

  if (!existsSync(filePath)) {
    sendText(response, 404, "Not found");
    return;
  }

  const contentType = extname(filePath) === ".css"
    ? "text/css; charset=utf-8"
    : extname(filePath) === ".js"
      ? "text/javascript; charset=utf-8"
      : "application/octet-stream";

  response.writeHead(200, {
    ...securityHeaders,
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  response.end(readFileSync(filePath));
};

const getSetupUiDir = () => {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const bundledPath = join(currentDir, "setup-ui");
  const sourcePath = join(currentDir, "ui");

  return existsSync(bundledPath) ? bundledPath : sourcePath;
};

const sendText = (response: ServerResponse, status: number, text: string) => {
  response.writeHead(status, {
    ...securityHeaders,
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(text);
};

const redirect = (response: ServerResponse, location: string) => {
  response.writeHead(302, { ...securityHeaders, Location: location });
  response.end();
};

const isLocalRequest = (request: IncomingMessage) => {
  const remote = request.socket.remoteAddress;
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
};

const isAllowedHost = (hostHeader: string | undefined) => {
  if (!hostHeader) {
    return true;
  }

  const hostName = hostHeader.split(":")[0]?.replace(/^\[|\]$/g, "");
  return hostName === "localhost" || hostName === "127.0.0.1" || hostName === "::1";
};

const normalizeLogin = (value: string | undefined) => {
  const login = extractLoginInput(value);
  return login ? normalizeTwitchLogin(login) : undefined;
};

const extractLoginInput = (value: string | undefined) => {
  const trimmed = value?.trim().replace(/^@/, "");

  if (!trimmed) {
    return undefined;
  }

  const maybeUrl = trimmed.match(/^https?:\/\//i)
    ? trimmed
    : trimmed.match(/^(www\.)?twitch\.tv\//i)
      ? `https://${trimmed}`
      : undefined;

  if (!maybeUrl) {
    return trimmed;
  }

  try {
    const parsed = new URL(maybeUrl);
    const host = parsed.hostname.toLowerCase();
    if (host === "twitch.tv" || host === "www.twitch.tv") {
      return parsed.pathname.split("/").filter(Boolean)[0];
    }
  } catch {
    return trimmed;
  }

  return trimmed;
};

const sanitizeOptionalText = (
  value: string | undefined,
  field: string,
  maxLength: number
) => (value?.trim() ? sanitizeText(value, { field, maxLength, required: true }) : undefined);

const sanitizeRedirectUri = (value: string | undefined) => {
  const redirectUri = sanitizeText(value || defaultRedirectUri, {
    field: "Redirect URI",
    maxLength: 200,
    required: true
  });
  const parsed = new URL(redirectUri);

  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "localhost" ||
    parsed.port !== "3434" ||
    parsed.pathname !== "/auth/twitch/callback"
  ) {
    throw new Error("Redirect URI must be http://localhost:3434/auth/twitch/callback.");
  }

  return parsed.toString();
};

const consumeOauthState = (state: string) => {
  const expiresAt = oauthStates.get(state);
  oauthStates.delete(state);

  for (const [storedState, storedExpiresAt] of oauthStates.entries()) {
    if (storedExpiresAt < Date.now()) {
      oauthStates.delete(storedState);
    }
  }

  return Boolean(expiresAt && expiresAt >= Date.now());
};

const valueOrExisting = (value: string | undefined, existing: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : existing;
};

const valueOrExistingLogin = (
  input: Record<string, string>,
  field: "broadcasterLogin" | "botLogin",
  existing: string | undefined
) => (hasSubmittedField(input, field) ? normalizeLogin(input[field]) : existing);

const hasSubmittedField = (input: Record<string, string>, field: string) =>
  Object.prototype.hasOwnProperty.call(input, field);

const clearTwitchAuthorization = (
  twitch: LocalSecrets["twitch"],
  options: { clearBroadcasterIdentity?: boolean } = {}
): LocalSecrets["twitch"] => ({
  ...twitch,
  accessToken: undefined,
  refreshToken: undefined,
  scopes: [],
  tokenExpiresAt: undefined,
  tokenValidatedAt: undefined,
  botUserId: undefined,
  broadcasterUserId: options.clearBroadcasterIdentity ? undefined : twitch.broadcasterUserId
});

const maskToken = (token: string) =>
  token.length <= 8 ? "********" : `${token.slice(0, 4)}...${token.slice(-4)}`;

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:"
};

const setupShellHtml = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>VaexCore</title>
    <link rel="stylesheet" href="/ui/styles.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/ui/app.js"></script>
  </body>
</html>`;

const isDirectRun = () => {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
};

if (isDirectRun()) {
  const handle = await startSetupServer();

  const shutdown = async () => {
    await handle.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}
