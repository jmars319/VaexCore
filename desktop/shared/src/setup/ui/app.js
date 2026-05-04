const windowParams = new URLSearchParams(window.location.search);
const isSettingsWindow = windowParams.get("window") === "settings";

document.body.classList.toggle("settings-window", isSettingsWindow);

const mainTabs = [
  ["dashboard", "Dashboard"],
  ["live-mode", "Live Mode"],
  ["commands", "Commands"],
  ["timers", "Timers"],
  ["moderation", "Moderation"],
  ["giveaways", "Giveaways"],
  ["chat-tools", "Chat Tools"],
  ["testing", "Testing"],
  ["diagnostics", "Diagnostics"],
  ["audit-log", "Audit Log"]
];

const tabs = isSettingsWindow ? [["settings", "Settings"]] : mainTabs;

const state = {
  activeTab: isSettingsWindow ? "settings" : "dashboard",
  config: null,
  status: null,
  giveaway: null,
  commands: [],
  commandHistory: [],
  commandSummary: { total: 0, enabled: 0, disabled: 0, aliases: 0, uses: 0 },
  commandReservedNames: [],
  commandPresets: [],
  commandPresetPacks: [],
  commandFeatureGate: null,
  timers: [],
  timerSummary: { total: 0, enabled: 0, disabled: 0, sent: 0, waitingForActivity: 0 },
  timerFeatureGate: null,
  timerReadiness: { ok: false, reason: "" },
  timerPresets: [],
  moderation: null,
  moderationTerms: [],
  moderationAllowedLinks: [],
  moderationBlockedLinks: [],
  moderationLinkPermits: [],
  moderationHits: [],
  moderationSummary: { terms: 0, enabledTerms: 0, allowedLinks: 0, enabledAllowedLinks: 0, blockedLinks: 0, enabledBlockedLinks: 0, activeLinkPermits: 0, roleExemptions: 0, filtersEnabled: 0, enforcementFilters: 0, botShield: "off", hits: 0 },
  moderationEnforcement: null,
  moderationFeatureGate: null,
  streamPresets: [],
  featureGates: [],
  templates: [],
  operatorMessages: [],
  reminder: null,
  launchPreparation: null,
  preflightResult: null,
  diagnostics: null,
  auditLogs: [],
  outboundMessages: [],
  outboundSummary: { total: 0, queued: 0, failed: 0, criticalFailed: 0, sent: 0 },
  validSetup: false,
  busy: new Set(),
  entrantFilter: "",
  winnerFilter: "all",
  commandFilter: "",
  selectedCommandId: null,
  selectedTimerId: null,
  message: { text: "", tone: "muted" },
  testResult: null,
  commandPreview: null,
  validationChecks: [],
  testMessageSent: false,
  settingsDraft: {},
  commandDraft: {},
  timerDraft: {},
  moderationDraft: {},
  moderationTermDraft: {},
  moderationAllowedLinkDraft: {},
  moderationBlockedLinkDraft: {},
  moderationPermitDraft: {},
  moderationTestResult: null,
  giveawayDraft: {},
  templateDraft: {},
  operatorTemplateDraft: {},
  reminderDraft: {},
  oauthNotice: readOAuthNotice()
};

const defaultRedirectUri = "http://localhost:3434/auth/twitch/callback";
const savedCredentialMask = "saved and masked";

const timerSuggestions = [
  {
    id: "schedule",
    useCase: "Schedule reminder",
    name: "Schedule reminder",
    intervalMinutes: 30,
    minChatMessages: 10,
    message: "Follow the channel for schedule updates and stream notices."
  },
  {
    id: "discord",
    useCase: "Community link",
    name: "Discord reminder",
    intervalMinutes: 45,
    minChatMessages: 12,
    message: "Join the Discord for stream alerts and support: https://example.com"
  },
  {
    id: "giveaway",
    useCase: "Giveaway pacing",
    name: "Giveaway reminder",
    intervalMinutes: 20,
    minChatMessages: 8,
    message: "Giveaway reminders appear here first. Keep chat open and watch for the next entry keyword."
  },
  {
    id: "help",
    useCase: "Support prompt",
    name: "Help reminder",
    intervalMinutes: 60,
    minChatMessages: 15,
    message: "Need help? Mods can answer setup questions, and channel rules are in the panels below."
  }
];

const moderationSuggestions = [
  {
    id: "warning-copy",
    useCase: "General warning copy",
    target: "Warning message",
    type: "warning",
    value: "@{user}, please keep chat readable and within channel guidelines."
  },
  {
    id: "spam-phrase",
    useCase: "Common spam phrase",
    target: "Blocked phrase",
    type: "blockedPhrase",
    value: "buy followers"
  },
  {
    id: "giveaway-scam",
    useCase: "Fake giveaway wording",
    target: "Blocked phrase",
    type: "blockedPhrase",
    value: "claim prize now"
  },
  {
    id: "shortener-domain",
    useCase: "Shortener review",
    target: "Blocked domain",
    type: "blockedDomain",
    value: "bit.ly"
  },
  {
    id: "official-domain",
    useCase: "Known safe link",
    target: "Allowed domain",
    type: "allowedDomain",
    value: "discord.gg"
  }
];

function readOAuthNotice() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");

  if (error) {
    if (error === "wrong_bot_account") {
      const connected = params.get("connected_login") || "the current Twitch account";
      const expected = params.get("expected_login") || "the configured Bot Login";
      return { tone: "bad", text: `Twitch authorized ${connected}, but Bot Login is ${expected}. Log into Twitch as the Bot Login account (${expected}), then click Connect Twitch as Bot Login again.` };
    }

    return { tone: "bad", text: oauthErrorMessage(error) };
  }

  if (params.get("connected") === "1") {
    return { tone: "ok", text: "Twitch authorization completed. Launch checks will validate it automatically." };
  }

  return undefined;
}

function oauthErrorMessage(error) {
  const messages = {
    access_denied: "Twitch authorization was cancelled before vaexcore console was connected.",
    invalid_client_secret: "Twitch rejected the saved Client Secret. Generate or copy a fresh Client Secret in the Twitch Developer Console, paste it here, save settings, then click Connect Twitch as Bot Login again.",
    invalid_client_credentials: "Twitch rejected the saved Client ID or Client Secret. Check both app credentials, save settings, then click Connect Twitch as Bot Login again.",
    missing_client_credentials: "Save the Twitch Client ID and Client Secret before connecting Twitch.",
    invalid_oauth_state: "Twitch authorization expired or did not match this session. Click Connect Twitch as Bot Login again.",
    oauth_exchange_failed: "Twitch did not complete the authorization exchange. Check the saved Twitch app credentials and try Connect Twitch as Bot Login again.",
    oauth_token_validation_failed: "Twitch returned a token, but vaexcore console could not validate it. Disconnect Twitch and connect again.",
    redirect_uri_mismatch: `Twitch rejected the redirect URL. In the Twitch Developer Console, set the OAuth Redirect URL to ${defaultRedirectUri}.`
  };

  return messages[error] || `Twitch authorization failed: ${error}`;
}

const api = {
  get: (url) => request(url),
  post: (url, body = {}) => request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }),
  config: () => api.get("/api/config"),
  saveConfig: (body) => api.post("/api/config", body),
  disconnectTwitch: () => api.post("/api/auth/twitch/disconnect"),
  validate: () => api.post("/api/validate"),
  testSend: () => api.post("/api/test-send"),
  status: () => api.get("/api/status"),
  launchPreparation: () => api.get("/api/launch-preparation"),
  runLaunchPreparation: () => api.post("/api/launch-preparation"),
  launchSuite: () => api.post("/api/launch-suite"),
  diagnostics: () => api.get("/api/diagnostics"),
  supportBundle: () => api.get("/api/support-bundle"),
  featureGates: () => api.get("/api/feature-gates"),
  setFeatureGate: (key, mode) => api.post("/api/feature-gates", { key, mode }),
  streamPresets: () => api.get("/api/stream-presets"),
  applyStreamPreset: (id, confirmed = false) => api.post("/api/stream-presets/apply", { id, confirmed }),
  preflight: () => api.post("/api/preflight"),
  botStart: () => api.post("/api/bot/start"),
  botStop: () => api.post("/api/bot/stop"),
  giveaway: () => api.get("/api/giveaway"),
  templates: () => api.get("/api/giveaway/templates"),
  saveTemplates: (templates) => api.post("/api/giveaway/templates", { templates }),
  resetTemplates: () => api.post("/api/giveaway/templates/reset"),
  reminder: () => api.get("/api/giveaway/reminder"),
  saveReminder: (body) => api.post("/api/giveaway/reminder", body),
  sendReminder: () => api.post("/api/giveaway/reminder/send"),
  auditLogs: () => api.get("/api/audit-logs"),
  outboundMessages: () => api.get("/api/outbound-messages"),
  resendOutboundMessage: (id) => api.post("/api/outbound-messages/resend", id ? { id } : {}),
  resendGiveawayAnnouncement: (action) => api.post("/api/giveaway/announcement/resend", { action }),
  resendCriticalGiveaway: () => api.post("/api/giveaway/critical/resend"),
  sendGiveawayStatus: () => api.post("/api/giveaway/status/send"),
  chatSend: (message) => api.post("/api/chat/send", { message }),
  operatorMessages: () => api.get("/api/operator-messages"),
  saveOperatorMessages: (templates) => api.post("/api/operator-messages", { templates }),
  resetOperatorMessages: () => api.post("/api/operator-messages/reset"),
  sendOperatorMessage: (id, confirmed = false) => api.post("/api/operator-messages/send", { id, confirmed }),
  exportBotConfig: () => api.get("/api/bot-config/export"),
  importBotConfig: (body) => api.post("/api/bot-config/import", body),
  commands: () => api.get("/api/commands"),
  saveCommand: (body) => api.post("/api/commands", body),
  enableCommand: (id, enabled) => api.post("/api/commands/enable", { id, enabled }),
  duplicateCommand: (id) => api.post("/api/commands/duplicate", { id }),
  deleteCommand: (id) => api.post("/api/commands/delete", { id }),
  exportCommands: () => api.get("/api/commands/export"),
  importCommands: (body) => api.post("/api/commands/import", body),
  applyCommandPreset: (id) => api.post("/api/commands/preset", { id }),
  applyCommandPresetPack: (id) => api.post("/api/commands/preset-pack", { id }),
  previewCommand: (body) => api.post("/api/commands/preview", body),
  timers: () => api.get("/api/timers"),
  exportTimers: () => api.get("/api/timers/export"),
  saveTimer: (body) => api.post("/api/timers", body),
  importTimers: (body) => api.post("/api/timers/import", body),
  applyTimerPreset: (id) => api.post("/api/timers/preset", { id }),
  enableTimer: (id, enabled) => api.post("/api/timers/enable", { id, enabled }),
  deleteTimer: (id) => api.post("/api/timers/delete", { id }),
  sendTimerNow: (id) => api.post("/api/timers/send-now", { id }),
  moderation: () => api.get("/api/moderation"),
  saveModerationSettings: (body) => api.post("/api/moderation/settings", body),
  saveModerationTerm: (body) => api.post("/api/moderation/terms", body),
  enableModerationTerm: (id, enabled) => api.post("/api/moderation/terms/enable", { id, enabled }),
  deleteModerationTerm: (id) => api.post("/api/moderation/terms/delete", { id }),
  saveModerationAllowedLink: (body) => api.post("/api/moderation/allowed-links", body),
  enableModerationAllowedLink: (id, enabled) => api.post("/api/moderation/allowed-links/enable", { id, enabled }),
  deleteModerationAllowedLink: (id) => api.post("/api/moderation/allowed-links/delete", { id }),
  saveModerationBlockedLink: (body) => api.post("/api/moderation/blocked-links", body),
  enableModerationBlockedLink: (id, enabled) => api.post("/api/moderation/blocked-links/enable", { id, enabled }),
  deleteModerationBlockedLink: (id) => api.post("/api/moderation/blocked-links/delete", { id }),
  grantModerationLinkPermit: (body) => api.post("/api/moderation/link-permits", body),
  simulateModeration: (body) => api.post("/api/moderation/simulate", body),
  giveawayAction: (name, body = {}) => api.post(`/api/giveaway/${name}`, withEcho(body)),
  simulateCommand: (body) => api.post("/api/command/simulate", withEcho(body))
};

async function request(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();

  if (!response.ok) {
    throw new Error(body.error || `Request failed: ${response.status}`);
  }

  return body;
}

function withEcho(body = {}) {
  return { ...body, echoToChat: Boolean(field("echoToChat")?.checked) };
}

const app = document.getElementById("app");
const backgroundRefreshMs = 5000;
const renderIdleDelayMs = 900;
const interactionQuietMs = 1400;
const scrollPositions = {};
let deferredRenderTimer = null;
let lastUserInteractionAt = 0;
let backgroundRefreshPromise = null;

function h(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);

  for (const [key, value] of Object.entries(attributes)) {
    if (value === false || value === undefined || value === null) {
      continue;
    }

    if (key === "className") {
      element.className = value;
    } else if (key === "text") {
      element.textContent = value;
    } else if (key.startsWith("on") && typeof value === "function") {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      element.setAttribute(key, String(value));
    }
  }

  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === undefined || child === null) {
      continue;
    }
    element.append(child.nodeType ? child : document.createTextNode(String(child)));
  }

  return element;
}

function field(id) {
  return document.getElementById(id);
}

function currentContentNode() {
  return app.querySelector(".content");
}

function saveScrollPosition(tabId = state.activeTab) {
  const content = currentContentNode();
  if (!content) {
    return;
  }
  scrollPositions[tabId] = content.scrollTop;
}

function restoreScrollPosition(tabId = state.activeTab) {
  const top = scrollPositions[tabId];
  if (top === undefined) {
    return;
  }

  requestAnimationFrame(() => {
    const content = currentContentNode();
    if (content) {
      content.scrollTop = top;
    }
  });
}

function render(options = {}) {
  if (deferredRenderTimer) {
    clearTimeout(deferredRenderTimer);
    deferredRenderTimer = null;
  }

  if (options.preserveScroll !== false && !options.skipSaveScroll) {
    saveScrollPosition();
  }

  if (isSettingsWindow) {
    app.replaceChildren(
      h("div", { className: "app-shell settings-shell" }, [
        renderHeader({
          title: "Configuration Settings",
          subtitle: "Twitch OAuth and local setup",
          showStatus: false
        }),
        h("main", { className: "content settings-content" }, [
          h("section", { id: "settings", className: "tab-panel active" }, renderSettings())
        ])
      ])
    );
    syncFormValues();
    updateDisabledState();
    if (options.preserveScroll !== false) {
      restoreScrollPosition();
    }
    return;
  }

  app.replaceChildren(
    h("div", { className: "app-shell" }, [
      renderHeader(),
      h("div", { className: "layout" }, [
        renderSidebar(),
        h("main", { className: "content" }, tabs.map(([id]) => renderTab(id)))
      ])
    ])
  );
  syncFormValues();
  updateDisabledState();
  if (options.preserveScroll !== false) {
    restoreScrollPosition();
  }
}

function renderHeader(options = {}) {
  const title = options.title || "vaexcore console";
  const subtitle = options.subtitle || "Local Twitch operations console";
  const showStatus = options.showStatus !== false;
  const showSettingsAction = options.showSettingsAction ?? !isSettingsWindow;
  const runtime = state.status?.runtime;
  const giveaway = state.status?.giveaway;
  const launch = currentLaunchPreparation();
  const connectionValue = launch?.status === "running"
    ? "checking"
    : runtime?.tokenValid
      ? "configured"
      : "not ready";
  return h("header", { className: "topbar" }, [
    h("div", { className: "brand-lockup" }, [
      h("img", {
        className: "brand-logo",
        src: "/ui/logo.jpg",
        alt: "vaexcore console"
      }),
      h("div", {}, [
        h("h1", { text: title }),
        h("p", { className: "subtitle", text: subtitle })
      ])
    ]),
    showStatus || showSettingsAction ? h("div", { className: "header-actions" }, [
      showStatus ? h("div", { className: "header-status" }, [
        statusPill("Mode", runtime?.mode || "loading"),
        statusPill("Connection", connectionValue, launch?.status === "running" || runtime?.tokenValid),
        statusPill("Chat", runtime?.liveChatConfirmed ? "confirmed" : "pending", runtime?.liveChatConfirmed),
        statusPill("Giveaway", giveaway?.status || "loading", giveaway?.status !== "open")
      ]) : null,
      actionButton("Launch Suite", { id: "launchSuite", variant: "secondary", busyKey: "launchSuite", onClick: launchSuite }),
      showSettingsAction ? settingsActionButton() : null
    ]) : null
  ]);
}

function settingsActionButton() {
  return h("button", {
    className: "icon-button settings-button",
    type: "button",
    title: "Open Configuration Settings",
    "aria-label": "Open Configuration Settings",
    onClick: () => openSettingsWindow(),
    text: "⚙"
  });
}

function renderSidebar() {
  return h("nav", { className: "sidebar", "aria-label": "Console sections" },
    tabs.map(([id, label]) => actionButton(label, {
      className: `nav-button${state.activeTab === id ? " active" : ""}`,
      onClick: () => {
        saveScrollPosition();
        state.activeTab = id;
        render({ skipSaveScroll: true });
      }
    }))
  );
}

function renderTab(id) {
  const body = {
    dashboard: renderDashboard,
    "live-mode": renderLiveMode,
    commands: renderCommands,
    timers: renderTimers,
    moderation: renderModeration,
    giveaways: renderGiveaways,
    "chat-tools": renderChatTools,
    testing: renderTesting,
    settings: renderSettings,
    diagnostics: renderDiagnostics,
    "audit-log": renderAuditLog
  }[id]();

  return h("section", { id, className: `tab-panel${state.activeTab === id ? " active" : ""}` }, body);
}

function sectionHeader(title, description, right) {
  return h("div", { className: "section-head" }, [
    h("div", {}, [h("h2", { text: title }), h("p", { text: description })]),
    right
  ]);
}

function card(title, children) {
  return h("div", { className: "panel" }, [title ? h("h3", { text: title }) : null, ...children]);
}

function formRow(label, control) {
  return h("label", {}, [label, control]);
}

function fieldRef(text, targetId, missing = false) {
  return h("button", {
    className: `field-ref${missing ? " needs-attention" : ""}`,
    type: "button",
    onClick: () => focusField(targetId),
    text
  });
}

function actionButton(label, options = {}) {
  const classes = [options.className || "", options.variant || ""].filter(Boolean).join(" ");
  return h("button", {
    className: classes,
    id: options.id,
    type: "button",
    title: options.title,
    disabled: options.disabled,
    onClick: options.onClick,
    text: state.busy.has(options.busyKey || options.id) ? "Working..." : label
  });
}

function statusPill(label, value, ok = true) {
  return h("div", { className: "pill compact" }, [
    h("strong", { text: label }),
    h("span", { className: ok ? "ok" : "warn", text: value })
  ]);
}

function statusGrid(rows) {
  return h("div", { className: "status-grid" }, rows.map(([label, value, ok = true]) =>
    h("div", { className: "pill" }, [
      h("strong", { text: label }),
      h("span", { className: ok ? "ok" : "warn", text: String(value) })
    ])
  ));
}

function callout(text, tone = "muted") {
  return h("div", { className: `callout ${tone}`, text });
}

function message() {
  return h("div", { className: `message ${state.message.tone}`, text: state.message.text });
}

function renderDashboard() {
  const status = state.status;
  const runtime = status?.runtime || {};
  const readiness = getReadiness();

  return [
    sectionHeader("Dashboard", "Startup path and live stream snapshot.",
      actionButton("Refresh", { id: "refresh", onClick: refreshAll, busyKey: "refresh" })
    ),
    renderDashboardStartCard(runtime, readiness),
    h("div", { className: "dashboard-grid" }, [
      renderDashboardReadinessCard(runtime, readiness),
      renderDashboardGiveawayCard(status?.giveaway)
    ]),
    message()
  ];
}

function renderDashboardStartCard(runtime, readiness) {
  const launch = currentLaunchPreparation();
  const process = runtime?.botProcess || {};
  const setupReady = isTwitchSetupReady();
  const launchReady = Boolean(launch?.setupReady);
  const botRunning = Boolean(process.running);
  const botStartReady = canStartBot(runtime);
  const chatConfirmed = Boolean(runtime?.liveChatConfirmed);
  const giveawayStatus = state.giveaway?.summary?.status || state.status?.giveaway?.status || "none";
  const primary = liveRunbookSteps()[0];

  return card("Start Here", [
    callout(readiness.nextAction || primary?.detail || "Review startup steps.", readiness.ready ? "ok" : "warn"),
    h("div", { className: "dashboard-steps" }, [
      dashboardStep({
        number: "1",
        label: "Settings",
        state: setupReady ? "complete" : "needed",
        tone: setupReady ? "ok" : "warn",
        detail: setupReady
          ? "Twitch OAuth, required scopes, and account IDs are ready."
          : "Finish Twitch credentials, Bot Login, and OAuth in the settings window.",
        action: actionButton(setupReady ? "Settings" : "Open setup", {
          id: "dashboardOpenSettings",
          variant: "secondary",
          onClick: () => openSettingsWindow(setupReady ? "" : "#setupGuide")
        })
      }),
      dashboardStep({
        number: "2",
        label: "Launch checks",
        state: launch?.status || "pending",
        tone: launchTone(launch),
        detail: launch?.summary || "Automatic launch checks run when the app starts.",
        action: actionButton("Rerun", {
          id: "dashboardRerunLaunchPreparation",
          variant: "secondary",
          busyKey: "launchPreparation",
          onClick: runLaunchPreparation
        })
      }),
      dashboardStep({
        number: "3",
        label: "Bot listener",
        state: botRunning ? "running" : "stopped",
        tone: botRunning ? "ok" : botStartReady ? "warn" : "bad",
        detail: botRunning
          ? "The live bot process is running."
          : botStartReady
            ? "Start the bot process before relying on live chat actions."
            : "Automatic validation must pass before the bot can start.",
        action: botRunning
          ? actionButton("Stop", { id: "botStop", variant: "secondary", onClick: stopBot })
          : actionButton("Start", { id: "botStart", variant: "secondary", disabled: !botStartReady, onClick: startBot })
      }),
      dashboardStep({
        number: "4",
        label: "Chat check",
        state: chatConfirmed ? "confirmed" : "pending",
        tone: chatConfirmed ? "ok" : "warn",
        detail: chatConfirmed
          ? "Live chat response is confirmed."
          : "After the bot starts, type !ping in Twitch chat to confirm the listener.",
        action: actionButton("Live Mode", { id: "dashboardOpenLiveMode", variant: "secondary", onClick: openLiveMode })
      }),
      dashboardStep({
        number: "5",
        label: "Giveaway tools",
        state: giveawayStatus,
        tone: giveawayStatus === "none" ? "muted" : "ok",
        detail: giveawayStatus === "none"
          ? "Open giveaway controls when you are ready to run one."
          : "A giveaway is active or recently available for follow-up.",
        action: actionButton("Open", { id: "dashboardOpenGiveaways", variant: "secondary", onClick: openGiveaways })
      })
    ])
  ]);
}

function dashboardStep({ number, label, state: stepState, tone, detail, action }) {
  return h("div", { className: `dashboard-step ${tone || "muted"}` }, [
    h("span", { className: "step-number dashboard-step-number", text: number }),
    h("div", { className: "dashboard-step-copy" }, [
      h("strong", { text: label }),
      h("span", { text: detail })
    ]),
    h("span", { className: `chip ${tone || "muted"}`, text: stepState }),
    action ? h("div", { className: "dashboard-step-action" }, [action]) : null
  ]);
}

function renderDashboardReadinessCard(runtime, readiness) {
  const launch = currentLaunchPreparation();
  const process = runtime?.botProcess || {};
  const recovery = runtime?.outboundRecovery || {};
  const blockers = readiness.blockers || [];

  return card("Live Readiness", [
    statusGrid([
      ["Setup", isTwitchSetupReady() ? "ready" : "needed", isTwitchSetupReady()],
      ["Launch", launch?.status || "pending", ["ready", "attention"].includes(launch?.status)],
      ["Token", runtime?.tokenValid ? "valid" : "not valid", Boolean(runtime?.tokenValid)],
      ["Scopes", runtime?.requiredScopesPresent ? "present" : "missing", Boolean(runtime?.requiredScopesPresent)],
      ["Bot", process.status || "stopped", Boolean(process.running)],
      ["EventSub", runtime?.eventSubConnected ? "connected" : "pending", Boolean(runtime?.eventSubConnected)],
      ["Queue", runtime?.queueReady ? "ready" : "not ready", Boolean(runtime?.queueReady)],
      ["Recovery", recovery.needed ? "needed" : "clear", !recovery.needed]
    ]),
    blockers.length
      ? list(blockers.slice(0, 3), "bad")
      : callout("No local console blockers detected.", "ok"),
    blockers.length > 3 ? callout(`${blockers.length - 3} more blocker(s) are shown in Live Mode and Diagnostics.`, "warn") : null
  ]);
}

