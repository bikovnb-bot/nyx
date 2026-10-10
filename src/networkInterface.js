import { spawnSync } from "node:child_process";

// Split tunneling routes some connections to the "direct" outbound instead
// of the VPN tunnel. With sing-box's TUN inbound using strict_route, the OS
// default route becomes the TUN itself, so the physical adapter is passed
// to the TUN's exclude_interface (sing-box docs: "when strict_route enabled,
// return traffic to excluded interfaces will not be automatically
// excluded, so add them as well").
//
// This must run BEFORE sing-box starts, while the OS's real default route
// still points at the physical adapter rather than the not-yet-created TUN.
//
// Two things that matter on real machines:
// - Only physical adapters count. Another VPN's TUN/TAP (Happ, ZoogVPN, a
//   leftover Nyx adapter) can also hold a default route, and picking one of
//   those would exclude the wrong interface.
// - Adapter names are often non-ASCII ("Беспроводная сеть 2"). PowerShell
//   writes to a pipe in the OEM codepage by default, which Node would decode
//   as UTF-8 into garbage, so the script switches its stdout to UTF-8 (no BOM).
const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$physical = @(Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | ForEach-Object { $_.ifIndex })
$best = Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Where-Object { $physical -contains $_.ifIndex } | ForEach-Object {
  $ifaceMetric = (Get-NetIPInterface -InterfaceIndex $_.ifIndex -AddressFamily IPv4).InterfaceMetric
  [pscustomobject]@{ Alias = $_.InterfaceAlias; Metric = $_.RouteMetric + $ifaceMetric }
} | Sort-Object Metric | Select-Object -First 1
if ($best) { [Console]::Out.Write($best.Alias) }
`.trim();

export function getDefaultInterfaceName() {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], {
    encoding: "utf8",
    windowsHide: true,
  });
  const name = (result.stdout || "").replace(/^﻿/, "").trim();
  return name || null;
}
