const tabs = [
  ["dashboard", "Dashboard"],
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
  auditLogs: [],
  validSetup: false,
  busy: new Set(),
  entrantFilter: "",
  winnerFilter: "all",
  message: { text: "", tone: "muted" },
  testResult: null,
  validationChecks: []
};

const api = {
  get: (url) => request(url),
  post: (url, body = {}) => request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }),
  config: () => api.get("/api/config"),
  saveConfig: (body) => api.post("/api/config", body),
  validate: () => api.post("/api/validate"),
  testSend: () => api.post("/api/test-send"),
  status: () => api.get("/api/status"),
  giveaway: () => api.get("/api/giveaway"),
  auditLogs: () => api.get("/api/audit-logs"),
  chatSend: (message) => api.post("/api/chat/send", { message }),
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
    sectionHeader("Dashboard", "High-level readiness for local operation and live stream use.",
      actionButton("Refresh", { id: "refresh", onClick: refreshAll, busyKey: "refresh" })
    ),
    card("Readiness", [
      statusGrid([
        ["Summary", readiness.ready ? "ready" : "not ready", readiness.ready],
        ["Twitch Auth", runtime.tokenValid ? "valid" : "not valid", runtime.tokenValid],
        ["Required Scopes", runtime.requiredScopesPresent ? "present" : "missing", runtime.requiredScopesPresent],
        ["Queue", runtime.queueReady ? "ready" : "not ready", runtime.queueReady],
        ["Bot Login", runtime.botLogin || "missing", Boolean(runtime.botLogin)],
        ["Broadcaster", runtime.broadcasterLogin || "missing", Boolean(runtime.broadcasterLogin)],
        ["EventSub", runtime.eventSubConnected ? "connected" : "bot terminal", runtime.eventSubConnected],
        ["Live Chat", runtime.liveChatConfirmed ? "confirmed" : "pending", runtime.liveChatConfirmed]
      ])
    ]),
    card("Blockers", [readiness.blockers.length ? list(readiness.blockers, "bad") : callout("No local console blockers detected.", "ok")]),
    card("Active Giveaway", [statusGrid(giveawayRows(status?.giveaway))]),
    card("Next Recommended Action", [h("p", { className: "info", text: readiness.nextAction })])
  ];
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
    card("Start Giveaway", [
      h("div", { className: "grid three" }, [
        formRow("Title", h("input", { id: "giveawayTitle" })),
        formRow("Keyword", h("input", { id: "giveawayKeyword" })),
        formRow("Number of winners", h("input", { id: "winnerCount", type: "number", min: "1" }))
      ]),
      h("div", { className: "actions" }, [
        actionButton("Start giveaway", { id: "gstart", onClick: startGiveaway }),
        actionButton("Close entries", { id: "gclose", variant: "secondary", onClick: () => runGiveawayAction("close") })
      ])
    ]),
    card("Winner Operations", [
      h("div", { className: "grid three" }, [
        formRow("Draw count", h("input", { id: "drawCount", type: "number", min: "1" })),
        formRow("Reroll winner", h("select", { id: "rerollSelect" })),
        formRow("Claim winner", h("select", { id: "claimSelect" })),
        formRow("Deliver winner", h("select", { id: "deliverSelect" }))
      ]),
      h("div", { className: "actions" }, [
        actionButton("Draw winners", { id: "gdraw", variant: "secondary", onClick: () => runGiveawayAction("draw", { count: Number(field("drawCount").value || 1) }, "Draw winners now?") }),
        actionButton("Reroll", { id: "greroll", variant: "secondary", onClick: () => runGiveawayAction("reroll", { username: field("rerollSelect").value }, "Reroll this winner?") }),
        actionButton("Mark claimed", { id: "gclaim", variant: "secondary", onClick: () => runGiveawayAction("claim", { username: field("claimSelect").value }) }),
        actionButton("Mark delivered", { id: "gdeliver", variant: "secondary", onClick: () => runGiveawayAction("deliver", { username: field("deliverSelect").value }) })
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
    message()
  ];
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
    card("Setup Completion", [
      statusGrid([
        ["Completion", required.length === 0 && config.hasAccessToken ? "complete" : "incomplete", required.length === 0 && config.hasAccessToken],
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
        formRow("Mode", h("select", { id: "mode" }, [option("live", "live"), option("local", "local")])),
        formRow("Redirect URI", h("input", { id: "redirectUri" })),
        formRow("Client ID", h("input", { id: "clientId", autocomplete: "off", placeholder: config.hasClientId ? "saved and masked" : "" })),
        formRow("Client Secret", h("input", { id: "clientSecret", type: "password", autocomplete: "off", placeholder: config.hasClientSecret ? "saved and masked" : "" })),
        formRow("Broadcaster Login", h("input", { id: "broadcasterLogin", placeholder: "channel login" })),
        formRow("Bot Login", h("input", { id: "botLogin", placeholder: "bot account login" }))
      ]),
      h("div", { className: "actions" }, [
        actionButton("Save settings", { id: "save", onClick: saveSettings }),
        connectButton(config, "secondary"),
        actionButton("Validate setup", { id: "validate", variant: "secondary", onClick: validateSetup })
      ]),
      h("ul", { id: "checks" }, state.validationChecks.map((check) =>
        h("li", { className: check.ok ? "ok" : "bad", text: `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}` })
      ))
    ]),
    card("Runtime Commands", [
      h("p", { text: "This console does not start or stop the separate live bot process. Use the packaged app for this console, and use CLI commands when you want terminal runtime control." }),
      h("p", {}, [h("code", { text: "npm run check:env" }), " ", h("code", { text: "npm run build" }), " ", h("code", { text: "npm run dev" })])
    ]),
    message()
  ];
}

function renderAuditLog() {
  return [
    sectionHeader("Audit Log", "Latest 100 local audit entries.",
      actionButton("Refresh audit log", { id: "refreshAudit", onClick: refreshAuditLogs })
    ),
    card("", [dataTable(["Timestamp", "Actor", "Action", "Target", "Metadata"], state.auditLogs.map((log) => [
      log.created_at,
      log.actor_twitch_user_id,
      log.action,
      log.target || "",
      summarizeMetadata(log.metadata_json)
    ]))])
  ];
}

function connectButton(config, variant = "secondary") {
  const disabled = missingConfigFields(config).some((item) => ["Client ID", "Client Secret", "Redirect URI"].includes(item));
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

  if (missingConfigFields(config).length) blockers.push("Connect Twitch in Settings");
  if (!runtime.tokenValid || !runtime.requiredScopesPresent) blockers.push("Run Validate Setup");
  if (!runtime.queueReady) blockers.push("Start the setup console again if queue readiness does not recover");
  if (!runtime.eventSubConnected || !runtime.chatSubscriptionActive) blockers.push("Start bot process");
  if (!runtime.liveChatConfirmed) blockers.push("Type !ping in chat");

  const giveawayReady = runtime.tokenValid && runtime.requiredScopesPresent && runtime.queueReady;
  const nextAction = blockers[0] || (state.status?.giveaway?.status === "none"
    ? "Giveaway controls ready"
    : nextGiveawayAction(state.status.giveaway));

  return {
    ready: blockers.length === 0 || giveawayReady,
    blockers,
    nextAction
  };
}

function nextGiveawayAction(summary = {}) {
  if (summary.status === "open") return "Close entries before drawing winners";
  if (summary.status === "closed" && Number(summary.winnersDrawn || 0) === 0) return "Draw winners";
  if (Number(summary.undeliveredWinnersCount || 0) > 0) return "Complete manual prize delivery";
  return "End the giveaway when operator work is complete";
}

function giveawayChecklist() {
  const summary = state.giveaway?.summary || {};
  const status = summary.status || "none";
  const winners = state.giveaway?.winners || [];
  const activeWinners = winners.filter((winner) => !winner.rerolled_at);
  return [
    status === "none" ? "Start is available because no giveaway exists." : "Start is disabled because a giveaway already exists.",
    status === "open" ? "Close is available while entries are open." : "Close is disabled unless entries are open.",
    status === "closed" ? "Draw is available because entries are closed." : "Draw is disabled until the giveaway is closed.",
    status !== "none" ? "End is available after confirmation." : "End is disabled because no giveaway exists.",
    activeWinners.length ? "Claim, deliver, and reroll controls have eligible winners." : "Claim, deliver, and reroll are disabled until winners exist."
  ];
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

function filterWinners(winners) {
  if (state.winnerFilter === "pending") return winners.filter((winner) => !winner.rerolled_at && !winner.delivered_at);
  if (state.winnerFilter === "delivered") return winners.filter((winner) => winner.delivered_at);
  if (state.winnerFilter === "rerolled") return winners.filter((winner) => winner.rerolled_at);
  return winners;
}

function winnerStatus(winner) {
  const chips = ["drawn"];
  if (winner.claimed_at) chips.push("claimed");
  if (winner.delivered_at) chips.push("delivered");
  if (winner.rerolled_at) chips.push("rerolled");
  return h("span", {}, chips.map((chip) => h("span", { className: `chip ${chip === "rerolled" ? "warn" : "ok"}`, text: chip })));
}

async function refreshAll() {
  await runAction("refresh", async () => {
    const [config, status, giveaway, audit] = await Promise.all([
      api.config(),
      api.status(),
      api.giveaway(),
      api.auditLogs()
    ]);
    state.config = config;
    state.status = status;
    state.giveaway = giveaway;
    state.auditLogs = audit.logs || [];
    return { ok: true };
  }, { quiet: true });
}

async function refreshAfterAction() {
  const [status, giveaway, audit] = await Promise.all([api.status(), api.giveaway(), api.auditLogs()]);
  state.status = status;
  state.giveaway = giveaway;
  state.auditLogs = audit.logs || [];
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
  if (confirmation && !confirm(confirmation)) {
    return;
  }
  await runAction(`g${name}`, () => api.giveawayAction(name, body), { success: "Giveaway state updated." });
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
  await runAction("save", async () => {
    const result = await api.saveConfig({
      mode: field("mode").value,
      redirectUri: field("redirectUri").value,
      clientId: field("clientId").value,
      clientSecret: field("clientSecret").value,
      broadcasterLogin: field("broadcasterLogin").value,
      botLogin: field("botLogin").value
    });
    state.config = result.config;
    return result;
  }, { success: "Settings saved." });
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
  await runAction("test", () => api.testSend(), { success: "Test message sent." });
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
  setValue("mode", config.mode || "live");
  setValue("redirectUri", config.redirectUri || "http://localhost:3434/auth/twitch/callback");
  setValue("broadcasterLogin", config.broadcasterLogin || "");
  setValue("botLogin", config.botLogin || "");
  setValue("giveawayTitle", field("giveawayTitle")?.value || state.giveaway?.summary?.title || "Community Giveaway");
  setValue("giveawayKeyword", field("giveawayKeyword")?.value || state.giveaway?.summary?.keyword || "enter");
  setValue("winnerCount", field("winnerCount")?.value || state.giveaway?.summary?.winnerCount || 3);
  setValue("drawCount", field("drawCount")?.value || suggestedDrawCount());
  setValue("simActor", field("simActor")?.value || "viewer");
  setValue("simRole", field("simRole")?.value || "viewer");
  setValue("simCommand", field("simCommand")?.value || "!gstatus");
  setValue("entrantFilter", state.entrantFilter);
  setValue("winnerFilter", state.winnerFilter);
  syncWinnerSelects();
}

function setValue(id, value) {
  const node = field(id);
  if (node && document.activeElement !== node) {
    node.value = value;
  }
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
  node.replaceChildren(...winners.map((winner) => option(winner.login, winner.display_name)));
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
  const connectReady = config.hasClientId && config.hasClientSecret && Boolean(config.redirectUri);
  const validationReady = missingConfigFields(config).length === 0;

  setDisabled("gstart", status !== "none", "Start is disabled because a giveaway already exists.");
  setDisabled("gclose", status !== "open", "Close is disabled unless entries are open.");
  setDisabled("gdraw", status !== "closed", "Draw is disabled until entries are closed.");
  setDisabled("gend", status === "none", "End is disabled because no giveaway exists.");
  setDisabled("greroll", activeWinners.length === 0, "Reroll is disabled until winners exist.");
  setDisabled("gclaim", activeWinners.filter((winner) => !winner.claimed_at).length === 0, "Claim is disabled until an unclaimed winner exists.");
  setDisabled("gdeliver", undelivered.length === 0, "Deliver is disabled until an undelivered winner exists.");
  setDisabled("validate", !validationReady, "Save Twitch credentials and connect OAuth before validating.");
  setDisabled("test", !state.validSetup, "Validate setup before sending a setup test message.");
  setDisabled("sendChat", !state.validSetup, "Validate setup before sending chat.");
  setDisabled("ping", !state.validSetup, "Validate setup before sending chat.");

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

refreshAll();
setInterval(() => {
  if (state.busy.size === 0) {
    void refreshAll();
  }
}, 5000);