function renderDashboardGiveawayCard(statusSummary = {}) {
  const summary = state.giveaway?.summary || statusSummary || {};
  const assurance = state.giveaway?.assurance || {};
  const display = liveDisplayState(summary, state.giveaway?.recap || {});
  const failedCritical = criticalGiveawayFailures().length > 0;

  return card("Giveaway Snapshot", [
    h("div", { className: `state-banner compact ${display.tone}` }, [
      h("strong", { text: display.label }),
      h("span", { text: display.detail })
    ]),
    statusGrid([
      ["Entries", summary.entryCount || 0, true],
      ["Winners", `${summary.winnersDrawn || 0}/${summary.winnerCount || 0}`, true],
      ["Delivery", Number(summary.undeliveredWinnersCount || 0) === 0 ? "clear" : `${summary.undeliveredWinnersCount} pending`, Number(summary.undeliveredWinnersCount || 0) === 0],
      ["Critical Failed", assurance.summary?.failedCritical || 0, Number(assurance.summary?.failedCritical || 0) === 0],
      ["Queue", state.status?.runtime?.queue?.queued || 0, Number(state.status?.runtime?.queue?.queued || 0) === 0],
      ["Safe To End", summary.safeToEnd ? "yes" : "no", Boolean(summary.safeToEnd)]
    ]),
    assurance.blockContinue ? callout(`Pause giveaway actions. ${assurance.nextAction}`, "bad") : null,
    h("div", { className: "actions" }, [
      actionButton("Open Giveaways", { id: "dashboardGiveawaysOpen", variant: "secondary", onClick: openGiveaways }),
      actionButton("Send status", { id: "dashboardSendGiveawayStatus", variant: "secondary", busyKey: "sendGiveawayStatus", onClick: sendGiveawayStatus }),
      failedCritical ? actionButton("Panic resend", { id: "dashboardPanicResendCritical", variant: "danger", busyKey: "resendCriticalGiveaway", onClick: resendCriticalGiveaway }) : null,
      actionButton("Copy recap", { id: "dashboardCopyRecap", variant: "secondary", busyKey: "copyRecap", onClick: copyRecap })
    ])
  ]);
}

function renderLaunchPreparationCard() {
  const launch = currentLaunchPreparation();
  const tone = launchTone(launch);
  const checks = launch?.checks || [];
  const tokenRefresh = checks.some((check) => check.ok && check.name === "Token refreshed");

  return card("Automatic Launch Preparation", [
    callout(launch?.summary || "Launch preparation will run when vaexcore console starts.", tone),
    statusGrid([
      ["Status", launch?.status || "pending", tone === "ok"],
      ["Setup", launch?.setupReady ? "ready" : "not ready", Boolean(launch?.setupReady)],
      ["Preflight", launch?.preflightReady ? "ready" : launch?.preflight ? "attention" : "pending", Boolean(launch?.preflightReady)],
      ["Token Refresh", tokenRefresh ? "refreshed" : "as needed", true]
    ]),
    launch?.nextAction ? callout(launch.nextAction, tone) : null,
    h("div", { className: "actions" }, [
      actionButton("Rerun launch checks", { id: "rerunLaunchPreparation", variant: "secondary", busyKey: "launchPreparation", onClick: runLaunchPreparation })
    ])
  ]);
}

function renderLiveMode() {
  const readiness = getReadiness();

  return [
    sectionHeader("Live Mode", "Compact stream-state controls for live operation.",
      actionButton("Refresh", { id: "liveRefresh", onClick: refreshAll, busyKey: "refresh" })
    ),
    renderLiveStateCard({ prefix: "live" }),
    readiness.blockers.length
      ? card("Blockers", [list(readiness.blockers, "bad")])
      : card("Ready Summary", [callout("Twitch connection ready", "ok")]),
    renderStreamPresetCard({ prefix: "live" }),
    renderLiveRunbookCard({ prefix: "live" }),
    renderQueueHealthCard(),
    renderRecoveryChecklistCard(),
    renderPanicResendCard(),
    renderPostStreamRecapCard({ compact: true }),
    renderFailureLogCard()
  ];
}

function renderLiveStateCard(options = {}) {
  const summary = state.giveaway?.summary || state.status?.giveaway || {};
  const assurance = state.giveaway?.assurance || {};
  const display = liveDisplayState(summary, state.giveaway?.recap || {});
  const tone = display.tone;
  const label = display.label;
  const detail = display.detail;
  const prefix = options.prefix || "liveState";

  return card("Live Giveaway State", [
    h("div", { className: `state-banner ${tone}` }, [
      h("strong", { text: label }),
      h("span", { text: detail })
    ]),
    statusGrid([
      ["Entries", summary.entryCount || 0, true],
      ["Winners", `${summary.winnersDrawn || 0}/${summary.winnerCount || 0}`, true],
      ["Delivery", Number(summary.undeliveredWinnersCount || 0) === 0 ? "clear" : `${summary.undeliveredWinnersCount} pending`, Number(summary.undeliveredWinnersCount || 0) === 0],
      ["Safe To End", summary.safeToEnd ? "yes" : "no", Boolean(summary.safeToEnd)],
      ["Critical Gaps", assurance.summary?.missingCritical || 0, Number(assurance.summary?.missingCritical || 0) === 0],
      ["Critical Failed", assurance.summary?.failedCritical || 0, Number(assurance.summary?.failedCritical || 0) === 0],
      ["Chat Queue", state.status?.runtime?.queue?.queued || 0, Number(state.status?.runtime?.queue?.queued || 0) === 0],
      ["Bot", state.status?.runtime?.botProcess?.status || "stopped", Boolean(state.status?.runtime?.botProcess?.running)]
    ]),
    assurance.blockContinue ? callout(`Do not continue giveaway operations yet. ${assurance.nextAction}`, "bad") : null,
    h("div", { className: "actions live-actions" }, [
      actionButton("Send status to chat", { id: `${prefix}SendGiveawayStatus`, variant: "secondary", busyKey: "sendGiveawayStatus", onClick: sendGiveawayStatus }),
      actionButton("Panic resend latest critical", { id: `${prefix}PanicResendCritical`, variant: "danger", busyKey: "resendCriticalGiveaway", onClick: resendCriticalGiveaway }),
      actionButton("Run preflight", { id: `${prefix}RunPreflight`, variant: "secondary", busyKey: "runPreflight", onClick: runPreflight }),
      actionButton("Copy recap", { id: `${prefix}CopyRecap`, variant: "secondary", busyKey: "copyRecap", onClick: copyRecap })
    ])
  ]);
}

function renderStreamPresetCard(options = {}) {
  const presets = state.streamPresets || [];
  const prefix = options.prefix || "stream";

  return card("Stream Night Presets", [
    presets.length
      ? dataTable(["Preset", "Custom Commands", "Timers", "Moderation", "Status", "Actions"], presets.map((preset) => [
          preset.label,
          preset.modes?.custom_commands || "off",
          preset.modes?.timers || "off",
          preset.modes?.moderation_filters || "off",
          preset.inspection?.detail || "",
          actionButton(preset.inspection?.status === "current" ? "Applied" : "Apply preset", {
            id: `${prefix}-stream-preset-${preset.id}`,
            variant: "secondary",
            busyKey: "streamPreset",
            disabled: preset.inspection?.status === "current",
            onClick: () => applyStreamPreset(preset.id)
          })
        ]))
      : callout("No stream presets are available.", "muted")
  ]);
}

function renderLiveRunbookCard(options = {}) {
  const runbook = liveRunbookSteps();
  const primary = runbook[0];
  const blockers = getReadiness().blockers;
  const prefix = options.prefix || "runbook";

  return card("Live Runbook", [
    statusGrid([
      ["Current Priority", primary?.label || "Monitor", !primary || primary.tone !== "bad"],
      ["Blockers", blockers.length, blockers.length === 0],
      ["Queue", state.status?.runtime?.queueHealth?.status || "unknown", state.status?.runtime?.queueHealth?.status !== "blocked"],
      ["Recovery", state.status?.runtime?.outboundRecovery?.needed ? "needed" : "clear", !state.status?.runtime?.outboundRecovery?.needed]
    ]),
    primary ? callout(primary.detail, primary.tone) : callout("No live runbook action needed. Keep monitoring chat and queue health.", "ok"),
    dataTable(["Priority", "State", "Action"], runbook.map((step, index) => [
      `${index + 1}. ${step.label}`,
      h("span", { className: step.tone || "muted", text: step.detail }),
      step.actionLabel
        ? actionButton(step.actionLabel, {
            id: `${prefix}-runbook-${step.id}`,
            variant: step.variant || "secondary",
            disabled: step.disabled,
            onClick: step.onClick
          })
        : ""
    ])),
    h("div", { className: "actions" }, [
      actionButton("Run preflight", { id: `${prefix}RunbookPreflight`, variant: "secondary", busyKey: "runPreflight", onClick: runPreflight }),
      actionButton("Copy incident note", { id: `${prefix}CopyIncidentNote`, variant: "secondary", busyKey: "copyIncidentNote", onClick: copyIncidentNote })
    ])
  ]);
}

function renderBotRuntimeCard(runtime) {
  const process = runtime?.botProcess || {};
  const running = Boolean(process.running);
  const canStart = canStartBot(runtime);
  const recentLogs = process.recentLogs || [];
  const failureLogs = outboundFailureLogs(recentLogs);

  return card("Bot Runtime", [
    statusGrid([
      ["Process", process.status || "stopped", running],
      ["PID", process.pid || "none", running],
      ["EventSub", runtime?.eventSubConnected ? "connected" : "not connected", runtime?.eventSubConnected],
      ["Chat Subscription", runtime?.chatSubscriptionActive ? "active" : "inactive", runtime?.chatSubscriptionActive],
      ["Live Chat", runtime?.liveChatConfirmed ? "confirmed" : "pending", runtime?.liveChatConfirmed]
    ]),
    h("div", { className: "actions" }, [
      actionButton("Start Bot", { id: "botStart", variant: "secondary", onClick: startBot }),
      actionButton("Stop Bot", { id: "botStop", variant: "secondary", onClick: stopBot })
    ]),
    canStart || running ? null : callout("Complete setup and let automatic validation finish before starting the bot.", "warn"),
    process.lastError ? callout(process.lastError, "bad") : null,
    failureLogs.length ? h("div", {}, [
      h("h3", { text: "Outbound Failure Logs" }),
      h("pre", { className: "runtime-log failure-log", text: failureLogs.slice(-5).join("\n") })
    ]) : null,
    recentLogs.length ? h("pre", { className: "runtime-log", text: recentLogs.slice(-8).join("\n") }) : h("p", { className: "muted", text: "No bot runtime logs yet." })
  ]);
}

function renderQueueHealthCard() {
  const health = state.status?.runtime?.queueHealth || {};
  const tone = queueTone(health.status);

  return card("Queue Health", [
    statusGrid([
      ["Status", health.status || "unknown", tone === "ok"],
      ["Pending", health.pending || 0, Number(health.pending || 0) === 0],
      ["Oldest Age", health.oldestAge || "0s", !health.stale],
      ["Processing", health.processing ? "yes" : "no", true],
      ["Oldest Action", health.oldestAction || "none", true],
      ["Oldest Importance", health.oldestImportance || "normal", health.oldestImportance !== "critical"],
      ["Retry Delay", health.retryDelay || "0s", Number(health.retryDelayMs || 0) === 0],
      ["Send Throttle", health.rateLimitDelay || "0s", !health.rateLimited],
      ["Rate Limited", health.rateLimitedPending || 0, Number(health.rateLimitedPending || 0) === 0],
      ["Max Attempts", health.maxAttempts || 4, true],
      ["Stale", health.stale ? "yes" : "no", !health.stale]
    ]),
    callout(health.nextAction || "Queue health unavailable.", tone),
    health.blockers?.length ? list(health.blockers, tone === "bad" ? "bad" : "warn") : null
  ]);
}

function renderRecoveryChecklistCard() {
  const recovery = state.status?.runtime?.outboundRecovery || {};
  const tone = recovery.needed ? recovery.severity === "critical" ? "bad" : "warn" : "ok";

  return card("Recovery Checklist", [
    statusGrid([
      ["Needed", recovery.needed ? "yes" : "no", !recovery.needed],
      ["Safe To Resend", recovery.safeToResend ? "yes" : "no", recovery.needed ? recovery.safeToResend : true],
      ["Action", recovery.action || "none", !recovery.needed],
      ["Category", recovery.failureCategory || "none", !recovery.needed || !["auth", "config"].includes(recovery.failureCategory)],
      ["Attempts", recovery.attempts || 0, !recovery.needed || Number(recovery.attempts || 0) < 4]
    ]),
    callout(recovery.nextAction || "No outbound recovery needed.", tone),
    recovery.reason ? callout(`Last failure: ${recovery.reason}`, tone) : null,
    recovery.steps?.length ? list(recovery.steps, recovery.needed ? "warn" : "muted") : null
  ]);
}

function renderFailureLogCard() {
  const logs = outboundFailureLogs(state.status?.runtime?.botProcess?.recentLogs || []);

  return card("Outbound Failure Logs", [
    logs.length
      ? h("pre", { className: "runtime-log failure-log", text: logs.slice(-8).join("\n") })
      : callout("No outbound chat failures in recent bot logs.", "ok")
  ]);
}

function renderPreflightCard() {
  const result = state.preflightResult;
  const launch = currentLaunchPreparation();

  return card("Preflight Rehearsal", [
    h("p", { text: "This runs automatically on launch. Rerun it before going live if setup or stream state changed." }),
    h("div", { className: "actions" }, [
      actionButton("Run preflight", { id: "runPreflight", variant: "secondary", onClick: runPreflight })
    ]),
    result ? statusGrid([
      ["Summary", result.ok ? "ready" : "not ready", result.ok],
      ["Next action", result.nextAction || "none", result.ok]
    ]) : null,
    result?.checks?.length ? dataTable(["Check", "Result", "Detail"], result.checks.map((check) => [
      check.name,
      h("span", { className: `chip ${check.ok ? "ok" : "bad"}`, text: check.ok ? "pass" : "fail" }),
      check.detail
    ])) : callout(
      launch?.status === "running"
        ? "Automatic preflight is running."
        : "Automatic preflight has not completed in this session.",
      launch?.status === "running" ? "warn" : "muted"
    )
  ]);
}

function renderOutboundHistoryCard() {
  const messages = state.outboundMessages || [];
  const summary = state.outboundSummary || {};
  const failed = messages.filter((item) => item.status === "failed");
  const recent = messages.slice(0, 12);

  return card("Outbound Chat History", [
    statusGrid([
      ["Tracked", summary.total || 0],
      ["Sent", summary.sent || 0, Number(summary.failed || 0) === 0],
      ["Queued/Retrying", summary.queued || 0, true],
      ["Failed", summary.failed || 0, Number(summary.failed || 0) === 0],
      ["Critical Failed", summary.criticalFailed || 0, Number(summary.criticalFailed || 0) === 0]
    ]),
    h("div", { className: "actions" }, [
      actionButton("Resend last failed", {
        id: "resendLastFailed",
        variant: "secondary",
        disabled: failed.length === 0,
        onClick: () => resendOutboundMessage()
      }),
      actionButton("Refresh history", { id: "refreshOutbound", variant: "secondary", onClick: refreshOutboundMessages })
    ]),
    failed.length ? callout("One or more outbound messages failed. Use resend after checking that the text is still appropriate.", "warn") : null,
    dataTable(["Updated", "Source", "Status", "Category", "Attempts", "Message", "Action"], recent.map((item) => [
      item.updatedAt || "",
      item.source || "",
      statusChip(item.status),
      failureCategoryChip(item.failureCategory),
      item.attempts || 0,
      formatMessagePreview(item.message),
      item.status === "failed"
        ? actionButton("Resend", {
            id: `resend-${item.id}`,
            variant: "secondary",
            busyKey: "resendOutbound",
            onClick: () => resendOutboundMessage(item.id)
          })
        : ""
    ]))
  ]);
}

function renderGiveawayOutboundCard() {
  const messages = giveawayOutboundMessages();
  const assurance = state.giveaway?.assurance || {};
  const critical = messages.filter((item) => item.importance === "critical");
  const failed = critical.filter((item) => item.status === "failed");
  const pending = critical.filter((item) => ["queued", "sending", "retrying"].includes(item.status));
  const sent = critical.filter((item) => ["sent", "resent"].includes(item.status));
  const phaseRows = assurance.phases || [];

  return card("Giveaway Chat Assurance", [
    statusGrid([
      ["Critical Confirmed", assurance.summary?.confirmedCritical || sent.length, Number(assurance.summary?.blockingCritical || 0) === 0],
      ["Critical Pending", assurance.summary?.pendingCritical || pending.length, Number(assurance.summary?.pendingCritical || pending.length) === 0],
      ["Critical Failed", failed.length, failed.length === 0],
      ["Missing Critical", assurance.summary?.missingCritical || 0, Number(assurance.summary?.missingCritical || 0) === 0],
      ["Tracked Messages", messages.length, true],
      ["Recap Sent", assurance.summary?.sent || 0, true],
      ["Recap Resent", assurance.summary?.resent || 0, true],
      ["Recap Pending", assurance.summary?.pending || 0, Number(assurance.summary?.failed || 0) === 0]
    ]),
    assurance.blockContinue
      ? callout(`Do not continue giveaway operations yet. ${assurance.nextAction || "Resolve critical chat assurance first."}`, "bad")
      : failed.length
        ? callout("A critical giveaway chat message failed. Resend it before continuing live operations.", "bad")
        : callout(messages.length ? "Required critical giveaway messages have send confirmation or are not required yet." : "No giveaway chat messages tracked yet.", messages.length ? "ok" : "muted"),
    phaseRows.length ? dataTable(["Phase", "Required", "Delivery", "Category", "Queue ID", "Attempts", "Next Attempt", "Reason", "Recovery", "Action"], phaseRows.map((phase) => [
      phase.label,
      phase.required ? "yes" : "tracked",
      statusChip(phase.queueStatus || phase.status),
      failureCategoryChip(phase.failureCategory),
      shortId(phase.outboundMessageId),
      phase.attempts || 0,
      phase.nextAttemptAt || "",
      phase.reason || "",
      phase.deliveryDetail || phase.recovery || "",
      phase.canSend
        ? actionButton(phase.status === "missing" ? "Send" : "Resend", {
            id: `phase-resend-${phase.id}`,
            variant: "secondary",
            busyKey: "resendGiveawayAnnouncement",
            onClick: () => resendGiveawayAnnouncement(phase.action || phase.id)
          })
        : ""
    ])) : null,
    dataTable(["Action", "Importance", "Status", "Category", "Attempts", "Message", "Updated", "Resend"], messages.slice(0, 10).map((item) => [
      item.action || "message",
      importanceChip(item.importance),
      statusChip(item.status),
      failureCategoryChip(item.failureCategory),
      item.attempts || 0,
      formatMessagePreview(item.message),
      item.updatedAt || "",
      item.status === "failed"
        ? actionButton("Resend", {
            id: `giveaway-resend-${item.id}`,
            variant: "secondary",
            busyKey: "resendOutbound",
            onClick: () => resendOutboundMessage(item.id)
          })
        : ""
    ]))
  ]);
}

function renderGiveawayReminderCard() {
  const reminder = state.reminder || {};

  return card("Reminder Controls", [
    h("p", { text: "Timed reminders only queue while entries are open and chat is configured." }),
    h("div", { className: "grid" }, [
      h("label", { className: "inline-check" }, [
        h("input", { id: "reminderEnabled", type: "checkbox", onChange: updateReminderDraft }),
        "Enable timed reminders"
      ]),
      formRow("Interval minutes", h("input", { id: "reminderInterval", type: "number", min: "2", max: "60", onInput: updateReminderDraft }))
    ]),
    statusGrid([
      ["State", reminder.enabled ? "enabled" : "off", Boolean(reminder.enabled)],
      ["Open Giveaway", reminder.openGiveaway ? reminder.giveawayTitle || "yes" : "no", Boolean(reminder.openGiveaway)],
      ["Last Sent", reminder.lastSentAt || "never", true],
      ["Next Send", reminder.nextSendAt || "none", !reminder.enabled || Boolean(reminder.nextSendAt)]
    ]),
    reminder.lastError ? callout(reminder.lastError, "warn") : null,
    h("div", { className: "actions" }, [
      actionButton("Save reminder", { id: "saveReminder", variant: "secondary", onClick: saveReminder }),
      actionButton("Send reminder now", { id: "sendReminderNow", variant: "secondary", onClick: sendReminderNow })
    ])
  ]);
}

function renderGiveawayTemplatesCard() {
  const templates = state.templates || [];

  return card("Message Templates", [
    h("p", { text: "Customize local giveaway chat messages without storing prize codes. Leave placeholders in braces when you want live giveaway values inserted." }),
    h("div", { className: "template-list" }, templates.map((template) =>
      h("label", { className: "template-row" }, [
        h("span", {}, [
          h("strong", { text: template.label }),
          h("small", { text: template.description })
        ]),
        h("textarea", {
          id: `template-${template.action}`,
          "data-action": template.action,
          onInput: updateTemplateDraft
        })
      ])
    )),
    callout("Available placeholders: {title}, {keyword}, {winnerCount}, {entryCount}, {displayName}, {winners}, {winnerPlural}, {drawnCount}, {requestedCount}, {partial}, {rerolled}, {replacement}."),
    h("div", { className: "actions" }, [
      actionButton("Save templates", { id: "saveTemplates", variant: "secondary", onClick: saveTemplates }),
      actionButton("Reset templates", { id: "resetTemplates", variant: "secondary", onClick: resetTemplates })
    ])
  ]);
}

function renderGiveawayRecapCard() {
  const recap = state.giveaway?.recap || {};

  if (!recap.available) {
    return card("Post-Giveaway Recap", [callout("No giveaway has run yet.", "muted")]);
  }

  return card("Post-Giveaway Recap", [
    statusGrid([
      ["Giveaway", `#${recap.id} ${recap.title}`, true],
      ["Status", recap.status, recap.status === "ended"],
      ["Entries", recap.entryCount || 0, true],
      ["Winners", recap.activeWinnerCount || 0, true],
      ["Pending Delivery", recap.pendingDeliveryCount || 0, Number(recap.pendingDeliveryCount || 0) === 0],
      ["Delivered", recap.deliveredWinnerCount || 0, true],
      ["Critical Messages", recap.criticalMessageCount || 0, true],
      ["Failed Messages", recap.failedMessageCount || 0, Number(recap.failedMessageCount || 0) === 0],
      ["Sent Messages", recap.sentMessageCount || 0, true],
      ["Resent Messages", recap.resentMessageCount || 0, true],
      ["Pending Messages", recap.pendingMessageCount || 0, Number(recap.pendingMessageCount || 0) === 0],
      ["Critical Confirmed", recap.confirmedCriticalCount || 0, Number(recap.blockingCriticalCount || 0) === 0],
      ["Critical Pending", recap.pendingCriticalCount || 0, Number(recap.pendingCriticalCount || 0) === 0],
      ["Missing Critical", recap.missingCriticalCount || 0, Number(recap.missingCriticalCount || 0) === 0],
      ["Blocking Critical", recap.blockingCriticalCount || 0, Number(recap.blockingCriticalCount || 0) === 0]
    ]),
    dataTable(["Winner", "Delivered"], (recap.winners || []).map((winner) => [
      `${winner.displayName} @${winner.login}`,
      winner.delivered ? "yes" : "pending"
    ]))
  ]);
}

function renderPanicResendCard() {
  const failures = criticalGiveawayFailures();
  const latest = failures[0];

  return card("Panic Resend", [
    statusGrid([
      ["Failed Critical", failures.length, failures.length === 0],
      ["Latest Action", latest?.action || "none", !latest],
      ["Latest Reason", latest?.reason || "none", !latest],
      ["Updated", latest?.updatedAt || "none", !latest]
    ]),
    latest
      ? callout("Review the failed message, then resend only if chat did not receive the critical giveaway announcement.", "bad")
      : callout("No failed critical giveaway messages need panic resend.", "ok"),
    latest ? h("pre", { className: "runtime-log failure-log", text: `${latest.action || "message"}: ${latest.message}` }) : null,
    h("div", { className: "actions" }, [
      actionButton("Panic resend latest critical", {
        id: "panicCardResendCritical",
        variant: "danger",
        busyKey: "resendCriticalGiveaway",
        onClick: resendCriticalGiveaway
      })
    ])
  ]);
}

function renderPostStreamRecapCard() {
  const text = postStreamRecapText();

  return card("Post-Stream Recap", [
    h("textarea", {
      id: "postStreamRecap",
      className: "recap-text",
      readonly: "readonly"
    }, text),
    h("div", { className: "actions" }, [
      actionButton("Copy recap", {
        id: "postStreamCopyRecap",
        variant: "secondary",
        busyKey: "copyRecap",
        onClick: copyRecap
      })
    ])
  ]);
}

function renderFeatureGateCard(key) {
  const gate = featureGate(key);
  const mode = gate.mode || "off";
  const isLive = mode === "live";
  const isTest = mode === "test";

  return card("Feature Gate", [
    statusGrid([
      ["Mode", mode, isLive],
      ["Local tests", gate.testAllowed ? "allowed" : "blocked", gate.testAllowed],
      ["Twitch chat", gate.liveAllowed ? "allowed" : "blocked", gate.liveAllowed],
      ["Updated", gate.updatedAt || "default", true]
    ]),
    h("div", { className: "actions segmented-actions" }, [
      actionButton("Off", {
        id: `${key}-gate-off`,
        variant: mode === "off" ? "" : "secondary",
        busyKey: "featureGate",
        disabled: mode === "off",
        onClick: () => setFeatureGate(key, "off")
      }),
      actionButton("Test", {
        id: `${key}-gate-test`,
        variant: isTest ? "" : "secondary",
        busyKey: "featureGate",
        disabled: isTest,
        onClick: () => setFeatureGate(key, "test")
      }),
      actionButton("Live", {
        id: `${key}-gate-live`,
        variant: isLive ? "" : "secondary",
        busyKey: "featureGate",
        disabled: isLive,
        onClick: () => setFeatureGate(key, "live")
      })
    ]),
    callout(featureGateSummary(gate), isLive ? "ok" : isTest ? "info" : "warn")
  ]);
}

