import { app, Tray, Menu, nativeImage, nativeTheme, BrowserWindow, ipcMain, Notification, shell, dialog, clipboard, net, screen } from "electron";
// electron-updater is CJS and only exposes autoUpdater via a lazy getter on
// its default export — `import { autoUpdater }` fails to resolve under
// Node's ESM/CJS interop and crashes the whole process before any code runs.
import electronUpdaterPkg from "electron-updater";
const { autoUpdater } = electronUpdaterPkg;
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect as netConnect, isIP } from "node:net";
import http from "node:http";
import { parseVlessLink } from "../src/parseLink.js";
import { buildSingBoxConfig, CLASH_API_ADDRESS } from "../src/configBuilder.js";
import { runSingBox, getSingBoxVersionAsync, findSingBoxBinary, findRulesDir } from "../src/singbox.js";
import { createProfileStore } from "../src/profileStore.js";
import { createSettingsStore } from "../src/settingsStore.js";
import { isElevatedWindows, relaunchElevatedWindows } from "../src/elevate.js";
import { ensureRegistered as ensureElevationTaskRegistered, runViaTask } from "../src/scheduledTask.js";
import { initLogger, log, getLogFile, getLogTail } from "../src/logger.js";
import * as killswitch from "../src/killswitch.js";
import { verifyBinary } from "../src/singboxIntegrity.js";
import { findXrayBinary, runXray, freeLoopbackPort, randomSocksAuth, waitForPort, XRAY_BINARY_NAME } from "../src/xray.js";
import { buildXrayConfig, chooseCore } from "../src/xrayConfig.js";
import { redactVlessLink } from "../src/redact.js";
import { getDefaultInterfaceName } from "../src/networkInterface.js";
import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { GEO_URL, parseGeoCountry, profileCountryWithGeo, createGeoResolver } from "../src/geoCountry.js";
import { createTrafficStats } from "../src/trafficStats.js";
import { parseSubscription, planSubscriptionSync, linkKey } from "../src/subscription.js";
import { createSubscriptionStore } from "../src/subscriptionStore.js";
import { pickBest, buildReconnectPlan, sortWithFavorites } from "../src/selection.js";
import { qrSvg } from "../src/qr.js";
import { explainSingBoxLine, createIssueThrottle } from "../src/errorHints.js";
import { IP_INFO_URL, parseIpInfo, leakVerdict, describeDns } from "../src/leakCheck.js";
import { refreshRules, pickRulesDir } from "../src/rulesUpdate.js";
import { runSpeedtest } from "../src/speedtest.js";
import { summarizeUpdaterError, createRetryPolicy } from "../src/updaterErrors.js";
import { parseProfileTitle, parseUserinfo, formatUsage, buildGroups } from "../src/subscriptionGroups.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!app.isPackaged) {
  app.setName("Nyx-Dev");
  app.setPath("userData", process.env.NYX_USER_DATA || path.join(app.getPath("appData"), "Nyx-Dev"));
} else {
  app.setName("Nyx");
}
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

// Autostart at Windows login launches "Nyx.exe --hidden" so the app sits in
// the tray quietly; a manual launch (shortcut, installer) opens the window.
// The elevated relaunch below goes through a Scheduled Task that can't carry
// arguments, so the unelevated launcher leaves a short-lived marker file for
// the elevated instance instead.
const HIDDEN_MARKER = path.join(app.getPath("userData"), "start-hidden.marker");

function consumeHiddenMarker() {
  try {
    const age = Date.now() - Number(readFileSync(HIDDEN_MARKER, "utf8"));
    unlinkSync(HIDDEN_MARKER);
    return age >= 0 && age < 60000;
  } catch {
    return false;
  }
}

const startedElevated = isElevatedWindows() || !app.isPackaged;

