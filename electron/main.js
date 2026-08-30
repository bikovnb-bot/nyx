import { app, Tray, Menu, nativeImage, BrowserWindow, ipcMain, Notification, shell, dialog, clipboard, safeStorage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect as netConnect } from "node:net";
import http from "node:http";
import { parseVlessLink } from "../src/parseLink.js";
import { buildSingBoxConfig, CLASH_API_ADDRESS } from "../src/configBuilder.js";
import { runSingBox, getSingBoxVersion } from "../src/singbox.js";
import { createProfileStore } from "../src/profileStore.js";
import { crescentMoonPng } from "../src/makeIcon.js";
import { isElevatedWindows, relaunchElevatedWindows } from "../src/elevate.js";
import { initLogger, log, getLogFile } from "../src/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.setName("Nyx");
initLogger(app.getPath("userData"));
log("app start, execPath=", process.execPath, "argv=", JSON.stringify(process.argv), "isPackaged=", app.isPackaged);

process.on("uncaughtException", (err) => {
  log("UNCAUGHT EXCEPTION:", err.stack || err.message);
});
process.on("unhandledRejection", (err) => {
  log("UNHANDLED REJECTION:", err?.stack || String(err));
});

// Requested before the elevation dance below so a second launch, while an
// instance (elevated or still-relaunching) already holds the lock, exits
// immediately here — without ever prompting UAC again. The lock is tied to
// the process; when the unelevated launcher below calls app.exit(0) it
// releases the lock, and the elevated child it just spawned picks it back
// up moments later once its own process starts.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  log("another instance already holds the lock, quitting");
  app.exit(0);
}

const startedElevated = isElevatedWindows();

if (!startedElevated) {
  log("not elevated, relaunching...");
  const relaunchArgs = app.isPackaged ? [] : process.argv.slice(1);
  const result = relaunchElevatedWindows(process.execPath, relaunchArgs);
  log(
    "relaunch result:",
    JSON.stringify({ status: result.status, error: result.error?.message, stderr: result.stderr?.toString() })
  );
  // app.quit() is graceful and only takes effect once the app finishes
  // starting up; by the time spawnSync above returns (UAC can take
  // seconds), Electron's own "ready" event has often already fired,
  // so whenReady().then() below would still run in this same,
  // about-to-die process and create a second, half-dead tray icon.
  // app.exit() tears the process down immediately instead — which also
  // releases the single-instance lock acquired above.
  app.exit(0);
}

let tray = null;
let mainWindow = null;
let child = null;
let activeProfileId = null;
let connecting = false;
let connectedAt = null;
let trafficReq = null;
let trafficHistory = [];
let trafficTotals = { up: 0, down: 0 };

const ICON_DISCONNECTED = nativeImage.createFromBuffer(
  crescentMoonPng(32, [140, 142, 158, 255], { stars: false })
);
const ICON_CONNECTED = nativeImage.createFromBuffer(
  crescentMoonPng(32, [167, 139, 250, 255], {
    dot: { offset: 10, radius: 5, color: [34, 197, 94, 255] },
  })
);
const APP_ICON = nativeImage.createFromBuffer(crescentMoonPng(256, [167, 139, 250, 255]));

function userDataDir() {
  return app.getPath("userData");
}

// Profiles embed a vless:// link, whose UUID is effectively a credential —
// encrypt them at rest via the OS keychain (DPAPI on Windows) when available,
// falling back to plaintext only on systems where safeStorage has nothing to
// back it with (e.g. a headless Linux box with no keyring).
const profileCodec = {
  encode: (str) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(str) : Buffer.from(str, "utf8")),
  decode: (buf) => {
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(buf);
      } catch {
        // Fall through: the file may predate encryption being available.
      }
    }
    return buf.toString("utf8");
  },
};

function profileStore() {
  return createProfileStore(userDataDir(), profileCodec);
}

function resetTraffic() {
  if (trafficReq) {
    trafficReq.destroy();
    trafficReq = null;
  }
  trafficHistory = [];
  trafficTotals = { up: 0, down: 0 };
}

