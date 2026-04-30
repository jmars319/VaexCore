const tabs = [
  ["dashboard", "Dashboard"],
  ["live-mode", "Live Mode"],
  ["giveaways", "Giveaways"],
  ["chat-tools", "Chat Tools"],
  ["testing", "Testing"],
  ["settings", "Settings"],
  ["audit-log", "Audit Log"]
];

const state = {
  activeTab: "dashboard",
  config: null,
  status: null,
  giveaway: null,
  templates: [],
  operatorMessages: [],
  reminder: null,
  preflightResult: null,
  auditLogs: [],
  outboundMessages: [],
  outboundSummary: { total: 0, queued: 0, failed: 0, criticalFailed: 0, sent: 0 },
  validSetup: false,
  busy: new Set(),
  entrantFilter: "",
  winnerFilter: "all",
  message: { text: "", tone: "muted" },
  testResult: null,
  validationChecks: [],
  testMessageSent: false,
  settingsDraft: {},
  giveawayDraft: {},
  templateDraft: {},
  operatorTemplateDraft: {},
  reminderDraft: {},
  oauthNotice: readOAuthNotice()
};

const defaultRedirectUri = "http://localhost:3434/auth/twitch/callback";
const savedCredentialMask = "saved and masked";

function readOAuthNotice() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");

  if (error) {
    if (error === "wrong_bot_account") {
      const connected = params.get("connected_login") || "the current Twitch account";
      const expected = params.get("expected_login") || "the configured Bot Login";
      return { tone: "bad", text: `Twitch authorized ${connected}, but Bot Login is ${expected}. Log into Twitch as ${expected}, then click Connect Twitch again.` };
    }

    return { tone: "bad", text: `Twitch authorization failed: ${error}` };
  }

  if (params.get("connected") === "1") {
    return { tone: "ok", text: "Twitch authorization completed. Run Validate Setup next." };
  }

  return undefined;
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

function render() {
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
}

function renderHeader() {
  const runtime = state.status?.runtime;
  const giveaway = state.status?.giveaway;
  return h("header", { className: "topbar" }, [
    h("div", {}, [
      h("h1", { text: "VaexCore" }),
      h("p", { className: "subtitle", text: "Local Twitch operations console" })
    ]),
    h("div", { className: "header-status" }, [
      statusPill("Mode", runtime?.mode || "loading"),
      statusPill("Connection", runtime?.tokenValid ? "configured" : "not ready", runtime?.tokenValid),
      statusPill("Chat", runtime?.liveChatConfirmed ? "confirmed" : "pending", runtime?.liveChatConfirmed),
      statusPill("Giveaway", giveaway?.status || "loading", giveaway?.status !== "open")
    ])
  ]);
}

function renderSidebar() {
  return h("nav", { className: "sidebar", "aria-label": "Console sections" },
    tabs.map(([id, label]) => actionButton(label, {
      className: `nav-button${state.activeTab === id ? " active" : ""}`,
      onClick: () => {
        state.activeTab = id;
        render();
      }
    }))
  );
}