function renderCommands() {
  const commands = filteredCustomCommands();
  const selected = selectedCustomCommand();
  const history = state.commandHistory || [];
  const reservedNames = (state.commandReservedNames || []).map((name) => `!${name}`).join(", ");

  return [
    sectionHeader("Commands", "Manage local custom chat commands, permissions, cooldowns, and usage history.",
      h("div", { className: "actions section-actions" }, [
        actionButton("New command", { id: "newCommand", variant: "secondary", onClick: newCustomCommand }),
        actionButton("Refresh", { id: "refreshCommands", variant: "secondary", busyKey: "refresh", onClick: refreshAll })
      ])
    ),
    renderFeatureGateCard("custom_commands"),
    renderCommandPresetPackCard(),
    renderCommandPresetCard(),
    card("Command Library", [
      statusGrid([
        ["Total", state.commandSummary.total || 0, true],
        ["Enabled", state.commandSummary.enabled || 0, true],
        ["Disabled", state.commandSummary.disabled || 0, Number(state.commandSummary.disabled || 0) === 0],
        ["Aliases", state.commandSummary.aliases || 0, true],
        ["Uses", state.commandSummary.uses || 0, true]
      ]),
      h("div", { className: "toolbar" }, [
        formRow("Search commands", h("input", {
          id: "commandFilter",
          placeholder: "filter by command or alias",
          onInput: (event) => {
            state.commandFilter = event.target.value;
            render();
          }
        })),
        h("span", { className: "count", text: `${commands.length} of ${(state.commands || []).length} visible` })
      ]),
      dataTable(["Command", "State", "Permission", "Cooldowns", "Aliases", "Uses", "Actions"], commands.map((command) => [
        `!${command.name}`,
        statusChip(command.enabled ? "enabled" : "disabled"),
        commandPermissionChip(command.permission),
        `${command.globalCooldownSeconds}s global / ${command.userCooldownSeconds}s user`,
        command.aliases.length ? command.aliases.map((alias) => `!${alias}`).join(", ") : "",
        `${command.useCount || 0}${command.lastUsedAt ? ` last ${command.lastUsedAt}` : ""}`,
        h("div", { className: "actions inline-actions table-actions" }, [
          actionButton("Edit", { id: `command-edit-${command.id}`, variant: "secondary", onClick: () => editCustomCommand(command.id) }),
          actionButton(command.enabled ? "Disable" : "Enable", { id: `command-enable-${command.id}`, variant: "secondary", busyKey: "commandEnable", onClick: () => toggleCustomCommand(command.id, !command.enabled) }),
          actionButton("Duplicate", { id: `command-duplicate-${command.id}`, variant: "secondary", busyKey: "commandDuplicate", onClick: () => duplicateCustomCommand(command.id) }),
          actionButton("Delete", { id: `command-delete-${command.id}`, variant: "danger", busyKey: "commandDelete", onClick: () => deleteCustomCommand(command.id, command.name) })
        ])
      ])),
      reservedNames ? callout(`Reserved names: ${reservedNames}`, "muted") : null
    ]),
    card("Command Editor", [
      selected ? callout(`Editing !${selected.name}`, selected.enabled ? "ok" : "warn") : callout("Create a new command or select one from the library.", "muted"),
      h("div", { className: "grid three" }, [
        formRow("Command name", h("input", { id: "commandName", placeholder: "discord", onInput: updateCommandDraft })),
        formRow("Permission", h("select", { id: "commandPermission", onChange: updateCommandDraft }, [
          option("viewer", "viewer"),
          option("moderator", "moderator"),
          option("broadcaster", "broadcaster")
        ])),
        h("label", { className: "inline-check editor-check" }, [
          h("input", { id: "commandEnabled", type: "checkbox", onChange: updateCommandDraft }),
          "Enabled"
        ]),
        formRow("Global cooldown seconds", h("input", { id: "commandGlobalCooldown", type: "number", min: "0", max: "86400", onInput: updateCommandDraft })),
        formRow("User cooldown seconds", h("input", { id: "commandUserCooldown", type: "number", min: "0", max: "86400", onInput: updateCommandDraft })),
        formRow("Aliases", h("textarea", { id: "commandAliases", placeholder: "links\nsocials", onInput: updateCommandDraft }))
      ]),
      formRow("Response variants", h("textarea", {
        id: "commandResponses",
        className: "command-response-editor",
        placeholder: "Join the Discord: https://example.com\n{user}, Discord is at https://example.com",
        onInput: updateCommandDraft
      })),
      callout("Placeholders: {user}, {displayName}, {login}, {args}, {arg1} through {arg9}, {target}, {count}. Put each random response variant on its own line.", "info"),
      h("div", { className: "grid three" }, [
        formRow("Preview actor", h("input", { id: "commandPreviewActor", placeholder: "viewer" })),
        formRow("Preview role", h("select", { id: "commandPreviewRole" }, [
          option("viewer", "viewer"),
          option("mod", "mod"),
          option("broadcaster", "broadcaster")
        ])),
        formRow("Preview args", h("input", { id: "commandPreviewArgs", placeholder: "target extra text" }))
      ]),
      h("div", { className: "actions" }, [
        actionButton("Save command", { id: "saveCommand", onClick: saveCustomCommand }),
        actionButton("Preview response", { id: "previewCommand", variant: "secondary", onClick: previewCustomCommand }),
        actionButton("Run test command", { id: "testCustomCommand", variant: "secondary", onClick: testCustomCommand })
      ]),
      renderCommandPreview(),
      renderTestResult()
    ]),
    card("Import And Export", [
      h("div", { className: "actions" }, [
        actionButton("Export commands JSON", { id: "exportCommands", variant: "secondary", onClick: exportCustomCommands }),
        actionButton("Import commands JSON", { id: "importCommands", variant: "secondary", onClick: importCustomCommands })
      ]),
      formRow("Import JSON", h("textarea", {
        id: "commandImportJson",
        className: "command-import",
        placeholder: "{\"commands\":[...]}"
      }))
    ]),
    card("Recent Command Uses", [
      dataTable(["Timestamp", "Command", "Alias", "User", "Response"], history.slice(0, 20).map((entry) => [
        entry.createdAt || "",
        `!${entry.commandName}`,
        entry.aliasUsed && entry.aliasUsed !== entry.commandName ? `!${entry.aliasUsed}` : "",
        entry.userLogin || "",
        formatMessagePreview(entry.responseText || "")
      ]))
    ]),
    message()
  ];
}

function renderCommandPresetCard() {
  const presets = state.commandPresets || [];

  return card("Starter Commands", [
    presets.length
      ? dataTable(["Preset", "Category", "Command", "Permission", "Response", "Status", "Actions"], presets.map((preset) => [
          preset.label,
          preset.category || "Utility",
          `!${preset.commandName}${preset.aliases?.length ? ` (${preset.aliases.map((alias) => `!${alias}`).join(", ")})` : ""}`,
          commandPermissionChip(preset.permission || "viewer"),
          formatMessagePreview((preset.responses || [])[0] || ""),
          preset.inspection?.status === "ready" ? preset.inspection?.nextAction || "ready" : preset.inspection?.detail || "blocked",
          actionButton("Create disabled", {
            id: `command-preset-${preset.id}`,
            variant: "secondary",
            busyKey: "commandPreset",
            disabled: preset.inspection?.status !== "ready",
            onClick: () => applyCommandPreset(preset.id)
          })
        ]))
      : callout("No command presets are available.", "muted")
  ]);
}

function renderCommandPresetPackCard() {
  const packs = state.commandPresetPacks || [];

  return card("Utility Packs", [
    callout("Packs create ready commands disabled. Review placeholder links/copy, then enable only after local tests.", "muted"),
    packs.length
      ? dataTable(["Pack", "Commands", "Ready", "Status", "Actions"], packs.map((pack) => [
          pack.label,
          pack.description || "",
          `${pack.readyCount || 0}/${pack.commandCount || 0}`,
          pack.inspection?.detail || "",
          actionButton("Create ready disabled", {
            id: `command-pack-${pack.id}`,
            variant: "secondary",
            busyKey: "commandPresetPack",
            disabled: !pack.readyCount,
            onClick: () => applyCommandPresetPack(pack.id)
          })
        ]))
      : callout("No utility packs are available.", "muted")
  ]);
}

function renderTimers() {
  const timers = state.timers || [];
  const selected = selectedTimer();
  const readiness = state.timerReadiness || {};

  return [
    sectionHeader("Timers", "Schedule local stream messages with live readiness, non-command chat activity, and queue guardrails.",
      h("div", { className: "actions section-actions" }, [
        actionButton("New timer", { id: "newTimer", variant: "secondary", onClick: newTimer }),
        actionButton("Refresh", { id: "refreshTimers", variant: "secondary", busyKey: "refresh", onClick: refreshAll })
      ])
    ),
    renderFeatureGateCard("timers"),
    renderTimerReadinessCard(),
    renderTimerPresetCard(),
    renderTimerSuggestionCard(),
    card("Timer Library", [
      statusGrid([
        ["Total", state.timerSummary.total || 0, true],
        ["Enabled", state.timerSummary.enabled || 0, true],
        ["Disabled", state.timerSummary.disabled || 0, Number(state.timerSummary.disabled || 0) === 0],
        ["Sent", state.timerSummary.sent || 0, true],
        ["Blocked", state.timerSummary.blocked || 0, Number(state.timerSummary.blocked || 0) === 0],
        ["Waiting activity", state.timerSummary.waitingForActivity || 0, true],
        ["Next fire", state.timerSummary.nextFireAt || "none", true],
        ["Readiness", readiness.ok ? "ready" : "blocked", Boolean(readiness.ok)]
      ]),
      readiness.reason ? callout(readiness.reason, readiness.ok ? "ok" : "warn") : null,
      dataTable(["Timer", "State", "Interval", "Activity", "Last Sent", "Next Fire", "Status", "Why / Next Action", "Actions"], timers.map((timer) => [
        timer.name,
        statusChip(timer.enabled ? "enabled" : "disabled"),
        `${timer.intervalMinutes}m`,
        timer.minChatMessages > 0
          ? `${Math.min(timer.chatMessagesSinceLastFire || 0, timer.minChatMessages)}/${timer.minChatMessages}`
          : "off",
        timer.lastSentAt || "never",
        timer.nextFireAt || "none",
        timer.lastStatus === "blocked" && timer.lastError
          ? `${timer.lastStatus}: ${timer.lastError}`
          : timer.lastStatus || "never",
        timer.inspection
          ? `${timer.inspection.detail} ${timer.inspection.nextAction || ""}`.trim()
          : "",
        h("div", { className: "actions inline-actions table-actions" }, [
          actionButton("Edit", { id: `timer-edit-${timer.id}`, variant: "secondary", onClick: () => editTimer(timer.id) }),
          actionButton(timer.enabled ? "Disable" : "Enable", { id: `timer-enable-${timer.id}`, variant: "secondary", busyKey: "timerEnable", onClick: () => toggleTimer(timer.id, !timer.enabled) }),
          actionButton("Send now", { id: `timer-send-${timer.id}`, variant: "secondary", busyKey: "timerSend", disabled: !timer.enabled || !readiness.ok, onClick: () => sendTimerNow(timer.id) }),
          actionButton("Delete", { id: `timer-delete-${timer.id}`, variant: "danger", busyKey: "timerDelete", onClick: () => deleteTimer(timer.id, timer.name) })
        ])
      ]))
    ]),
    card("Timer Editor", [
      selected ? callout(`Editing ${selected.name}`, selected.enabled ? "ok" : "warn") : callout("Create a timer or select one from the library.", "muted"),
      h("div", { className: "grid three" }, [
        formRow("Timer name", h("input", { id: "timerName", placeholder: "Discord reminder", onInput: updateTimerDraft })),
        formRow("Interval minutes", h("input", { id: "timerInterval", type: "number", min: "5", max: "1440", onInput: updateTimerDraft })),
        formRow("Chat messages required", h("input", { id: "timerMinChatMessages", type: "number", min: "0", max: "500", onInput: updateTimerDraft })),
        h("label", { className: "inline-check editor-check" }, [
          h("input", { id: "timerEnabled", type: "checkbox", onChange: updateTimerDraft }),
          "Enabled"
        ])
      ]),
      formRow("Message", h("textarea", {
        id: "timerMessage",
        className: "command-response-editor",
        placeholder: "Follow the channel for schedule updates.",
        onInput: updateTimerDraft
      })),
      callout("Timers use the outbound queue and only fire when Timers are Live, the bot is live-ready, the queue is clear, and the timer's non-command chat activity requirement is met. Minimum interval is 5 minutes.", "info"),
      h("div", { className: "actions" }, [
        actionButton("Save timer", { id: "saveTimer", onClick: saveTimer }),
        selected ? actionButton("Send now", { id: "sendSelectedTimer", variant: "secondary", busyKey: "timerSend", disabled: !selected.enabled || !readiness.ok, onClick: () => sendTimerNow(selected.id) }) : null
      ])
    ]),
    card("Import And Export", [
      h("div", { className: "actions" }, [
        actionButton("Export timers JSON", { id: "exportTimers", variant: "secondary", onClick: exportTimers }),
        actionButton("Import timers JSON", { id: "importTimers", variant: "secondary", onClick: importTimers })
      ]),
      formRow("Import JSON", h("textarea", {
        id: "timerImportJson",
        className: "command-import",
        placeholder: "{\"timers\":[...]}"
      }))
    ]),
    message()
  ];
}

function renderTimerReadinessCard() {
  const readiness = state.timerReadiness || {};
  const checks = readiness.checks || [];

  return card("Live Timer Readiness", [
    statusGrid([
      ["Feature gate", readiness.gateMode || featureGate("timers").mode || "off", readiness.gateMode === "live"],
      ["Summary", readiness.ok ? "ready" : "blocked", Boolean(readiness.ok)],
      ["Next action", readiness.nextAction || readiness.reason || "Review timer setup.", Boolean(readiness.ok)]
    ]),
    checks.length
      ? dataTable(["Check", "Status", "Detail"], checks.map((check) => [
          check.name,
          statusChip(check.ok ? "ok" : "blocked"),
          check.detail || ""
        ]))
      : null
  ]);
}

function renderTimerPresetCard() {
  const presets = state.timerPresets || [];

  return card("Preset Starters", [
    presets.length
      ? dataTable(["Preset", "Interval", "Message", "Actions"], presets.map((preset) => [
          preset.name,
          `${preset.intervalMinutes}m`,
          formatMessagePreview(preset.message),
          actionButton("Create disabled", { id: `timer-preset-${preset.id}`, variant: "secondary", busyKey: "timerPreset", onClick: () => applyTimerPreset(preset.id) })
        ]))
      : callout("No timer presets are available.", "muted")
  ]);
}

function renderTimerSuggestionCard() {
  return card("Timer Suggestions", [
    callout("Optional starters only. Copy a message or load one into the editor, then review it before saving.", "muted"),
    dataTable(["Use case", "Interval", "Activity", "Message", "Actions"], timerSuggestions.map((suggestion) => [
      suggestion.useCase,
      `${suggestion.intervalMinutes}m`,
      suggestion.minChatMessages ? `${suggestion.minChatMessages} chat messages` : "off",
      formatMessagePreview(suggestion.message),
      h("div", { className: "actions inline-actions table-actions" }, [
        actionButton("Load", {
          id: `timer-suggestion-load-${suggestion.id}`,
          variant: "secondary",
          onClick: () => applyTimerSuggestion(suggestion.id)
        }),
        actionButton("Copy", {
          id: `timer-suggestion-copy-${suggestion.id}`,
          variant: "secondary",
          busyKey: "copySuggestion",
          onClick: () => copyTimerSuggestion(suggestion.id)
        })
      ])
    ]))
  ]);
}

function renderModerationSuggestionCard() {
  return card("Moderation Suggestions", [
    callout("Optional examples only. Copy a value or load it into the matching editor, then test before saving live rules.", "muted"),
    dataTable(["Use case", "Target", "Value", "Actions"], moderationSuggestions.map((suggestion) => [
      suggestion.useCase,
      suggestion.target,
      formatMessagePreview(suggestion.value),
      h("div", { className: "actions inline-actions table-actions" }, [
        actionButton("Load", {
          id: `moderation-suggestion-load-${suggestion.id}`,
          variant: "secondary",
          onClick: () => applyModerationSuggestion(suggestion.id)
        }),
        actionButton("Copy", {
          id: `moderation-suggestion-copy-${suggestion.id}`,
          variant: "secondary",
          busyKey: "copySuggestion",
          onClick: () => copyModerationSuggestion(suggestion.id)
        })
      ])
    ]))
  ]);
}

function renderModeration() {
  const settings = state.moderation?.settings || {};
  const hits = state.moderationHits || [];
  const terms = state.moderationTerms || [];
  const allowedLinks = state.moderationAllowedLinks || [];
  const blockedLinks = state.moderationBlockedLinks || [];
  const linkPermits = state.moderationLinkPermits || [];
  const enforcement = state.moderationEnforcement || {};

  return [
    sectionHeader("Moderation", "Lightweight local filters with scoped warn, delete, and timeout actions.",
      h("div", { className: "actions section-actions" }, [
        actionButton("Refresh", { id: "refreshModeration", variant: "secondary", busyKey: "refresh", onClick: refreshAll })
      ])
    ),
    renderFeatureGateCard("moderation_filters"),
    renderModerationSuggestionCard(),
    card("Filter Settings", [
      statusGrid([
        ["Filters enabled", state.moderationSummary.filtersEnabled || 0, Number(state.moderationSummary.filtersEnabled || 0) > 0],
        ["Blocked phrases", `${state.moderationSummary.enabledTerms || 0}/${state.moderationSummary.terms || 0}`, true],
        ["Allowed domains", `${state.moderationSummary.enabledAllowedLinks || 0}/${state.moderationSummary.allowedLinks || 0}`, true],
        ["Blocked domains", `${state.moderationSummary.enabledBlockedLinks || 0}/${state.moderationSummary.blockedLinks || 0}`, true],
        ["Active permits", state.moderationSummary.activeLinkPermits || 0, true],
        ["Enforced filters", state.moderationSummary.enforcementFilters || 0, true],
        ["Bot Shield", state.moderationSummary.botShield || "off", Boolean(state.moderationSummary.botShield && state.moderationSummary.botShield !== "off")],
        ["Escalation", state.moderationSummary.escalation || "off", Boolean(state.moderationSummary.escalation && state.moderationSummary.escalation !== "off")],
        ["Recent hits", state.moderationSummary.hits || 0, true]
      ]),
      h("h3", { text: "Actions" }),
      h("div", { className: "grid three" }, [
        formRow("Blocked phrases", moderationActionSelect("blockedTermsAction")),
        formRow("Links", moderationActionSelect("linkFilterAction")),
        formRow("Excessive caps", moderationActionSelect("capsFilterAction")),
        formRow("Repeated messages", moderationActionSelect("repeatFilterAction")),
        formRow("Symbol spam", moderationActionSelect("symbolFilterAction")),
        formRow("Bot Shield", moderationActionSelect("botShieldAction")),
        formRow("Timeout seconds", h("input", {
          id: "timeoutSeconds",
          type: "number",
          min: "10",
          max: "1200",
          onInput: updateModerationDraft
        }))
      ]),
      statusGrid([
        ["Delete scope", enforcement.deleteMessages?.available ? "available" : "unavailable", Boolean(enforcement.deleteMessages?.available)],
        ["Timeout scope", enforcement.timeoutUsers?.available ? "available" : "unavailable", Boolean(enforcement.timeoutUsers?.available)],
        ["Live mode", enforcement.mode || "off", enforcement.mode === "live"]
      ]),
      callout(enforcement.nextAction || "Warn-only moderation works without optional enforcement scopes.", enforcement.missingScopes?.length ? "warn" : "info"),
      h("div", { className: "grid three" }, [
        h("label", { className: "inline-check" }, [
          h("input", { id: "blockedTermsEnabled", type: "checkbox", onChange: updateModerationDraft }),
          "Blocked phrases"
        ]),
        h("label", { className: "inline-check" }, [
          h("input", { id: "linkFilterEnabled", type: "checkbox", onChange: updateModerationDraft }),
          "Links"
        ]),
        h("label", { className: "inline-check" }, [
          h("input", { id: "capsFilterEnabled", type: "checkbox", onChange: updateModerationDraft }),
          "Excessive caps"
        ]),
        h("label", { className: "inline-check" }, [
          h("input", { id: "repeatFilterEnabled", type: "checkbox", onChange: updateModerationDraft }),
          "Repeated messages"
        ]),
        h("label", { className: "inline-check" }, [
          h("input", { id: "symbolFilterEnabled", type: "checkbox", onChange: updateModerationDraft }),
          "Symbol spam"
        ]),
        h("label", { className: "inline-check" }, [
          h("input", { id: "botShieldEnabled", type: "checkbox", onChange: updateModerationDraft }),
          "Bot Shield"
        ]),
        formRow("Warning message", h("input", {
          id: "moderationWarningMessage",
          placeholder: "@{user}, please keep chat within channel guidelines.",
          onInput: updateModerationDraft
        }))
      ]),
      callout("Bot Shield is heuristic. It scores likely follower/viewer spam using message text, risky links, promo domains, and randomized usernames; use Local Test before live enforcement.", "muted"),
      h("div", { className: "grid three" }, [
        formRow("Caps min length", h("input", { id: "capsMinLength", type: "number", min: "5", max: "450", onInput: updateModerationDraft })),
        formRow("Caps ratio", h("input", { id: "capsRatio", type: "number", min: "0.1", max: "1", step: "0.05", onInput: updateModerationDraft })),
        formRow("Repeat limit", h("input", { id: "repeatLimit", type: "number", min: "2", max: "20", onInput: updateModerationDraft })),
        formRow("Repeat window seconds", h("input", { id: "repeatWindowSeconds", type: "number", min: "5", max: "600", onInput: updateModerationDraft })),
        formRow("Symbol min length", h("input", { id: "symbolMinLength", type: "number", min: "5", max: "450", onInput: updateModerationDraft })),
        formRow("Symbol ratio", h("input", { id: "symbolRatio", type: "number", min: "0.1", max: "1", step: "0.05", onInput: updateModerationDraft })),
        formRow("Bot Shield score", h("input", { id: "botShieldScoreThreshold", type: "number", min: "30", max: "100", onInput: updateModerationDraft }))
      ]),
      h("h3", { text: "Escalation" }),
      callout("Optional repeat-hit escalation upgrades the same user's recent moderation hits from warn to delete to timeout. It never bypasses trusted-role exemptions or scope checks.", "muted"),
      h("div", { className: "grid four" }, [
        h("label", { className: "inline-check editor-check" }, [
          h("input", { id: "escalationEnabled", type: "checkbox", onChange: updateModerationDraft }),
          "Enable escalation"
        ]),
        formRow("Window seconds", h("input", { id: "escalationWindowSeconds", type: "number", min: "30", max: "3600", onInput: updateModerationDraft })),
        formRow("Delete after hits", h("input", { id: "escalationDeleteAfter", type: "number", min: "2", max: "25", onInput: updateModerationDraft })),
        formRow("Timeout after hits", h("input", { id: "escalationTimeoutAfter", type: "number", min: "2", max: "25", onInput: updateModerationDraft }))
      ]),
      h("h3", { text: "Trusted Roles" }),
      h("div", { className: "grid four" }, [
        h("label", { className: "inline-check" }, [
          h("input", { id: "exemptBroadcaster", type: "checkbox", onChange: updateModerationDraft }),
          "Broadcaster"
        ]),
        h("label", { className: "inline-check" }, [
          h("input", { id: "exemptModerators", type: "checkbox", onChange: updateModerationDraft }),
          "Moderators"
        ]),
        h("label", { className: "inline-check" }, [
          h("input", { id: "exemptVips", type: "checkbox", onChange: updateModerationDraft }),
          "VIPs"
        ]),
        h("label", { className: "inline-check" }, [
          h("input", { id: "exemptSubscribers", type: "checkbox", onChange: updateModerationDraft }),
          "Subscribers"
        ])
      ]),
      callout("Moderation filters fail open and never ban. Protected bot commands and active giveaway entry commands are exempt. Warnings always use the outbound queue.", "info"),
      h("div", { className: "actions" }, [
        actionButton("Save moderation settings", { id: "saveModerationSettings", onClick: saveModerationSettings })
      ])
    ]),
    card("Blocked Phrases", [
      h("div", { className: "grid" }, [
        formRow("Phrase or word", h("input", { id: "moderationTerm", placeholder: "phrase", onInput: updateModerationTermDraft })),
        h("label", { className: "inline-check editor-check" }, [
          h("input", { id: "moderationTermEnabled", type: "checkbox", onChange: updateModerationTermDraft }),
          "Enabled"
        ])
      ]),
      callout("Plain words and phrases use boundary-aware matching. Use * only when you intentionally want wildcard matching.", "muted"),
      h("div", { className: "actions" }, [
        actionButton("Save phrase", { id: "saveModerationTerm", variant: "secondary", onClick: saveModerationTerm })
      ]),
      dataTable(["Phrase", "State", "Actions"], terms.map((term) => [
        term.term,
        statusChip(term.enabled ? "enabled" : "disabled"),
        h("div", { className: "actions inline-actions table-actions" }, [
          actionButton(term.enabled ? "Disable" : "Enable", { id: `moderation-term-enable-${term.id}`, variant: "secondary", busyKey: "moderationTermEnable", onClick: () => toggleModerationTerm(term.id, !term.enabled) }),
          actionButton("Delete", { id: `moderation-term-delete-${term.id}`, variant: "danger", busyKey: "moderationTermDelete", onClick: () => deleteModerationTerm(term.id, term.term) })
        ])
      ]))
    ]),
    card("Blocked Link Domains", [
      h("div", { className: "grid" }, [
        formRow("Domain", h("input", { id: "moderationBlockedDomain", placeholder: "bad.example", onInput: updateModerationBlockedLinkDraft })),
        h("label", { className: "inline-check editor-check" }, [
          h("input", { id: "moderationBlockedDomainEnabled", type: "checkbox", onChange: updateModerationBlockedLinkDraft }),
          "Enabled"
        ])
      ]),
      h("div", { className: "actions" }, [
        actionButton("Save blocked domain", { id: "saveModerationBlockedLink", variant: "secondary", onClick: saveModerationBlockedLink })
      ]),
      dataTable(["Domain", "State", "Actions"], blockedLinks.map((link) => [
        link.domain,
        statusChip(link.enabled ? "enabled" : "disabled"),
        h("div", { className: "actions inline-actions table-actions" }, [
          actionButton(link.enabled ? "Disable" : "Enable", { id: `moderation-blocked-link-enable-${link.id}`, variant: "secondary", busyKey: "moderationBlockedLinkEnable", onClick: () => toggleModerationBlockedLink(link.id, !link.enabled) }),
          actionButton("Delete", { id: `moderation-blocked-link-delete-${link.id}`, variant: "danger", busyKey: "moderationBlockedLinkDelete", onClick: () => deleteModerationBlockedLink(link.id, link.domain) })
        ])
      ]))
    ]),
    card("Allowed Link Domains", [
      h("div", { className: "grid" }, [
        formRow("Domain", h("input", { id: "moderationAllowedDomain", placeholder: "example.com", onInput: updateModerationAllowedLinkDraft })),
        h("label", { className: "inline-check editor-check" }, [
          h("input", { id: "moderationAllowedDomainEnabled", type: "checkbox", onChange: updateModerationAllowedLinkDraft }),
          "Enabled"
        ])
      ]),
      h("div", { className: "actions" }, [
        actionButton("Save allowed domain", { id: "saveModerationAllowedLink", variant: "secondary", onClick: saveModerationAllowedLink })
      ]),
      dataTable(["Domain", "State", "Actions"], allowedLinks.map((link) => [
        link.domain,
        statusChip(link.enabled ? "enabled" : "disabled"),
        h("div", { className: "actions inline-actions table-actions" }, [
          actionButton(link.enabled ? "Disable" : "Enable", { id: `moderation-allowed-link-enable-${link.id}`, variant: "secondary", busyKey: "moderationAllowedLinkEnable", onClick: () => toggleModerationAllowedLink(link.id, !link.enabled) }),
          actionButton("Delete", { id: `moderation-allowed-link-delete-${link.id}`, variant: "danger", busyKey: "moderationAllowedLinkDelete", onClick: () => deleteModerationAllowedLink(link.id, link.domain) })
        ])
      ]))
    ]),
    card("Temporary Link Permits", [
      h("div", { className: "grid three" }, [
        formRow("Username", h("input", { id: "moderationPermitUser", placeholder: "viewer", onInput: updateModerationPermitDraft })),
        formRow("Minutes", h("input", { id: "moderationPermitMinutes", type: "number", min: "1", max: "120", onInput: updateModerationPermitDraft })),
        h("div", { className: "actions align-end" }, [
          actionButton("Grant permit", { id: "grantModerationLinkPermit", variant: "secondary", onClick: grantModerationLinkPermit })
        ])
      ]),
      dataTable(["User", "State", "Expires", "Used", "Created by"], linkPermits.map((permit) => [
        permit.userLogin,
        statusChip(permit.active ? "active" : permit.usedAt ? "used" : "expired"),
        permit.expiresAt || "",
        permit.usedAt || "not used",
        permit.createdBy || ""
      ]))
    ]),
    card("Local Test", [
      h("div", { className: "grid three" }, [
        formRow("Actor", h("input", { id: "moderationTestActor", placeholder: "viewer" })),
        formRow("Role", h("select", { id: "moderationTestRole" }, [
          option("viewer", "viewer"),
          option("subscriber", "subscriber"),
          option("vip", "vip"),
          option("mod", "mod"),
          option("broadcaster", "broadcaster")
        ])),
        formRow("Message", h("input", { id: "moderationTestText", placeholder: "test chat message" }))
      ]),
      h("div", { className: "actions" }, [
        actionButton("Run moderation test", { id: "runModerationTest", variant: "secondary", onClick: runModerationTest })
      ]),
      renderModerationTestResult()
    ]),
    card("Recent Hits", [
      dataTable(["Timestamp", "Filter", "User", "Action", "Detail", "Message"], hits.slice(0, 25).map((hit) => [
        hit.createdAt || "",
        hit.filterType || "",
        hit.userLogin || "",
        hit.action || "warn",
        hit.detail || "",
        formatMessagePreview(hit.messagePreview || "")
      ]))
    ]),
    message()
  ];
}

