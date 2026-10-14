import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";

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

// Fast path: `route print` answers in ~35 ms where the PowerShell script above
// needs 1.6-1.8 s. The default routes (0.0.0.0/0) are read from it, the lowest
// metric wins and the adapter's name comes from Node's own view of the
// interfaces. Anything that looks like a virtual adapter or a VPN makes the
// fast path give up, because only the PowerShell script knows what is physical.
const VIRTUAL_NAME = /tun|tap|wintun|vpn|virtual|vethernet|vmware|vbox|wsl|hyper-v|loopback|pseudo|zoog|happ|nyx|vlessvpn|tailscale|wireguard|radmin|hamachi|docker/i;

// "  0.0.0.0  0.0.0.0  192.168.31.1  192.168.31.56  25" -> { gateway, ip, metric }
export function parseRoutePrint(text) {
  const routes = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(.+?)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s*$/.exec(line);
    if (m) routes.push({ gateway: m[1].trim(), ip: m[2], metric: Number(m[3]) });
  }
  return routes.sort((a, b) => a.metric - b.metric);
}

// interfaces: the result of os.networkInterfaces(). Routes of virtual-looking
// adapters (another VPN, or Nyx's own tunnel that has not gone away yet) are
// skipped; null when nothing clear-cut is left.
export function pickDefaultInterface(routes, interfaces) {
  for (const route of routes) {
    for (const [name, addrs] of Object.entries(interfaces || {})) {
      if ((addrs || []).some((a) => a.family === "IPv4" && a.address === route.ip)) {
        if (!VIRTUAL_NAME.test(name)) return name;
        break;
      }
    }
  }
  return null;
}

function run(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", windowsHide: true, timeout }, (err, stdout) => resolve(err ? "" : stdout));
  });
}

async function fastDefaultInterfaceName() {
  try {
    return pickDefaultInterface(parseRoutePrint(await run("route", ["print", "-4", "0.0.0.0"], 5000)), networkInterfaces());
  } catch {
    return null;
  }
}

async function slowDefaultInterfaceName() {
  const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], 20000);
  return out.replace(/^\ufeff/, "").trim() || null;
}

// Never blocks the main process (this used to freeze the window for ~1.7 s on
// every connect).
export async function getDefaultInterfaceName() {
  return (await fastDefaultInterfaceName()) || (await slowDefaultInterfaceName());
}