function renderTab(id) {
  const body = {
    dashboard: renderDashboard,
    "live-mode": renderLiveMode,
    giveaways: renderGiveaways,
    "chat-tools": renderChatTools,
    testing: renderTesting,
    settings: renderSettings,
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
  const setupReady = isTwitchSetupReady();
  return [
    sectionHeader("Dashboard", "High-level readiness for local operation and live stream use.",
      actionButton("Refresh", { id: "refresh", onClick: refreshAll, busyKey: "refresh" })
    ),
    card("Twitch Setup", [
      callout(setupReady ? "Twitch connection ready" : "Setup incomplete - open Settings -> Setup Guide", setupReady ? "ok" : "warn"),
      setupReady ? null : actionButton("Open Setup Guide", {
        variant: "secondary",
        onClick: () => {
          state.activeTab = "settings";
          render();
          document.getElementById("setupGuide")?.scrollIntoView({ block: "start" });
        }
      })
    ]),
    renderLiveStateCard({ prefix: "dashboard" }),
    renderLiveRunbookCard({ prefix: "dashboard" }),
    renderBotRuntimeCard(runtime),
    renderPreflightCard(),
    card("Readiness", [
      statusGrid([
        ["Summary", readiness.ready ? "ready" : "not ready", readiness.ready],
        ["Twitch Auth", runtime.tokenValid ? "valid" : "not valid", runtime.tokenValid],
        ["Required Scopes", runtime.requiredScopesPresent ? "present" : "missing", runtime.requiredScopesPresent],
        ["Queue", runtime.queueReady ? "ready" : "not ready", runtime.queueReady],
        ["Bot Login", runtime.botLogin || "missing", Boolean(runtime.botLogin)],
        ["Broadcaster", runtime.broadcasterLogin || "missing", Boolean(runtime.broadcasterLogin)],
        ["Bot Process", runtime.botProcess?.status || "stopped", Boolean(runtime.botProcess?.running)],
        ["EventSub", runtime.eventSubConnected ? "connected" : "not connected", runtime.eventSubConnected],
        ["Live Chat", runtime.liveChatConfirmed ? "confirmed" : "pending", runtime.liveChatConfirmed],
        ["Outbound Failures", runtime.outboundChat?.failed || 0, Number(runtime.outboundChat?.failed || 0) === 0]
      ])
    ]),
    card("Blockers", [readiness.blockers.length ? list(readiness.blockers, "bad") : callout("No local console blockers detected.", "ok")]),
    card("Active Giveaway", [statusGrid(giveawayRows(status?.giveaway))]),
    card("Next Recommended Action", [h("p", { className: "info", text: readiness.nextAction })])
  ];
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
    canStart || running ? null : callout("Complete setup and validation before starting the bot.", "warn"),
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

  return card("Preflight Rehearsal", [
    h("p", { text: "Run this before going live to confirm setup, bot runtime, chat listener, and giveaway assurance are in a usable state." }),
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
    ])) : callout("No preflight run in this session.", "muted")
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
      ["Critical Sent", sent.length, failed.length === 0],
      ["Critical Pending", pending.length, failed.length === 0],
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
        : callout(messages.length ? "Giveaway chat messages are tracked from durable outbound history." : "No giveaway chat messages tracked yet.", messages.length ? "ok" : "muted"),
    phaseRows.length ? dataTable(["Phase", "Required", "Status", "Age", "Category", "Reason", "Recovery", "Action"], phaseRows.map((phase) => [
      phase.label,
      phase.required ? "yes" : "tracked",
      statusChip(phase.status),
      phase.age || "",
      failureCategoryChip(phase.failureCategory),
      phase.reason || "",
      phase.recovery || "",
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
      ["Missing Critical", recap.missingCriticalCount || 0, Number(recap.missingCriticalCount || 0) === 0]
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

function renderGiveaways() {
  const giveaway = state.giveaway;
  const summary = giveaway?.summary || state.status?.giveaway || {};
  return [
    sectionHeader("Giveaways", "Operate entries, winner selection, and manual prize delivery from one place."),
    card("", [
      callout("VaexCore does not store or reveal giveaway prizes. Delivery remains manual.", "warn"),
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
    sectionHeader("Chat Tools", "Send operator messages and verify outbound chat without changing giveaway state."),
    renderOperatorMessagesCard(),
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

  return card("Operator Messages", [
    callout("Local presets only. They do not store prize codes and every send uses the normal outbound queue, history, and recovery flow.", "muted"),
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
      actionButton("Save operator messages", { id: "saveOperatorMessages", variant: "secondary", onClick: saveOperatorMessages }),
      actionButton("Reset operator messages", { id: "resetOperatorMessages", variant: "secondary", onClick: resetOperatorMessages })
    ])
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
  return [
    sectionHeader("Settings", "Configure local mode, Twitch OAuth, and safe connection validation.",
      connectButton(config)
    ),
    renderSetupGuide(),
    card("Setup Completion", [
      statusGrid([
        ["Completion", isValidationPassed() ? "complete" : "incomplete", isValidationPassed()],
        ["Client ID", config.hasClientId ? "present" : "missing", config.hasClientId],
        ["Client Secret", config.hasClientSecret ? "present" : "missing", config.hasClientSecret],
        ["OAuth Token", config.hasAccessToken ? "present" : "missing", config.hasAccessToken],
        ["Broadcaster", config.broadcasterLogin || "missing", Boolean(config.broadcasterLogin)],
        ["Bot", config.botLogin || "missing", Boolean(config.botLogin)],
        ["Scopes", (config.scopes || []).join(", ") || "missing", Boolean((config.scopes || []).length)],
        ["Token", config.token || "not connected", Boolean(config.token)]
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
      botLoginReconnectCallout(config),
      h("div", { className: "actions" }, [
        actionButton("Save settings", { id: "save", onClick: saveSettings }),
        connectButton(config, "secondary"),
        config.hasAccessToken ? actionButton("Disconnect Twitch", { id: "disconnectTwitch", variant: "secondary", onClick: disconnectTwitch }) : null,
        actionButton("Validate setup", { id: "validate", variant: "secondary", onClick: validateSetup })
      ]),
      h("ul", { id: "checks" }, state.validationChecks.map((check) =>
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
          h("p", { text: "You need to create a Twitch application so VaexCore can connect to your account." }),
          h("a", {
            className: "button secondary",
            href: "https://dev.twitch.tv/console/apps",
            target: "_blank",
            rel: "noreferrer",
            text: "Open Twitch Developer Console"
          }),
          h("ul", {}, [
            h("li", { text: "Click Register Your Application." }),
            h("li", { text: "Name: anything, for example VaexCore." }),
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
          h("p", { text: "Click Connect Twitch while logged into the Bot Login account to authorize VaexCore." }),
          h("div", { className: "actions" }, [
            connectButton(config, "secondary", !canConnect),
            config.hasAccessToken ? actionButton("Disconnect Twitch", { id: "guideDisconnectTwitch", variant: "secondary", busyKey: "disconnectTwitch", onClick: disconnectTwitch }) : null
          ]),
          statusGrid([
            ["Connected", config.hasAccessToken ? "yes" : "no", config.hasAccessToken],
            ["Bot account detected", config.hasBotUserId ? config.botLogin || "yes" : "not yet", config.hasBotUserId],
            ["user:read:chat", hasScope("user:read:chat") ? "granted" : "missing", hasScope("user:read:chat")],
            ["user:write:chat", hasScope("user:write:chat") ? "granted" : "missing", hasScope("user:write:chat")]
          ]),
          botLoginReconnectCallout(config),
          state.oauthNotice ? callout(state.oauthNotice.text, state.oauthNotice.tone) : null,
          canConnect ? null : callout("Enter credentials and usernames before connecting Twitch.", "warn")
        ]
      }),
      setupStep({
        id: "validate",
        number: 5,
        title: "Validate Setup",
        active: activeStep === "validate",
        complete: progress.validationPassed,
        disabled: !canValidate,
        children: [
          h("p", { text: "Verify that everything is configured correctly." }),
          h("div", { className: "actions" }, [
            actionButton("Validate Setup", { id: "guideValidate", variant: "secondary", onClick: validateSetup })
          ]),
          renderValidationSummary(),
          canValidate ? null : callout("Connect Twitch before running validation.", "warn")
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
          canTest ? null : callout("Validate setup before sending a test message.", "warn")
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
          h("p", {}, ["CLI after using the macOS app setup: ", h("code", { text: "npm run dev:app-config" })]),
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

  if (state.validationChecks.length) {
    return h("ul", {}, state.validationChecks.map((check) =>
      h("li", { className: check.ok ? "ok" : "bad", text: `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}` })
    ));
  }

  return statusGrid([
    ["Token valid", state.status?.runtime?.tokenValid ? "yes" : "not validated", state.status?.runtime?.tokenValid],
    ["Scopes correct", hasRequiredScopes() ? "yes" : "not validated", hasRequiredScopes()],
    ["Bot identity resolved", config.hasBotUserId ? "yes" : "not validated", config.hasBotUserId],
    ["Broadcaster identity resolved", config.hasBroadcasterUserId ? "yes" : "not validated", config.hasBroadcasterUserId]
  ]);
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
  const disabled = forceDisabled || missingConfigFields(config).some((item) => ["Client ID", "Client Secret", "Redirect URI"].includes(item));
  const link = h("a", { className: `button ${variant}${disabled ? " disabled" : ""}`, href: disabled ? "#" : "/auth/twitch/start", text: "Connect Twitch" });
  if (disabled) {
    link.title = "Save Client ID, Client Secret, and Redirect URI first.";
  }
  return link;
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

function getReadiness() {
  const runtime = state.status?.runtime || {};
  const config = state.config || {};
  const blockers = [];

  if (!isTwitchSetupReady()) blockers.push("Open Settings -> Setup Guide");
  if (!runtime.tokenValid || !runtime.requiredScopesPresent) blockers.push("Run Validate Setup");
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
  const steps = [];

  if (!isTwitchSetupReady()) {
    steps.push({
      id: "setup-guide",
      label: "Complete setup",
      detail: "Setup is incomplete. Open Settings -> Setup Guide.",
      tone: "bad",
      actionLabel: "Open Setup Guide",
      onClick: openSetupGuide
    });
    return steps;
  }

  if (!runtime.tokenValid || !runtime.requiredScopesPresent) {
    steps.push({
      id: "validate",
      label: "Validate Twitch",
      detail: "Run Validate Setup so chat sends and recovery actions are allowed.",
      tone: "bad",
      actionLabel: "Validate setup",
      onClick: validateSetup
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
      { id: "validate", label: "Validation passed", complete: progress.validationPassed },
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
    state.validSetup ||
    (
      config.hasAccessToken &&
      config.hasBotUserId &&
      config.hasBroadcasterUserId &&
      runtime.tokenValid &&
      runtime.requiredScopesPresent &&
      hasRequiredScopes()
    )
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

  return callout(`Bot Login is ${config.botLogin}, but the connected OAuth token has not validated for that account. Disconnect Twitch if needed, log into ${config.botLogin}, click Connect Twitch, then run Validate Setup.`, "warn");
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

function statusChip(status) {
  const tone = ["sent", "resent"].includes(status) ? "ok" : status === "failed" ? "bad" : "warn";
  return h("span", { className: `chip ${tone}`, text: status || "unknown" });
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
  const failed = Number(state.outboundSummary?.failed ?? outboundFailures.length);
  const tone = criticalFailed > 0 || botErrors.length > 0
    ? "bad"
    : pendingDelivery > 0 || failed > 0
      ? "warn"
      : "ok";
  const nextAction = criticalFailed > 0
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

async function refreshAll() {
  await runAction("refresh", async () => {
    const [config, status, giveaway, templates, operatorMessages, reminder, audit, outbound] = await Promise.all([
      api.config(),
      api.status(),
      api.giveaway(),
      api.templates(),
      api.operatorMessages(),
      api.reminder(),
      api.auditLogs(),
      api.outboundMessages()
    ]);
    state.config = config;
    state.status = status;
    state.giveaway = giveaway;
    state.templates = templates.templates || [];
    state.operatorMessages = operatorMessages.templates || [];
    state.reminder = reminder.reminder || {};
    state.auditLogs = audit.logs || [];
    state.outboundMessages = outbound.messages || [];
    state.outboundSummary = outbound.summary || {};
    state.validSetup = isValidationPassed();
    return { ok: true };
  }, { quiet: true });
}

async function refreshAfterAction() {
  const [status, giveaway, operatorMessages, reminder, audit, outbound] = await Promise.all([api.status(), api.giveaway(), api.operatorMessages(), api.reminder(), api.auditLogs(), api.outboundMessages()]);
  state.status = status;
  state.giveaway = giveaway;
  state.operatorMessages = operatorMessages.templates || [];
  state.reminder = reminder.reminder || {};
  state.auditLogs = audit.logs || [];
  state.outboundMessages = outbound.messages || [];
  state.outboundSummary = outbound.summary || {};
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

async function runAction(key, fn, options = {}) {
  state.busy.add(key);
  if (!options.quiet) state.message = { text: "Working...", tone: "muted" };
  render();

  try {
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
    render();
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
  if (shouldWarnBeforeGiveawayAction(name) && !confirm(`${state.giveaway.assurance.nextAction} Continue anyway?`)) {
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
      text: "Twitch connection cleared. Log into the Bot Login account, then click Connect Twitch."
    };
    return result;
  }, { skipRefresh: true, success: "Twitch connection cleared." });
  await refreshAll();
}

function updateSettingsDraft(event) {
  state.settingsDraft[event.target.id] = event.target.value;
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
  await runAction("botStart", () => api.botStart(), { success: "Bot process starting." });
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

function openSetupGuide() {
  state.activeTab = "settings";
  render();
  document.getElementById("setupGuide")?.scrollIntoView({ block: "start" });
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

function incidentNoteText() {
  const runtime = state.status?.runtime || {};
  const process = runtime.botProcess || {};
  const summary = state.giveaway?.summary || state.status?.giveaway || {};
  const recovery = runtime.outboundRecovery || {};
  const health = runtime.queueHealth || {};
  const runbook = liveRunbookSteps();

  return [
    `VaexCore incident note - ${new Date().toISOString()}`,
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

function fallbackCommandMessage(result) {
  if (result.routerResult === "denied") return "Command denied by permission checks.";
  if (result.routerResult === "unknown") return "Unknown command ignored.";
  return result.ok ? "Command ran with no chat reply." : result.error || "Command failed.";
}

function syncFormValues() {
  const config = state.config || {};
  const summary = state.giveaway?.summary || {};
  setValue("mode", settingsValue("mode", config.mode || "live"));
  setValue("redirectUri", settingsValue("redirectUri", config.redirectUri || defaultRedirectUri));
  setValue("clientId", settingsValue("clientId", config.hasClientId ? savedCredentialMask : ""));
  setValue("clientSecret", settingsValue("clientSecret", config.hasClientSecret ? savedCredentialMask : ""));
  setValue("broadcasterLogin", settingsValue("broadcasterLogin", config.broadcasterLogin || ""));
  setValue("botLogin", settingsValue("botLogin", config.botLogin || ""));
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
  const connectReady = config.hasClientId && config.hasClientSecret && Boolean(config.redirectUri);
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
  setDisabled("dashboardSendGiveawayStatus", !canSendGiveawayStatus, hasGiveaway ? "Validate setup before sending status to chat." : "No giveaway exists.");
  setDisabled("liveSendGiveawayStatus", !canSendGiveawayStatus, hasGiveaway ? "Validate setup before sending status to chat." : "No giveaway exists.");
  setDisabled("dashboardPanicResendCritical", !canPanicResend, failedCritical ? "Validate setup before panic resend." : "No failed critical giveaway message exists.");
  setDisabled("livePanicResendCritical", !canPanicResend, failedCritical ? "Validate setup before panic resend." : "No failed critical giveaway message exists.");
  setDisabled("panicCardResendCritical", !canPanicResend, failedCritical ? "Validate setup before panic resend." : "No failed critical giveaway message exists.");
  setDisabled("dashboardCopyRecap", !hasRecap, "No giveaway recap exists.");
  setDisabled("liveCopyRecap", !hasRecap, "No giveaway recap exists.");
  setDisabled("postStreamCopyRecap", !hasRecap, "No giveaway recap exists.");
  setDisabled("sendReminderNow", status !== "open", "Reminder is disabled unless entries are open.");
  setDisabled("validate", !validationReady, "Save Twitch credentials and connect OAuth before validating.");
  setDisabled("guideValidate", !guideValidationReady, "Connect Twitch before validating.");
  setDisabled("disconnectTwitch", !config.hasAccessToken, "No Twitch connection to disconnect.");
  setDisabled("guideDisconnectTwitch", !config.hasAccessToken, "No Twitch connection to disconnect.");
  setDisabled("test", !state.validSetup, "Validate setup before sending a setup test message.");
  setDisabled("guideTest", !state.validSetup, "Validate setup before sending a setup test message.");
  setDisabled("sendChat", !state.validSetup, "Validate setup before sending chat.");
  setDisabled("ping", !state.validSetup, "Validate setup before sending chat.");
  for (const template of state.operatorMessages || []) {
    setDisabled(`operator-send-${template.id}`, !state.validSetup, "Validate setup before sending operator messages.");
  }
  setDisabled("botStart", !botStartReady || botRunning, botRunning ? "Bot is already running." : "Complete setup and validation before starting the bot.");
  setDisabled("guideBotStart", !botStartReady || botRunning, botRunning ? "Bot is already running." : "Complete setup and validation before starting the bot.");
  setDisabled("botStop", !botRunning, "Bot is not running.");
  setDisabled("guideBotStop", !botRunning, "Bot is not running.");

  const connectLinks = [...document.querySelectorAll("a.button")].filter((link) => link.textContent === "Connect Twitch");
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

function isEditingFormField() {
  return ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
}

refreshAll();
setInterval(() => {
  if (state.busy.size === 0 && !isEditingFormField()) {
    void refreshAll();
  }
}, 5000);
