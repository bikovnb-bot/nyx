// Running the Xray core next to sing-box (see xrayConfig.js for why). The binary
// is bundled like sing-box's; when it is missing Nyx simply keeps using sing-box.
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { createServer, connect } from "node:net";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const XRAY_BINARY_NAME = platform() === "win32" ? "xray.exe" : "xray";
const DEV_BINARY = path.join(__dirname, "..", "vendor", XRAY_BINARY_NAME);
const PACKAGED_BINARY = process.resourcesPath ? path.join(process.resourcesPath, "vendor", XRAY_BINARY_NAME) : null;

// null when there is no Xray binary to run.
export function findXrayBinary() {
  if (process.env.XRAY_PATH && existsSync(process.env.XRAY_PATH)) return process.env.XRAY_PATH;
  if (PACKAGED_BINARY && existsSync(PACKAGED_BINARY)) return PACKAGED_BINARY;
  if (existsSync(DEV_BINARY)) return DEV_BINARY;
  return null;
}

export function runXray(configPath, { onLog, onError } = {}) {
  const bin = findXrayBinary();
  if (!bin) throw new Error("xray binary not found");
  const child = spawn(bin, ["run", "-c", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout.on("data", (buf) => onLog?.(buf.toString()));
  child.stderr.on("data", (buf) => onLog?.(buf.toString()));
  if (onError) child.on("error", onError);

  // the config holds the account's UUID: it must not outlive the process
  const cleanup = () => {
    try {
      rmSync(path.dirname(configPath), { recursive: true, force: true });
    } catch {}
  };
  child.once("exit", cleanup);
  child.once("error", cleanup);

  return child;
}

// A free loopback port for Xray's SOCKS inbound.
export function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Other programs on this PC can reach a loopback port too; a random password
// keeps them from using the user's tunnel.
export function randomSocksAuth() {
  return { user: randomBytes(6).toString("hex"), pass: randomBytes(16).toString("hex") };
}

// Resolves once something accepts connections on the port; rejects on timeout or
// as soon as isAlive() says the process died.
export function waitForPort(port, { timeoutMs = 8000, intervalMs = 100, isAlive = () => true } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (!isAlive()) return reject(new Error("process exited"));
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error("timeout"));
        else setTimeout(attempt, intervalMs);
      });
    };
    attempt();
  });
}
