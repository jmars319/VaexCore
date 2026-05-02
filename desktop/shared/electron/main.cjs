const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const { existsSync } = require("node:fs");
const { get } = require("node:http");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

let mainWindow;
let settingsWindow;
let setupServer;
let activeSetupUrl;
let quitting = false;
const setupPort = 3434;
const setupUrl = `http://localhost:${setupPort}`;
const setupProbeUrl = `http://127.0.0.1:${setupPort}/api/config`;
const productName = "vaexcore console";
const legacyProductName = "VaexCore";
const isMac = process.platform === "darwin";

app.setName(productName);

const buildApplicationMenu = () => {
  const template = [
    {
      label: isMac ? productName : "File",
      submenu: [
        ...(isMac ? [{ role: "about" }, { type: "separator" }] : []),
        {
          label: "Configuration Settings...",
          accelerator: "CommandOrControl+,",
          click: () => {
            void createSettingsWindow();
          }
        },
        { type: "separator" },
        {
          label: "Close Window (App Keeps Running)",
          accelerator: "CommandOrControl+W",
          click: () => closeMainWindow()
        },
        {
          label: "Quit App (Stops Local Server)",
          accelerator: "CommandOrControl+Q",
          click: () => app.quit()
        }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

const closeMainWindow = () => {
  const window = BrowserWindow.getFocusedWindow() || mainWindow;
  if (window && !window.isDestroyed()) {
    window.close();
  }
};

const createSettingsWindow = async (fragment = "") => {
  if (!activeSetupUrl) {
    return;
  }

  const settingsUrl = `${activeSetupUrl}/?window=settings${fragment}`;
  const icon = resolveWindowIconPath();

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    if (fragment) {
      await settingsWindow.loadURL(settingsUrl);
    }
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 760,
    minHeight: 620,
    title: `${productName} Configuration Settings`,
    backgroundColor: "#090b12",
    ...(icon ? { icon } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  settingsWindow.on("closed", () => {
    settingsWindow = undefined;
  });

  configureWindowOpenHandler(settingsWindow);
  await settingsWindow.loadURL(settingsUrl);
};

const createWindow = async (url) => {
  const icon = resolveWindowIconPath();

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    title: productName,
    backgroundColor: "#0d1117",
    ...(icon ? { icon } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  configureWindowOpenHandler(mainWindow);

  await mainWindow.loadURL(url);
};

const configureWindowOpenHandler = (window) => {
  window.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl.startsWith("https://id.twitch.tv/")) {
      void shell.openExternal(targetUrl);
      return { action: "deny" };
    }

    if (isSettingsUrl(targetUrl)) {
      const parsed = new URL(targetUrl);
      void createSettingsWindow(parsed.hash);
      return { action: "deny" };
    }

    return { action: "allow" };
  });
};

const isSettingsUrl = (targetUrl) => {
  try {
    const parsed = new URL(targetUrl);
    return parsed.origin === setupUrl && parsed.searchParams.get("window") === "settings";
  } catch {
    return false;
  }
};

const startApp = async () => {
  const userData = resolveUserDataPath();
  app.setPath("userData", userData);
  process.env.VAEXCORE_CONFIG_DIR = userData;
  process.env.DATABASE_URL = `file:${join(userData, "data/vaexcore.sqlite")}`;

  const moduleUrl = pathToFileURL(join(app.getAppPath(), "dist-bundle/setup-server.js")).href;
  const setup = await import(moduleUrl);
  try {
    setupServer = await setup.startSetupServer({ port: setupPort });
    activeSetupUrl = setupServer.url;
  } catch (error) {
    if (isAddressInUse(error) && await isConsoleServerRunning()) {
      activeSetupUrl = setupUrl;
    } else {
      showStartupError(error);
      app.quit();
      return;
    }
  }

  await createWindow(activeSetupUrl);
};

const isAddressInUse = (error) => error?.code === "EADDRINUSE";

const resolveUserDataPath = () => {
  if (process.env.VAEXCORE_APP_USER_DATA) {
    return process.env.VAEXCORE_APP_USER_DATA;
  }

  const legacyUserData = join(app.getPath("appData"), legacyProductName);
  return existsSync(legacyUserData) ? legacyUserData : app.getPath("userData");
};

const resolveWindowIconPath = () => {
  const appPath = app.getAppPath();
  const candidates = process.platform === "win32"
    ? ["desktop/windows/assets/icon.ico", "desktop/shared/assets/logo.jpg"]
    : process.platform === "darwin"
      ? ["desktop/macOS/assets/icon.icns", "desktop/shared/assets/logo.jpg"]
      : ["desktop/shared/assets/logo.jpg"];

  return candidates
    .map((candidate) => join(appPath, candidate))
    .find((candidate) => existsSync(candidate));
};

const isConsoleServerRunning = async () => {
  try {
    const config = await getJson(setupProbeUrl);
    return (
      config &&
      typeof config === "object" &&
      config.redirectUri === `${setupUrl}/auth/twitch/callback` &&
      Array.isArray(config.requiredScopes)
    );
  } catch {
    return false;
  }
};

const getJson = (url) => new Promise((resolve, reject) => {
  const request = get(url, { timeout: 1500 }, (response) => {
    let raw = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      raw += chunk;
    });
    response.on("end", () => {
      if (response.statusCode !== 200) {
        reject(new Error(`Unexpected status ${response.statusCode}`));
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
  });

  request.on("timeout", () => {
    request.destroy(new Error("Timed out probing setup server."));
  });
  request.on("error", reject);
});

const showStartupError = (error) => {
  const message = isAddressInUse(error)
    ? `Port ${setupPort} is already in use and did not respond as vaexcore console. Quit the other app or process using localhost:${setupPort}, then open vaexcore console again.\n\n${portRecoveryHint()}`
    : error?.message || "vaexcore console could not start.";

  dialog.showErrorBox("vaexcore console startup failed", message);
};

const portRecoveryHint = () => {
  if (process.platform === "win32") {
    return `For recovery, run: netstat -ano | findstr :${setupPort}`;
  }

  return `For recovery, run: lsof -nP -iTCP:${setupPort} -sTCP:LISTEN`;
};

app.whenReady().then(() => {
  buildApplicationMenu();
  void startApp().catch((error) => {
    showStartupError(error);
    app.quit();
  });
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && activeSetupUrl) {
    void createWindow(activeSetupUrl);
  }
});

app.on("before-quit", (event) => {
  if (quitting || !setupServer) {
    return;
  }

  event.preventDefault();
  quitting = true;
  const server = setupServer;
  setupServer = undefined;
  void server.stop().finally(() => app.quit());
});