function moderationActionSelect(id) {
  return h("select", { id, onChange: updateModerationDraft }, [
    option("warn", "warn"),
    option("delete", "delete"),
    option("timeout", "timeout")
  ]);
}

function renderGiveaways() {
  const giveaway = state.giveaway;
  const summary = giveaway?.summary || state.status?.giveaway || {};
  return [
    sectionHeader("Giveaways", "Operate entries, winner selection, and manual prize delivery from one place."),
    card("", [
      callout("vaexcore console does not store or reveal giveaway prizes. Delivery remains manual.", "warn"),
      statusGrid([...giveawayRows(summary), ["Delivery", summary.manualCodeDeliveryRequired ? "manual delivery required" : "none", !summary.manualCodeDeliveryRequired]]),
      h("p", { className: "warn", text: (summary.endWarnings || []).join(" ") })
    ]),
    card("Readiness Checklist", [list(giveawayChecklist(), "muted")]),
    renderGiveawayReminderCard(),
    renderGiveawayTemplatesCard(),
    renderGiveawayRecapCard(),
    renderGiveawayOutboundCard(),
    card("Start Giveaway", [
      h("div", { className: "grid three" }, [
        formRow("Title", h("input", { id: "giveawayTitle", onInput: updateGiveawayDraft })),
        formRow("Keyword", h("input", { id: "giveawayKeyword", onInput: updateGiveawayDraft })),
        formRow("Number of winners", h("input", { id: "winnerCount", type: "number", min: "1", onInput: updateGiveawayDraft }))
      ]),
      h("div", { className: "actions" }, [
        actionButton("Start giveaway", { id: "gstart", onClick: startGiveaway }),
        actionButton("Send last call", { id: "glastcall", busyKey: "glast-call", variant: "secondary", onClick: () => runGiveawayAction("last-call") }),
        actionButton("Close entries", { id: "gclose", variant: "secondary", onClick: () => runGiveawayAction("close") })
      ])
    ]),
    card("Winner Operations", [
      h("div", { className: "grid three" }, [
        formRow("Draw count", h("input", { id: "drawCount", type: "number", min: "1", onInput: updateGiveawayDraft })),
        formRow("Reroll winner", h("select", { id: "rerollSelect", onChange: updateGiveawayDraft })),
        formRow("Claim winner", h("select", { id: "claimSelect", onChange: updateGiveawayDraft })),
        formRow("Deliver winner", h("select", { id: "deliverSelect", onChange: updateGiveawayDraft }))
      ]),
      h("div", { className: "actions" }, [
        actionButton("Draw winners", { id: "gdraw", variant: "secondary", onClick: () => runGiveawayAction("draw", { count: Number(field("drawCount").value || 1) }, "Draw winners now?") }),
        actionButton("Reroll", { id: "greroll", variant: "secondary", onClick: () => runGiveawayAction("reroll", { username: field("rerollSelect").value }, "Reroll this winner?") }),
        actionButton("Mark claimed", { id: "gclaim", variant: "secondary", onClick: () => runGiveawayAction("claim", { username: field("claimSelect").value }) }),
        actionButton("Mark delivered", { id: "gdeliver", variant: "secondary", onClick: () => runGiveawayAction("deliver", { username: field("deliverSelect").value }) }),
        actionButton("Copy winners", { id: "copyWinners", variant: "secondary", onClick: copyWinnerList }),
        actionButton("Mark all delivered", { id: "gdeliverAll", variant: "secondary", onClick: () => runGiveawayAction("deliver-all", {}, "Mark all active winners delivered?") })
      ]),
      h("div", { className: "actions destructive-actions" }, [
        actionButton("End giveaway", { id: "gend", variant: "danger", onClick: endGiveaway })
      ])
    ]),
    h("div", { className: "columns" }, [
      card("Entrants", [renderEntrantsTable()]),
      card("Winners", [renderWinnersTable()])
    ]),
    message()
  ];
}

function renderChatTools() {
  return [
    sectionHeader("Chat Tools", "Send operator macros and verify outbound chat without changing giveaway state."),
    renderOperatorMessagesCard(),
    renderBotConfigBundleCard(),
    card("Outbound Chat", [
      formRow("Message text", h("textarea", { id: "chatMessage", placeholder: "Message to send to Twitch chat" })),
      h("div", { className: "actions" }, [
        actionButton("Send message to chat", { id: "sendChat", onClick: () => runAction("sendChat", () => api.chatSend(field("chatMessage").value)) }),
        actionButton("Send !ping / test ping", { id: "ping", variant: "secondary", onClick: () => runAction("ping", () => api.chatSend("!ping")) }),
        actionButton("Send setup test message", { id: "test", variant: "secondary", onClick: sendSetupTest })
      ])
    ]),
    card("Command Echo", [
      h("p", { text: "Direct UI actions do not need chat echo. Echo is optional visibility only and is queued through the normal outbound rate limit." }),
      h("label", { className: "inline-check" }, [h("input", { id: "echoToChat", type: "checkbox" }), "Echo equivalent operator commands to chat"])
    ]),
    renderOutboundHistoryCard(),
    message()
  ];
}

function renderOperatorMessagesCard() {
  const templates = state.operatorMessages || [];

  return card("Operator Macros", [
    callout("Reusable local chat macros only. They do not store prize codes and every send uses the normal outbound queue, history, and recovery flow.", "muted"),
    h("div", { className: "template-list" }, templates.map((template) =>
      h("div", { className: "template-row operator-template-row" }, [
        h("span", {}, [
          h("strong", { text: template.label }),
          h("small", { text: template.description }),
          template.requiresConfirmation ? h("small", { className: "warn", text: "Requires confirmation" }) : null
        ]),
        h("textarea", {
          id: `operator-template-${template.id}`,
          "data-id": template.id,
          onInput: updateOperatorTemplateDraft
        }),
        h("div", { className: "actions inline-actions" }, [
          actionButton("Send", {
            id: `operator-send-${template.id}`,
            variant: template.requiresConfirmation ? "danger" : "secondary",
            busyKey: "sendOperatorMessage",
            onClick: () => sendOperatorMessage(template.id, template.label, Boolean(template.requiresConfirmation))
          })
        ])
      ])
    )),
    h("div", { className: "actions" }, [
      actionButton("Save operator macros", { id: "saveOperatorMessages", variant: "secondary", onClick: saveOperatorMessages }),
      actionButton("Reset operator macros", { id: "resetOperatorMessages", variant: "secondary", onClick: resetOperatorMessages })
    ])
  ]);
}

function renderBotConfigBundleCard() {
  return card("Bot Config Backup", [
    callout("Exports reusable bot behavior only: commands, timers, moderation rules, operator macros, giveaway message templates, and reminder settings. Twitch secrets, OAuth tokens, active giveaways, prize data, and runtime history are excluded.", "info"),
    h("div", { className: "actions" }, [
      actionButton("Export safe bot config", { id: "exportBotConfig", variant: "secondary", onClick: exportBotConfigBundle }),
      actionButton("Import safe bot config", { id: "importBotConfig", variant: "secondary", onClick: importBotConfigBundle })
    ]),
    formRow("Import JSON", h("textarea", {
      id: "botConfigImportJson",
      className: "command-import",
      placeholder: "{\"version\":1,\"commands\":[...],\"timers\":[...],\"moderation\":{...}}"
    }))
  ]);
}

function renderTesting() {
  return [
    sectionHeader("Testing", "Testing tools are for local verification before using a live stream."),
    card("Simulate Entrant", [
      h("div", { className: "grid" }, [
        formRow("Username/login", h("input", { id: "simLogin", placeholder: "alice" })),
        formRow("Display name", h("input", { id: "simDisplayName", placeholder: "Alice" }))
      ]),
      h("div", { className: "actions" }, [
        actionButton("Add entrant", { id: "addEntrant", variant: "secondary", onClick: () => runGiveawayAction("add-entrant", { login: field("simLogin").value, displayName: field("simDisplayName").value }) })
      ])
    ]),
    card("Simulate Command", [
      h("div", { className: "grid three" }, [
        formRow("Actor username", h("input", { id: "simActor" })),
        formRow("Actor role", h("select", { id: "simRole" }, [
          option("viewer", "viewer"),
          option("mod", "mod"),
          option("broadcaster", "broadcaster")
        ])),
        formRow("Command text", h("input", { id: "simCommand" }))
      ]),
      h("div", { className: "actions" }, [
        actionButton("Run command", { id: "runCommand", variant: "secondary", onClick: runSimulatedCommand }),
        actionButton("Run local lifecycle test", { id: "runTestGiveaway", variant: "secondary", onClick: runLifecycleTest })
      ]),
      renderTestResult()
    ]),
    message()
  ];
}

function renderSettings() {
  const config = state.config || {};
  const required = missingConfigFields(config);
  const validationChecks = visibleValidationChecks();
  return [
    sectionHeader("Settings", "Configure local mode, Twitch OAuth, and automatic launch validation.",
      connectButton(config)
    ),
    renderSettingsLaunchNotice(),
    renderSetupGuide(),
    card("Setup Completion", [
      statusGrid([
        ["Completion", isValidationPassed() ? "complete" : "incomplete", isValidationPassed()],
        ["Client ID", config.hasClientId ? "present" : "missing", config.hasClientId],
        ["Client Secret", config.hasClientSecret ? "present" : "missing", config.hasClientSecret],
        ["OAuth Token", config.hasAccessToken ? "present" : "missing", config.hasAccessToken],
        ["Refresh Token", config.hasRefreshToken ? "available" : "missing", config.hasRefreshToken],
        ["Broadcaster", config.broadcasterLogin || "missing", Boolean(config.broadcasterLogin)],
        ["Bot", config.botLogin || "missing", Boolean(config.botLogin)],
        ["Scopes", (config.scopes || []).join(", ") || "missing", Boolean((config.scopes || []).length)],
        ["Token", config.token || "not connected", Boolean(config.token)],
        ["Expires", config.tokenExpiresAt || "unknown", Boolean(config.tokenExpiresAt)]
      ]),
      required.length ? list(required.map((item) => `Missing required config: ${item}`), "warn") : callout("Required config fields are present.", "ok")
    ]),
    card("Twitch Configuration", [
      h("div", { className: "grid" }, [
        formRow("Mode", h("select", { id: "mode", onChange: updateSettingsDraft }, [option("live", "live"), option("local", "local")])),
        formRow("Redirect URI", h("input", { id: "redirectUri", className: !config.redirectUri ? "needs-attention" : "", onInput: updateSettingsDraft })),
        formRow("Client ID", h("input", { id: "clientId", className: !config.hasClientId ? "needs-attention" : "", autocomplete: "off", placeholder: config.hasClientId ? savedCredentialMask : "", onFocus: clearSavedCredentialMask, onBlur: restoreSavedCredentialMask, onInput: updateSettingsDraft })),
        formRow("Client Secret", h("input", { id: "clientSecret", className: !config.hasClientSecret ? "needs-attention" : "", type: "password", autocomplete: "new-password", placeholder: config.hasClientSecret ? savedCredentialMask : "", onFocus: clearSavedCredentialMask, onBlur: restoreSavedCredentialMask, onInput: updateSettingsDraft })),
        formRow("Broadcaster Login", h("input", { id: "broadcasterLogin", className: !config.broadcasterLogin ? "needs-attention" : "", placeholder: "channel login", onBlur: normalizeLoginField, onInput: updateSettingsDraft })),
        formRow("Bot Login", h("input", { id: "botLogin", className: !config.botLogin ? "needs-attention" : "", placeholder: "bot account login", onBlur: normalizeLoginField, onInput: updateSettingsDraft }))
      ]),
      callout("Saved Client ID and Client Secret are intentionally not shown. Paste them, click Save settings, then the fields return to saved and masked."),
      oauthAccountCallout(config),
      botLoginReconnectCallout(config),
      h("div", { className: "actions" }, [
        actionButton("Save settings", { id: "save", onClick: saveSettings }),
        connectButton(config, "secondary"),
        config.hasAccessToken ? actionButton("Disconnect Twitch", { id: "disconnectTwitch", variant: "secondary", onClick: disconnectTwitch }) : null,
        actionButton("Rerun validation", { id: "validate", variant: "secondary", onClick: validateSetup })
      ]),
      h("ul", { id: "checks" }, validationChecks.map((check) =>
        h("li", { className: check.ok ? "ok" : "bad", text: `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}` })
      ))
    ]),
    card("Runtime Commands", [
      h("p", { text: "Use Dashboard controls to start or stop the live bot listener. CLI commands remain available when you want terminal runtime control." }),
      h("p", {}, [h("code", { text: "npm run check:env" }), " ", h("code", { text: "npm run build" }), " ", h("code", { text: "npm run dev:app-config" })])
    ]),
    message()
  ];
}

function renderSetupGuide() {
  const config = state.config || {};
  const progress = getSetupProgress();
  const activeStep = progress.steps.find((step) => !step.complete)?.id || "final";
  const missingCredentialNames = missingCredentialLabels(config);
  const credentialsMissing = !progress.credentialsEntered;
  const missingUsernames = !progress.usernamesEntered;
  const canConnect = progress.credentialsEntered && progress.usernamesEntered;
  const canValidate = progress.twitchConnected && progress.usernamesEntered;
  const canTest = progress.validationPassed;

  return card("Setup Guide", [
    h("div", { id: "setupGuide", className: "setup-guide" }, [
      h("div", { className: "setup-progress" }, progress.steps.map((step) =>
        h("div", { className: `setup-check ${step.complete ? "complete" : ""}` }, [
          h("span", { className: "checkmark", text: step.complete ? "[x]" : "[ ]" }),
          h("span", { text: step.label })
        ])
      )),
      setupStep({
        id: "app",
        number: 1,
        title: "Create Twitch Developer App",
        active: activeStep === "app",
        complete: progress.appCreated,
        children: [
          h("p", { text: "You need to create a Twitch application so vaexcore console can connect to your account." }),
          h("a", {
            className: "button secondary",
            href: "https://dev.twitch.tv/console/apps",
            target: "_blank",
            rel: "noreferrer",
            text: "Open Twitch Developer Console"
          }),
          h("ul", {}, [
            h("li", { text: "Click Register Your Application." }),
            h("li", { text: "Name: anything, for example vaexcore console." }),
            h("li", {}, ["OAuth Redirect URL: ", h("code", { text: defaultRedirectUri })]),
            h("li", { text: "Use one redirect URL only. Do not leave an extra blank redirect URL row." }),
            h("li", { text: "Category: Application Integration." })
          ]),
          callout("The redirect URL must match exactly. If Twitch shows an HTTPS warning, remove any blank extra redirect URL row and keep only the localhost URL above.", "warn")
        ]
      }),
      setupStep({
        id: "credentials",
        number: 2,
        title: "Enter App Credentials",
        active: activeStep === "credentials",
        complete: progress.credentialsEntered,
        children: [
          h("p", { text: "After creating the app, copy your Client ID and Client Secret here." }),
          h("div", { className: "field-ref-row" }, [
            fieldRef("Client ID", "clientId", !config.hasClientId),
            fieldRef("Client Secret", "clientSecret", !config.hasClientSecret),
            fieldRef("Redirect URI", "redirectUri", !config.redirectUri)
          ]),
          h("p", { className: progress.credentialsEntered ? "ok" : "warn", text: progress.credentialsEntered ? "Credentials complete." : `Missing ${missingCredentialNames.join(", ")}.` })
        ]
      }),
      setupStep({
        id: "users",
        number: 3,
        title: "Enter Twitch Usernames",
        active: activeStep === "users",
        complete: progress.usernamesEntered,
        disabled: credentialsMissing,
        children: [
          h("p", { text: "Enter the Twitch account that will run the bot and the channel it will operate in." }),
          h("p", { text: "These can be the same account, or separate accounts if desired." }),
          h("p", { text: "Bot Login must be the account that grants OAuth in the next step; Broadcaster Login is the channel." }),
          h("div", { className: "field-ref-row" }, [
            fieldRef("Broadcaster login", "broadcasterLogin", !config.broadcasterLogin),
            fieldRef("Bot login", "botLogin", !config.botLogin)
          ]),
          h("p", { className: progress.usernamesEntered ? "ok" : "warn", text: progress.usernamesEntered ? "Usernames filled." : "Broadcaster login or Bot login is empty." })
        ]
      }),
      setupStep({
        id: "connect",
        number: 4,
        title: "Connect Twitch",
        active: activeStep === "connect",
        complete: progress.twitchConnected,
        disabled: !canConnect,
        children: [
          h("p", { text: "Click Connect Twitch while logged into the Bot Login account to authorize vaexcore console for chat and optional scoped moderation actions." }),
          oauthAccountCallout(config),
          h("div", { className: "actions" }, [
            connectButton(config, "secondary", !canConnect),
            config.hasAccessToken ? actionButton("Disconnect Twitch", { id: "guideDisconnectTwitch", variant: "secondary", busyKey: "disconnectTwitch", onClick: disconnectTwitch }) : null
          ]),
          statusGrid([
            ["Connected", config.hasAccessToken ? "yes" : "no", config.hasAccessToken],
            ["OAuth account", config.botLogin || "Bot Login", Boolean(config.botLogin)],
            ["Refresh token", config.hasRefreshToken ? "available" : "missing", config.hasRefreshToken],
            ["Bot account detected", config.hasBotUserId ? config.botLogin || "yes" : "not yet", config.hasBotUserId],
            ["user:read:chat", hasScope("user:read:chat") ? "granted" : "missing", hasScope("user:read:chat")],
            ["user:write:chat", hasScope("user:write:chat") ? "granted" : "missing", hasScope("user:write:chat")],
            ["moderator:manage:chat_messages", hasScope("moderator:manage:chat_messages") ? "granted" : "optional", true],
            ["moderator:manage:banned_users", hasScope("moderator:manage:banned_users") ? "granted" : "optional", true]
          ]),
          config.hasAccessToken ? callout("vaexcore console will refresh expired Twitch access tokens automatically. If refresh fails, disconnect and reconnect Twitch.", "info") : null,
          botLoginReconnectCallout(config),
          state.oauthNotice ? callout(state.oauthNotice.text, state.oauthNotice.tone) : null,
          canConnect ? null : callout("Enter credentials and usernames before connecting Twitch.", "warn")
        ]
      }),
      setupStep({
        id: "validate",
        number: 5,
        title: "Automatic Validation",
        active: activeStep === "validate",
        complete: progress.validationPassed,
        disabled: !canValidate,
        children: [
          h("p", { text: "vaexcore console validates saved Twitch setup on launch and after Twitch connects." }),
          h("div", { className: "actions" }, [
            actionButton("Rerun validation", { id: "guideValidate", variant: "secondary", onClick: validateSetup })
          ]),
          renderValidationSummary(),
          canValidate ? null : callout("Connect Twitch before automatic validation can complete.", "warn")
        ]
      }),
      setupStep({
        id: "test",
        number: 6,
        title: "Test Chat",
        active: activeStep === "test",
        complete: progress.testMessageSent,
        disabled: !canTest,
        children: [
          h("p", { text: "Send a test message to confirm the bot can speak in chat." }),
          h("div", { className: "actions" }, [
            actionButton("Send test message", { id: "guideTest", variant: "secondary", onClick: sendSetupTest })
          ]),
          h("p", { className: progress.testMessageSent ? "ok" : "muted", text: progress.testMessageSent ? "Test message sent successfully." : "No test message sent in this session." }),
          canTest ? null : callout("Wait for automatic validation before sending a test message.", "warn")
        ]
      }),
      setupStep({
        id: "final",
        number: 7,
        title: "Final Step",
        active: activeStep === "final",
        complete: isTwitchSetupReady(),
        disabled: !progress.validationPassed,
        children: [
          h("p", { text: "Start the live bot listener and confirm it responds in chat." }),
          h("div", { className: "actions" }, [
            actionButton("Start Bot", { id: "guideBotStart", variant: "secondary", onClick: startBot }),
            actionButton("Stop Bot", { id: "guideBotStop", variant: "secondary", onClick: stopBot })
          ]),
          h("p", {}, ["CLI after using the packaged desktop app setup: ", h("code", { text: "npm run dev:app-config" })]),
          h("p", {}, ["CLI after using project-local setup or .env: ", h("code", { text: "npm run dev" })]),
          h("p", {}, ["Instruction: type ", h("code", { text: "!ping" }), " in your Twitch chat."]),
          h("p", { className: "ok", text: "Success condition: LIVE CHAT CONFIRMED" })
        ]
      })
    ])
  ]);
}

function setupStep({ id, number, title, active, complete, disabled, children }) {
  return h("div", {
    className: `setup-step ${active ? "active" : ""} ${complete ? "complete" : ""} ${disabled ? "disabled" : ""}`,
    "data-step": id
  }, [
    h("div", { className: "step-title" }, [
      h("span", { className: "step-number", text: String(number) }),
      h("strong", { text: title }),
      h("span", { className: complete ? "ok" : "warn", text: complete ? "complete" : disabled ? "locked" : active ? "next" : "pending" })
    ]),
    h("div", { className: "step-body" }, children)
  ]);
}

