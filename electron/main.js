import { app, Tray, Menu, nativeImage, BrowserWindow, ipcMain, Notification, shell, dialog, clipboard } from "electron";
// electron-updater is CJS and only exposes autoUpdater via a lazy getter on
// its default export — `import { autoUpdater }` fails to resolve under
// Node's ESM/CJS interop and crashes the whole process before any code runs.
import electronUpdaterPkg from "electron-updater";
const { autoUpdater } = electronUpdaterPkg;
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect as netConnect } from "node:net";
import http from "node:http";
import { parseVlessLink } from "../src/parseLink.js";
import { buildSingBoxConfig, CLASH_API_ADDRESS } from "../src/configBuilder.js";
import { runSingBox, getSingBoxVersion, findSingBoxBinary } from "../src/singbox.js";
import { createProfileStore } from "../src/profileStore.js";
import { createSettingsStore } from "../src/settingsStore.js";
import { crescentMoonPng } from "../src/makeIcon.js";
import { isElevatedWindows, relaunchElevatedWindows } from "../src/elevate.js";
import { ensureRegistered as ensureElevationTaskRegistered, runViaTask } from "../src/scheduledTask.js";
import { initLogger, log, getLogFile, getLogTail } from "../src/logger.js";
import * as killswitch from "../src/killswitch.js";
import { verifySingBoxBinary } from "../src/singboxIntegrity.js";
import { redactVlessLink } from "../src/redact.js";

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
  // A packaged app can relaunch itself elevated via a pre-registered
  // Scheduled Task (see scheduledTask.js) with no UAC prompt at all — only
  // fall back to the classic Start-Process -Verb RunAs dance (which always
  // prompts) if that task doesn't exist yet or fails to start. Skipped in
  // dev, where the task would launch a bare Electron.exe without the app
  // path argument.
  const launchedViaTask = app.isPackaged && runViaTask(log);
  if (launchedViaTask) {
    log("relaunched via scheduled task, no UAC prompt needed");
  } else {
    const relaunchArgs = app.isPackaged ? [] : process.argv.slice(1);
    const result = relaunchElevatedWindows(process.execPath, relaunchArgs);
    log(
      "relaunch result:",
      JSON.stringify({ status: result.status, error: result.error?.message, stderr: result.stderr?.toString() })
    );
  }
  // app.quit() is graceful and only takes effect once the app finishes
  // starting up; by the time the relaunch above returns (UAC can take
  // seconds), Electron's own "ready" event has often already fired,
  // so whenReady().then() below would still run in this same,
  // about-to-die process and create a second, half-dead tray icon.
  // app.exit() tears the process down immediately instead — which also
  // releases the single-instance lock acquired above.
  app.exit(0);
}

// We're elevated now (whether via the task above, a fresh UAC prompt, or
// because the OS session itself is elevated). Make sure the task exists so
// every later launch can skip the UAC prompt entirely.
if (app.isPackaged) {
  ensureElevationTaskRegistered(process.execPath, log);
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

function profileStore() {
  return createProfileStore(userDataDir(), undefined, (...args) => log("[profileStore]", ...args));
}

function settingsStore() {
  return createSettingsStore(userDataDir(), (...args) => log("[settingsStore]", ...args));
}

let killSwitchActive = false;
let userInitiatedDisconnect = false;
let isQuitting = false;
const TUN_INTERFACE_NAME = "vlessvpn0";

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
  userInitiatedDisconnect = true;
  if (child) {
    child.kill();
    child = null;
  }
  resetTraffic();
  activeProfileId = null;
  connecting = false;
  connectedAt = null;
  if (killSwitchActive) {
    killswitch.restore(userDataDir(), log);
    killSwitchActive = false;
    notify("Kill switch", "Сеть восстановлена.");
  }
  broadcastState();
}

