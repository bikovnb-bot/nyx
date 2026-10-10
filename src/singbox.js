import { spawn, spawnSync, execFile } from "node:child_process";
import { platform } from "node:os";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BINARY_NAME = platform() === "win32" ? "sing-box.exe" : "sing-box";
// Dev: run from source, binary lives next to this file's package.
const DEV_BINARY = path.join(__dirname, "..", "vendor", BINARY_NAME);
// Packaged: electron-builder copies extraResources next to app.asar, not
// inside it, so the binary is reachable at runtime as a plain file on disk.
const PACKAGED_BINARY = process.resourcesPath
  ? path.join(process.resourcesPath, "vendor", BINARY_NAME)
  : null;

const RULES_DIR = process.resourcesPath && PACKAGED_BINARY && existsSync(path.join(process.resourcesPath, "rules"))
  ? path.join(process.resourcesPath, "rules")
  : path.join(__dirname, "..", "vendor", "rules");

export function findRulesDir() {
  return existsSync(RULES_DIR) ? RULES_DIR : null;
}

export function findSingBoxBinary() {
  if (process.env.SINGBOX_PATH) return process.env.SINGBOX_PATH;
  if (PACKAGED_BINARY && existsSync(PACKAGED_BINARY)) return PACKAGED_BINARY;
  if (existsSync(DEV_BINARY)) return DEV_BINARY;
  return BINARY_NAME;
}

export function parseSingBoxVersion(stdout) {
  if (!stdout) return null;
  const match = /version\s+([^\s]+)/i.exec(stdout);
  return match ? match[1] : stdout.trim().split("\n")[0];
}

export function getSingBoxVersion() {
  const result = spawnSync(findSingBoxBinary(), ["version"], { encoding: "utf8" });
  return result.status === 0 ? parseSingBoxVersion(result.stdout) : null;
}

// `sing-box version` takes 1-2 seconds to start (large binary, antivirus scan),
// so the app asks for it once in the background instead of blocking on it.
export function getSingBoxVersionAsync() {
  return new Promise((resolve) => {
    execFile(findSingBoxBinary(), ["version"], { encoding: "utf8", windowsHide: true, timeout: 10000 }, (err, stdout) => {
      resolve(err ? null : parseSingBoxVersion(stdout));
    });
  });
}

export function isElevated() {
  if (platform() === "win32") {
    const result = spawnSync("net", ["session"], { stdio: "ignore" });
    return result.status === 0;
  }
  return typeof process.getuid === "function" && process.getuid() === 0;
}

export function runSingBox(configPath, { onLog, onError } = {}) {
  const bin = findSingBoxBinary();
  const child = spawn(bin, ["run", "-c", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (buf) => onLog?.(buf.toString()));
  child.stderr.on("data", (buf) => onLog?.(buf.toString()));
  if (onError) child.on("error", onError);

  const cleanup = () => {
    try {
      rmSync(path.dirname(configPath), { recursive: true, force: true });
    } catch {}
  };
  child.once("exit", cleanup);
  child.once("error", cleanup);

  return child;
}