function renderValidationSummary() {
  const config = state.config || {};
  const validationChecks = visibleValidationChecks();

  if (validationChecks.length) {
    return h("ul", {}, validationChecks.map((check) =>
      h("li", { className: check.ok ? "ok" : "bad", text: `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}` })
    ));
  }

  return statusGrid([
    ["Token valid", state.status?.runtime?.tokenValid ? "yes" : "not validated", state.status?.runtime?.tokenValid],
    ["Refresh available", config.hasRefreshToken ? "yes" : "missing", config.hasRefreshToken],
    ["Scopes correct", hasRequiredScopes() ? "yes" : "not validated", hasRequiredScopes()],
    ["Bot identity resolved", config.hasBotUserId ? "yes" : "not validated", config.hasBotUserId],
    ["Broadcaster identity resolved", config.hasBroadcasterUserId ? "yes" : "not validated", config.hasBroadcasterUserId]
  ]);
}

function renderDiagnostics() {
  const report = state.diagnostics;
  const readiness = report?.readiness || {};
  const app = report?.app || {};
  const paths = report?.paths || {};
  const database = report?.database || {};
  const setupUi = report?.setupUi || {};
  const firstRun = report?.firstRun || {};
  const runtime = report?.runtime || {};
  const bot = runtime.botProcess || {};

  return [
    sectionHeader("Diagnostics", "Safe local report for setup, packaging, runtime, and support handoff.",
      h("div", { className: "actions" }, [
        actionButton("Run readiness check", { id: "runDiagnostics", onClick: runDiagnostics, busyKey: "diagnostics" }),
        actionButton("Copy diagnostic report", { id: "copyDiagnostics", variant: "secondary", onClick: copyDiagnostics, busyKey: "copyDiagnostics" }),
        actionButton("Copy support bundle", { id: "copySupportBundle", variant: "secondary", onClick: copySupportBundle, busyKey: "copySupportBundle" })
      ])
    ),
    readiness.status
      ? callout(
          readiness.status === "ready"
            ? "Diagnostics clear."
            : readiness.status === "attention"
              ? `Attention: ${readiness.nextAction}`
              : `Not ready: ${readiness.nextAction}`,
          readiness.status === "ready" ? "ok" : readiness.status === "attention" ? "warn" : "bad"
        )
      : callout("Run diagnostics to generate a local support report.", "muted"),
    card("Readiness", [
      statusGrid([
        ["Status", readiness.status || "not run", readiness.status === "ready"],
        ["Blockers", readiness.blockers?.length || 0, !readiness.blockers?.length],
        ["Warnings", readiness.warnings?.length || 0, !readiness.warnings?.length],
        ["Next action", readiness.nextAction || "Run diagnostics", readiness.status === "ready"]
      ]),
      readiness.blockers?.length ? list(readiness.blockers, "bad") : null,
      readiness.warnings?.length ? list(readiness.warnings, "warn") : null
    ]),
    card("First Run And Recovery", [
      statusGrid([
        ["Clean install", firstRun.cleanInstall ? "yes" : "no", !firstRun.cleanInstall],
        ["Config file", firstRun.configFilePresent ? "present" : "not yet", Boolean(firstRun.configFilePresent)],
        ["Setup complete", firstRun.setupComplete ? "yes" : "no", Boolean(firstRun.setupComplete)],
        ["Missing fields", firstRun.missingConfig?.length || 0, !firstRun.missingConfig?.length],
        ["Next action", firstRun.nextAction || "Run diagnostics", Boolean(firstRun.nextAction) && firstRun.setupComplete]
      ]),
      firstRun.blockers?.length ? list(firstRun.blockers, "bad") : null,
      firstRun.warnings?.length ? list(firstRun.warnings, "warn") : null,
      firstRun.recoverySteps?.length ? list(firstRun.recoverySteps, firstRun.blockers?.length ? "bad" : "muted") : null
    ]),
    card("About This Build", [
      statusGrid([
        ["Version", app.version || "unknown", Boolean(app.version)],
        ["Distribution", app.runtime === "electron" ? desktopDistributionLabel(app.platform) : "local development", Boolean(app.runtime)],
        ["Update method", app.runtime === "electron" ? desktopUpdateMethod(app.platform) : "rebuild and restart local server", Boolean(app.runtime)],
        ["Runtime", app.runtime || "unknown", Boolean(app.runtime)],
        ["Electron", app.electron || "not electron", Boolean(app.electron)],
        ["Platform", `${app.platform || "unknown"} ${app.arch || ""}`.trim(), Boolean(app.platform)],
        ["Generated", report?.generatedAt || "not run", Boolean(report?.generatedAt)]
      ]),
      app.runtime === "electron"
        ? callout(desktopUpdateNote(app.platform), "muted")
        : null
    ]),
    card("Environment", [
      statusGrid([
        ["Node", app.node || "unknown", Boolean(app.node)],
        ["Config", paths.configDir || "unknown", Boolean(paths.configDir)],
        ["Database", paths.databasePath || "unknown", Boolean(paths.databasePath)]
      ])
    ]),
    card("Local Paths", [
      statusGrid([
        ["Config", paths.configDir || "unknown", Boolean(paths.configDir)],
        ["Secrets", paths.secretsPath || "unknown", Boolean(paths.secretsPath)],
        ["Database", paths.databasePath || "unknown", Boolean(paths.databasePath)],
        ["UI assets", paths.setupUiDir || "unknown", Boolean(paths.setupUiDir)]
      ])
    ]),
    card("Storage And Assets", [
      statusGrid([
        ["Database", database.ok ? "ok" : "failed", database.ok],
        ["SQLite", database.driver || "unknown", database.driver === "better-sqlite3"],
        ["app.js", setupUi.appJs ? "present" : "missing", setupUi.appJs],
        ["styles.css", setupUi.stylesCss ? "present" : "missing", setupUi.stylesCss],
        ["logo.jpg", setupUi.logoJpg ? "present" : "missing", setupUi.logoJpg]
      ]),
      database.error ? callout(database.error, database.ok ? "muted" : "bad") : null
    ]),
    card("Runtime Snapshot", [
      statusGrid([
        ["Bot process", bot.status || "stopped", Boolean(bot.running)],
        ["PID", bot.pid || "none", Boolean(bot.pid)],
        ["EventSub", runtime.eventSubConnected ? "connected" : "not connected", runtime.eventSubConnected],
        ["Chat subscription", runtime.chatSubscriptionActive ? "active" : "inactive", runtime.chatSubscriptionActive],
        ["Live chat", runtime.liveChatConfirmed ? "confirmed" : "pending", runtime.liveChatConfirmed],
        ["Queue", runtime.queueHealth?.status || "unknown", runtime.queueHealth?.status === "clear"]
      ])
    ]),
    card("Checks", [
      dataTable(["Check", "Severity", "Result", "Detail"], (report?.checks || []).map((check) => [
        check.name,
        check.severity,
        check.ok ? "pass" : "fail",
        check.detail
      ]))
    ]),
    message()
  ];
}

function renderAuditLog() {
  return [
    sectionHeader("Audit Log", "Post-stream review and latest 100 local audit entries.",
      actionButton("Refresh audit log", { id: "refreshAudit", onClick: refreshAuditLogs })
    ),
    renderPostStreamReviewCard(),
    card("", [dataTable(["Timestamp", "Actor", "Action", "Target", "Metadata"], state.auditLogs.map((log) => [
      log.created_at,
      log.actor_twitch_user_id,
      log.action,
      log.target || "",
      summarizeMetadata(log.metadata_json)
    ]))])
  ];
}

function renderPostStreamReviewCard() {
  const review = postStreamReviewData();
  const failures = review.outbound.failures.slice(0, 8);

  return card("Post-Stream Review", [
    statusGrid([
      ["Giveaway", review.giveaway.available ? `#${review.giveaway.id}` : "none", review.giveaway.available],
      ["Entries", review.giveaway.entries, true],
      ["Winners", review.giveaway.winners.length, true],
      ["Pending Delivery", review.giveaway.pendingDelivery, review.giveaway.pendingDelivery === 0],
      ["Blocking Critical", review.outbound.blockingCritical, review.outbound.blockingCritical === 0],
      ["Critical Pending", review.outbound.pendingCritical, review.outbound.pendingCritical === 0],
      ["Critical Failed", review.outbound.criticalFailed, review.outbound.criticalFailed === 0],
      ["Outbound Failed", review.outbound.failed, review.outbound.failed === 0],
      ["Retries", review.outbound.retries, true],
      ["Bot Errors", review.runtime.errorCount, review.runtime.errorCount === 0]
    ]),
    callout(review.nextAction, review.tone),
    review.giveaway.winners.length
      ? dataTable(["Winner", "Login", "Delivered"], review.giveaway.winners.map((winner) => [
          winner.displayName,
          winner.login,
          winner.delivered ? "yes" : "pending"
        ]))
      : callout("No winner rows available for the latest giveaway.", "muted"),
    failures.length
      ? dataTable(["Updated", "Action", "Category", "Attempts", "Message"], failures.map((item) => [
          item.updatedAt || "",
          item.action || "message",
          failureCategoryChip(item.failureCategory),
          item.attempts || 0,
          formatMessagePreview(item.message)
        ]))
      : callout("No outbound failures are currently tracked.", "ok"),
    h("div", { className: "actions" }, [
      actionButton("Copy review", { id: "copyPostStreamReview", variant: "secondary", busyKey: "copyPostStreamReview", onClick: copyPostStreamReview }),
      actionButton("Export review JSON", { id: "exportPostStreamReview", variant: "secondary", busyKey: "exportPostStreamReview", onClick: exportPostStreamReviewJson })
    ])
  ]);
}

function connectButton(config, variant = "secondary", forceDisabled = false) {
  const disabled = forceDisabled || missingConfigFields(config).some((item) => ["Client ID", "Client Secret", "Redirect URI", "Bot Login"].includes(item));
  const label = config?.botLogin
    ? `Connect Twitch as ${config.botLogin}`
    : "Connect Twitch as Bot Login";
  const title = oauthAccountInstruction(config);
  const link = h("a", {
    className: `button ${variant}${disabled ? " disabled" : ""}`,
    "data-action": "connect-twitch",
    href: disabled ? "#" : "/auth/twitch/start",
    title: disabled ? "Save Client ID, Client Secret, Redirect URI, and Bot Login first." : title,
    text: label
  });
  if (disabled) {
    link.title = "Save Client ID, Client Secret, Redirect URI, and Bot Login first.";
  }
  return link;
}

function oauthAccountInstruction(config = {}) {
  const bot = config.botLogin || "the Bot Login account";
  const broadcaster = config.broadcasterLogin || "the Broadcaster Login channel";

  if (config.botLogin && config.broadcasterLogin && config.botLogin === config.broadcasterLogin) {
    return `Log into Twitch as ${bot}. This account is both the bot and broadcaster.`;
  }

  return `Log into Twitch as the Bot Login account (${bot}), not the Broadcaster Login (${broadcaster}), unless they are the same account.`;
}

function oauthAccountCallout(config = {}) {
  return callout(oauthAccountInstruction(config), "info");
}

function renderEntrantsTable() {
  const entries = [...(state.giveaway?.entries || [])].sort((a, b) => String(a.entered_at).localeCompare(String(b.entered_at)));
  const filtered = entries.filter((entry) => entry.login.includes(state.entrantFilter.toLowerCase()));
  return h("div", {}, [
    h("div", { className: "toolbar" }, [
      formRow("Search login", h("input", { id: "entrantFilter", placeholder: "filter by login", onInput: (event) => {
        state.entrantFilter = event.target.value;
        render();
      }})),
      h("span", { className: "count", text: `${filtered.length} of ${entries.length} visible` })
    ]),
    dataTable(["User", "Entered"], filtered.map((entry) => [
      `${entry.display_name} @${entry.login}`,
      entry.entered_at
    ]))
  ]);
}

function renderWinnersTable() {
  const winners = filterWinners(state.giveaway?.winners || []);
  return h("div", {}, [
    h("div", { className: "toolbar" }, [
      formRow("Filter", h("select", { id: "winnerFilter", onChange: (event) => {
        state.winnerFilter = event.target.value;
        render();
      }}, [
        option("all", "all"),
        option("pending", "pending delivery"),
        option("delivered", "delivered"),
        option("rerolled", "rerolled")
      ])),
      h("span", { className: "count", text: `${winners.length} visible` })
    ]),
    dataTable(["User", "Status", "Drawn", "Claimed", "Delivered", "Rerolled"], winners.map((winner) => [
      `${winner.display_name} @${winner.login}`,
      winnerStatus(winner),
      winner.drawn_at,
      winner.claimed_at || "",
      winner.delivered_at || "",
      winner.rerolled_at || ""
    ]))
  ]);
}

function dataTable(headers, rows) {
  if (!rows.length) {
    return h("div", { className: "table-wrap" }, [h("div", { className: "empty", text: "No rows to show." })]);
  }

  return h("div", { className: "table-wrap" }, [
    h("table", {}, [
      h("thead", {}, [h("tr", {}, headers.map((header) => h("th", { text: header })))]),
      h("tbody", {}, rows.map((row) => h("tr", {}, row.map((cell) => h("td", {}, cell?.nodeType ? [cell] : [String(cell ?? "")])))))
    ])
  ]);
}

function list(items, tone) {
  return h("ul", {}, items.map((item) => h("li", { className: tone, text: item })));
}

function option(value, label) {
  return h("option", { value, text: label });
}

function giveawayRows(summary = {}) {
  return [
    ["Status", summary.status || "none"],
    ["Title", summary.title || "none"],
    ["Keyword", summary.keyword || "enter"],
    ["Winners", `${summary.winnersDrawn || 0}/${summary.winnerCount || 0}`],
    ["Entries", summary.entryCount || 0],
    ["Enough Entrants", summary.enoughEntrantsForFullDraw ? "yes" : "no", summary.enoughEntrantsForFullDraw],
    ["Undelivered", summary.undeliveredWinnersCount || 0, Number(summary.undeliveredWinnersCount || 0) === 0],
    ["Rerolled", summary.rerolledCount || 0]
  ];
}

function currentLaunchPreparation() {
  return state.launchPreparation || state.status?.launchPreparation || state.diagnostics?.launchPreparation || null;
}

function visibleValidationChecks() {
  if (state.validationChecks.length) return state.validationChecks;

  const launch = currentLaunchPreparation();
  if (launch?.validation?.checks?.length) return launch.validation.checks;
  if (["setup_required", "error"].includes(launch?.status) && launch?.checks?.length) return launch.checks;
  return [];
}

function renderSettingsLaunchNotice() {
  const launch = currentLaunchPreparation();

  if (!launch || ["pending", "ready"].includes(launch.status)) {
    return null;
  }

  const tone = launchTone(launch);
  const summary = launch.summary || "Automatic launch checks need attention.";
  const nextAction = launch.nextAction && launch.nextAction !== summary
    ? ` ${launch.nextAction}`
    : "";

  return callout(`${summary}${nextAction}`, tone);
}

function launchTone(launch = currentLaunchPreparation()) {
  if (!launch) return "muted";
  if (launch.status === "ready") return "ok";
  if (launch.status === "setup_required" || launch.status === "error") return "bad";
  if (launch.status === "running" || launch.status === "attention") return "warn";
  return "muted";
}

function syncLaunchPreparation(payload = {}) {
  const launch = payload.launchPreparation || payload.diagnostics?.launchPreparation || (
    payload.status && payload.step && Array.isArray(payload.checks) ? payload : null
  );
  if (!launch) return;

  state.launchPreparation = launch;

  if (launch.validation?.checks?.length) {
    state.validationChecks = launch.validation.checks;
  }

  if (launch.preflight?.checks?.length) {
    state.preflightResult = launch.preflight;
  }

  if (launch.setupReady) {
    state.validSetup = true;
  } else if (["setup_required", "error"].includes(launch.status)) {
    state.validSetup = false;
  }
}

function getReadiness() {
  const runtime = state.status?.runtime || {};
  const launch = currentLaunchPreparation();
  const blockers = [];

  if (launch?.status === "running") {
    blockers.push("Automatic launch checks are still running");
  } else if (!isTwitchSetupReady()) {
    blockers.push("Open Configuration Settings -> Setup Guide");
  }
  if (!runtime.tokenValid || !runtime.requiredScopesPresent) {
    blockers.push(launch?.nextAction || "Reconnect Twitch if automatic launch validation cannot confirm the saved token");
  }
  if (!runtime.queueReady) blockers.push("Start the setup console again if queue readiness does not recover");
  if (runtime.outboundRecovery?.needed && runtime.outboundRecovery.severity === "critical") {
    blockers.push(`Resolve critical outbound chat failure: ${runtime.outboundRecovery.nextAction}`);
  }
  if (!runtime.eventSubConnected || !runtime.chatSubscriptionActive) blockers.push("Start bot process");
  if (!runtime.liveChatConfirmed) blockers.push("Type !ping in chat");

  const nextAction = blockers[0] || (state.status?.giveaway?.status === "none"
    ? "Giveaway controls ready"
    : nextGiveawayAction(state.status.giveaway));

  return {
    ready: blockers.length === 0,
    blockers,
    nextAction
  };
}

function liveRunbookSteps() {
  const runtime = state.status?.runtime || {};
  const summary = state.giveaway?.summary || state.status?.giveaway || {};
  const recovery = runtime.outboundRecovery || {};
  const health = runtime.queueHealth || {};
  const process = runtime.botProcess || {};
  const launch = currentLaunchPreparation();
  const steps = [];

  if (!isTwitchSetupReady()) {
    steps.push({
      id: "setup-guide",
      label: "Complete setup",
      detail: "Setup is incomplete. Open Configuration Settings -> Setup Guide.",
      tone: "bad",
      actionLabel: "Open Setup Guide",
      onClick: openSetupGuide
    });
    return steps;
  }

  if (!runtime.tokenValid || !runtime.requiredScopesPresent) {
    steps.push({
      id: "validate",
      label: launch?.status === "running" ? "Wait for validation" : "Reconnect Twitch",
      detail: launch?.status === "running"
        ? "Automatic launch validation is checking the saved Twitch token."
        : "Automatic validation could not confirm the saved Twitch token and scopes.",
      tone: launch?.status === "running" ? "warn" : "bad",
      actionLabel: "Rerun launch checks",
      onClick: runLaunchPreparation
    });
    return steps;
  }

  if (!process.running) {
    steps.push({
      id: "start-bot",
      label: "Start bot",
      detail: "The live bot listener is stopped.",
      tone: "warn",
      actionLabel: "Start Bot",
      onClick: startBot,
      disabled: !canStartBot(runtime)
    });
  } else if (!runtime.eventSubConnected || !runtime.chatSubscriptionActive) {
    steps.push({
      id: "wait-eventsub",
      label: "Wait for chat listener",
      detail: "Bot is starting. Wait for EventSub and chat subscription to become active.",
      tone: "warn"
    });
  } else if (!runtime.liveChatConfirmed) {
    steps.push({
      id: "confirm-chat",
      label: "Confirm chat",
      detail: "Type !ping in Twitch chat and wait for LIVE CHAT CONFIRMED.",
      tone: "warn"
    });
  }

  if (recovery.needed && recovery.severity === "critical") {
    steps.push({
      id: "critical-recovery",
      label: "Recover critical chat",
      detail: recovery.nextAction || "Resolve the failed critical outbound message.",
      tone: "bad",
      actionLabel: "Panic resend",
      variant: "danger",
      disabled: !state.validSetup,
      onClick: resendCriticalGiveaway
    });
  } else if (recovery.needed) {
    steps.push({
      id: "outbound-recovery",
      label: "Review outbound failure",
      detail: recovery.nextAction || "Review the failed outbound message.",
      tone: "warn"
    });
  }

  if (health.status === "blocked" || health.status === "watch") {
    steps.push({
      id: "queue-health",
      label: "Watch queue",
      detail: health.nextAction || "Watch Queue Health until pending messages clear.",
      tone: health.status === "blocked" ? "bad" : "warn"
    });
  }

  if (summary.status === "open") {
    steps.push({
      id: "close-giveaway",
      label: "Close before draw",
      detail: "Giveaway entries are open. Close entries before drawing winners.",
      tone: "ok",
      actionLabel: "Close entries",
      onClick: () => runGiveawayAction("close")
    });
  } else if (summary.status === "closed" && Number(summary.winnersDrawn || 0) === 0) {
    steps.push({
      id: "draw-winners",
      label: "Draw winners",
      detail: "Entries are closed and no winners are drawn yet.",
      tone: "ok",
      actionLabel: "Draw winners",
      onClick: () => runGiveawayAction("draw", { count: Number(field("drawCount")?.value || suggestedDrawCount()) }, "Draw winners now?")
    });
  } else if (Number(summary.undeliveredWinnersCount || 0) > 0) {
    steps.push({
      id: "deliver-prizes",
      label: "Finish delivery",
      detail: `${summary.undeliveredWinnersCount} winner(s) still need manual delivery.`,
      tone: "warn",
      actionLabel: "Open Giveaways",
      onClick: openGiveaways
    });
  } else if (summary.safeToEnd) {
    steps.push({
      id: "end-giveaway",
      label: "End giveaway",
      detail: "Active winners are marked delivered. The giveaway can be ended.",
      tone: "ok",
      actionLabel: "End giveaway",
      variant: "danger",
      onClick: endGiveaway
    });
  } else if (summary.status === "none") {
    steps.push({
      id: "ready",
      label: "Ready",
      detail: "Giveaway controls are ready when stream operations need them.",
      tone: "ok",
      actionLabel: "Open Giveaways",
      onClick: openGiveaways
    });
  }

  return steps.length ? steps : [{
    id: "monitor",
    label: "Monitor",
    detail: "No immediate live action needed. Keep watching chat and queue health.",
    tone: "ok"
  }];
}

function liveDisplayState(summary = {}, recap = {}) {
  if ((summary.status || "none") === "none" && recap.available && recap.status === "ended") {
    const pending = Number(recap.pendingDeliveryCount || 0);
    return {
      label: "giveaway ended",
      detail: pending > 0 ? `${pending} winner(s) remained pending at end.` : "Post-stream recap is ready.",
      tone: pending > 0 ? "warn" : "ok"
    };
  }

  return {
    label: summary.operatorState || "loading",
    detail: summary.operatorStateDetail || "Waiting for giveaway state.",
    tone: summary.operatorStateTone || "muted"
  };
}

function nextGiveawayAction(summary = {}) {
  if (summary.status === "open") return "Close entries before drawing winners";
  if (summary.status === "closed" && Number(summary.winnersDrawn || 0) === 0) return "Draw winners";
  if (Number(summary.undeliveredWinnersCount || 0) > 0) return "Complete manual prize delivery";
  return "End the giveaway when operator work is complete";
}

function getSetupProgress() {
  const config = state.config || {};
  const validationPassed = isValidationPassed();
  const progress = {
    appCreated: Boolean(config.hasClientId || config.hasClientSecret),
    credentialsEntered: Boolean(config.hasClientId && config.hasClientSecret && config.redirectUri),
    usernamesEntered: Boolean(config.broadcasterLogin && config.botLogin),
    twitchConnected: Boolean(config.hasAccessToken),
    validationPassed,
    testMessageSent: Boolean(state.testMessageSent)
  };

  return {
    ...progress,
    steps: [
      { id: "app", label: "App created", complete: progress.appCreated },
      { id: "credentials", label: "Credentials entered", complete: progress.credentialsEntered },
      { id: "users", label: "Usernames entered", complete: progress.usernamesEntered },
      { id: "connect", label: "Twitch connected", complete: progress.twitchConnected },
      { id: "validate", label: "Auto validation passed", complete: progress.validationPassed },
      { id: "test", label: "Test message sent", complete: progress.testMessageSent }
    ]
  };
}

function isTwitchSetupReady() {
  return isValidationPassed();
}

function canStartBot(runtime = state.status?.runtime || {}) {
  return Boolean(
    isTwitchSetupReady() &&
    runtime.tokenValid &&
    runtime.requiredScopesPresent &&
    runtime.queueReady
  );
}

function isValidationPassed() {
  const config = state.config || {};
  const runtime = state.status?.runtime || {};
  return Boolean(
    config.hasAccessToken &&
    config.hasBotUserId &&
    config.hasBroadcasterUserId &&
    runtime.tokenValid &&
    runtime.requiredScopesPresent &&
    hasRequiredScopes()
  );
}

function hasRequiredScopes() {
  const config = state.config || {};
  const required = config.requiredScopes || ["user:read:chat", "user:write:chat"];
  return required.every((scope) => hasScope(scope));
}

function hasScope(scope) {
  return Boolean((state.config?.scopes || []).includes(scope));
}

function giveawayChecklist() {
  const summary = state.giveaway?.summary || {};
  const status = summary.status || "none";
  const winners = state.giveaway?.winners || [];
  const activeWinners = winners.filter((winner) => !winner.rerolled_at);
  const checklist = [
    status === "none" ? "Start is available because no giveaway exists." : "Start is disabled because a giveaway already exists.",
    status === "open" ? "Close is available while entries are open." : "Close is disabled unless entries are open.",
    status === "closed" ? "Draw is available because entries are closed." : "Draw is disabled until the giveaway is closed.",
    status !== "none" ? "End is available after confirmation." : "End is disabled because no giveaway exists.",
    status === "open" ? "Last call is available while entries are open." : "Last call is disabled unless entries are open.",
    activeWinners.length ? "Claim, deliver, and reroll controls have eligible winners." : "Claim, deliver, and reroll are disabled until winners exist."
  ];

  if (state.giveaway?.assurance?.blockContinue) {
    checklist.unshift(`Resolve chat assurance before continuing: ${state.giveaway.assurance.nextAction}`);
  }

  if (Number(state.giveaway?.assurance?.summary?.pendingCritical || 0) > 0) {
    checklist.unshift("Wait for pending critical giveaway chat sends to confirm before moving to the next phase.");
  }

  return checklist;
}

