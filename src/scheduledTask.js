import { spawnSync } from "node:child_process";

const TASK_NAME = "NyxElevatedLaunch";

function runPowerShell(script) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
}

// sing-box's TUN mode needs admin, so Nyx has always self-elevated via
// Start-Process -Verb RunAs on every single launch — a UAC prompt every
// time. A Scheduled Task with "run with highest privileges" is the standard
// way around that: once such a task exists, Start-ScheduledTask launches it
// fully elevated with NO further UAC consent dialog, because the elevation
// decision was already made when the task was created.
//
// Registering it (with /rl highest equivalent — RunLevel Highest) itself
// requires the *creating* process to already be elevated, so this only
// ever runs from inside an already-elevated Nyx process (see main.js),
// never from the pre-elevation launcher.
//
// schtasks requires *some* trigger to create a task, so this uses an
// "at logon" trigger — but with the TRIGGER itself disabled (its own
// .Enabled = $false), not the task. That distinction matters: disabling
// the whole task via `schtasks /disable` (the first version of this file)
// also blocks `/run`/Start-ScheduledTask from ever launching it manually,
// which defeated the entire point. Disabling just the trigger stops it
// from firing on its own (autostart is handled separately via
// app.setLoginItemSettings) while leaving the task itself runnable anytime.
//
// ensureRegistered() always re-registers with -Force so a stale/broken
// task definition from an older Nyx version self-heals on next launch,
// rather than requiring the user to delete it by hand.

export function ensureRegistered(exePath, logger = console.error) {
  const escapedPath = exePath.replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute '${escapedPath}'
$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Enabled = $false
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -RunLevel Highest -LogonType Interactive
Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
`.trim();
  const result = runPowerShell(script);
  if (result.status !== 0) {
    logger("[scheduledTask] failed to register:", result.stderr || result.stdout);
    return false;
  }
  logger("[scheduledTask] registered", TASK_NAME, "->", exePath);
  return true;
}

export function runViaTask(logger = console.error) {
  const result = runPowerShell(`Start-ScheduledTask -TaskName '${TASK_NAME}'`);
  if (result.status !== 0) {
    logger("[scheduledTask] Start-ScheduledTask failed:", result.stderr || result.stdout);
    return false;
  }
  return true;
}

export function unregisterTask(logger = console.error) {
  const result = runPowerShell(`Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`);
  if (result.status !== 0) {
    logger("[scheduledTask] unregister failed (may not have existed):", result.stderr || result.stdout);
  }
}