function connect(profile) {
  disconnect();
  userInitiatedDisconnect = false;

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

  const singboxBinary = findSingBoxBinary();
  const integrity = verifySingBoxBinary(userDataDir(), singboxBinary, app.getVersion(), log);
  if (!integrity.ok) {
    if (integrity.reason === "missing") {
      notify("sing-box не найден", "Бинарник sing-box отсутствует, подключение невозможно.");
    } else {
      notify(
        "Проверка целостности не пройдена",
        "Файл sing-box.exe изменился с прошлого запуска этой версии Nyx. Подключение остановлено в целях безопасности."
      );
    }
    return;
  }

  const settings = settingsStore().load();
  const config = buildSingBoxConfig(parsed, { interfaceName: TUN_INTERFACE_NAME, splitTunneling: settings.splitTunneling });
  const dir = mkdtempSync(path.join(tmpdir(), "vlessvpn-"));
  const configPath = path.join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  log("connecting to", profile.name, redactVlessLink(profile.link), "config:", configPath);

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
      const unexpected = !userInitiatedDisconnect && code !== 0;
      resetTraffic();
      activeProfileId = null;
      connecting = false;
      broadcastState();
      if (unexpected) {
        notify("Отключено", `sing-box завершился с кодом ${code}`);
        if (settingsStore().load().killSwitchEnabled) {
          log("[killswitch] engaging after unexpected sing-box exit");
          killswitch.engage(userDataDir(), TUN_INTERFACE_NAME, log);
          killSwitchActive = true;
          notify(
            "Kill switch активирован",
            "Соединение оборвалось неожиданно — сеть заблокирована, чтобы избежать утечки трафика. Отключите kill switch или переподключитесь в настройках."
          );
        }
      }
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

let updateState = { status: "idle" };

function setUpdateState(next) {
  updateState = next;
  mainWindow?.webContents.send("update-status", updateState);
}

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.logger = {
  info: (...args) => log("[updater]", ...args),
  warn: (...args) => log("[updater] WARN:", ...args),
  error: (...args) => log("[updater] ERROR:", ...args),
};

autoUpdater.on("checking-for-update", () => setUpdateState({ status: "checking" }));
autoUpdater.on("update-available", (info) => {
  setUpdateState({ status: "available", version: info.version });
  notify("Доступно обновление", `Nyx ${info.version} загружается в фоне`);
});
autoUpdater.on("update-not-available", () => setUpdateState({ status: "not-available" }));
autoUpdater.on("download-progress", (progress) => {
  setUpdateState({ status: "downloading", percent: Math.round(progress.percent) });
});
autoUpdater.on("update-downloaded", (info) => {
  setUpdateState({ status: "downloaded", version: info.version });
  notify("Обновление готово", `Nyx ${info.version} установится при перезапуске`);
});
autoUpdater.on("error", (err) => {
  setUpdateState({ status: "error", message: err.message });
  log("[updater] error:", err.stack || err.message);
});

function checkForUpdates() {
  if (!app.isPackaged) {
    setUpdateState({ status: "not-available" });
    return;
  }
  autoUpdater.checkForUpdates().catch((err) => {
    setUpdateState({ status: "error", message: err.message });
  });
}

function getState() {
  let profiles;
  try {
    profiles = profileStore().load();
  } catch (err) {
    log("getState: profileStore().load() THREW:", err.stack || err.message);
    profiles = [];
  }
  log("getState: userDataDir=", userDataDir(), "profiles.length=", profiles.length);
  return {
    profiles,
    activeProfileId,
    connecting,
    connectedAt,
    autoStart: isAutoStartEnabled(),
    settings: settingsStore().load(),
    killSwitchActive,
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
    width: 430,
    height: 660,
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
    if (isQuitting) return;
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

ipcMain.handle("get-settings", () => settingsStore().load());

ipcMain.handle("update-settings", (_evt, partial) => {
  const next = settingsStore().update(partial);
  // Kill switch being turned off should immediately lift any active block.
  if (!next.killSwitchEnabled && killSwitchActive) {
    killswitch.restore(userDataDir(), log);
    killSwitchActive = false;
  }
  broadcastState();
  return next;
});

ipcMain.handle("export-backup", async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "Экспорт резервной копии",
    defaultPath: "nyx-backup.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (canceled || !filePath) return { ok: false };
  const backup = { profiles: profileStore().load(), settings: settingsStore().load() };
  writeFileSync(filePath, JSON.stringify(backup, null, 2));
  return { ok: true, filePath };
});

ipcMain.handle("import-backup", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Импорт резервной копии",
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths[0]) return { ok: false };
  try {
    const data = JSON.parse(readFileSync(filePaths[0], "utf8"));
    let count = 0;
    if (Array.isArray(data.profiles)) {
      for (const p of data.profiles) {
        if (p && typeof p.link === "string" && p.link.startsWith("vless://")) {
          profileStore().add({ name: p.name || p.link, link: p.link });
          count++;
        }
      }
    }
    if (data.settings && typeof data.settings === "object") {
      settingsStore().update(data.settings);
    }
    broadcastState();
    return { ok: true, count };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("get-log-tail", () => getLogTail());

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

ipcMain.handle("get-update-status", () => updateState);

ipcMain.handle("check-for-updates", () => {
  checkForUpdates();
});

ipcMain.handle("install-update", () => {
  autoUpdater.quitAndInstall();
});

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
  if (killswitch.isEngaged(userDataDir())) {
    log("[killswitch] stale engaged state found at startup, restoring network");
    killswitch.restore(userDataDir(), log);
  }
  try {
    tray = new Tray(ICON_DISCONNECTED);
    tray.on("click", openMainWindow);
    updateTrayIcon();
    log("tray created ok");
    setTimeout(checkForUpdates, 5000);
  } catch (err) {
    log("TRAY CREATE FAILED:", err.stack || err.message);
  }
});

app.on("window-all-closed", (e) => e.preventDefault());
app.on("before-quit", () => {
  isQuitting = true;
  disconnect();
});
app.on("second-instance", () => openMainWindow());