function missingConfigFields(config = {}) {
  const missing = [];
  if (!config.hasClientId) missing.push("Client ID");
  if (!config.hasClientSecret) missing.push("Client Secret");
  if (!config.redirectUri) missing.push("Redirect URI");
  if (!config.broadcasterLogin) missing.push("Broadcaster Login");
  if (!config.botLogin) missing.push("Bot Login");
  return missing;
}

function missingCredentialLabels(config = {}) {
  const missing = [];
  if (!config.hasClientId) missing.push("Client ID");
  if (!config.hasClientSecret) missing.push("Client Secret");
  if (!config.redirectUri) missing.push("Redirect URI");
  return missing;
}

function botLoginReconnectCallout(config = {}) {
  if (!config.hasAccessToken || !config.botLogin || config.hasBotUserId) {
    return null;
  }

  return callout(`Bot Login is ${config.botLogin}, but the connected OAuth token has not validated for that account. Disconnect Twitch if needed, log into Twitch as ${config.botLogin}, click Connect Twitch as Bot Login, then let launch checks validate automatically.`, "warn");
}

function filterWinners(winners) {
  if (state.winnerFilter === "pending") return winners.filter((winner) => !winner.rerolled_at && !winner.delivered_at);
  if (state.winnerFilter === "delivered") return winners.filter((winner) => winner.delivered_at);
  if (state.winnerFilter === "rerolled") return winners.filter((winner) => winner.rerolled_at);
  return winners;
}

function activeWinnerList() {
  return (state.giveaway?.winners || []).filter((winner) => !winner.rerolled_at);
}

function winnerStatus(winner) {
  const chips = ["drawn"];
  if (winner.claimed_at) chips.push("claimed");
  if (winner.delivered_at) chips.push("delivered");
  if (winner.rerolled_at) chips.push("rerolled");
  return h("span", {}, chips.map((chip) => h("span", { className: `chip ${chip === "rerolled" ? "warn" : "ok"}`, text: chip })));
}

function featureGate(key) {
  return (state.featureGates || []).find((gate) => gate.key === key) ||
    (key === "custom_commands" ? state.commandFeatureGate : null) ||
    (key === "timers" ? state.timerFeatureGate : null) ||
    (key === "moderation_filters" ? state.moderationFeatureGate : null) ||
    { key, label: key, mode: "off", liveAllowed: false, testAllowed: false };
}

function featureGateSummary(gate = {}) {
  if (gate.mode === "live") {
    return `${gate.label || "Feature"} is enabled for Twitch chat and local simulation.`;
  }

  if (gate.mode === "test") {
    return `${gate.label || "Feature"} is available for local simulation only. Twitch chat will not trigger it.`;
  }

  return `${gate.label || "Feature"} is off. Use Test for local validation or Live when ready for Twitch chat.`;
}

function selectedCustomCommand() {
  return (state.commands || []).find((command) => Number(command.id) === Number(state.selectedCommandId));
}

function selectedTimer() {
  return (state.timers || []).find((timer) => Number(timer.id) === Number(state.selectedTimerId));
}

function filteredCustomCommands() {
  const query = state.commandFilter.trim().replace(/^!/, "").toLowerCase();
  const commands = state.commands || [];

  if (!query) {
    return commands;
  }

  return commands.filter((command) =>
    command.name.includes(query) ||
    (command.aliases || []).some((alias) => alias.includes(query)) ||
    command.permission.includes(query)
  );
}

function statusChip(status) {
  const tone = ["sent", "resent"].includes(status)
    ? "ok"
    : status === "failed"
      ? "bad"
      : status === "enabled"
        ? "ok"
        : status === "disabled"
          ? "muted"
          : ["not-reached", "none"].includes(status)
        ? "muted"
        : "warn";
  return h("span", { className: `chip ${tone}`, text: status || "unknown" });
}

function commandPermissionChip(permission) {
  const tone = permission === "viewer" ? "ok" : permission === "moderator" ? "warn" : "bad";
  return h("span", { className: `chip ${tone}`, text: permission || "viewer" });
}

function renderCommandPreview() {
  if (!state.commandPreview) {
    return callout("No command preview has run yet.", "muted");
  }

  return state.commandPreview.ok
    ? callout(state.commandPreview.response || "Preview produced no response.", "ok")
    : callout(state.commandPreview.error || "Preview failed.", "bad");
}

function shortId(id = "") {
  return id ? id.slice(-8) : "";
}

function importanceChip(importance = "normal") {
  const tone = importance === "critical" ? "bad" : importance === "important" ? "warn" : "ok";
  return h("span", { className: `chip ${tone}`, text: importance });
}

function failureCategoryChip(category = "none") {
  const tone = ["auth", "config", "twitch_rejected"].includes(category)
    ? "bad"
    : ["rate_limit", "network", "timeout", "unknown"].includes(category)
      ? "warn"
      : "muted";
  return h("span", { className: `chip ${tone}`, text: category || "none" });
}

function queueTone(status) {
  if (status === "blocked") return "bad";
  if (status === "watch") return "warn";
  return "ok";
}

function giveawayOutboundMessages() {
  const giveawayId = state.giveaway?.giveaway?.id;
  const messages = (state.outboundMessages || [])
    .filter((item) => item.category === "giveaway")
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  if (!giveawayId) {
    return messages;
  }

  return messages.filter((item) => Number(item.giveawayId) === Number(giveawayId));
}

function criticalGiveawayFailures() {
  const giveawayId = state.giveaway?.giveaway?.id;
  const failures = (state.outboundMessages || [])
    .filter((item) => item.category === "giveaway" && item.importance === "critical" && item.status === "failed")
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  const current = giveawayId === undefined
    ? []
    : failures.filter((item) => Number(item.giveawayId) === Number(giveawayId));

  return current.length ? current : failures;
}

function outboundFailureLogs(logs = []) {
  return logs.filter((line) =>
    /Outbound chat send failed|outboundStatus.*failed|retry limit|message dropped/i.test(line)
  );
}

function postStreamRecapText() {
  const recap = state.giveaway?.recap || {};
  const summary = state.giveaway?.summary || {};
  const assurance = state.giveaway?.assurance || {};

  if (!recap.available) {
    return "No giveaway recap available yet.";
  }

  const winners = (recap.winners || []).length
    ? (recap.winners || []).map((winner) =>
        `- ${winner.displayName} (@${winner.login}) - ${winner.delivered ? "delivered" : "pending delivery"}`
      )
    : ["- No active winners recorded."];

  return [
    `Giveaway: #${recap.id} ${recap.title}`,
    `State: ${summary.operatorState || recap.status}`,
    `Entries: ${recap.entryCount || 0}`,
    `Winners: ${recap.activeWinnerCount || 0}`,
    `Pending delivery: ${recap.pendingDeliveryCount || 0}`,
    `Critical chat sent: ${recap.sentMessageCount || 0}`,
    `Critical chat resent: ${recap.resentMessageCount || 0}`,
    `Critical chat pending: ${recap.pendingMessageCount || 0}`,
    `Critical chat failed: ${recap.criticalFailedCount || 0}`,
    `Missing critical phases: ${recap.missingCriticalCount || 0}`,
    `Next action: ${assurance.nextAction || "none"}`,
    "Winner list:",
    ...winners
  ].join("\n");
}

function postStreamReviewData() {
  const recap = state.giveaway?.recap || {};
  const summary = state.giveaway?.summary || state.status?.giveaway || {};
  const runtime = state.status?.runtime || {};
  const botProcess = runtime.botProcess || {};
  const outboundMessages = state.outboundMessages || [];
  const outboundFailures = outboundMessages.filter((message) => message.status === "failed");
  const giveawayMessages = outboundMessages.filter((message) => message.category === "giveaway");
  const botErrors = (botProcess.recentLogs || []).filter((line) => /failed|error/i.test(line));
  const audit = (state.auditLogs || []).slice(0, 20).map((log) => ({
    createdAt: log.created_at,
    actor: log.actor_twitch_user_id,
    action: log.action,
    target: log.target || "",
    metadata: summarizeMetadata(log.metadata_json)
  }));
  const pendingDelivery = Number(recap.pendingDeliveryCount ?? summary.undeliveredWinnersCount ?? 0);
  const criticalFailed = Number(recap.criticalFailedCount ?? state.outboundSummary?.criticalFailed ?? 0);
  const pendingCritical = Number(recap.pendingCriticalCount ?? state.giveaway?.assurance?.summary?.pendingCritical ?? 0);
  const blockingCritical = Number(recap.blockingCriticalCount ?? state.giveaway?.assurance?.summary?.blockingCritical ?? 0);
  const failed = Number(state.outboundSummary?.failed ?? outboundFailures.length);
  const tone = criticalFailed > 0 || blockingCritical > 0 || botErrors.length > 0
    ? "bad"
    : pendingDelivery > 0 || pendingCritical > 0 || failed > 0
      ? "warn"
      : "ok";
  const nextAction = blockingCritical > 0
    ? "Review critical giveaway chat delivery before the next live run."
    : criticalFailed > 0
      ? "Review and recover failed critical giveaway chat before the next live run."
      : pendingDelivery > 0
        ? "Confirm manual prize delivery notes before closing the night."
        : failed > 0
          ? "Review outbound failures and decide whether any follow-up is needed."
          : "Post-stream review is clear.";

  return {
    generatedAt: new Date().toISOString(),
    tone,
    nextAction,
    runtime: {
      mode: runtime.mode || "",
      botStatus: botProcess.status || "",
      eventSubConnected: Boolean(runtime.eventSubConnected),
      chatSubscriptionActive: Boolean(runtime.chatSubscriptionActive),
      liveChatConfirmed: Boolean(runtime.liveChatConfirmed),
      errorCount: botErrors.length,
      recentErrors: botErrors.slice(-8)
    },
    giveaway: {
      available: Boolean(recap.available),
      id: recap.id || state.giveaway?.giveaway?.id || "",
      title: recap.title || summary.title || "",
      status: recap.status || summary.status || "none",
      entries: Number(recap.entryCount ?? summary.entryCount ?? 0),
      activeWinnerCount: Number(recap.activeWinnerCount ?? summary.winnersDrawn ?? 0),
      pendingDelivery,
      deliveredWinnerCount: Number(recap.deliveredWinnerCount ?? 0),
      winners: (recap.winners || []).map((winner) => ({
        displayName: winner.displayName,
        login: winner.login,
        delivered: Boolean(winner.delivered)
      }))
    },
    outbound: {
      total: Number(state.outboundSummary?.total ?? outboundMessages.length),
      sent: Number(state.outboundSummary?.sent ?? 0),
      resent: Number(state.outboundSummary?.resent ?? 0),
      pending: Number(state.outboundSummary?.pending ?? 0),
      failed,
      criticalFailed,
      pendingCritical,
      blockingCritical,
      retries: outboundMessages.filter((message) => Number(message.attempts || 0) > 1).length,
      giveawayTracked: giveawayMessages.length,
      failures: outboundFailures.map((message) => ({
        id: message.id,
        source: message.source,
        action: message.action || "",
        failureCategory: message.failureCategory || "none",
        status: message.status,
        attempts: message.attempts || 0,
        updatedAt: message.updatedAt || "",
        reason: message.reason || "",
        message: message.message || ""
      }))
    },
    audit,
    incident: incidentNoteText()
  };
}

function postStreamReviewText() {
  const review = postStreamReviewData();
  const winners = review.giveaway.winners.length
    ? review.giveaway.winners.map((winner) =>
        `- ${winner.displayName} (@${winner.login}) - ${winner.delivered ? "delivered" : "pending delivery"}`
      )
    : ["- No winner rows available."];
  const failures = review.outbound.failures.length
    ? review.outbound.failures.slice(0, 8).map((failure) =>
        `- ${failure.updatedAt} ${failure.action || "message"} ${failure.failureCategory}: ${failure.reason || formatMessagePreview(failure.message)}`
      )
    : ["- No outbound failures tracked."];

  return [
    `Post-stream review - ${review.generatedAt}`,
    `Next action: ${review.nextAction}`,
    `Bot: ${review.runtime.botStatus}`,
    `EventSub: ${review.runtime.eventSubConnected ? "connected" : "not connected"}`,
    `Live chat: ${review.runtime.liveChatConfirmed ? "confirmed" : "pending"}`,
    `Giveaway: ${review.giveaway.status} ${review.giveaway.title}`.trim(),
    `Entries: ${review.giveaway.entries}`,
    `Winners: ${review.giveaway.activeWinnerCount}`,
    `Pending delivery: ${review.giveaway.pendingDelivery}`,
    `Outbound failed: ${review.outbound.failed}`,
    `Critical failed: ${review.outbound.criticalFailed}`,
    `Critical pending: ${review.outbound.pendingCritical}`,
    `Blocking critical: ${review.outbound.blockingCritical}`,
    `Retries: ${review.outbound.retries}`,
    "Winners:",
    ...winners,
    "Outbound failures:",
    ...failures
  ].join("\n");
}

function formatMessagePreview(message = "") {
  return message.length > 120 ? `${message.slice(0, 117)}...` : message;
}

function desktopDistributionLabel(platform) {
  if (platform === "win32") {
    return "manual Windows build";
  }

  if (platform === "darwin") {
    return "manual unsigned zip";
  }

  return "manual desktop build";
}

function desktopUpdateMethod(platform) {
  if (platform === "win32") {
    return "quit app, replace installed Windows app";
  }

  if (platform === "darwin") {
    return "quit app, replace vaexcore console.app";
  }

  return "quit app, replace desktop app";
}

function desktopUpdateNote(platform) {
  if (platform === "win32") {
    return "Manual updates should replace only the installed vaexcore console app files. Keep the AppData folder unless you intentionally want to reset Twitch setup and local data.";
  }

  if (platform === "darwin") {
    return "Manual updates should replace only vaexcore console.app. Keep the Application Support folder unless you intentionally want to reset Twitch setup and local data.";
  }

  return "Manual updates should replace only the app files. Keep the app data folder unless you intentionally want to reset Twitch setup and local data.";
}

async function loadFreshState() {
  const [config, status, launchPreparation, giveaway, commands, timers, moderation, templates, operatorMessages, reminder, audit, outbound, diagnostics, featureGateResult, streamPresetResult] = await Promise.all([
    api.config(),
    api.status(),
    api.launchPreparation(),
    api.giveaway(),
    api.commands(),
    api.timers(),
    api.moderation(),
    api.templates(),
    api.operatorMessages(),
    api.reminder(),
    api.auditLogs(),
    api.outboundMessages(),
    api.diagnostics(),
    api.featureGates(),
    api.streamPresets()
  ]);
  state.config = config;
  state.status = status;
  syncLaunchPreparation(launchPreparation);
  state.giveaway = giveaway;
  setCommandState(commands);
  setTimerState(timers);
  setModerationState(moderation);
  state.templates = templates.templates || [];
  state.operatorMessages = operatorMessages.templates || [];
  state.reminder = reminder.reminder || {};
  state.auditLogs = audit.logs || [];
  state.outboundMessages = outbound.messages || [];
  state.outboundSummary = outbound.summary || {};
  state.diagnostics = diagnostics;
  state.featureGates = featureGateResult.featureGates || [];
  state.streamPresets = streamPresetResult.presets || [];
  syncLaunchPreparation(status);
  syncLaunchPreparation(diagnostics);
  state.validSetup = isValidationPassed();
  return { ok: true };
}

async function refreshAll(options = {}) {
  if (options.background) {
    if (backgroundRefreshPromise) {
      return backgroundRefreshPromise;
    }

    backgroundRefreshPromise = loadFreshState()
      .catch((error) => {
        state.message = { text: error.message || "Refresh failed.", tone: "bad" };
        return null;
      })
      .finally(() => {
        backgroundRefreshPromise = null;
        renderWhenIdle();
      });

    return backgroundRefreshPromise;
  }

  await runAction("refresh", loadFreshState, { quiet: true });
}

async function refreshAfterAction() {
  const [status, launchPreparation, giveaway, commands, timers, moderation, templates, operatorMessages, reminder, audit, outbound, featureGateResult, streamPresetResult] = await Promise.all([api.status(), api.launchPreparation(), api.giveaway(), api.commands(), api.timers(), api.moderation(), api.templates(), api.operatorMessages(), api.reminder(), api.auditLogs(), api.outboundMessages(), api.featureGates(), api.streamPresets()]);
  state.status = status;
  syncLaunchPreparation(launchPreparation);
  state.giveaway = giveaway;
  setCommandState(commands);
  setTimerState(timers);
  setModerationState(moderation);
  state.templates = templates.templates || [];
  state.operatorMessages = operatorMessages.templates || [];
  state.reminder = reminder.reminder || {};
  state.auditLogs = audit.logs || [];
  state.outboundMessages = outbound.messages || [];
  state.outboundSummary = outbound.summary || {};
  state.featureGates = featureGateResult.featureGates || [];
  state.streamPresets = streamPresetResult.presets || [];
  syncLaunchPreparation(status);
  state.validSetup = isValidationPassed();
}

async function refreshOutboundMessages() {
  await runAction("refreshOutbound", async () => {
    const outbound = await api.outboundMessages();
    state.outboundMessages = outbound.messages || [];
    state.outboundSummary = outbound.summary || {};
    return { ok: true };
  }, { quiet: true });
}

async function refreshAuditLogs() {
  await runAction("refreshAudit", async () => {
    const audit = await api.auditLogs();
    state.auditLogs = audit.logs || [];
    return { ok: true };
  }, { quiet: true });
}

function setCommandState(result = {}) {
  state.commands = result.commands || [];
  state.commandHistory = result.invocations || [];
  state.commandSummary = result.summary || { total: 0, enabled: 0, disabled: 0, aliases: 0, uses: 0 };
  state.commandReservedNames = result.reservedNames || [];
  state.commandPresets = result.presets || state.commandPresets || [];
  state.commandPresetPacks = result.presetPacks || state.commandPresetPacks || [];
  state.commandFeatureGate = result.featureGate || state.commandFeatureGate;

  if (state.selectedCommandId && !state.commands.some((command) => Number(command.id) === Number(state.selectedCommandId))) {
    state.selectedCommandId = null;
    state.commandDraft = {};
  }
}

function setTimerState(result = {}) {
  state.timers = result.timers || [];
  state.timerSummary = result.summary || { total: 0, enabled: 0, disabled: 0, sent: 0, blocked: 0, waitingForActivity: 0, nextFireAt: "" };
  state.timerFeatureGate = result.featureGate || state.timerFeatureGate;
  state.timerReadiness = result.readiness || state.timerReadiness;
  state.timerPresets = result.presets || state.timerPresets || [];

  if (state.selectedTimerId && !state.timers.some((timer) => Number(timer.id) === Number(state.selectedTimerId))) {
    state.selectedTimerId = null;
    state.timerDraft = {};
  }
}

function setModerationState(result = {}) {
  state.moderation = result;
  state.moderationTerms = result.terms || [];
  state.moderationAllowedLinks = result.allowedLinks || [];
  state.moderationBlockedLinks = result.blockedLinks || [];
  state.moderationLinkPermits = result.linkPermits || [];
  state.moderationHits = result.hits || [];
  state.moderationSummary = result.summary || { terms: 0, enabledTerms: 0, allowedLinks: 0, enabledAllowedLinks: 0, blockedLinks: 0, enabledBlockedLinks: 0, activeLinkPermits: 0, roleExemptions: 0, filtersEnabled: 0, enforcementFilters: 0, botShield: "off", hits: 0 };
  state.moderationEnforcement = result.enforcement || null;
  state.moderationFeatureGate = result.featureGate || state.moderationFeatureGate;
}

async function runAction(key, fn, options = {}) {
  state.busy.add(key);
  if (!options.quiet) state.message = { text: "Working...", tone: "muted" };
  if (!options.background) {
    render();
  }

  try {
    if (!options.background && backgroundRefreshPromise) {
      await backgroundRefreshPromise;
    }
    const result = await fn();
    if (result && result.ok === false) {
      throw new Error(result.error || "Action failed");
    }
    if (!options.skipRefresh) await refreshAfterAction();
    if (!options.quiet) state.message = { text: options.success || "Action completed.", tone: "ok" };
    return result;
  } catch (error) {
    state.message = { text: error.message || "Action failed.", tone: "bad" };
    return null;
  } finally {
    state.busy.delete(key);
    if (options.background) {
      renderWhenIdle();
    } else {
      render();
    }
  }
}

async function startGiveaway() {
  await runGiveawayAction("start", {
    title: field("giveawayTitle").value,
    keyword: field("giveawayKeyword").value || "enter",
    winnerCount: Number(field("winnerCount").value || 1)
  });
}

async function runGiveawayAction(name, body = {}, confirmation) {
  if (shouldWarnBeforeGiveawayAction(name) && !confirm(`${state.giveaway.assurance.nextAction} Chat may not have received the previous critical giveaway announcement. Continue anyway?`)) {
    return;
  }

  if (confirmation && !confirm(confirmation)) {
    return;
  }
  await runAction(`g${name}`, () => api.giveawayAction(name, body), { success: "Giveaway state updated." });
}

function shouldWarnBeforeGiveawayAction(name) {
  const assurance = state.giveaway?.assurance;
  return Boolean(
    assurance?.blockContinue &&
    ["close", "draw", "reroll", "end"].includes(name)
  );
}

async function endGiveaway() {
  const warnings = state.giveaway?.summary?.endWarnings || [];
  const warningText = warnings.length ? `${warnings.join(" ")} ` : "";
  if (!confirm(`${warningText}End giveaway?`)) {
    return;
  }
  await runGiveawayAction("end");
}

async function runSimulatedCommand() {
  await runAction("runCommand", async () => {
    const result = await api.simulateCommand({
      actor: field("simActor").value,
      role: field("simRole").value,
      command: field("simCommand").value
    });
    state.testResult = result;
    return result;
  }, { success: "Simulated command completed." });
}

async function runLifecycleTest() {
  if (!confirm("Run a local test giveaway? This writes test giveaway rows to SQLite and requires no active giveaway.")) {
    return;
  }
  await runAction("runTestGiveaway", async () => {
    const result = await api.giveawayAction("run-test", { confirmed: true });
    state.testResult = result;
    return result;
  }, { success: "Lifecycle test completed." });
}

async function setFeatureGate(key, mode) {
  if (mode === "live" && !confirm("Enable this feature for live Twitch chat? Run local tests first if this is a new workflow.")) {
    return;
  }

  await runAction("featureGate", () => api.setFeatureGate(key, mode), {
    success: "Feature gate updated."
  });
}

async function applyStreamPreset(id) {
  const preset = (state.streamPresets || []).find((item) => item.id === id);
  const confirmed = !preset?.requiresConfirmation || confirm(`Apply ${preset.label}? This changes feature gates for stream operation. Run preflight now if you are going live immediately.`);

  if (!confirmed) {
    return;
  }

  await runAction("streamPreset", async () => {
    const result = await api.applyStreamPreset(id, confirmed);
    state.streamPresets = result.presets || state.streamPresets;
    state.featureGates = result.featureGates || state.featureGates;
    return result;
  }, { success: "Stream preset applied." });
}

function newTimer() {
  state.selectedTimerId = null;
  state.timerDraft = {
    timerName: "",
    timerInterval: 5,
    timerMinChatMessages: 5,
    timerEnabled: false,
    timerMessage: ""
  };
  render();
}

function editTimer(id) {
  const timer = (state.timers || []).find((item) => Number(item.id) === Number(id));
  if (!timer) return;
  state.selectedTimerId = timer.id;
  state.timerDraft = {};
  render();
  field("timerName")?.focus();
}

async function saveTimer() {
  await runAction("saveTimer", async () => {
    const result = await api.saveTimer(readTimerPayload());
    setTimerState(result);
    state.selectedTimerId = result.timer?.id ?? state.selectedTimerId;
    state.timerDraft = {};
    return result;
  }, { skipRefresh: true, success: "Timer saved." });
}

async function toggleTimer(id, enabled) {
  await runAction("timerEnable", async () => {
    const result = await api.enableTimer(id, enabled);
    setTimerState(result);
    return result;
  }, { skipRefresh: true, success: enabled ? "Timer enabled." : "Timer disabled." });
}

async function deleteTimer(id, name) {
  if (!confirm(`Delete timer "${name}"?`)) {
    return;
  }

  await runAction("timerDelete", async () => {
    const result = await api.deleteTimer(id);
    setTimerState(result);
    state.selectedTimerId = null;
    state.timerDraft = {};
    return result;
  }, { skipRefresh: true, success: "Timer deleted." });
}

async function sendTimerNow(id) {
  if (!confirm("Send this timer message to Twitch chat now?")) {
    return;
  }

  await runAction("timerSend", async () => {
    const result = await api.sendTimerNow(id);
    setTimerState(result);
    return result;
  }, { skipRefresh: true, success: "Timer queued." });
}

async function applyTimerPreset(id) {
  await runAction("timerPreset", async () => {
    const result = await api.applyTimerPreset(id);
    setTimerState(result);
    state.selectedTimerId = result.timer?.id ?? state.selectedTimerId;
    state.timerDraft = {};
    return result;
  }, { skipRefresh: true, success: "Timer preset created disabled." });
}

function applyTimerSuggestion(id) {
  const suggestion = timerSuggestions.find((item) => item.id === id);
  if (!suggestion) return;

  state.selectedTimerId = null;
  state.timerDraft = {
    timerName: suggestion.name,
    timerInterval: suggestion.intervalMinutes,
    timerMinChatMessages: suggestion.minChatMessages,
    timerEnabled: false,
    timerMessage: suggestion.message
  };
  state.message = { text: "Timer suggestion loaded into the editor. Review it before saving.", tone: "ok" };
  render();
  field("timerName")?.focus();
}

