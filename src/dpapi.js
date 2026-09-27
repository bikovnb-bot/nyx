import { spawnSync } from "node:child_process";

// Windows DPAPI ties encrypted data to the current Windows user account,
// not to the app's code-signing identity — unlike Electron's safeStorage
// (Chromium "App-Bound Encryption"), which broke on every single auto-update
// because each build carries a fresh, unrelated ad-hoc self-signed cert (see
// profileStore.js's history). DPAPI survives app updates fine since it never
// looks at who signed the calling process, only which OS user is asking.
// There's no built-in Node API for it, so this shells out to the
// System.Security.Cryptography.ProtectedData class via PowerShell.

function runPowerShell(script, input) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

const PROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($b64)
$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($protected))
`.trim();

const UNPROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($b64)
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($plain))
`.trim();

export function protectCurrentUser(plainBuffer) {
  const result = runPowerShell(PROTECT_SCRIPT, plainBuffer.toString("base64"));
  if (result.status !== 0 || !result.stdout) {
    throw new Error(`DPAPI protect failed: ${result.stderr || "no output"}`);
  }
  return Buffer.from(result.stdout.trim(), "base64");
}

export function unprotectCurrentUser(cipherBuffer) {
  const result = runPowerShell(UNPROTECT_SCRIPT, cipherBuffer.toString("base64"));
  if (result.status !== 0 || !result.stdout) {
    throw new Error(`DPAPI unprotect failed: ${result.stderr || "no output"}`);
  }
  return Buffer.from(result.stdout.trim(), "base64");
}