if (!startedElevated) {
  log("not elevated, relaunching...");
  if (process.argv.includes("--hidden")) {
    try {
      writeFileSync(HIDDEN_MARKER, String(Date.now()));
    } catch {}
  }
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

const startHidden = startedElevated && (process.argv.includes("--hidden") || consumeHiddenMarker());

// We're elevated now (whether via the task above, a fresh UAC prompt, or
// because the OS session itself is elevated). Make sure the task exists so
// every later launch can skip the UAC prompt entirely.
if (app.isPackaged) {
  ensureElevationTaskRegistered(process.execPath, log);
}

let tray = null;
let mainWindow = null;
let child = null;
// The Xray core, when it carries the connection and sing-box only keeps the tunnel.
let xrayChild = null;
let xrayTail = [];
let activeProfileId = null;
let connecting = false;
// The latest explained problem with the proxy connection, shown as a banner.
let connectionIssue = null;
let connectStartedAt = 0;
const issueThrottle = createIssueThrottle();
const issueTimes = new Map();
// The IP seen while the VPN was off, for the leak check to compare against.
let knownRealIp = null;
let connectedAt = null;
let trafficReq = null;
let trafficHistory = [];
let trafficTotals = { up: 0, down: 0 };

const asset = (name) => nativeImage.createFromPath(path.join(__dirname, "assets", name));
const ICON_DISCONNECTED = asset("tray-disconnected.png");
const ICON_CONNECTED = asset("tray-connected.png");
const APP_ICON = asset("app-icon-256.png");

function userDataDir() {
  return app.getPath("userData");
}

let profileStoreInstance = null;
function profileStore() {
  profileStoreInstance ??= createProfileStore(userDataDir(), undefined, (...args) => log("[profileStore]", ...args));
  return profileStoreInstance;
}

let subscriptionStoreInstance = null;
function subscriptionStore() {
  subscriptionStoreInstance ??= createSubscriptionStore(userDataDir(), { logger: (...args) => log("[subscriptions]", ...args) });
  return subscriptionStoreInstance;
}

const trafficStats = createTrafficStats(app.getPath("userData"), { logger: (...args) => log("[stats]", ...args) });

function settingsStore() {
  return createSettingsStore(userDataDir(), (...args) => log("[settingsStore]", ...args));
}

// Country for profiles whose name does not say where the server is: looked up
// once from the server's IP address and remembered (see src/geoCountry.js).
const GEO_CACHE_FILE = path.join(app.getPath("userData"), "geo-cache.json");
function loadGeoCache() {
  try {
    const raw = JSON.parse(readFileSync(GEO_CACHE_FILE, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}
const geoCache = loadGeoCache();
const geoResolver = createGeoResolver({
  cache: geoCache,
  save: (cache) => {
    try {
      writeFileSync(GEO_CACHE_FILE, JSON.stringify(cache), "utf8");
    } catch (err) {
      log("[geo] cannot save cache:", err.message);
    }
  },
  resolveHost: async (host) => (await dnsLookup(host, { family: 4 })).address,
  fetchCountry: async (ip) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await net.fetch(GEO_URL(ip), { signal: controller.signal, headers: { "User-Agent": `Nyx/${app.getVersion()}` } });
      if (!res.ok) throw new Error(`geolocation HTTP ${res.status}`);
      return parseGeoCountry(await res.json());
    } finally {
      clearTimeout(timer);
    }
  },
  onChange: () => {
    broadcastState();
    updateTrayIcon();
  },
});
const countryOf = (profile) => profileCountryWithGeo(profile, geoCache);

let killSwitchActive = false;
// The adapters the kill switch disabled are coming back (asynchronously); a new
// connection waits for it, because it needs the network.
let killRestore = null;
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
          trafficStats.add(profileId, up, down);
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

let connectToken = 0;

function disconnect() {
  connectionIssue = null;
  connectToken++;
  userInitiatedDisconnect = true;
  if (child) {
    child.kill();
    child = null;
  }
  stopXray();
  resetTraffic();
  trafficStats.flush();
  activeProfileId = null;
  connecting = false;
  connectedAt = null;
  if (killSwitchActive) {
    killSwitchActive = false;
    // On quit the process may end before an asynchronous restore finishes, so it
    // is synchronous there; a click on "disconnect" does not wait for PowerShell.
    if (isQuitting) {
      killswitch.restore(userDataDir(), log);
      notify("Kill switch", "Сеть восстановлена.");
    } else {
      killRestore = killswitch.restoreAsync(userDataDir(), log).then(() => {
        killRestore = null;
        notify("Kill switch", "Сеть восстановлена.");
      });
    }
  }
  broadcastState();
}

function markConnected(profile) {
  if (activeProfileId !== profile.id || !connecting) return;
  connecting = false;
  connectedAt = Date.now();
  broadcastState();
}

// A proxy error is shown right away while connecting (and for start-up
// failures); later on it takes a few repeats, so one failed site does not look
// like a broken VPN.
function shouldSurfaceIssue(issue) {
  if (/fatal/i.test(issue.raw)) return true;
  const now = Date.now();
  if (now - connectStartedAt < 15000) return true;
  const recent = (issueTimes.get(issue.kind) || []).filter((t) => now - t < 20000);
  recent.push(now);
  issueTimes.set(issue.kind, recent);
  return recent.length >= 3;
}

function handleSingBoxLine(line) {
  const issue = explainSingBoxLine(line);
  if (!issue || !shouldSurfaceIssue(issue) || !issueThrottle(issue.kind)) return;
  connectionIssue = { kind: issue.kind, title: issue.title, hint: issue.hint, at: Date.now() };
  notify(issue.title, issue.hint);
  broadcastState();
}

function stopXray() {
  if (!xrayChild) return;
  const x = xrayChild;
  xrayChild = null;
  x.kill();
}

// Checks a bundled core binary against what this app version recorded, and tells
// the user if it is missing or was changed.
function binaryTrusted(binaryPath, label, fileName) {
  const integrity = verifyBinary(userDataDir(), binaryPath, app.getVersion(), log, label);
  if (integrity.ok) return true;
  if (integrity.reason === "missing") {
    notify(`${fileName} не найден`, `Файл ${fileName} отсутствует, подключение невозможно.`);
  } else {
    notify(
      "Проверка целостности не пройдена",
      `Файл ${fileName} изменился с прошлого запуска этой версии Nyx. Подключение остановлено в целях безопасности.`
    );
  }
  return false;
}

function connect(profile) {
  disconnect();
  userInitiatedDisconnect = false;
  connectStartedAt = Date.now();
  issueTimes.clear();
  const token = connectToken;

  // Show "connecting" right away: the integrity hash and interface lookup below
  // block this process for a moment.
  connecting = true;
  broadcastState();
  const fail = () => {
    connecting = false;
    broadcastState();
    return false;
  };

  let parsed;
  try {
    parsed = parseVlessLink(profile.link);
  } catch (err) {
    notify("Плохая ссылка профиля", err.message);
    return fail();
  }

  if (parsed.allowInsecure) {
    notify("Небезопасное соединение", `Профиль "${profile.name}" отключает проверку TLS-сертификата.`);
  }

  const settings = settingsStore().load();
  const xrayBinary = findXrayBinary();
  const choice = chooseCore(parsed, settings.core, { xrayAvailable: !!xrayBinary });
  if (choice.core === null) {
    notify("Нужно ядро Xray", "Профиль использует XHTTP, а Xray в этой сборке не найден.");
    return fail();
  }
  if (choice.note === "xhttp-needs-xray") notify("Используется Xray", "XHTTP работает только через ядро Xray, выбор sing-box пропущен.");
  if (choice.note === "xray-missing") notify("Xray не найден", "Подключаюсь через sing-box.");
  log("core:", choice.core, "| setting:", settings.core || "auto");

  // sing-box always runs (it keeps the tunnel); Xray only when it carries the connection.
  if (!binaryTrusted(findSingBoxBinary(), "singbox", "sing-box.exe")) return fail();
  if (choice.core === "xray" && !binaryTrusted(xrayBinary, "xray", "xray.exe")) return fail();

  if (choice.core === "xray") {
    activeProfileId = profile.id;
    broadcastState();
    startXrayThenTunnel(profile, parsed, settings, token);
    return true;
  }
  startSingBoxTunnel(profile, parsed, settings, null).catch((err) => {
    log("tunnel start failed:", err.stack || err.message);
    notify("Не удалось запустить подключение", err.message);
    if (token === connectToken) {
      activeProfileId = null;
      connecting = false;
      broadcastState();
    }
  });
  return true;
}

// Xray first (it needs the server's address resolved while the network is still
// untouched), then the tunnel on top of it.
async function startXrayThenTunnel(profile, parsed, settings, token) {
  const abort = (title, text) => {
    if (token !== connectToken) return; // already disconnected or switched to another profile
    stopXray();
    notify(title, text);
    activeProfileId = null;
    connecting = false;
    broadcastState();
  };

  try {
    if (killRestore) await killRestore;
    const host = parsed.host.replace(/^\[|\]$/g, "");
    let serverIp = host;
    if (!isIP(host)) {
      try {
        serverIp = (await dnsLookup(host, { family: 4 })).address;
      } catch (err) {
        log("cannot resolve the server name:", host, err.message);
        return abort("Не удалось найти сервер", `Адрес ${host} не определился: проверьте интернет и имя сервера.`);
      }
    }
    const port = await freeLoopbackPort();
    const auth = randomSocksAuth();
    if (token !== connectToken) return;

    const dir = mkdtempSync(path.join(tmpdir(), "nyxxray-"));
    const configPath = path.join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        buildXrayConfig(parsed, { socksPort: port, socksAuth: auth, serverIp: isIP(host) ? undefined : serverIp, fragment: settings.fragment.enabled })
      )
    );
    log("starting xray for", profile.name, redactVlessLink(profile.link), "socks 127.0.0.1:" + port, "server", serverIp);

    xrayTail = [];
    const thisXray = runXray(configPath, {
      onLog: (text) => {
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          log("[xray]", line);
          xrayTail = [...xrayTail.slice(-4), line];
          // Xray words the Reality failure differently; the hint table knows sing-box's wording.
          handleSingBoxLine(line.replace(/REALITY: received real certificate.*/, "reality verification failed"));
        }
      },
      onError: (err) => log("xray spawn error:", err.stack || err.message),
    });
    xrayChild = thisXray;
    thisXray.on("exit", (code) => {
      log("xray exited, code=", code);
      if (xrayChild !== thisXray) return; // stopped on purpose
      xrayChild = null;
      if (child && activeProfileId === profile.id && !userInitiatedDisconnect) {
        notify("Ядро Xray остановилось", `Код завершения: ${code}`);
        child.kill(); // the tunnel has nothing to carry traffic any more: sing-box's exit handler takes over
      }
    });

    try {
      await waitForPort(port, { isAlive: () => xrayChild === thisXray && thisXray.exitCode === null });
    } catch (err) {
      return abort("Не удалось запустить Xray", err.message === "timeout" ? "Ядро не отвечает." : `Xray завершился при запуске. ${xrayTail.slice(-1)[0] || "Подробности в журнале."}`);
    }
    if (token !== connectToken) return;

    await startSingBoxTunnel(profile, parsed, settings, { port, auth, serverIps: [serverIp], processNames: [XRAY_BINARY_NAME] });
  } catch (err) {
    log("xray start failed:", err.stack || err.message);
    abort("Не удалось запустить Xray", err.message);
  }
}

