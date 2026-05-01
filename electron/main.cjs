const { app, BrowserWindow, dialog, shell } = require("electron");
const { get } = require("node:http");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

let mainWindow;
let setupServer;
let activeSetupUrl;
let quitting = false;
const setupPort = 3434;
const setupUrl = `http://localhost:${setupPort}`;
const setupProbeUrl = `http://127.0.0.1:${setupPort}/api/config`;

app.setName("VaexCore");

const createWindow = async (url) => {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    title: "VaexCore",
    backgroundColor: "#0d1117",
    icon: join(app.getAppPath(), "assets/icon.icns"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl.startsWith("https://id.twitch.tv/")) {
      void shell.openExternal(targetUrl);
      return { action: "deny" };
    }

    return { action: "allow" };
  });

  await mainWindow.loadURL(url);
};

const startApp = async () => {
  const userData = process.env.VAEXCORE_APP_USER_DATA || app.getPath("userData");
  if (process.env.VAEXCORE_APP_USER_DATA) {
    app.setPath("userData", userData);
  }
  process.env.VAEXCORE_CONFIG_DIR = userData;
  process.env.DATABASE_URL = `file:${join(userData, "data/vaexcore.sqlite")}`;

  const moduleUrl = pathToFileURL(join(app.getAppPath(), "dist-bundle/setup-server.js")).href;
  const setup = await import(moduleUrl);
  try {
    setupServer = await setup.startSetupServer({ port: setupPort });
    activeSetupUrl = setupServer.url;
  } catch (error) {
    if (isAddressInUse(error) && await isVaexCoreServerRunning()) {
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

const isVaexCoreServerRunning = async () => {
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
    ? `Port ${setupPort} is already in use and did not respond as VaexCore. Quit the other app or process using localhost:${setupPort}, then open VaexCore again.\n\nFor recovery, run: lsof -nP -iTCP:${setupPort} -sTCP:LISTEN`
    : error?.message || "VaexCore could not start.";

  dialog.showErrorBox("VaexCore startup failed", message);
};

app.whenReady().then(() => {
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
