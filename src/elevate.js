import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { isElevated } from "./singbox.js";

export function isElevatedWindows() {
  if (platform() !== "win32") return true;
  return isElevated();
}

// Note: electron-builder's "portable" Windows target wraps the app in a
// self-extracting launcher that runs the real exe inside a Job Object; once
// that original (unelevated) process exits after triggering this relaunch,
// Windows tears down the whole job — including the detached elevated
// process spawned below — a few seconds later, even though it started fine.
// Build with the "nsis" (installer) or "dir" targets instead; only those
// run the app directly, without that job-object wrapper.
export function relaunchElevatedWindows(exePath, args) {
  const psArgs = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(",");
  const command =
    `Start-Process -FilePath '${exePath}' ` +
    (args.length ? `-ArgumentList @(${psArgs}) ` : "") +
    `-Verb RunAs`;
  // spawnSync blocks until Start-Process has actually issued the elevation
  // request; if we quit() right after an async spawn(), Electron's job
  // object can kill the powershell child before it gets scheduled.
  return spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}