// `upstream`: null when sing-box connects to the server itself, otherwise the
// local SOCKS port of the core that does (see buildSingBoxConfig).
async function startSingBoxTunnel(profile, parsed, settings, upstream) {
  // The lookup is asynchronous (it used to block the window for ~1.7 s), so the
  // profile is marked first and the user may disconnect or switch while it runs.
  const token = connectToken;
  activeProfileId = profile.id;
  broadcastState();
  if (killRestore) await killRestore;
  const defaultInterfaceName = await getDefaultInterfaceName();
  if (token !== connectToken) return false;
  log("default network interface for split routing:", defaultInterfaceName);
  const config = buildSingBoxConfig(parsed, {
    interfaceName: TUN_INTERFACE_NAME,
    splitTunneling: settings.splitTunneling,
    defaultInterfaceName,
    routing: settings.routing,
    dns: settings.dns,
    fragment: settings.fragment.enabled,
    rulesDir: pickRulesDir(userDataDir(), findRulesDir()),
    upstream: upstream || undefined,
  });
  const dir = mkdtempSync(path.join(tmpdir(), "vlessvpn-"));
  const configPath = path.join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  log(
    "options: TLS fragment", settings.fragment.enabled ? "on" : "off",
    "| RU direct", settings.routing.directRu ? "on" : "off",
    "| ad block", settings.routing.blockAds ? "on" : "off",
    "| DNS", settings.dns.provider
  );
  log("connecting to", profile.name, redactVlessLink(profile.link), "config:", configPath);

  const thisChild = runSingBox(configPath, {
    onLog: (line) => {
      log("[sing-box]", line.trim());
      if (/sing-box started/i.test(line)) markConnected(profile);
      handleSingBoxLine(line);
    },
    onError: (err) => {
      log("sing-box spawn error:", err.stack || err.message);
      notify("Не удалось запустить sing-box", err.message);
      if (activeProfileId === profile.id) {
        activeProfileId = null;
        connecting = false;
        stopXray();
        broadcastState();
      }
    },
  });
  child = thisChild;

  thisChild.on("exit", (code) => {
    log("sing-box exited, code=", code);
    if (child === thisChild) stopXray(); // Xray only exists to serve this tunnel
    if (activeProfileId === profile.id) {
      const unexpected = !userInitiatedDisconnect && code !== 0;
      resetTraffic();
      activeProfileId = null;
      connecting = false;
      broadcastState();
      if (unexpected) {
        notify("Отключено", `sing-box завершился с кодом ${code}`);
        if (!handleUnexpectedDrop(profile)) engageKillSwitchIfEnabled();
      }
    }
  });

  activeProfileId = profile.id;
  connecting = true;
  connectedAt = null;
  settingsStore().update({ lastProfileId: profile.id });
  broadcastState();
  notify("Подключение", profile.name);
  startTrafficPolling(profile.id);

  // Normally "connected" is shown as soon as sing-box reports it started; the
  // timer only covers a log line that never comes.
  setTimeout(() => markConnected(profile), 5000);

  // A tunnel that is still up after a few seconds counts as a real
  // connection; that ends an auto-reconnect sequence.
  setTimeout(() => {
    if (activeProfileId === profile.id && child && reconnect.active) {
      cancelReconnect();
      notify("Соединение восстановлено", profile.name);
    }
  }, 8000);
  return true;
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

async function pingAll(profiles) {
  const entries = await Promise.all(profiles.map(async (p) => [p.id, await pingProfile(p)]));
  return Object.fromEntries(entries);
}

function lastOrFirst(profiles) {
  const id = settingsStore().load().lastProfileId;
  return profiles.find((p) => p.id === id) || profiles[0] || null;
}

/* ---------- connecting: last used / fastest ---------- */

async function connectBest() {
  const profiles = profileStore().load();
  if (!profiles.length) return;
  disconnect();
  const token = connectToken;
  connecting = true;
  broadcastState();
  const pings = await pingAll(profiles);
  if (token !== connectToken) return; // the user disconnected or chose something else meanwhile
  connecting = false;
  const best = pickBest(profiles, pings);
  if (!best) {
    notify("Автовыбор сервера", "Ни один сервер не ответил. Подключаюсь к последнему использованному.");
    const fallback = lastOrFirst(profiles);
    if (fallback) connect(fallback);
    else broadcastState();
    return;
  }
  notify("Автовыбор сервера", `${best.profile.name} — ${best.ms} мс`);
  connect(best.profile);
}

function quickConnect() {
  cancelReconnect();
  const profiles = profileStore().load();
  if (!profiles.length) return;
  if (settingsStore().load().autoBest.enabled) connectBest();
  else connect(lastOrFirst(profiles));
}

/* ---------- kill switch + auto-reconnect after an unexpected drop ---------- */

function engageKillSwitchIfEnabled() {
  if (!settingsStore().load().killSwitchEnabled) return;
  log("[killswitch] engaging after unexpected sing-box exit");
  killswitch.engage(userDataDir(), TUN_INTERFACE_NAME, log);
  killSwitchActive = true;
  notify(
    "Kill switch активирован",
    "Соединение оборвалось неожиданно: сеть заблокирована, чтобы трафик не утёк мимо VPN. Переподключитесь или отключите kill switch в настройках."
  );
  broadcastState();
}

const MAX_RECONNECT_ATTEMPTS = 3;
let reconnect = { active: false, plan: null, made: 0 };

function cancelReconnect() {
  reconnect = { active: false, plan: null, made: 0 };
}

// Returns true if auto-reconnect has taken over. With the kill switch on, the
// network is only blocked after every attempt has failed: blocking at once
// would cut off the very connection the retries need.
function handleUnexpectedDrop(lost) {
  const cfg = settingsStore().load().autoReconnect;
  if (!cfg.enabled) return false;
  if (reconnect.active) {
    attemptReconnect();
    return true;
  }
  reconnect = { active: true, plan: null, made: 0 };
  (async () => {
    const profiles = profileStore().load();
    const pings = await pingAll(profiles.filter((p) => p.id !== lost.id));
    if (!reconnect.active) return;
    reconnect.plan = buildReconnectPlan({ lostId: lost.id, fallbackId: cfg.fallbackProfileId, profiles, pings }).slice(
      0,
      MAX_RECONNECT_ATTEMPTS
    );
    attemptReconnect();
  })();
  return true;
}

function attemptReconnect() {
  if (!reconnect.active || !reconnect.plan) return;
  const id = reconnect.plan.shift();
  const profile = id && profileStore().load().find((p) => p.id === id);
  if (!profile) return giveUpReconnect();
  reconnect.made++;
  notify("Переподключение", `Попытка ${reconnect.made} из ${MAX_RECONNECT_ATTEMPTS}: ${profile.name}`);
  const myAttempt = reconnect.made;
  setTimeout(() => {
    if (!reconnect.active || reconnect.made !== myAttempt) return;
    if (!connect(profile)) attemptReconnect();
  }, myAttempt === 1 ? 1500 : 500);
}

function giveUpReconnect() {
  cancelReconnect();
  notify("Не удалось переподключиться", "Все попытки исчерпаны.");
  engageKillSwitchIfEnabled();
}

function applySettings(partial) {
  const next = settingsStore().update(partial);
  // Kill switch being turned off should immediately lift any active block.
  if (!next.killSwitchEnabled && killSwitchActive) {
    killswitch.restore(userDataDir(), log);
    killSwitchActive = false;
  }
  broadcastState();
  return next;
}

/* ---------- subscriptions ---------- */

const MAX_SUBSCRIPTION_BYTES = 2 * 1024 * 1024;

async function fetchSubscriptionText(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Нужна ссылка http:// или https://");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await net.fetch(url, { signal: controller.signal, headers: { "User-Agent": `Nyx/${app.getVersion()}` } });
    if (!res.ok) throw new Error(`Сервер подписки ответил ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_SUBSCRIPTION_BYTES) throw new Error("Ответ подписки слишком большой");
    return {
      text: buf.toString("utf8"),
      title: parseProfileTitle(res.headers.get("profile-title")),
      usage: parseUserinfo(res.headers.get("subscription-userinfo")),
    };
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Сервер подписки не ответил за 15 секунд");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Loads the list once and saves it once: every store call goes through DPAPI.
async function syncSubscription(sub) {
  try {
    const { text, title, usage } = await fetchSubscriptionText(sub.url);
    const { links, skipped } = parseSubscription(text);
    if (!links.length) {
      throw new Error(skipped ? "В подписке нет VLESS-ссылок (другие протоколы не поддерживаются)" : "Подписка пуста или формат не распознан");
    }
    const store = profileStore();
    const all = store.load();
    const mine = all.filter((x) => x.subscriptionId === sub.id);
    const otherKeys = new Set(all.filter((x) => x.subscriptionId !== sub.id).map((x) => linkKey(x.link)));
    const plan = planSubscriptionSync(mine, links, otherKeys);

    let next = all.map((x) => {
      const u = plan.toUpdate.find((c) => c.id === x.id);
      return u ? { ...x, link: u.link, ...(u.name ? { name: u.name } : {}) } : x;
    });
    const removable = new Set(plan.toRemoveIds.filter((id) => id !== activeProfileId));
    next = next.filter((x) => !removable.has(x.id));
    for (const a of plan.toAdd) next.push({ id: randomUUID(), name: a.name, link: a.link, subscriptionId: sub.id });
    store.save(next);

    subscriptionStore().applyServerTitle(sub.id, title);
    subscriptionStore().patch(sub.id, { updatedAt: Date.now(), count: links.length, error: null, usage });
    log("[subscriptions] synced", sub.name, `added=${plan.toAdd.length} updated=${plan.toUpdate.length} removed=${removable.size} skipped=${skipped}`);
    return { ok: true, added: plan.toAdd.length, updated: plan.toUpdate.length, removed: removable.size, skipped };
  } catch (err) {
    log("[subscriptions] sync failed for", sub.name, "-", err.message);
    subscriptionStore().patch(sub.id, { error: err.message });
    return { ok: false, error: err.message };
  } finally {
    broadcastState();
  }
}

async function refreshAllSubscriptions() {
  for (const sub of subscriptionStore().list()) await syncSubscription(sub);
}

function publicSubscriptions() {
  return subscriptionStore().list().map((x) => {
    let host = "";
    try {
      host = new URL(x.url).hostname;
    } catch {}
    return { id: x.id, name: x.name, nameIsCustom: !!x.nameIsCustom, host, updatedAt: x.updatedAt, count: x.count, error: x.error, usage: x.usage || null };
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
  // The "error" event below logs a failure once, in one line; electron-updater
  // would otherwise dump the whole releases feed here as well.
  error: () => {},
};

autoUpdater.on("checking-for-update", () => setUpdateState({ status: "checking" }));
autoUpdater.on("update-available", (info) => {
  updateRetry.reset();
  setUpdateState({ status: "available", version: info.version });
  notify("Доступно обновление", `Nyx ${info.version} загружается в фоне`);
});
autoUpdater.on("update-not-available", () => {
  updateRetry.reset();
  setUpdateState({ status: "not-available" });
});
autoUpdater.on("download-progress", (progress) => {
  setUpdateState({ status: "downloading", percent: Math.round(progress.percent) });
});
autoUpdater.on("update-downloaded", (info) => {
  setUpdateState({ status: "downloaded", version: info.version });
  notify("Обновление готово", `Nyx ${info.version} установится при перезапуске`);
});
// A dropped connection (VPN switching, DNS not ready yet) is not an update
// problem: retry quietly a few times instead of showing an error.
const updateRetry = createRetryPolicy();
let updateRetryTimer = null;
autoUpdater.on("error", (err) => {
  const summary = summarizeUpdaterError(err);
  const delay = updateRetry.next(err);
  if (delay !== null) {
    log(`[updater] network error, retry ${updateRetry.attempts} in ${Math.round(delay / 1000)}s: ${summary}`);
    clearTimeout(updateRetryTimer);
    updateRetryTimer = setTimeout(checkForUpdates, delay);
    setUpdateState({ status: "idle" });
    return;
  }
  log("[updater] error:", summary);
  setUpdateState({ status: "error", message: summary });
});

function checkForUpdates() {
  if (!app.isPackaged) {
    setUpdateState({ status: "not-available" });
    return;
  }
  // electron-updater emits "error" for every failure, handled above.
  autoUpdater.checkForUpdates().catch(() => {});
}

function getState() {
  const settings = settingsStore().load();
  let profiles;
  try {
    profiles = profileStore().load();
  } catch (err) {
    log("getState: profileStore().load() THREW:", err.stack || err.message);
    profiles = [];
  }
  geoResolver.queue(profiles);
  const subscriptions = publicSubscriptions();
  const favorites = new Set(settings.favorites);
  profiles = sortWithFavorites(profiles, settings.favorites).map((p) => ({
    ...p,
    country: countryOf(p),
    favorite: favorites.has(p.id),
  }));
  return {
    profiles,
    activeProfileId,
    connecting,
    connectedAt,
    autoStart: isAutoStartEnabled(),
    settings,
    killSwitchActive,
    issue: connectionIssue,
    subscriptions,
    // The profile list: favorites, the servers added by hand and one group per
    // subscription, with the folded ones marked (the window only draws them).
    groups: buildGroups(profiles, subscriptions, { collapsed: settings.collapsedGroups, activeProfileId }).map((g) => ({
      ...g,
      usageText: formatUsage(g.usage),
    })),
  };
}

function broadcastState() {
  updateTrayIcon();
  mainWindow?.webContents.send("state", getState());
}

function restoredBounds() {
  const w = settingsStore().load().window;
  if (!w || !Number.isFinite(w.width) || !Number.isFinite(w.height)) return {};
  const bounds = { width: Math.max(w.width, 960), height: Math.max(w.height, 600) };
  if (Number.isFinite(w.x) && Number.isFinite(w.y)) {
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return w.x + 100 > a.x && w.x < a.x + a.width - 100 && w.y + 50 > a.y && w.y < a.y + a.height - 50;
    });
    if (onScreen) {
      bounds.x = w.x;
      bounds.y = w.y;
    }
  }
  return bounds;
}

let boundsTimer = null;
function persistWindowBounds() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isMinimized()) return;
    const b = mainWindow.getNormalBounds();
    settingsStore().update({ window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized: mainWindow.isMaximized() } });
  }, 600);
}

function openSettingsWindow() {
  openMainWindow();
  const send = () => mainWindow?.webContents.send("open-settings");
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once("did-finish-load", send);
  else send();
}

// The colour behind the page while it loads, so a light theme does not flash dark.
function windowBackground() {
  const mode = settingsStore().load().theme;
  const light = mode === "light" || (mode === "system" && !nativeTheme.shouldUseDarkColors);
  return light ? "#eef2f7" : "#0b0e14";
}

function openMainWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  log("creating main window");
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 640,
    ...restoredBounds(),
    minWidth: 960,
    minHeight: 600,
    frame: false,
    backgroundColor: windowBackground(),
    title: "Nyx",
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  if (settingsStore().load().window?.maximized) mainWindow.maximize();
  for (const evt of ["resize", "move", "maximize", "unmaximize"]) mainWindow.on(evt, persistWindowBounds);
  mainWindow.loadFile(path.join(__dirname, "main-window.html"));
  mainWindow.on("close", (e) => {
    if (isQuitting) return;
    e.preventDefault();
    mainWindow.hide();
  });
}

ipcMain.handle("window-minimize", () => mainWindow?.minimize());
ipcMain.handle("window-maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});
ipcMain.handle("window-close", () => mainWindow?.close());
ipcMain.handle("window-is-maximized", () => mainWindow?.isMaximized() ?? false);

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
  cancelReconnect();
  const profile = profileStore().load().find((p) => p.id === id);
  if (profile) connect(profile);
});

ipcMain.handle("quick-connect", () => quickConnect());

ipcMain.handle("connect-best", () => {
  cancelReconnect();
  return connectBest();
});

ipcMain.handle("disconnect", () => {
  cancelReconnect();
  disconnect();
});

ipcMain.handle("toggle-favorite", (_evt, id) => {
  const favs = new Set(settingsStore().load().favorites);
  if (favs.has(id)) favs.delete(id);
  else favs.add(id);
  applySettings({ favorites: [...favs] });
});

ipcMain.handle("get-profile-qr", (_evt, id) => {
  const profile = profileStore().load().find((p) => p.id === id);
  if (!profile) return { ok: false };
  return { ok: true, name: profile.name, svg: qrSvg(profile.link) };
});

ipcMain.handle("get-stats", (_evt, days = 7) => {
  const summary = trafficStats.summary(Math.min(Math.max(Number(days) || 7, 1), 90));
  const names = Object.fromEntries(profileStore().load().map((p) => [p.id, p.name]));
  return { ...summary, names };
});

ipcMain.handle("add-subscription", async (_evt, url, typedName) => {
  const clean = String(url || "").trim();
  try {
    new URL(clean);
  } catch {
    return { ok: false, error: "Это не похоже на ссылку" };
  }
  let name = clean;
  try {
    name = new URL(clean).hostname;
  } catch {}
  const typed = String(typedName || "").trim();
  const id = subscriptionStore().add({ url: clean, name: typed || name, custom: !!typed });
  const sub = subscriptionStore().list().find((x) => x.id === id);
  const result = await syncSubscription(sub);
  if (!result.ok) subscriptionStore().remove(id);
  broadcastState();
  return result;
});

ipcMain.handle("rename-subscription", (_evt, id, name) => {
  const ok = subscriptionStore().rename(id, name);
  broadcastState();
  updateTrayIcon();
  return { ok };
});

ipcMain.handle("set-group-collapsed", (_evt, groupId, collapsed) => {
  const current = new Set(settingsStore().load().collapsedGroups);
  if (collapsed) current.add(groupId);
  else current.delete(groupId);
  settingsStore().update({ collapsedGroups: [...current] });
  broadcastState();
});

ipcMain.handle("refresh-subscription", async (_evt, id) => {
  const sub = subscriptionStore().list().find((x) => x.id === id);
  return sub ? syncSubscription(sub) : { ok: false, error: "Подписка не найдена" };
});

ipcMain.handle("refresh-all-subscriptions", async () => {
  await refreshAllSubscriptions();
  return { ok: true };
});

ipcMain.handle("remove-subscription", (_evt, id) => {
  const store = profileStore();
  const all = store.load();
  if (all.some((p) => p.subscriptionId === id && p.id === activeProfileId)) disconnect();
  store.save(all.filter((p) => p.subscriptionId !== id));
  subscriptionStore().remove(id);
  broadcastState();
});

ipcMain.handle("dismiss-hint", (_evt, name) => {
  if (name === "trayShown") applySettings({ hints: { trayShown: true } });
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

ipcMain.handle("update-settings", (_evt, partial) => applySettings(partial));

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

let singboxVersionPromise = null;
function loadSingBoxVersion() {
  singboxVersionPromise ??= getSingBoxVersionAsync().then((v) => {
    if (v === null) singboxVersionPromise = null; // try again next time
    return v;
  });
  return singboxVersionPromise;
}

ipcMain.handle("get-app-info", async () => ({
  name: "Nyx",
  version: app.getVersion(),
  author: "Balamut",
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  singboxVersion: await loadSingBoxVersion(),
}));

// Real round-trip through the tunnel (Clash API asks the "proxy" outbound to
// fetch a tiny URL), unlike a TCP ping to the server's own IP, which from
// this process would itself be routed into the tunnel.
ipcMain.handle("dismiss-issue", () => {
  connectionIssue = null;
  broadcastState();
});

// "Is the VPN really in use?": ask an IP-geolocation service how this machine
// looks from the outside. The request is made by this app, so it travels the
// same way as any other program's traffic.
ipcMain.handle("check-leaks", async () => {
  const settings = settingsStore().load();
  const active = activeProfileId ? profileStore().load().find((p) => p.id === activeProfileId) : null;
  const connected = !!active && !connecting;
  let info = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await net.fetch(IP_INFO_URL, { signal: controller.signal, headers: { "User-Agent": `Nyx/${app.getVersion()}` } });
      if (res.ok) info = parseIpInfo(await res.json());
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    log("leak check failed:", err.message);
  }
  let serverHost = null;
  if (active) {
    try {
      serverHost = parseVlessLink(active.link).host;
    } catch {}
  }
  const verdict = leakVerdict({ connected, info, serverHost, realIp: knownRealIp });
  if (info && !connected) knownRealIp = info.ip;
  return { connected, info, verdict, dns: describeDns(settings), profileName: active ? active.name : null };
});

// Speed test through the current route (the tunnel when connected).
let speedtestAbort = null;

ipcMain.handle("run-speedtest", async () => {
  if (speedtestAbort) return { ok: false, error: "Тест уже идёт" };
  const controller = new AbortController();
  speedtestAbort = controller;
  const overall = setTimeout(() => controller.abort(), 60000);
  const active = activeProfileId ? profileStore().load().find((p) => p.id === activeProfileId) : null;
  const context = { connected: !!active && !connecting, profileName: active ? active.name : null };
  const fetchFn = (url, init) => net.fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  try {
    const result = await runSpeedtest(fetchFn, {
      isCancelled: () => controller.signal.aborted,
      onUpdate: (u) => mainWindow?.webContents.send("speedtest", u),
    });
    return { ok: true, result, ...context };
  } catch (err) {
    const cancelled = controller.signal.aborted;
    log("speed test failed:", err.message);
    return { ok: false, cancelled, error: cancelled ? "Тест остановлен" : "Нет связи с сервером теста. Проверьте подключение." , ...context };
  } finally {
    clearTimeout(overall);
    speedtestAbort = null;
  }
});

ipcMain.handle("cancel-speedtest", () => {
  speedtestAbort?.abort();
});

ipcMain.handle("get-rules-info", () => {
  const settings = settingsStore().load();
  const custom = pickRulesDir(userDataDir(), null);
  return { custom: !!custom, updatedAt: settings.rulesUpdatedAt };
});

ipcMain.handle("update-rules", async () => {
  async function fetchBuffer(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await net.fetch(url, { signal: controller.signal, headers: { "User-Agent": `Nyx/${app.getVersion()}` } });
      if (!res.ok) throw new Error(`Сервер ответил ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 8 * 1024 * 1024) throw new Error("Файл слишком большой");
      return buf;
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    const result = await refreshRules(userDataDir(), fetchBuffer);
    const updatedAt = Date.now();
    settingsStore().update({ rulesUpdatedAt: updatedAt });
    log("routing lists refreshed:", result.files.join(", "), result.bytes, "bytes");
    return { ok: true, updatedAt, applied: !activeProfileId };
  } catch (err) {
    log("routing lists refresh failed:", err.message);
    return { ok: false, error: err.name === "AbortError" ? "нет ответа от GitHub" : err.message };
  }
});

