import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";

function statePath(userDataDir) {
  return path.join(userDataDir, "killswitch-state.json");
}

function runPowerShell(script) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
}

// A firewall-rule-based kill switch is unreliable on Windows: explicit
// block rules always take precedence over explicit allow rules regardless
// of how specific the allow rule is, so a generic "block everything"
// exception list for our own processes doesn't actually work. Instead,
// engage() disables every network adapter except the sing-box TUN
// interface, which deterministically stops all traffic (nothing can leak
// around a tunnel that no longer has a physical link under it). restore()
// is the only way to bring connectivity back.
export function engage(userDataDir, tunInterfaceName, logger = console.error) {
  const script = `Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.Name -ne '${tunInterfaceName}' } | Select-Object -ExpandProperty Name`;
  const result = runPowerShell(script);
  const names = (result.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length) {
    logger("[killswitch] no adapters to disable");
    return;
  }
  writeFileSync(statePath(userDataDir), JSON.stringify(names));
  for (const name of names) {
    const disable = runPowerShell(`Disable-NetAdapter -Name '${name.replace(/'/g, "''")}' -Confirm:$false`);
    logger(`[killswitch] disabled adapter "${name}" (exit=${disable.status})`, disable.stderr || "");
  }
}

export function restore(userDataDir, logger = console.error) {
  const file = statePath(userDataDir);
  if (!existsSync(file)) return;
  let names = [];
  try {
    names = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  for (const name of names) {
    const enable = runPowerShell(`Enable-NetAdapter -Name '${name.replace(/'/g, "''")}' -Confirm:$false`);
    logger(`[killswitch] re-enabled adapter "${name}" (exit=${enable.status})`, enable.stderr || "");
  }
  try {
    unlinkSync(file);
  } catch {}
}

export function isEngaged(userDataDir) {
  return existsSync(statePath(userDataDir));
}
