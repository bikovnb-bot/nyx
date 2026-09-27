import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

let logFile = null;

export function initLogger(dir) {
  mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, "vlessvpn.log");
  return logFile;
}

export function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  if (logFile) {
    try {
      appendFileSync(logFile, line + "\n");
    } catch {}
  }
  console.log(line);
}

export function getLogFile() {
  return logFile;
}

export function getLogTail(maxLines = 300) {
  if (!logFile || !existsSync(logFile)) return "";
  const lines = readFileSync(logFile, "utf8").split(/\r?\n/);
  return lines.slice(-maxLines).join("\n");
}