async function copyTimerSuggestion(id) {
  const suggestion = timerSuggestions.find((item) => item.id === id);
  if (!suggestion) return;
  await copyText(suggestion.message, "Timer suggestion copied.");
}

async function exportTimers() {
  await runAction("exportTimers", async () => {
    const exported = await api.exportTimers();
    downloadTextFile(
      `vaexcore-timers-${new Date().toISOString().slice(0, 10)}.json`,
      `${JSON.stringify(exported, null, 2)}\n`,
      "application/json"
    );
    return { ok: true };
  }, { skipRefresh: true, success: "Timers exported." });
}

async function importTimers() {
  const raw = field("timerImportJson")?.value || "";
  if (!raw.trim()) {
    state.message = { text: "Paste exported timer JSON before importing.", tone: "warn" };
    render();
    return;
  }

  await runAction("importTimers", async () => {
    const result = await api.importTimers(JSON.parse(raw));
    setTimerState(result);
    state.timerDraft = {};
    return result;
  }, { skipRefresh: true, success: "Timers imported." });
}

async function applyCommandPreset(id) {
  await runAction("commandPreset", async () => {
    const result = await api.applyCommandPreset(id);
    setCommandState(result);
    state.selectedCommandId = result.command?.id ?? state.selectedCommandId;
    state.commandDraft = {};
    return result;
  }, { skipRefresh: true, success: "Command preset created disabled." });
}

async function applyCommandPresetPack(id) {
  await runAction("commandPresetPack", async () => {
    const result = await api.applyCommandPresetPack(id);
    setCommandState(result);
    state.selectedCommandId = result.created?.[0]?.id ?? state.selectedCommandId;
    state.commandDraft = {};
    return result;
  }, { skipRefresh: true, success: "Utility pack created ready commands disabled." });
}

function applyModerationSuggestion(id) {
  const suggestion = moderationSuggestions.find((item) => item.id === id);
  if (!suggestion) return;

  if (suggestion.type === "warning") {
    state.moderationDraft = {
      ...state.moderationDraft,
      moderationWarningMessage: suggestion.value
    };
  } else if (suggestion.type === "blockedPhrase") {
    state.moderationTermDraft = {
      moderationTerm: suggestion.value,
      moderationTermEnabled: true
    };
  } else if (suggestion.type === "blockedDomain") {
    state.moderationBlockedLinkDraft = {
      moderationBlockedDomain: suggestion.value,
      moderationBlockedDomainEnabled: true
    };
  } else if (suggestion.type === "allowedDomain") {
    state.moderationAllowedLinkDraft = {
      moderationAllowedDomain: suggestion.value,
      moderationAllowedDomainEnabled: true
    };
  }

  state.message = { text: "Moderation suggestion loaded into the matching editor. Test it before saving live rules.", tone: "ok" };
  render();

  const focusByType = {
    warning: "moderationWarningMessage",
    blockedPhrase: "moderationTerm",
    blockedDomain: "moderationBlockedDomain",
    allowedDomain: "moderationAllowedDomain"
  };
  field(focusByType[suggestion.type])?.focus();
}

async function copyModerationSuggestion(id) {
  const suggestion = moderationSuggestions.find((item) => item.id === id);
  if (!suggestion) return;
  await copyText(suggestion.value, "Moderation suggestion copied.");
}

async function saveModerationSettings() {
  await runAction("saveModerationSettings", async () => {
    const result = await api.saveModerationSettings(readModerationSettingsPayload());
    setModerationState(result);
    state.moderationDraft = {};
    return result;
  }, { skipRefresh: true, success: "Moderation settings saved." });
}

async function saveModerationTerm() {
  await runAction("saveModerationTerm", async () => {
    const result = await api.saveModerationTerm(readModerationTermPayload());
    setModerationState(result);
    state.moderationTermDraft = {};
    return result;
  }, { skipRefresh: true, success: "Blocked phrase saved." });
}

async function toggleModerationTerm(id, enabled) {
  await runAction("moderationTermEnable", async () => {
    const result = await api.enableModerationTerm(id, enabled);
    setModerationState(result);
    return result;
  }, { skipRefresh: true, success: enabled ? "Blocked phrase enabled." : "Blocked phrase disabled." });
}

async function deleteModerationTerm(id, term) {
  if (!confirm(`Delete blocked phrase "${term}"?`)) {
    return;
  }

  await runAction("moderationTermDelete", async () => {
    const result = await api.deleteModerationTerm(id);
    setModerationState(result);
    return result;
  }, { skipRefresh: true, success: "Blocked phrase deleted." });
}

async function saveModerationAllowedLink() {
  await runAction("saveModerationAllowedLink", async () => {
    const result = await api.saveModerationAllowedLink(readModerationAllowedLinkPayload());
    setModerationState(result);
    state.moderationAllowedLinkDraft = {};
    return result;
  }, { skipRefresh: true, success: "Allowed domain saved." });
}

async function toggleModerationAllowedLink(id, enabled) {
  await runAction("moderationAllowedLinkEnable", async () => {
    const result = await api.enableModerationAllowedLink(id, enabled);
    setModerationState(result);
    return result;
  }, { skipRefresh: true, success: enabled ? "Allowed domain enabled." : "Allowed domain disabled." });
}

async function deleteModerationAllowedLink(id, domain) {
  if (!confirm(`Delete allowed domain "${domain}"?`)) {
    return;
  }

  await runAction("moderationAllowedLinkDelete", async () => {
    const result = await api.deleteModerationAllowedLink(id);
    setModerationState(result);
    return result;
  }, { skipRefresh: true, success: "Allowed domain deleted." });
}

async function saveModerationBlockedLink() {
  await runAction("saveModerationBlockedLink", async () => {
    const result = await api.saveModerationBlockedLink(readModerationBlockedLinkPayload());
    setModerationState(result);
    state.moderationBlockedLinkDraft = {};
    return result;
  }, { skipRefresh: true, success: "Blocked domain saved." });
}

async function toggleModerationBlockedLink(id, enabled) {
  await runAction("moderationBlockedLinkEnable", async () => {
    const result = await api.enableModerationBlockedLink(id, enabled);
    setModerationState(result);
    return result;
  }, { skipRefresh: true, success: enabled ? "Blocked domain enabled." : "Blocked domain disabled." });
}

async function deleteModerationBlockedLink(id, domain) {
  if (!confirm(`Delete blocked domain "${domain}"?`)) {
    return;
  }

  await runAction("moderationBlockedLinkDelete", async () => {
    const result = await api.deleteModerationBlockedLink(id);
    setModerationState(result);
    return result;
  }, { skipRefresh: true, success: "Blocked domain deleted." });
}

async function grantModerationLinkPermit() {
  await runAction("grantModerationLinkPermit", async () => {
    const result = await api.grantModerationLinkPermit(readModerationPermitPayload());
    setModerationState(result);
    state.moderationPermitDraft = {};
    return result;
  }, { skipRefresh: true, success: "Link permit granted." });
}

async function runModerationTest() {
  await runAction("runModerationTest", async () => {
    const result = await api.simulateModeration({
      actor: field("moderationTestActor")?.value || "viewer",
      role: field("moderationTestRole")?.value || "viewer",
      text: field("moderationTestText")?.value || ""
    });
    setModerationState(result);
    state.moderationTestResult = result;
    return result;
  }, { skipRefresh: true, success: "Moderation test completed." });
}

function newCustomCommand() {
  state.selectedCommandId = null;
  state.commandDraft = {
    commandName: "",
    commandPermission: "viewer",
    commandEnabled: true,
    commandGlobalCooldown: 30,
    commandUserCooldown: 10,
    commandAliases: "",
    commandResponses: ""
  };
  state.commandPreview = null;
  render();
}

function editCustomCommand(id) {
  const command = (state.commands || []).find((item) => Number(item.id) === Number(id));
  if (!command) return;
  state.selectedCommandId = command.id;
  state.commandDraft = {};
  state.commandPreview = null;
  render();
  field("commandName")?.focus();
}

async function saveCustomCommand() {
  await runAction("saveCommand", async () => {
    const result = await api.saveCommand(readCommandPayload());
    setCommandState(result);
    state.selectedCommandId = result.command?.id ?? state.selectedCommandId;
    state.commandDraft = {};
    return result;
  }, { skipRefresh: true, success: "Custom command saved." });
}

async function toggleCustomCommand(id, enabled) {
  await runAction("commandEnable", async () => {
    const result = await api.enableCommand(id, enabled);
    setCommandState(result);
    return result;
  }, { skipRefresh: true, success: enabled ? "Custom command enabled." : "Custom command disabled." });
}

async function duplicateCustomCommand(id) {
  await runAction("commandDuplicate", async () => {
    const result = await api.duplicateCommand(id);
    setCommandState(result);
    state.selectedCommandId = result.command?.id ?? null;
    state.commandDraft = {};
    return result;
  }, { skipRefresh: true, success: "Custom command duplicated." });
}

async function deleteCustomCommand(id, name) {
  if (!confirm(`Delete !${name}? Usage history remains in the audit log, but the command definition will be removed.`)) {
    return;
  }

  await runAction("commandDelete", async () => {
    const result = await api.deleteCommand(id);
    setCommandState(result);
    state.selectedCommandId = null;
    state.commandDraft = {};
    return result;
  }, { skipRefresh: true, success: "Custom command deleted." });
}

async function previewCustomCommand() {
  await runAction("previewCommand", async () => {
    const payload = readCommandPayload();
    const result = await api.previewCommand({
      commandId: payload.id,
      responseText: splitLines(field("commandResponses")?.value || "")[0] || "",
      actor: field("commandPreviewActor")?.value || "viewer",
      role: field("commandPreviewRole")?.value || "viewer",
      rawArgs: field("commandPreviewArgs")?.value || "target"
    });
    state.commandPreview = result;
    return result;
  }, { skipRefresh: true, success: "Command preview rendered." });
}

async function testCustomCommand() {
  await runAction("testCustomCommand", async () => {
    const payload = readCommandPayload();
    const name = String(payload.name || "").replace(/^!/, "");
    const args = field("commandPreviewArgs")?.value || "";
    const result = await api.simulateCommand({
      actor: field("commandPreviewActor")?.value || "viewer",
      role: field("commandPreviewRole")?.value || "viewer",
      command: `!${name}${args ? ` ${args}` : ""}`
    });
    state.testResult = result;
    return result;
  }, { success: "Custom command test completed." });
}

async function exportCustomCommands() {
  await runAction("exportCommands", async () => {
    const exported = await api.exportCommands();
    downloadTextFile(
      `vaexcore-custom-commands-${new Date().toISOString().slice(0, 10)}.json`,
      `${JSON.stringify(exported, null, 2)}\n`,
      "application/json"
    );
    return { ok: true };
  }, { skipRefresh: true, success: "Custom commands exported." });
}

async function importCustomCommands() {
  const raw = field("commandImportJson")?.value || "";
  if (!raw.trim()) {
    state.message = { text: "Paste exported command JSON before importing.", tone: "warn" };
    render();
    return;
  }

  await runAction("importCommands", async () => {
    const result = await api.importCommands(JSON.parse(raw));
    setCommandState(result);
    state.commandDraft = {};
    return result;
  }, { skipRefresh: true, success: "Custom commands imported." });
}

async function exportBotConfigBundle() {
  await runAction("exportBotConfig", async () => {
    const exported = await api.exportBotConfig();
    downloadTextFile(
      `vaexcore-safe-bot-config-${new Date().toISOString().slice(0, 10)}.json`,
      `${JSON.stringify(exported, null, 2)}\n`,
      "application/json"
    );
    return { ok: true };
  }, { skipRefresh: true, success: "Safe bot config exported." });
}

async function importBotConfigBundle() {
  const raw = field("botConfigImportJson")?.value || "";
  if (!raw.trim()) {
    state.message = { text: "Paste exported safe bot config JSON before importing.", tone: "warn" };
    render();
    return;
  }

  await runAction("importBotConfig", async () => api.importBotConfig(JSON.parse(raw)), {
    success: "Safe bot config imported."
  });
}

async function saveSettings() {
  const payload = readSettingsPayload();

  await runAction("save", async () => {
    const result = await api.saveConfig(payload);
    state.config = result.config;
    state.settingsDraft = {};
    return result;
  }, { success: "Settings saved." });
}

async function disconnectTwitch() {
  if (!confirm("Disconnect the current Twitch OAuth token? Your app Client ID and Client Secret stay saved.")) {
    return;
  }

  await runAction("disconnectTwitch", async () => {
    const result = await api.disconnectTwitch();
    state.config = result.config;
    state.validSetup = false;
    state.validationChecks = [];
    state.oauthNotice = {
      tone: "ok",
      text: `Twitch connection cleared. Log into the Bot Login account (${state.config?.botLogin || "Bot Login"}), then click Connect Twitch as Bot Login.`
    };
    return result;
  }, { skipRefresh: true, success: "Twitch connection cleared." });
  await refreshAll();
}

function updateSettingsDraft(event) {
  state.settingsDraft[event.target.id] = event.target.value;
}

function updateCommandDraft(event) {
  const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
  state.commandDraft[event.target.id] = value;
}

function updateTimerDraft(event) {
  const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
  state.timerDraft[event.target.id] = value;
}

function updateModerationDraft(event) {
  const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
  state.moderationDraft[event.target.id] = value;
}

function updateModerationTermDraft(event) {
  const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
  state.moderationTermDraft[event.target.id] = value;
}

function updateModerationAllowedLinkDraft(event) {
  const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
  state.moderationAllowedLinkDraft[event.target.id] = value;
}

function updateModerationBlockedLinkDraft(event) {
  const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
  state.moderationBlockedLinkDraft[event.target.id] = value;
}

function updateModerationPermitDraft(event) {
  state.moderationPermitDraft[event.target.id] = event.target.value;
}

function updateGiveawayDraft(event) {
  state.giveawayDraft[event.target.id] = event.target.value;
}

function updateTemplateDraft(event) {
  const action = event.target.dataset.action;
  if (!action) return;
  state.templateDraft[action] = event.target.value;
}

function updateOperatorTemplateDraft(event) {
  const id = event.target.dataset.id;
  if (!id) return;
  state.operatorTemplateDraft[id] = event.target.value;
}

function updateReminderDraft(event) {
  const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
  state.reminderDraft[event.target.id] = value;
}

function normalizeLoginField(event) {
  const normalized = normalizeLoginInput(event.target.value);
  if (normalized === event.target.value) {
    return;
  }

  event.target.value = normalized;
  state.settingsDraft[event.target.id] = normalized;
}

function normalizeLoginInput(value) {
  const trimmed = value.trim().replace(/^@/, "");
  const maybeUrl = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : /^(www\.)?twitch\.tv\//i.test(trimmed)
      ? `https://${trimmed}`
      : null;

  if (!maybeUrl) {
    return trimmed.toLowerCase();
  }

  try {
    const parsed = new URL(maybeUrl);
    if (["twitch.tv", "www.twitch.tv"].includes(parsed.hostname.toLowerCase())) {
      return (parsed.pathname.split("/").filter(Boolean)[0] || "").toLowerCase();
    }
  } catch {
    return trimmed.toLowerCase();
  }

  return trimmed.toLowerCase();
}

function clearSavedCredentialMask(event) {
  const id = event.target.id;
  if (!["clientId", "clientSecret"].includes(id) || event.target.value !== savedCredentialMask) {
    return;
  }
  event.target.value = "";
  state.settingsDraft[id] = "";
}

function restoreSavedCredentialMask(event) {
  const id = event.target.id;
  if (!hasSavedCredential(id) || event.target.value !== "") {
    return;
  }
  delete state.settingsDraft[id];
  event.target.value = savedCredentialMask;
}

function readSettingsPayload() {
  return {
    mode: fieldValue("mode", state.config?.mode || "live"),
    redirectUri: fieldValue("redirectUri", state.config?.redirectUri || defaultRedirectUri),
    clientId: credentialFieldValue("clientId", state.config?.hasClientId),
    clientSecret: credentialFieldValue("clientSecret", state.config?.hasClientSecret),
    broadcasterLogin: fieldValue("broadcasterLogin", state.config?.broadcasterLogin || ""),
    botLogin: fieldValue("botLogin", state.config?.botLogin || "")
  };
}

function readCommandPayload() {
  const selected = selectedCustomCommand();
  return {
    id: selected?.id,
    name: field("commandName")?.value || "",
    permission: field("commandPermission")?.value || "viewer",
    enabled: Boolean(field("commandEnabled")?.checked),
    globalCooldownSeconds: Number(field("commandGlobalCooldown")?.value || 0),
    userCooldownSeconds: Number(field("commandUserCooldown")?.value || 0),
    aliases: splitLinesAndCommas(field("commandAliases")?.value || ""),
    responses: splitLines(field("commandResponses")?.value || "")
  };
}

function readTimerPayload() {
  const selected = selectedTimer();
  return {
    id: selected?.id,
    name: field("timerName")?.value || "",
    intervalMinutes: Number(field("timerInterval")?.value || 5),
    minChatMessages: Number(field("timerMinChatMessages")?.value || 0),
    enabled: Boolean(field("timerEnabled")?.checked),
    message: field("timerMessage")?.value || ""
  };
}

function readModerationSettingsPayload() {
  return {
    blockedTermsEnabled: Boolean(field("blockedTermsEnabled")?.checked),
    linkFilterEnabled: Boolean(field("linkFilterEnabled")?.checked),
    capsFilterEnabled: Boolean(field("capsFilterEnabled")?.checked),
    repeatFilterEnabled: Boolean(field("repeatFilterEnabled")?.checked),
    symbolFilterEnabled: Boolean(field("symbolFilterEnabled")?.checked),
    botShieldEnabled: Boolean(field("botShieldEnabled")?.checked),
    blockedTermsAction: field("blockedTermsAction")?.value || "warn",
    linkFilterAction: field("linkFilterAction")?.value || "warn",
    capsFilterAction: field("capsFilterAction")?.value || "warn",
    repeatFilterAction: field("repeatFilterAction")?.value || "warn",
    symbolFilterAction: field("symbolFilterAction")?.value || "warn",
    botShieldAction: field("botShieldAction")?.value || "delete",
    botShieldScoreThreshold: Number(field("botShieldScoreThreshold")?.value || 70),
    timeoutSeconds: Number(field("timeoutSeconds")?.value || 60),
    warningMessage: field("moderationWarningMessage")?.value || "",
    capsMinLength: Number(field("capsMinLength")?.value || 20),
    capsRatio: Number(field("capsRatio")?.value || 0.75),
    repeatLimit: Number(field("repeatLimit")?.value || 3),
    repeatWindowSeconds: Number(field("repeatWindowSeconds")?.value || 30),
    symbolMinLength: Number(field("symbolMinLength")?.value || 12),
    symbolRatio: Number(field("symbolRatio")?.value || 0.6),
    escalationEnabled: Boolean(field("escalationEnabled")?.checked),
    escalationWindowSeconds: Number(field("escalationWindowSeconds")?.value || 300),
    escalationDeleteAfter: Number(field("escalationDeleteAfter")?.value || 2),
    escalationTimeoutAfter: Number(field("escalationTimeoutAfter")?.value || 3),
    exemptBroadcaster: Boolean(field("exemptBroadcaster")?.checked),
    exemptModerators: Boolean(field("exemptModerators")?.checked),
    exemptVips: Boolean(field("exemptVips")?.checked),
    exemptSubscribers: Boolean(field("exemptSubscribers")?.checked)
  };
}

function readModerationTermPayload() {
  return {
    term: field("moderationTerm")?.value || "",
    enabled: Boolean(field("moderationTermEnabled")?.checked)
  };
}

function readModerationAllowedLinkPayload() {
  return {
    domain: field("moderationAllowedDomain")?.value || "",
    enabled: Boolean(field("moderationAllowedDomainEnabled")?.checked)
  };
}

function readModerationBlockedLinkPayload() {
  return {
    domain: field("moderationBlockedDomain")?.value || "",
    enabled: Boolean(field("moderationBlockedDomainEnabled")?.checked)
  };
}

function readModerationPermitPayload() {
  return {
    userLogin: field("moderationPermitUser")?.value || "",
    minutes: Number(field("moderationPermitMinutes")?.value || 5)
  };
}

function readTemplatePayload() {
  const payload = {};

  for (const template of state.templates || []) {
    const id = `template-${template.action}`;
    payload[template.action] = templateValue(template.action, template.template || "");
    if (field(id)) {
      payload[template.action] = field(id).value;
    }
  }

  return payload;
}

function splitLines(value) {
  return value.split(/\n+/).map((item) => item.trim()).filter(Boolean);
}

function splitLinesAndCommas(value) {
  return value.split(/[,\n]+/).map((item) => item.trim()).filter(Boolean);
}

function readOperatorTemplatePayload() {
  const payload = {};

  for (const template of state.operatorMessages || []) {
    const id = `operator-template-${template.id}`;
    payload[template.id] = operatorTemplateValue(template.id, template.template || "");
    if (field(id)) {
      payload[template.id] = field(id).value;
    }
  }

  return payload;
}

async function validateSetup() {
  await runAction("validate", async () => {
    const result = await api.validate();
    state.validSetup = Boolean(result.ok);
    state.validationChecks = result.checks || [];
    return result;
  }, { skipRefresh: true, success: "Validation completed." });
  await refreshAll();
}

async function sendSetupTest() {
  const result = await runAction("test", () => api.testSend(), { success: "Test message sent." });
  if (result?.ok) {
    state.testMessageSent = true;
    render();
  }
}

async function startBot() {
  await runAction("botStart", async () => {
    const result = await api.botStart();
    if (result?.checks) {
      state.preflightResult = {
        ok: Boolean(result.ok),
        checks: result.checks,
        nextAction: result.nextAction || result.error || "",
        summary: state.giveaway?.summary || {}
      };
    }
    if (result?.diagnostics) {
      state.diagnostics = result.diagnostics;
    }
    return result;
  }, { success: "Bot process starting." });
}

async function stopBot() {
  await runAction("botStop", () => api.botStop(), { success: "Bot process stopped." });
}

async function runPreflight() {
  await runAction("runPreflight", async () => {
    const result = await api.preflight();
    state.preflightResult = result;
    return { ok: true };
  }, { success: "Preflight completed." });
}

async function runLaunchPreparation() {
  await runAction("launchPreparation", async () => {
    const result = await api.runLaunchPreparation();
    syncLaunchPreparation(result);
    return { ok: true };
  }, { skipRefresh: true, success: "Launch checks completed." });
  await refreshAll();
}

async function launchSuite() {
  await runAction("launchSuite", async () => {
    const result = await api.launchSuite();
    if (!result.ok) {
      throw new Error(formatSuiteLaunchFailure(result.results || []));
    }
    return { ok: true };
  }, { skipRefresh: true, success: "Launch requested for Studio, Pulse, and Console." });
}

function formatSuiteLaunchFailure(results) {
  const appNames = results
    .filter((result) => !result.ok)
    .map((result) => result.appName)
    .join(", ");
  return appNames
    ? `Could not launch ${appNames}. Install the app bundles in Applications, then try again.`
    : "Unable to launch the vaexcore suite.";
}

function openSettingsWindow(fragment = "") {
  window.open(`/?window=settings${fragment}`, "vaexcore-settings", "width=980,height=760");
}

function openSetupGuide() {
  if (!isSettingsWindow) {
    openSettingsWindow("#setupGuide");
    return;
  }

  state.activeTab = "settings";
  render();
  document.getElementById("setupGuide")?.scrollIntoView({ block: "start" });
}

function openLiveMode() {
  state.activeTab = "live-mode";
  render();
}

function openGiveaways() {
  state.activeTab = "giveaways";
  render();
}

async function saveTemplates() {
  await runAction("saveTemplates", async () => {
    const result = await api.saveTemplates(readTemplatePayload());
    state.templates = result.templates || [];
    state.templateDraft = {};
    return result;
  }, { skipRefresh: true, success: "Templates saved." });
}

async function resetTemplates() {
  if (!confirm("Reset giveaway message templates to defaults?")) {
    return;
  }

  await runAction("resetTemplates", async () => {
    const result = await api.resetTemplates();
    state.templates = result.templates || [];
    state.templateDraft = {};
    return result;
  }, { skipRefresh: true, success: "Templates reset." });
}

async function saveOperatorMessages() {
  await runAction("saveOperatorMessages", async () => {
    const result = await api.saveOperatorMessages(readOperatorTemplatePayload());
    state.operatorMessages = result.templates || [];
    state.operatorTemplateDraft = {};
    return result;
  }, { skipRefresh: true, success: "Operator messages saved." });
}

async function resetOperatorMessages() {
  if (!confirm("Reset operator message presets to defaults?")) {
    return;
  }

  await runAction("resetOperatorMessages", async () => {
    const result = await api.resetOperatorMessages();
    state.operatorMessages = result.templates || [];
    state.operatorTemplateDraft = {};
    return result;
  }, { skipRefresh: true, success: "Operator messages reset." });
}

async function sendOperatorMessage(id, label, requiresConfirmation) {
  if (requiresConfirmation && !confirm(`Send "${label}" to Twitch chat now?`)) {
    return;
  }

  await runAction("sendOperatorMessage", () => api.sendOperatorMessage(id, requiresConfirmation), {
    success: "Operator message queued."
  });
}

async function saveReminder() {
  await runAction("saveReminder", async () => {
    const result = await api.saveReminder({
      enabled: Boolean(field("reminderEnabled")?.checked),
      intervalMinutes: Number(field("reminderInterval")?.value || 10)
    });
    state.reminder = result.reminder || {};
    state.reminderDraft = {};
    return result;
  }, { skipRefresh: true, success: "Reminder settings saved." });
}

async function sendReminderNow() {
  await runAction("sendReminderNow", async () => {
    const result = await api.sendReminder();
    state.reminder = result.reminder || {};
    return result;
  }, { success: "Reminder queued." });
}