function startTrafficPolling(profileId, attempt = 0) {
  const req = http.get(`http://${CLASH_API_ADDRESS}/traffic`, (res) => {
    let buffer = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line || activeProfileId !== profileId) continue;
        try {
          const { up = 0, down = 0 } = JSON.parse(line);
          trafficTotals = { up: trafficTotals.up + up, down: trafficTotals.down + down };
          trafficHistory.push({ up, down });
          if (trafficHistory.length > 60) trafficHistory.shift();
          mainWindow?.webContents.send("traffic", { up, down, history: trafficHistory, totals: trafficTotals });
        } catch {}
      }
    });
    res.on("error", () => {});
  });
  req.on("error", () => {
    // The Clash API server can take a moment to come up after sing-box starts.
    if (activeProfileId === profileId && attempt < 10) {
      setTimeout(() => startTrafficPolling(profileId, attempt + 1), 500);
    }
  });
  trafficReq = req;
}

function disconnect() {
  if (child) {
    child.kill();
    child = null;
  }
  resetTraffic();
  activeProfileId = null;
  connecting = false;
  connectedAt = null;
  broadcastState();
}

function connect(profile) {
  disconnect();

  let parsed;
  try {
    parsed = parseVlessLink(profile.link);
  } catch (err) {
    notify("Плохая ссылка профиля", err.message);
    return;
  }

  if (parsed.allowInsecure) {
    notify("Небезопасное соединение", `Профиль "${profile.name}" отключает проверку TLS-сертификата.`);
  }

  const config = buildSingBoxConfig(parsed);
  const dir = mkdtempSync(path.join(tmpdir(), "vlessvpn-"));
  const configPath = path.join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  log("connecting to", profile.name, profile.link, "config:", configPath);

  child = runSingBox(configPath, {
    onLog: (line) => {
      log("[sing-box]", line.trim());
      if (/FATAL/i.test(line)) {
        notify("Ошибка подключения", line.trim().slice(0, 200));
      }
    },
    onError: (err) => {
      log("sing-box spawn error:", err.stack || err.message);
      notify("Не удалось запустить sing-box", err.message);
      if (activeProfileId === profile.id) {
        activeProfileId = null;
        connecting = false;
        broadcastState();
      }
    },
  });

  child.on("exit", (code) => {
    log("sing-box exited, code=", code);
    if (activeProfileId === profile.id) {
      resetTraffic();
      activeProfileId = null;
      connecting = false;
      broadcastState();
      if (code !== 0) notify("Отключено", `sing-box завершился с кодом ${code}`);
    }
  });

  activeProfileId = profile.id;
  connecting = true;
  connectedAt = null;
  broadcastState();
  notify("Подключение", profile.name);
  startTrafficPolling(profile.id);

  setTimeout(() => {
    if (activeProfileId === profile.id) {
      connecting = false;
      connectedAt = Date.now();
      broadcastState();
    }
  }, 2000);
}

function pingProfile(profile) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = parseVlessLink(profile.link);
    } catch {
      resolve({ ok: false });
      return;
    }
    const started = Date.now();
    const socket = netConnect({ host: parsed.host, port: parsed.port, timeout: 4000 });
    const finish = (ok) => {
      socket.destroy();
      resolve(ok ? { ok: true, ms: Date.now() - started } : { ok: false });
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function notify(title, body) {
  log("NOTIFY:", title, "-", body);
  new Notification({ title, body }).show();
}

function getState() {
  return {
    profiles: profileStore().load(),
    activeProfileId,
    connecting,
    connectedAt,
    autoStart: isAutoStartEnabled(),
  };
}

function broadcastState() {
  updateTrayIcon();
  mainWindow?.webContents.send("state", getState());
}

function openMainWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 380,
    height: 640,
    resizable: false,
    backgroundColor: "#14151b",
    title: "Nyx",
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "main-window.html"));
  mainWindow.on("close", (e) => {
    e.preventDefault();
    mainWindow.hide();
  });
}

ipcMain.handle("get-state", () => getState());

ipcMain.handle("add-profile", (_evt, { name, link }) => {
  profileStore().add({ name: name || link, link });
  broadcastState();
});

ipcMain.handle("remove-profile", (_evt, id) => {
  if (activeProfileId === id) disconnect();
  profileStore().remove(id);
  broadcastState();
});