ipcMain.handle("get-tunnel-latency", () => {
  return new Promise((resolve) => {
    if (!activeProfileId) return resolve(null);
    const url = encodeURIComponent("https://www.gstatic.com/generate_204");
    const req = http.get(`http://${CLASH_API_ADDRESS}/proxies/proxy/delay?url=${url}&timeout=4000`, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body).delay ?? null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(6000, () => {
      req.destroy();
      resolve(null);
    });
  });
});

ipcMain.handle("get-update-status", () => updateState);

ipcMain.handle("check-for-updates", () => {
  checkForUpdates();
});

ipcMain.handle("install-update", () => {
  // silent: no installer window; force-run: Nyx starts again once it is installed
  autoUpdater.quitAndInstall(true, true);
});

function buildTrayMenu() {
  const settings = settingsStore().load();
  const profiles = sortWithFavorites(profileStore().load(), settings.favorites);
  const active = profiles.find((p) => p.id === activeProfileId);
  const flagIcon = (p) => {
    const c = countryOf(p);
    if (!c) return undefined;
    const img = nativeImage.createFromPath(path.join(__dirname, "assets", "flags-png", `${c}.png`));
    return img.isEmpty() ? undefined : img.resize({ width: 20, height: 15 });
  };

  const header = active
    ? `Подключено: ${active.name}`
    : connecting
      ? "Подключение..."
      : killSwitchActive
        ? "Сеть заблокирована (kill switch)"
        : "Отключено";

  const profileItem = (p) => ({
    label: `${settings.favorites.includes(p.id) ? "★ " : ""}${p.name}`,
    icon: flagIcon(p),
    type: "radio",
    checked: p.id === activeProfileId,
    click: () => {
      cancelReconnect();
      connect(p);
    },
  });
  // Favorites and the servers added by hand sit at the top level; every
  // subscription is a submenu, so several of them do not turn into one long list.
  const groups = buildGroups(
    profiles.map((p) => ({ ...p, favorite: settings.favorites.includes(p.id) })),
    subscriptionStore().list().map((s) => ({ id: s.id, name: s.name })),
    { activeProfileId }
  );
  const hasSubscriptions = groups.some((g) => g.kind === "subscription" && g.count);
  const profileItems = [];
  for (const g of groups) {
    if (!g.count) continue;
    if (g.kind === "subscription") {
      profileItems.push({ label: `${g.hasActive ? "● " : ""}${g.name} (${g.count})`, submenu: g.profiles.map(profileItem) });
    } else if (g.kind === "favorites") {
      profileItems.push({ label: "Избранное", enabled: false }, ...g.profiles.map(profileItem));
      if (groups.length > 1) profileItems.push({ type: "separator" });
    } else {
      if (hasSubscriptions) profileItems.push({ label: "Мои серверы", enabled: false });
      profileItems.push(...g.profiles.map(profileItem));
    }
  }

  return Menu.buildFromTemplate([
    { label: header, enabled: false },
    { type: "separator" },
    activeProfileId
      ? {
          label: "Отключить",
          click: () => {
            cancelReconnect();
            disconnect();
          },
        }
      : {
          label: settings.autoBest.enabled ? "Подключиться (лучший сервер)" : "Подключиться",
          enabled: profiles.length > 0 && !connecting,
          click: quickConnect,
        },
    {
      label: "Подключиться к самому быстрому",
      enabled: profiles.length > 1 && !connecting,
      click: () => {
        cancelReconnect();
        connectBest();
      },
    },
    { type: "separator" },
    ...(profileItems.length ? profileItems : [{ label: "Нет профилей", enabled: false }]),
    { type: "separator" },
    {
      label: "Kill switch",
      type: "checkbox",
      checked: settings.killSwitchEnabled,
      click: (item) => applySettings({ killSwitchEnabled: item.checked }),
    },
    { label: "Открыть Nyx", click: openMainWindow },
    { label: "Настройки", click: openSettingsWindow },
    { label: "Выход", click: () => app.quit() },
  ]);
}

