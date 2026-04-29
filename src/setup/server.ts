import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { URL } from "node:url";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLogger } from "../core/logger";
import type { ChatMessage } from "../core/chatMessage";
import { CommandRouter } from "../core/commandRouter";
import { MessageQueue } from "../core/messageQueue";
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
const setupRuntimeStatus = createRuntimeStatus("local");
const chatQueue = new MessageQueue({
  logger,
  send: async (message) => sendConfiguredChatMessage(message)
});
chatQueue.start();
setupRuntimeStatus.messageQueueReady = chatQueue.isReady();

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

  await new Promise<void>((resolve) => {
    server.listen(port, host, resolve);
  });

  logger.info(
    { url: `http://localhost:${port}`, secretsPath: getLocalSecretsPath() },
    "VaexCore setup server started"
  );

  return {
    url: `http://localhost:${port}`,
    stop: async () => {
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

  if (request.method === "POST" && url.pathname === "/api/chat/send") {
    const body = (await readJson(request)) as { message?: string };
    sendJson(response, 200, await enqueueChatMessage(body.message));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/giveaway") {
    sendJson(response, 200, getGiveawayState());
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
      echoCommand: `!gstart codes=${winnerCount} keyword=${keyword} title="${title.replace(/"/g, "'")}"`
    }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/giveaway/close") {
    const body = (await readJson(request)) as { echoToChat?: boolean };
    sendJson(response, 200, runGiveawayAction(() => ({
      giveaway: giveawaysService.close(localUiActor)
    }), { echoToChat: Boolean(body.echoToChat), echoCommand: "!gclose" }));
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
    }), { echoToChat: Boolean(body.echoToChat), echoCommand: `!gdraw ${count}` }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/giveaway/reroll") {
    const body = (await readJson(request)) as { username?: string; echoToChat?: boolean };
    sendJson(response, 200, runGiveawayAction(() => ({
      result: giveawaysService.reroll(localUiActor, requireUsername(body.username))
    }), {
      echoToChat: Boolean(body.echoToChat),
      echoCommand: body.username ? `!greroll ${requireUsername(body.username)}` : undefined
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

  if (request.method === "POST" && url.pathname === "/api/giveaway/end") {
    const body = (await readJson(request)) as { echoToChat?: boolean };
    sendJson(response, 200, runGiveawayAction(() => ({
      giveaway: giveawaysService.end(localUiActor)
    }), { echoToChat: Boolean(body.echoToChat), echoCommand: "!gend" }));
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
    }), { echoToChat: Boolean(body.echoToChat), echoCommand: "!enter" }));
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
    broadcasterLogin: twitch.broadcasterLogin ?? "",
    botLogin: twitch.botLogin ?? "",
    redirectUri: twitch.redirectUri ?? defaultRedirectUri,
    scopes: twitch.scopes,
    token: twitch.accessToken ? maskToken(twitch.accessToken) : ""
  };
};

const saveConfig = (body: unknown) => {
  const input = body as Record<string, string>;
  const existing = readLocalSecrets();
  const redirectUri = sanitizeRedirectUri(input.redirectUri);
  const next: LocalSecrets = {
    mode: input.mode === "local" ? "local" : "live",
    twitch: {
      ...existing.twitch,
      clientId: valueOrExisting(
        sanitizeOptionalText(input.clientId, "Client ID", 120),
        existing.twitch.clientId
      ),
      clientSecret: valueOrExisting(
        sanitizeOptionalText(input.clientSecret, "Client secret", 200),
        existing.twitch.clientSecret
      ),
      redirectUri,
      broadcasterLogin:
        normalizeLogin(input.broadcasterLogin) ?? existing.twitch.broadcasterLogin,
      botLogin: normalizeLogin(input.botLogin) ?? existing.twitch.botLogin
    }
  };

  writeLocalSecrets(next);
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

  writeLocalSecrets({
    ...secrets,
    twitch: {
      ...twitch,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      scopes: validation.scopes,
      tokenExpiresAt: expiresAt,
      tokenValidatedAt: new Date().toISOString(),
      botLogin: twitch.botLogin || validation.login,
      botUserId: validation.user_id
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

  if (botUser && broadcasterUser) {
    writeLocalSecrets({
      ...secrets,
      twitch: {
        ...twitch,
        scopes: token.scopes,
        botLogin: botUser.login,
        botUserId: botUser.id,
        broadcasterLogin: broadcasterUser.login,
        broadcasterUserId: broadcasterUser.id,
        tokenValidatedAt: new Date().toISOString()
      }
    });
  }

  return { ok: checks.every((check) => check.ok), checks };
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
      eventSubConnected: false,
      chatSubscriptionActive: false,
      queueReady: chatQueue.isReady(),
      liveChatConfirmed: false,
      note: "The setup console runs separately from npm run dev, so live EventSub status is shown in the bot terminal."
    },
    giveaway: summarizeGiveawayState(giveaway)
  };
};

const enqueueChatMessage = async (message: string | undefined) => {
  const text = sanitizeChatMessage(message);

  const validation = await validateSetup();

  if (!validation.ok) {
    return {
      ok: false,
      error: "Validation must pass before sending chat messages.",
      checks: validation.checks
    };
  }

  chatQueue.enqueue(text);
  return { ok: true, queued: true };
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

const getGiveawayState = () => {
  const state = giveawaysService.getOperatorState();
  return {
    ok: true,
    ...state,
    summary: summarizeGiveawayState(state)
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

const runGiveawayAction = (
  action: () => Record<string, unknown>,
  options: { echoToChat?: boolean; echoCommand?: string } = {}
) => {
  try {
    const result = action();
    const echoQueued = maybeEchoCommand(options.echoToChat, options.echoCommand);

    return {
      ok: true,
      ...result,
      echoQueued,
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
    runtimeStatus: setupRuntimeStatus
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

const normalizeLogin = (value: string | undefined) =>
  value?.trim() ? normalizeTwitchLogin(value) : undefined;

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