ipcMain.handle("edit-profile", (_evt, { id, name, link }) => {
  profileStore().update(id, { name, link });
  broadcastState();
});

ipcMain.handle("connect-profile", (_evt, id) => {
  const profile = profileStore().load().find((p) => p.id === id);
  if (profile) connect(profile);
});

ipcMain.handle("disconnect", () => disconnect());

ipcMain.handle("ping-profile", (_evt, id) => {
  const profile = profileStore().load().find((p) => p.id === id);
  if (!profile) return { ok: false };
  return pingProfile(profile);
});

ipcMain.handle("copy-link", (_evt, id) => {
  const profile = profileStore().load().find((p) => p.id === id);
  if (profile) clipboard.writeText(profile.link);
});

ipcMain.handle("export-profiles", async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "Экспорт профилей",
    defaultPath: "vlessvpn-profiles.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (canceled || !filePath) return { ok: false };
  writeFileSync(filePath, JSON.stringify(profileStore().load(), null, 2));
  return { ok: true, filePath };
});

ipcMain.handle("import-profiles", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Импорт профилей",
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths[0]) return { ok: false };
  try {
    const imported = JSON.parse(readFileSync(filePaths[0], "utf8"));
    if (!Array.isArray(imported)) throw new Error("Ожидался список профилей");
    let count = 0;
    for (const p of imported) {
      if (p && typeof p.link === "string" && p.link.startsWith("vless://")) {
        profileStore().add({ name: p.name || p.link, link: p.link });
        count++;
      }
    }
    broadcastState();
    return { ok: true, count };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("set-autostart", (_evt, enabled) => {
  setAutoStartEnabled(enabled);
  broadcastState();
});

ipcMain.handle("open-log", () => shell.showItemInFolder(getLogFile()));

ipcMain.handle("quit", () => app.quit());

ipcMain.handle("get-app-info", () => ({
  name: "Nyx",
  version: app.getVersion(),
  author: "Balamut",
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  singboxVersion: getSingBoxVersion(),
}));

function buildTrayMenu() {
  const profiles = profileStore().load();

  const profileItems = profiles.map((p) => ({
    label: p.id === activeProfileId ? `● ${p.name}` : p.name,
    type: "radio",
    checked: p.id === activeProfileId,
    click: () => connect(p),
  }));

  return Menu.buildFromTemplate([
    { label: "Открыть", click: openMainWindow },
    { type: "separator" },
    { label: activeProfileId ? "Подключено" : "Отключено", enabled: false },
    { type: "separator" },
    ...(profileItems.length ? profileItems : [{ label: "Нет профилей", enabled: false }]),
    { type: "separator" },
    { label: "Отключить", enabled: !!activeProfileId, click: disconnect },
    { label: "Выход", click: () => app.quit() },
  ]);
}

function autoStartSettings() {
  return {
    path: process.execPath,
    args: app.isPackaged ? [] : [path.join(__dirname, "..")],
  };
}

function isAutoStartEnabled() {
  return app.getLoginItemSettings(autoStartSettings()).openAtLogin;
}

function setAutoStartEnabled(enabled) {
  app.setLoginItemSettings({ ...autoStartSettings(), openAtLogin: enabled });
}

function updateTrayIcon() {
  if (!tray) return;
  tray.setImage(activeProfileId ? ICON_CONNECTED : ICON_DISCONNECTED);
  tray.setToolTip(activeProfileId ? "Nyx: подключено" : "Nyx: отключено");
  tray.setContextMenu(buildTrayMenu());
}

app.whenReady().then(() => {
  if (!startedElevated) {
    log("app became ready in the pre-relaunch process; ignoring (exit already requested)");
    return;
  }
  log("app ready, tray starting");
  try {
    tray = new Tray(ICON_DISCONNECTED);
    tray.on("click", openMainWindow);
    updateTrayIcon();
    log("tray created ok");
  } catch (err) {
    log("TRAY CREATE FAILED:", err.stack || err.message);
  }
});

app.on("window-all-closed", (e) => e.preventDefault());
app.on("before-quit", () => disconnect());
app.on("second-instance", () => openMainWindow());
