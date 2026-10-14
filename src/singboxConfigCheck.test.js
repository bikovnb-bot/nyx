// The configs the app generates are checked by the real sing-box. A config that the
// unit tests accept can still be refused by the core (it happened with the DNS rule
// strategy), so every combination of options is run through `sing-box check`.
// Skipped when vendor/sing-box.exe is not there (CI runs the tests before it is downloaded).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSingBoxConfig } from "./configBuilder.js";
import { parseVlessLink } from "./parseLink.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "vendor", process.platform === "win32" ? "sing-box.exe" : "sing-box");
const rulesDir = path.join(root, "vendor", "rules");
const have = existsSync(bin) && existsSync(rulesDir);

const links = {
  ip: "vless://11111111-1111-1111-1111-111111111111@203.0.113.5:443?type=ws&security=tls&path=%2Fs&sni=example.com#ip",
  name: "vless://11111111-1111-1111-1111-111111111111@cloud.example.com:443?type=ws&security=tls&path=%2Fs#name",
  reality: "vless://11111111-1111-1111-1111-111111111111@203.0.113.5:443?type=tcp&security=reality&pbk=mhPpkjhAi2d5SGPiQFkYtBYYCoPMhDbCMBjrNFAErWw&sid=01ab&sni=example.com&flow=xtls-rprx-vision#r",
};
const options = {
  plain: {},
  ru: { routing: { directRu: true }, rulesDir },
  ads: { routing: { blockAds: true }, rulesDir },
  all: { routing: { directRu: true, blockAds: true }, rulesDir, fragment: true, dns: { provider: "quad9" }, defaultInterfaceName: "Wi-Fi", splitTunneling: { enabled: true, domains: ["example.org"], processes: ["x.exe"] } },
};

for (const [lname, link] of Object.entries(links)) {
  for (const [oname, opts] of Object.entries(options)) {
    test(`sing-box accepts the config: ${lname} / ${oname}`, { skip: !have && "vendor/sing-box.exe not present" }, () => {
      const file = path.join(mkdtempSync(path.join(tmpdir(), "nyx-check-")), "config.json");
      writeFileSync(file, JSON.stringify(buildSingBoxConfig(parseVlessLink(link), opts)));
      const r = spawnSync(bin, ["check", "-c", file], { encoding: "utf8" });
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    });
  }
}

// The same check for the mode where Xray carries the connection and sing-box only
// keeps the tunnel (the proxy outbound is a local SOCKS port).
for (const [lname, link] of Object.entries(links)) {
  for (const [oname, opts] of Object.entries(options)) {
    test(`sing-box accepts the upstream-core config: ${lname} / ${oname}`, { skip: !have && "vendor/sing-box.exe not present" }, () => {
      const file = path.join(mkdtempSync(path.join(tmpdir(), "nyx-check-")), "config.json");
      const upstream = { port: 10808, auth: { user: "u", pass: "p" }, serverIps: ["203.0.113.5"], processNames: ["xray.exe"] };
      writeFileSync(file, JSON.stringify(buildSingBoxConfig(parseVlessLink(link), { ...opts, upstream })));
      const r = spawnSync(bin, ["check", "-c", file], { encoding: "utf8" });
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    });
  }
}
