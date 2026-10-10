// Nyx installer wizard: a branded front-end around the regular NSIS setup.
//
// The NSIS setup (the very file the in-app updater uses) is downloaded from the
// latest GitHub release, checked against the hash in latest.yml and run
// silently; this window only drives it and shows progress. Updates therefore
// keep working exactly as before. A setup.exe next to the wizard (or the
// NYX_SETUP_PATH variable) is used instead of downloading, for offline/dev use.
const { app, BrowserWindow, ipcMain, dialog, net } = require("electron");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APP_DIR_NAME = "Nyx";
// Installed size reported by the NSIS setup, used to turn "how much is on disk
// so far" into a percentage. Only a progress hint, never a correctness check.
const EXPECTED_BYTES = 450 * 1024 * 1024;

const defaultBase = process.env.NYX_INSTALL_BASE || path.join(process.env.LOCALAPPDATA || os.homedir(), "Programs");
let win = null;
let installing = false;
let installedDir = null;

const RELEASE_BASE = "https://github.com/bikovnb-bot/nyx/releases/latest/download/";

function localSetupPath() {
  if (process.env.NYX_SETUP_PATH) return process.env.NYX_SETUP_PATH;
  const bundled = path.join(process.resourcesPath || __dirname, "setup.exe");
  return fs.existsSync(bundled) ? bundled : null;
}

// latest.yml is the file electron-updater itself reads: {path, sha512 (base64), size}.
function parseLatestYml(text) {
  const grab = (key) => {
    const m = new RegExp(`^${key}:[ \t]*(.+)$`, "m").exec(text);
    return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : null;
  };
  const file = grab("path");
  const sha512 = grab("sha512");
  const version = grab("version");
  const size = Number((/^\s+size:\s*(\d+)/m.exec(text) || [])[1]) || 0;
  if (!file || !sha512 || !/^[\w.\-]+\.exe$/i.test(file)) throw new Error("Некорректный файл latest.yml");
  return { file, sha512, version, size };
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await net.fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Сервер ответил ${res.status}`);
    return { res, done: () => clearTimeout(timer) };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function downloadSetup(onProgress) {
  const meta = await (async () => {
    const { res, done } = await fetchWithTimeout(RELEASE_BASE + "latest.yml", 20000);
    try {
      return parseLatestYml(await res.text());
    } finally {
      done();
    }
  })();
  const target = path.join(os.tmpdir(), `nyx-setup-${process.pid}-${meta.file}`);
  const { res, done } = await fetchWithTimeout(RELEASE_BASE + encodeURIComponent(meta.file), 60000);
  const total = meta.size || Number(res.headers.get("content-length")) || 0;
  const hash = crypto.createHash("sha512");
  const out = fs.createWriteStream(target);
  let got = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      hash.update(value);
      got += value.length;
      if (!out.write(value)) await new Promise((r) => out.once("drain", r));
      onProgress(got, total);
    }
    await new Promise((r) => out.end(r));
  } finally {
    done();
  }
  if (hash.digest("base64") !== meta.sha512) {
    fs.rmSync(target, { force: true });
    throw new Error("Скачанный файл не совпал с контрольной суммой. Попробуйте ещё раз.");
  }
  return target;
}

function withAppFolder(dir) {
  const clean = String(dir || "").replace(/[\\/]+$/, "");
  return path.basename(clean).toLowerCase() === APP_DIR_NAME.toLowerCase() ? clean : path.join(clean, APP_DIR_NAME);
}

function appExeIn(dir) {
  return path.join(dir, "Nyx.exe");
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch {}
      }
    }
  }
  return total;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 480,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    backgroundColor: "#0b0e14",
    title: "Установка Nyx",
    icon: path.join(__dirname, "assets", "logo.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.once("ready-to-show", () => win.show());
  win.loadFile(path.join(__dirname, "index.html"));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(createWindow);
  app.on("window-all-closed", () => app.quit());
}

ipcMain.handle("info", () => {
  const dir = withAppFolder(defaultBase);
  return {
    version: app.getVersion(),
    dir,
    update: fs.existsSync(appExeIn(dir)),
    online: true,
  };
});

ipcMain.handle("choose-dir", async (_evt, current) => {
  const res = await dialog.showOpenDialog(win, {
    title: "Папка для установки Nyx",
    defaultPath: path.dirname(current || defaultBase),
    properties: ["openDirectory", "createDirectory"],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const dir = withAppFolder(res.filePaths[0]);
  return { dir, update: fs.existsSync(appExeIn(dir)) };
});

ipcMain.handle("install", async (_evt, requestedDir) => {
  if (installing) return;
  installing = true;
  const dir = withAppFolder(requestedDir || defaultBase);
  installedDir = dir;
  let downloaded = null;
  const fail = (message) => {
    installing = false;
    if (downloaded) fs.rm(downloaded, { force: true }, () => {});
    send("failed", { message });
  };

  // 0-50%: getting the setup file; 50-100%: running it.
  let setup = localSetupPath();
  if (!setup) {
    send("stage", "download");
    try {
      setup = downloaded = await downloadSetup((got, total) => {
        send("progress", total ? Math.min(49, Math.round((got / total) * 50)) : 1);
        send("bytes", { got, total });
      });
    } catch (err) {
      return fail(`Не удалось скачать Nyx: ${err.name === "AbortError" ? "нет ответа от сервера" : err.message}`);
    }
  }
  send("stage", "install");
  send("progress", 50);

  if (process.env.NYX_DRY_RUN) {
    // test hook: stop after the download and hash check
    installing = false;
    if (downloaded) fs.rm(downloaded, { force: true }, () => {});
    send("progress", 100);
    send("done", { dir });
    return;
  }

  // /D must be the last argument and must not be quoted, so the command line is
  // passed through verbatim.
  const child = spawn(setup, ["/S", `/D=${dir}`], { windowsHide: true, windowsVerbatimArguments: true });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d));

  let lastPct = 50;
  const tick = setInterval(() => {
    const pct = 50 + Math.min(46, Math.round((dirSize(dir) / EXPECTED_BYTES) * 50));
    lastPct = Math.max(lastPct, pct);
    send("progress", lastPct);
  }, 700);

  child.on("error", (err) => {
    clearInterval(tick);
    fail(`Не удалось запустить установку: ${err.message}`);
  });
  child.on("exit", (code) => {
    clearInterval(tick);
    if (code === 0 && fs.existsSync(appExeIn(dir))) {
      installing = false;
      if (downloaded) fs.rm(downloaded, { force: true }, () => {});
      send("progress", 100);
      send("done", { dir });
    } else {
      fail(`Установка завершилась с кодом ${code}.${stderr ? " " + stderr.trim().slice(0, 200) : ""}`);
    }
  });
});

ipcMain.handle("launch", () => {
  if (!installedDir) return;
  const child = spawn(appExeIn(installedDir), [], { detached: true, stdio: "ignore", cwd: installedDir });
  child.unref();
});

ipcMain.handle("minimize", () => win?.minimize());
ipcMain.handle("close", () => {
  if (!installing) app.quit();
});
ipcMain.handle("is-installing", () => installing);