function autoStartSettings({ hidden }) {
  const base = app.isPackaged ? [] : [path.join(__dirname, "..")];
  return {
    path: process.execPath,
    args: hidden ? [...base, "--hidden"] : base,
  };
}

// Versions before 0.2.4 registered autostart without "--hidden"; still
// recognize that entry so the checkbox doesn't show "off" after an update.
function isAutoStartEnabled() {
  return (
    app.getLoginItemSettings(autoStartSettings({ hidden: true })).openAtLogin ||
    app.getLoginItemSettings(autoStartSettings({ hidden: false })).openAtLogin
  );
}

function setAutoStartEnabled(enabled) {
  app.setLoginItemSettings({ ...autoStartSettings({ hidden: true }), openAtLogin: enabled });
}

function updateTrayIcon() {
  if (!tray) return;
  tray.setImage(activeProfileId ? ICON_CONNECTED : ICON_DISCONNECTED);
  const active = activeProfileId ? profileStore().load().find((p) => p.id === activeProfileId) : null;
  const code = active ? countryOf(active) : null;
  tray.setToolTip(active ? `Nyx: подключено — ${active.name}${code ? ` (${code.toUpperCase()})` : ""}` : "Nyx: отключено");
  tray.setContextMenu(buildTrayMenu());
}

// The profiles are decrypted in the background while Electron starts up.
if (startedElevated) profileStore().preload();

app.whenReady().then(() => {
  if (!startedElevated) {
    log("app became ready in the pre-relaunch process; ignoring (exit already requested)");
    return;
  }
  log("app ready, tray starting");
  loadSingBoxVersion();
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
    setInterval(() => trafficStats.flush(), 30000);
    if (settingsStore().load().subscriptionsAutoUpdate) {
      setTimeout(refreshAllSubscriptions, 8000);
      setInterval(() => {
        if (settingsStore().load().subscriptionsAutoUpdate) refreshAllSubscriptions();
      }, 6 * 60 * 60 * 1000);
    }
  } catch (err) {
    log("TRAY CREATE FAILED:", err.stack || err.message);
  }
  // Even if the tray icon failed or Windows tucked it into the hidden-icons
  // flyout (it does that for any new tray icon), a manual launch should
  // always show something.
  if (!startHidden) openMainWindow();
});

app.on("window-all-closed", (e) => e.preventDefault());
app.on("before-quit", () => {
  isQuitting = true;
  cancelReconnect();
  disconnect();
  trafficStats.flush();
});
app.on("second-instance", () => openMainWindow());