async function copyWinnerList() {
  const winners = activeWinnerList();
  const text = winners.map((winner) => `${winner.display_name} (@${winner.login})`).join("\n");

  if (!text) {
    state.message = { text: "No winners to copy.", tone: "warn" };
    render();
    return;
  }

  await copyText(text, "Winner list copied.");
}

async function copyRecap() {
  await copyText(postStreamRecapText(), "Post-stream recap copied.");
}

async function copyPostStreamReview() {
  await copyText(postStreamReviewText(), "Post-stream review copied.");
}

function exportPostStreamReviewJson() {
  downloadTextFile(
    `vaexcore-post-stream-review-${new Date().toISOString().slice(0, 10)}.json`,
    `${JSON.stringify(postStreamReviewData(), null, 2)}\n`,
    "application/json"
  );
  state.message = { text: "Post-stream review JSON exported.", tone: "ok" };
  render();
}

async function copyIncidentNote() {
  await copyText(incidentNoteText(), "Incident note copied.");
}

async function runDiagnostics() {
  await runAction("diagnostics", async () => {
    const report = await api.diagnostics();
    state.diagnostics = report;
    syncLaunchPreparation(report);
    return report;
  }, { skipRefresh: true, success: "Diagnostics updated." });
}

async function copyDiagnostics() {
  const report = state.diagnostics || await api.diagnostics();
  state.diagnostics = report;
  syncLaunchPreparation(report);
  await copyText(JSON.stringify(report, null, 2), "Diagnostic report copied.");
}

async function copySupportBundle() {
  await runAction("copySupportBundle", async () => {
    const bundle = await api.supportBundle();
    state.diagnostics = bundle.diagnostics || state.diagnostics;
    syncLaunchPreparation(bundle.diagnostics || {});
    await copyText(JSON.stringify(bundle, null, 2), "Support bundle copied.");
    return bundle;
  }, { skipRefresh: true, quiet: true });
}

function incidentNoteText() {
  const runtime = state.status?.runtime || {};
  const process = runtime.botProcess || {};
  const summary = state.giveaway?.summary || state.status?.giveaway || {};
  const recovery = runtime.outboundRecovery || {};
  const health = runtime.queueHealth || {};
  const runbook = liveRunbookSteps();

  return [
    `vaexcore console incident note - ${new Date().toISOString()}`,
    `Mode: ${runtime.mode || "unknown"}`,
    `Bot: ${process.status || "unknown"}${process.pid ? ` pid=${process.pid}` : ""}`,
    `EventSub: ${runtime.eventSubConnected ? "connected" : "not connected"}`,
    `Chat subscription: ${runtime.chatSubscriptionActive ? "active" : "inactive"}`,
    `Live chat: ${runtime.liveChatConfirmed ? "confirmed" : "pending"}`,
    `Queue: ${health.status || "unknown"} - ${health.nextAction || "none"}`,
    `Recovery: ${recovery.needed ? `${recovery.severity || "needed"} ${recovery.action || ""} ${recovery.failureCategory || ""}`.trim() : "clear"}`,
    recovery.reason ? `Recovery reason: ${recovery.reason}` : "",
    `Giveaway: ${summary.status || "none"} ${summary.title || ""}`.trim(),
    `Entries: ${summary.entryCount || 0}`,
    `Winners: ${summary.winnersDrawn || 0}/${summary.winnerCount || 0}`,
    `Undelivered: ${summary.undeliveredWinnersCount || 0}`,
    `Next runbook action: ${runbook[0]?.label || "Monitor"} - ${runbook[0]?.detail || "No action."}`
  ].filter(Boolean).join("\n");
}

async function copyText(text, success) {
  try {
    await navigator.clipboard.writeText(text);
    state.message = { text: success, tone: "ok" };
  } catch {
    state.message = { text, tone: "muted" };
  }

  render();
}

function downloadTextFile(filename, text, type = "text/plain") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function sendGiveawayStatus() {
  await runAction("sendGiveawayStatus", async () => {
    const result = await api.sendGiveawayStatus();
    if (result.state) {
      state.giveaway = result.state;
    }
    return result;
  }, { success: "Giveaway status queued." });
}

async function resendCriticalGiveaway() {
  await runAction("resendCriticalGiveaway", async () => {
    const result = await api.resendCriticalGiveaway();
    if (result.state) {
      state.giveaway = result.state;
    }
    state.outboundMessages = result.messages || state.outboundMessages;
    state.outboundSummary = result.summary || state.outboundSummary;
    return result;
  }, { success: "Critical giveaway message requeued." });
}

async function resendOutboundMessage(id) {
  await runAction("resendOutbound", async () => {
    const result = await api.resendOutboundMessage(id);
    state.outboundMessages = result.messages || [];
    state.outboundSummary = result.summary || {};
    return result;
  }, { skipRefresh: true, success: "Outbound message requeued." });
  await refreshAll();
}

async function resendGiveawayAnnouncement(action) {
  await runAction("resendGiveawayAnnouncement", async () => {
    const result = await api.resendGiveawayAnnouncement(action);
    if (result.state) {
      state.giveaway = result.state;
    }
    return result;
  }, { success: "Giveaway announcement queued." });
}

function renderTestResult() {
  if (!state.testResult) {
    return h("div", { className: "message", text: "No simulated command has run yet." });
  }

  const result = state.testResult;
  const replies = result.replies?.length ? result.replies : [fallbackCommandMessage(result)];
  const validationErrors = result.checks?.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`) || [];

  return h("div", {}, [
    statusGrid([
      ["Result", result.ok ? "ok" : "failed", result.ok],
      ["Router", result.routerResult || "n/a", result.routerResult !== "denied"],
      ["Echo queued", result.echoQueued ? "yes" : "no", Boolean(result.echoQueued)],
      ["Validation errors", validationErrors.length, validationErrors.length === 0]
    ]),
    h("h3", { text: "Replies" }),
    list(replies, result.ok ? "muted" : "bad"),
    validationErrors.length ? list(validationErrors, "bad") : null
  ]);
}

function renderModerationTestResult() {
  const test = state.moderationTestResult || {};
  const result = test.result;
  const plan = test.enforcementPlan;

  if (!result) {
    return null;
  }

  return h("div", { className: "test-result" }, [
    statusGrid([
      ["Result", result.hit ? "hit" : result.skipped ? "skipped" : "clear", !result.hit],
      ["Action", result.hit?.action || "none", !result.hit],
      ["Filter actions", (result.hit?.filterActions || []).map((item) => `${item.filterType}:${item.action}`).join(", ") || "none", !result.hit],
      ["Matched rules", (result.hit?.matches || []).map((item) => item.detail).join("; ") || "none", !result.hit],
      ["Bot Shield", result.botShield ? `${result.botShield.score}/${result.botShield.threshold}` : "off", !result.hit],
      ["Bot reasons", (result.botShield?.reasons || []).join(", ") || "none", !result.hit],
      ["First-time chatter", result.botShield ? (result.botShield.firstTimeChatter ? "yes" : "no") : "unknown", !result.botShield?.firstTimeChatter],
      ["Silent first action", result.hit?.silent ? "yes" : "no", !result.hit?.silent],
      ["Escalation", result.hit?.escalation?.reason || "none", !result.hit || !result.hit.escalation],
      ["Timeout", result.hit?.timeoutSeconds ? `${result.hit.timeoutSeconds}s` : "none", !result.hit],
      ["Enforcement", plan ? `${plan.status}: ${plan.reason}` : "none", !result.hit || plan?.status === "skipped"],
      ["Allowed links", (result.allowedLinks || []).join(", ") || "none", !result.hit],
      ["Permit", result.consumedPermit ? `available for ${result.consumedPermit.userLogin}` : "none", !result.hit],
      ["Reason", result.hit?.detail || result.reason || "none", !result.hit]
    ]),
    result.hit ? callout(result.hit.warningMessage, "warn") : null
  ]);
}

function fallbackCommandMessage(result) {
  if (result.routerResult === "denied") return "Command denied by permission checks.";
  if (result.routerResult === "unknown") return "Unknown command ignored.";
  return result.ok ? "Command ran with no chat reply." : result.error || "Command failed.";
}

function syncFormValues() {
  const config = state.config || {};
  const summary = state.giveaway?.summary || {};
  const selectedCommand = selectedCustomCommand();
  const currentTimer = selectedTimer();
  const moderationSettings = state.moderation?.settings || {};
  setValue("mode", settingsValue("mode", config.mode || "live"));
  setValue("redirectUri", settingsValue("redirectUri", config.redirectUri || defaultRedirectUri));
  setValue("clientId", settingsValue("clientId", config.hasClientId ? savedCredentialMask : ""));
  setValue("clientSecret", settingsValue("clientSecret", config.hasClientSecret ? savedCredentialMask : ""));
  setValue("broadcasterLogin", settingsValue("broadcasterLogin", config.broadcasterLogin || ""));
  setValue("botLogin", settingsValue("botLogin", config.botLogin || ""));
  setValue("commandName", commandValue("commandName", selectedCommand?.name || ""));
  setValue("commandPermission", commandValue("commandPermission", selectedCommand?.permission || "viewer"));
  setChecked("commandEnabled", commandValue("commandEnabled", selectedCommand?.enabled ?? true));
  setValue("commandGlobalCooldown", commandValue("commandGlobalCooldown", selectedCommand?.globalCooldownSeconds ?? 30));
  setValue("commandUserCooldown", commandValue("commandUserCooldown", selectedCommand?.userCooldownSeconds ?? 10));
  setValue("commandAliases", commandValue("commandAliases", (selectedCommand?.aliases || []).join("\n")));
  setValue("commandResponses", commandValue("commandResponses", (selectedCommand?.responses || []).join("\n")));
  setValue("commandPreviewActor", field("commandPreviewActor")?.value || "viewer");
  setValue("commandPreviewRole", field("commandPreviewRole")?.value || "viewer");
  setValue("commandPreviewArgs", field("commandPreviewArgs")?.value || "target");
  setValue("timerName", timerValue("timerName", currentTimer?.name || ""));
  setValue("timerInterval", timerValue("timerInterval", currentTimer?.intervalMinutes || 5));
  setValue("timerMinChatMessages", timerValue("timerMinChatMessages", currentTimer?.minChatMessages ?? 5));
  setChecked("timerEnabled", Boolean(timerValue("timerEnabled", currentTimer?.enabled ?? false)));
  setValue("timerMessage", timerValue("timerMessage", currentTimer?.message || ""));
  setChecked("blockedTermsEnabled", Boolean(moderationValue("blockedTermsEnabled", moderationSettings.blockedTermsEnabled)));
  setChecked("linkFilterEnabled", Boolean(moderationValue("linkFilterEnabled", moderationSettings.linkFilterEnabled)));
  setChecked("capsFilterEnabled", Boolean(moderationValue("capsFilterEnabled", moderationSettings.capsFilterEnabled)));
  setChecked("repeatFilterEnabled", Boolean(moderationValue("repeatFilterEnabled", moderationSettings.repeatFilterEnabled)));
  setChecked("symbolFilterEnabled", Boolean(moderationValue("symbolFilterEnabled", moderationSettings.symbolFilterEnabled)));
  setChecked("botShieldEnabled", Boolean(moderationValue("botShieldEnabled", moderationSettings.botShieldEnabled)));
  setValue("blockedTermsAction", moderationValue("blockedTermsAction", moderationSettings.blockedTermsAction || "warn"));
  setValue("linkFilterAction", moderationValue("linkFilterAction", moderationSettings.linkFilterAction || "warn"));
  setValue("capsFilterAction", moderationValue("capsFilterAction", moderationSettings.capsFilterAction || "warn"));
  setValue("repeatFilterAction", moderationValue("repeatFilterAction", moderationSettings.repeatFilterAction || "warn"));
  setValue("symbolFilterAction", moderationValue("symbolFilterAction", moderationSettings.symbolFilterAction || "warn"));
  setValue("botShieldAction", moderationValue("botShieldAction", moderationSettings.botShieldAction || "delete"));
  setValue("botShieldScoreThreshold", moderationValue("botShieldScoreThreshold", moderationSettings.botShieldScoreThreshold || 70));
  setValue("timeoutSeconds", moderationValue("timeoutSeconds", moderationSettings.timeoutSeconds || 60));
  setValue("moderationWarningMessage", moderationValue("moderationWarningMessage", moderationSettings.warningMessage || "@{user}, please keep chat within channel guidelines."));
  setValue("capsMinLength", moderationValue("capsMinLength", moderationSettings.capsMinLength || 20));
  setValue("capsRatio", moderationValue("capsRatio", moderationSettings.capsRatio || 0.75));
  setValue("repeatLimit", moderationValue("repeatLimit", moderationSettings.repeatLimit || 3));
  setValue("repeatWindowSeconds", moderationValue("repeatWindowSeconds", moderationSettings.repeatWindowSeconds || 30));
  setValue("symbolMinLength", moderationValue("symbolMinLength", moderationSettings.symbolMinLength || 12));
  setValue("symbolRatio", moderationValue("symbolRatio", moderationSettings.symbolRatio || 0.6));
  setChecked("escalationEnabled", Boolean(moderationValue("escalationEnabled", moderationSettings.escalationEnabled ?? false)));
  setValue("escalationWindowSeconds", moderationValue("escalationWindowSeconds", moderationSettings.escalationWindowSeconds || 300));
  setValue("escalationDeleteAfter", moderationValue("escalationDeleteAfter", moderationSettings.escalationDeleteAfter || 2));
  setValue("escalationTimeoutAfter", moderationValue("escalationTimeoutAfter", moderationSettings.escalationTimeoutAfter || 3));
  setChecked("exemptBroadcaster", Boolean(moderationValue("exemptBroadcaster", moderationSettings.exemptBroadcaster ?? true)));
  setChecked("exemptModerators", Boolean(moderationValue("exemptModerators", moderationSettings.exemptModerators ?? true)));
  setChecked("exemptVips", Boolean(moderationValue("exemptVips", moderationSettings.exemptVips ?? false)));
  setChecked("exemptSubscribers", Boolean(moderationValue("exemptSubscribers", moderationSettings.exemptSubscribers ?? false)));
  setValue("moderationTerm", draftValue(state.moderationTermDraft, "moderationTerm", ""));
  setChecked("moderationTermEnabled", Boolean(draftValue(state.moderationTermDraft, "moderationTermEnabled", true)));
  setValue("moderationAllowedDomain", draftValue(state.moderationAllowedLinkDraft, "moderationAllowedDomain", ""));
  setChecked("moderationAllowedDomainEnabled", Boolean(draftValue(state.moderationAllowedLinkDraft, "moderationAllowedDomainEnabled", true)));
  setValue("moderationBlockedDomain", draftValue(state.moderationBlockedLinkDraft, "moderationBlockedDomain", ""));
  setChecked("moderationBlockedDomainEnabled", Boolean(draftValue(state.moderationBlockedLinkDraft, "moderationBlockedDomainEnabled", true)));
  setValue("moderationPermitUser", draftValue(state.moderationPermitDraft, "moderationPermitUser", ""));
  setValue("moderationPermitMinutes", draftValue(state.moderationPermitDraft, "moderationPermitMinutes", 5));
  setValue("moderationTestActor", field("moderationTestActor")?.value || "viewer");
  setValue("moderationTestRole", field("moderationTestRole")?.value || "viewer");
  setValue("moderationTestText", field("moderationTestText")?.value || "VISIT EXAMPLE.COM NOW");
  setValue("giveawayTitle", giveawayValue("giveawayTitle", summary.title || "Community Giveaway"));
  setValue("giveawayKeyword", giveawayValue("giveawayKeyword", summary.keyword || "enter"));
  setValue("winnerCount", giveawayValue("winnerCount", summary.winnerCount || 3));
  setValue("drawCount", giveawayValue("drawCount", suggestedDrawCount()));
  for (const template of state.templates || []) {
    setValue(`template-${template.action}`, templateValue(template.action, template.template || ""));
  }
  for (const template of state.operatorMessages || []) {
    setValue(`operator-template-${template.id}`, operatorTemplateValue(template.id, template.template || ""));
  }
  setChecked("reminderEnabled", Boolean(reminderValue("reminderEnabled", state.reminder?.enabled)));
  setValue("reminderInterval", reminderValue("reminderInterval", state.reminder?.intervalMinutes || 10));
  setValue("simActor", field("simActor")?.value || "viewer");
  setValue("simRole", field("simRole")?.value || "viewer");
  setValue("simCommand", field("simCommand")?.value || "!gstatus");
  setValue("entrantFilter", state.entrantFilter);
  setValue("winnerFilter", state.winnerFilter);
  syncWinnerSelects();
}

function settingsValue(id, fallback) {
  return draftValue(state.settingsDraft, id, fallback);
}

function commandValue(id, fallback) {
  return draftValue(state.commandDraft, id, fallback);
}

function timerValue(id, fallback) {
  return draftValue(state.timerDraft, id, fallback);
}

function moderationValue(id, fallback) {
  return draftValue(state.moderationDraft, id, fallback);
}

function giveawayValue(id, fallback) {
  return draftValue(state.giveawayDraft, id, fallback);
}

function templateValue(action, fallback) {
  return draftValue(state.templateDraft, action, fallback);
}

function operatorTemplateValue(id, fallback) {
  return draftValue(state.operatorTemplateDraft, id, fallback);
}

function reminderValue(id, fallback) {
  return draftValue(state.reminderDraft, id, fallback);
}

function draftValue(draft, id, fallback) {
  return Object.prototype.hasOwnProperty.call(draft, id) ? draft[id] : fallback;
}

function fieldValue(id, fallback) {
  return field(id)?.value ?? settingsValue(id, fallback);
}

function credentialFieldValue(id, hasSavedCredential) {
  const value = fieldValue(id, hasSavedCredential ? savedCredentialMask : "");
  return hasSavedCredential && value === savedCredentialMask ? "" : value;
}

function hasSavedCredential(id) {
  if (id === "clientId") return Boolean(state.config?.hasClientId);
  if (id === "clientSecret") return Boolean(state.config?.hasClientSecret);
  return false;
}

function setValue(id, value) {
  const node = field(id);
  if (node && document.activeElement !== node) {
    node.value = value;
  }
}

function setChecked(id, value) {
  const node = field(id);
  if (node && document.activeElement !== node) {
    node.checked = Boolean(value);
  }
}

function focusField(id) {
  const node = field(id);
  if (!node) return;
  node.scrollIntoView({ block: "center" });
  node.focus();
}

function syncWinnerSelects() {
  const winners = state.giveaway?.winners || [];
  const activeWinners = winners.filter((winner) => !winner.rerolled_at);
  setOptions("rerollSelect", activeWinners);
  setOptions("claimSelect", activeWinners.filter((winner) => !winner.claimed_at));
  setOptions("deliverSelect", activeWinners.filter((winner) => !winner.delivered_at));
}

function setOptions(id, winners) {
  const node = field(id);
  if (!node) return;
  const selected = giveawayValue(id, node.value);
  node.replaceChildren(...winners.map((winner) => option(winner.login, winner.display_name)));
  if (winners.some((winner) => winner.login === selected)) {
    node.value = selected;
  }
}

function suggestedDrawCount() {
  const summary = state.giveaway?.summary || {};
  const remaining = Math.max(Number(summary.winnerCount || 1) - Number(summary.winnersDrawn || 0), 1);
  return Math.min(remaining, Math.max(Number(summary.entryCount || remaining), 1));
}

function updateDisabledState() {
  const summary = state.giveaway?.summary || {};
  const status = summary.status || "none";
  const winners = state.giveaway?.winners || [];
  const activeWinners = winners.filter((winner) => !winner.rerolled_at);
  const undelivered = activeWinners.filter((winner) => !winner.delivered_at);
  const config = state.config || {};
  const runtime = state.status?.runtime || {};
  const botProcess = runtime.botProcess || {};
  const connectReady = config.hasClientId && config.hasClientSecret && Boolean(config.redirectUri) && Boolean(config.botLogin);
  const validationReady = missingConfigFields(config).length === 0;
  const guideValidationReady = validationReady && Boolean(config.hasAccessToken);
  const botRunning = Boolean(botProcess.running);
  const botStartReady = canStartBot(runtime);
  const hasGiveaway = status !== "none";
  const hasRecap = Boolean(state.giveaway?.recap?.available);
  const failedCritical = criticalGiveawayFailures().length > 0;
  const canSendGiveawayStatus = hasGiveaway && state.validSetup;
  const canPanicResend = failedCritical && state.validSetup;

  setDisabled("gstart", status !== "none", "Start is disabled because a giveaway already exists.");
  setDisabled("glastcall", status !== "open", "Last call is disabled unless entries are open.");
  setDisabled("gclose", status !== "open", "Close is disabled unless entries are open.");
  setDisabled("gdraw", status !== "closed", "Draw is disabled until entries are closed.");
  setDisabled("gend", status === "none", "End is disabled because no giveaway exists.");
  setDisabled("greroll", activeWinners.length === 0, "Reroll is disabled until winners exist.");
  setDisabled("gclaim", activeWinners.filter((winner) => !winner.claimed_at).length === 0, "Claim is disabled until an unclaimed winner exists.");
  setDisabled("gdeliver", undelivered.length === 0, "Deliver is disabled until an undelivered winner exists.");
  setDisabled("gdeliverAll", undelivered.length === 0, "Mark all delivered is disabled until undelivered winners exist.");
  setDisabled("copyWinners", activeWinners.length === 0, "Copy winners is disabled until winners exist.");
  setDisabled("dashboardSendGiveawayStatus", !canSendGiveawayStatus, hasGiveaway ? "Automatic validation must pass before sending status to chat." : "No giveaway exists.");
  setDisabled("liveSendGiveawayStatus", !canSendGiveawayStatus, hasGiveaway ? "Automatic validation must pass before sending status to chat." : "No giveaway exists.");
  setDisabled("dashboardPanicResendCritical", !canPanicResend, failedCritical ? "Automatic validation must pass before panic resend." : "No failed critical giveaway message exists.");
  setDisabled("livePanicResendCritical", !canPanicResend, failedCritical ? "Automatic validation must pass before panic resend." : "No failed critical giveaway message exists.");
  setDisabled("panicCardResendCritical", !canPanicResend, failedCritical ? "Automatic validation must pass before panic resend." : "No failed critical giveaway message exists.");
  setDisabled("dashboardCopyRecap", !hasRecap, "No giveaway recap exists.");
  setDisabled("liveCopyRecap", !hasRecap, "No giveaway recap exists.");
  setDisabled("postStreamCopyRecap", !hasRecap, "No giveaway recap exists.");
  setDisabled("sendReminderNow", status !== "open", "Reminder is disabled unless entries are open.");
  setDisabled("validate", !validationReady, "Save Twitch credentials and connect OAuth before rerunning validation.");
  setDisabled("guideValidate", !guideValidationReady, "Connect Twitch before rerunning validation.");
  setDisabled("disconnectTwitch", !config.hasAccessToken, "No Twitch connection to disconnect.");
  setDisabled("guideDisconnectTwitch", !config.hasAccessToken, "No Twitch connection to disconnect.");
  setDisabled("test", !state.validSetup, "Automatic validation must pass before sending a setup test message.");
  setDisabled("guideTest", !state.validSetup, "Automatic validation must pass before sending a setup test message.");
  setDisabled("sendChat", !state.validSetup, "Automatic validation must pass before sending chat.");
  setDisabled("ping", !state.validSetup, "Automatic validation must pass before sending chat.");
  for (const template of state.operatorMessages || []) {
    setDisabled(`operator-send-${template.id}`, !state.validSetup, "Automatic validation must pass before sending operator messages.");
  }
  setDisabled("botStart", !botStartReady || botRunning, botRunning ? "Bot is already running." : "Complete setup and let automatic validation finish before starting the bot.");
  setDisabled("guideBotStart", !botStartReady || botRunning, botRunning ? "Bot is already running." : "Complete setup and let automatic validation finish before starting the bot.");
  setDisabled("botStop", !botRunning, "Bot is not running.");
  setDisabled("guideBotStop", !botRunning, "Bot is not running.");

  const connectLinks = [...document.querySelectorAll('a[data-action="connect-twitch"]')];
  for (const link of connectLinks) {
    if (!connectReady) link.classList.add("disabled");
  }
}

function setDisabled(id, disabled, title) {
  const node = field(id);
  if (!node) return;
  node.disabled = Boolean(disabled) || [...state.busy].length > 0;
  node.title = disabled ? title : "";
}

function summarizeMetadata(raw) {
  try {
    return Object.entries(JSON.parse(raw)).slice(0, 4).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ");
  } catch {
    return raw || "";
  }
}

function noteUserInteraction() {
  lastUserInteractionAt = Date.now();
}

function isEditingFormField() {
  return ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
}

function isUserInteracting() {
  return isEditingFormField() || Date.now() - lastUserInteractionAt < interactionQuietMs;
}

function renderWhenIdle() {
  if (!isUserInteracting()) {
    render();
    return;
  }

  if (deferredRenderTimer) {
    clearTimeout(deferredRenderTimer);
  }
  deferredRenderTimer = setTimeout(renderWhenIdle, renderIdleDelayMs);
}

for (const eventName of ["input", "keydown", "pointerdown", "touchstart", "wheel"]) {
  document.addEventListener(eventName, noteUserInteraction, { capture: true, passive: true });
}
document.addEventListener("scroll", noteUserInteraction, { capture: true, passive: true });
document.addEventListener("focusout", () => {
  if (deferredRenderTimer) {
    renderWhenIdle();
  }
}, { capture: true });

refreshAll();
setInterval(() => {
  if (state.busy.size === 0) {
    void refreshAll({ background: true });
  }
}, backgroundRefreshMs);
