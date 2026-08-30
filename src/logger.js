import { appendFileSync, mkdirSync } from "node:fs";
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
