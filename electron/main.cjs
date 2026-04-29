const { app, BrowserWindow, shell } = require("electron");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

let mainWindow;
let setupServer;
let quitting = false;

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
  const userData = app.getPath("userData");
  process.env.VAEXCORE_CONFIG_DIR = userData;
  process.env.DATABASE_URL = `file:${join(userData, "data/vaexcore.sqlite")}`;

  const moduleUrl = pathToFileURL(join(app.getAppPath(), "dist-bundle/setup-server.js")).href;
  const setup = await import(moduleUrl);
  setupServer = await setup.startSetupServer({ port: 3434 });
  await createWindow(setupServer.url);
};

app.whenReady().then(() => {
  void startApp();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && setupServer) {
    void createWindow(setupServer.url);
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
