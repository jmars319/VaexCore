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
import {
  classifyOutboundMessage,
  createOutboundHistory,
  isOutboundCategory,
  isOutboundImportance
} from "../core/outboundHistory";
import { createRuntimeStatus } from "../core/runtimeStatus";
import {
  limits,
  normalizeKeyword,
  normalizeLogin as normalizeTwitchLogin,
  parseSafeInteger,
  redactSecrets,
  safeErrorMessage,
  sanitizeChatMessage,
  sanitizeCommandText,
  sanitizeDisplayName,
  sanitizeGiveawayTitle,
  sanitizeText
} from "../core/security";
import { createDbClient } from "../db/client";
import { registerGiveawayCommands } from "../modules/giveaways/giveaways.commands";
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

export type SetupServerHandle = {
  url: string;
  stop: () => Promise<void>;
};

const host = "127.0.0.1";
const defaultPort = 3434;
const logger = createLogger("info");
const oauthStates = new Map<string, number>();
const db = createDbClient(process.env.DATABASE_URL ?? "file:./data/vaexcore.sqlite");
const giveawaysService = new GiveawaysService({ db, logger });
const giveawayTemplates = createGiveawayTemplateStore(db);
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
    hasBroadcasterUserId: Boolean(twitch.broadcasterUserId),
    hasBotUserId: Boolean(twitch.botUserId),
    broadcasterLogin: twitch.broadcasterLogin ?? "",
    botLogin: twitch.botLogin ?? "",
    redirectUri: twitch.redirectUri ?? defaultRedirectUri,
    requiredScopes: requiredTwitchScopes,
    scopes: twitch.scopes,
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
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
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

  const token = await validateToken(twitch.accessToken);
  pass("Token valid", `Token belongs to ${token.login}.`);

  const missingScopes = requiredTwitchScopes.filter(
    (scope) => !token.scopes.includes(scope)
  );

  if (missingScopes.length > 0) {
    fail("Required scopes", `Missing: ${missingScopes.join(", ")}.`);
  } else {
    pass("Required scopes", token.scopes.join(", "));
  }

  const botUser = twitch.botLogin
    ? await getTwitchUserByLogin(
        { clientId: twitch.clientId, accessToken: twitch.accessToken },
        twitch.botLogin
      )
    : undefined;
  const broadcasterUser = twitch.broadcasterLogin
    ? await getTwitchUserByLogin(
        { clientId: twitch.clientId, accessToken: twitch.accessToken },
        twitch.broadcasterLogin
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
    ...twitch,
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
    ...secrets,
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

  const sender = new TwitchChatSender({
    clientId: twitch.clientId,
    accessToken: twitch.accessToken,
    broadcasterId: twitch.broadcasterUserId,
    senderId: twitch.botUserId,
    logger
  });

  const result = await sender.send("VaexCore setup test.");
  return { ok: result === "sent" };
};

const getOperatorStatus = async () => {
  const config = getSafeConfig();
  let tokenValid = false;
  let requiredScopesPresent = false;

  try {
    const secrets = readLocalSecrets();
    const token = secrets.twitch.accessToken
      ? await validateToken(secrets.twitch.accessToken)
      : undefined;
    tokenValid = Boolean(token);
    requiredScopesPresent = token
      ? requiredTwitchScopes.every((scope) => token.scopes.includes(scope))
      : false;
  } catch {
    tokenValid = false;
    requiredScopesPresent = false;
  }

  const giveaway = giveawaysService.getOperatorState();

  return {
    ok: true,
    config,
    runtime: {
      mode: config.mode,
      botLogin: config.botLogin,
      broadcasterLogin: config.broadcasterLogin,
      tokenValid,
      requiredScopesPresent,
      botProcess: getBotProcessSnapshot(),
      eventSubConnected: botProcess.eventSubConnected,
      chatSubscriptionActive: botProcess.chatSubscriptionActive,
      queueReady: chatQueue.isReady(),
      outboundChat: outboundHistory.summary(),
      liveChatConfirmed: botProcess.liveChatConfirmed,
      note: botProcess.child
        ? "Live bot runtime is managed by this setup console."
        : "Start the live bot runtime from Dashboard or Settings to receive chat commands."
    },
    giveaway: summarizeGiveawayState(giveaway)
  };
};

const runPreflightCheck = async () => {
  const status = await getOperatorStatus();
  const runtime = status.runtime;
  const giveawayState = getGiveawayState();
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
      ok: outbound.criticalFailed === 0,
      detail: outbound.criticalFailed === 0
        ? "No critical giveaway chat failures are currently tracked."
        : "Resend failed critical giveaway messages before continuing."
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

  if (!validation.ok) {
    return {
      ok: false,
      error: "Validation must pass before starting the live bot.",
      checks: validation.checks,
      botProcess: getBotProcessSnapshot()
    };
  }

  const command = getBotRuntimeCommand();
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

  return { ok: true, started: true, botProcess: getBotProcessSnapshot() };
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
  const safeLine = line.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
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

const sendConfiguredChatMessage = async (message: string) => {
  const secrets = readLocalSecrets();
  const twitch = secrets.twitch;

  if (
    !twitch.clientId ||
    !twitch.accessToken ||
    !twitch.broadcasterUserId ||
    !twitch.botUserId
  ) {
    throw new Error("Setup is missing resolved Twitch IDs.");
  }

  const sender = new TwitchChatSender({
    clientId: twitch.clientId,
    accessToken: twitch.accessToken,
    broadcasterId: twitch.broadcasterUserId,
    senderId: twitch.botUserId,
    logger
  });

  return sender.send(message);
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

const getGiveawayState = () => {
  const state = giveawaysService.getOperatorState();
  const latest = giveawaysService.getLatestGiveawayState();
  return {
    ok: true,
    ...state,
    summary: summarizeGiveawayState(state),
    recap: summarizeGiveawayRecap(latest)
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
    manualCodeDeliveryRequired: Boolean(state.giveaway),
    endWarnings: [
      state.giveaway?.status === "open" ? "Giveaway is still open." : undefined,
      undeliveredWinnersCount > 0
        ? `${undeliveredWinnersCount} winner(s) are not marked delivered.`
        : undefined
    ].filter(Boolean)
  };
};

const summarizeGiveawayRecap = (
  state: ReturnType<GiveawaysService["getLatestGiveawayState"]>
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
    winners: activeWinners.map((winner) => ({
      login: winner.login,
      displayName: winner.display_name,
      delivered: Boolean(winner.delivered_at)
    }))
  };
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
}) => {
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

  return (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string[];
    token_type: string;
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
