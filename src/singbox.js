import { spawn, spawnSync } from "node:child_process";
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

export function findSingBoxBinary() {
  if (process.env.SINGBOX_PATH) return process.env.SINGBOX_PATH;
  if (PACKAGED_BINARY && existsSync(PACKAGED_BINARY)) return PACKAGED_BINARY;
  if (existsSync(DEV_BINARY)) return DEV_BINARY;
  return BINARY_NAME;
}

export function getSingBoxVersion() {
  const bin = findSingBoxBinary();
  const result = spawnSync(bin, ["version"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return null;
  const match = /version\s+([^\s]+)/i.exec(result.stdout);
  return match ? match[1] : result.stdout.trim().split("\n")[0];
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
