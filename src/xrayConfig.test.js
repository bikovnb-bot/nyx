import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseVlessLink } from "./parseLink.js";
import { buildXrayConfig, chooseCore, normalizeCore } from "./xrayConfig.js";

const UUID = "11111111-1111-1111-1111-111111111111";
const links = {
  reality: `vless://${UUID}@203.0.113.5:443?type=tcp&security=reality&pbk=mhPpkjhAi2d5SGPiQFkYtBYYCoPMhDbCMBjrNFAErWw&sid=01ab&sni=www.cloudflare.com&fp=chrome&spx=%2F&flow=xtls-rprx-vision#r`,
  wsTls: `vless://${UUID}@cloud.example.com:443?type=ws&security=tls&path=%2Fs&host=cdn.example.com&sni=cloud.example.com#w`,
  wsTlsNoSni: `vless://${UUID}@cloud.example.com:443?type=ws&security=tls&path=%2Fs#w`,
  grpc: `vless://${UUID}@203.0.113.5:443?type=grpc&security=tls&serviceName=svc&sni=example.com#g`,
  xhttp: `vless://${UUID}@203.0.113.5:443?type=xhttp&security=tls&path=%2Fx&mode=packet-up&sni=example.com#x`,
  plain: `vless://${UUID}@203.0.113.5:80?type=tcp#p`,
};
const build = (name, opts = {}) => buildXrayConfig(parseVlessLink(links[name]), { socksPort: 10808, ...opts });
const proxy = (cfg) => cfg.outbounds.find((o) => o.tag === "proxy");

test("reality profile: keys, flow and the local SOCKS inbound", () => {
  const cfg = build("reality");
  assert.deepEqual(cfg.inbounds[0].port, 10808);
  assert.equal(cfg.inbounds[0].listen, "127.0.0.1");
  const out = proxy(cfg);
  assert.equal(out.settings.vnext[0].users[0].flow, "xtls-rprx-vision");
  assert.equal(out.settings.vnext[0].users[0].encryption, "none");
  assert.equal(out.streamSettings.security, "reality");
  const r = out.streamSettings.realitySettings;
  assert.equal(r.publicKey, "mhPpkjhAi2d5SGPiQFkYtBYYCoPMhDbCMBjrNFAErWw");
  assert.equal(r.shortId, "01ab");
  assert.equal(r.serverName, "www.cloudflare.com");
  assert.equal(r.fingerprint, "chrome");
});

test("ws+tls keeps the server name even when connecting by a resolved address", () => {
  const out = proxy(build("wsTls", { serverIp: "198.51.100.7" }));
  assert.equal(out.settings.vnext[0].address, "198.51.100.7");
  assert.equal(out.streamSettings.tlsSettings.serverName, "cloud.example.com");
  assert.equal(out.streamSettings.wsSettings.path, "/s");
  assert.equal(out.streamSettings.wsSettings.host, "cdn.example.com");
  // with no explicit SNI the original host name is what the TLS handshake asks for
  assert.equal(proxy(build("wsTlsNoSni", { serverIp: "198.51.100.7" })).streamSettings.tlsSettings.serverName, "cloud.example.com");
});

test("grpc, xhttp and plain tcp", () => {
  assert.equal(proxy(build("grpc")).streamSettings.grpcSettings.serviceName, "svc");
  const x = proxy(build("xhttp")).streamSettings;
  assert.equal(x.network, "xhttp");
  assert.equal(x.xhttpSettings.mode, "packet-up");
  assert.equal(x.xhttpSettings.path, "/x");
  const p = proxy(build("plain")).streamSettings;
  assert.equal(p.network, "tcp");
  assert.equal(p.security, "none");
});

test("an IP address is never used as the TLS server name", () => {
  const link = `vless://${UUID}@203.0.113.5:443?type=ws&security=tls&path=%2Fs#ip`;
  assert.equal(proxy(buildXrayConfig(parseVlessLink(link), { socksPort: 1 })).streamSettings.tlsSettings.serverName, undefined);
});

test("TLS fragment adds a helper outbound and routes the proxy through it", () => {
  const cfg = build("reality", { fragment: true });
  assert.ok(cfg.outbounds.some((o) => o.tag === "fragment" && o.settings.fragment.packets === "tlshello"));
  assert.equal(proxy(cfg).streamSettings.sockopt.dialerProxy, "fragment");
  assert.equal(proxy(build("reality")).streamSettings.sockopt, undefined);
  assert.equal(proxy(build("plain", { fragment: true })).streamSettings.sockopt, undefined);
});

test("the local SOCKS port can require a password", () => {
  const s = build("reality", { socksAuth: { user: "u", pass: "p" } }).inbounds[0].settings;
  assert.equal(s.auth, "password");
  assert.deepEqual(s.accounts, [{ user: "u", pass: "p" }]);
  assert.equal(build("reality").inbounds[0].settings.auth, "noauth");
});

test("core choice: auto sends Reality and XHTTP to Xray, the rest to sing-box", () => {
  const p = (name) => parseVlessLink(links[name]);
  assert.equal(chooseCore(p("reality"), "auto").core, "xray");
  assert.equal(chooseCore(p("xhttp"), "auto").core, "xray");
  assert.equal(chooseCore(p("wsTls"), "auto").core, "singbox");
  assert.equal(chooseCore(p("grpc"), "auto").core, "singbox");
  assert.equal(chooseCore(p("plain"), undefined).core, "singbox");
});

test("core choice: a manual choice wins, except where a core cannot do the job", () => {
  const p = (name) => parseVlessLink(links[name]);
  assert.equal(chooseCore(p("reality"), "singbox").core, "singbox");
  assert.equal(chooseCore(p("wsTls"), "xray").core, "xray");
  assert.deepEqual(chooseCore(p("xhttp"), "singbox"), { core: "xray", note: "xhttp-needs-xray" });
});

test("core choice: without the Xray binary Nyx falls back, or refuses XHTTP", () => {
  const p = (name) => parseVlessLink(links[name]);
  assert.deepEqual(chooseCore(p("reality"), "auto", { xrayAvailable: false }), { core: "singbox", note: null });
  assert.deepEqual(chooseCore(p("reality"), "xray", { xrayAvailable: false }), { core: "singbox", note: "xray-missing" });
  assert.deepEqual(chooseCore(p("xhttp"), "auto", { xrayAvailable: false }), { core: null, note: "xhttp-needs-xray-missing" });
});

test("unknown core values mean auto", () => {
  assert.equal(normalizeCore("nonsense"), "auto");
  assert.equal(normalizeCore(undefined), "auto");
  assert.equal(normalizeCore("xray"), "xray");
});

// The real Xray accepts every config the app can generate (set XRAY_PATH to an
// xray binary, or put vendor/xray.exe next to sing-box.exe). Skipped otherwise.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const xrayBin = process.env.XRAY_PATH || path.join(root, "vendor", process.platform === "win32" ? "xray.exe" : "xray");
const haveXray = existsSync(xrayBin);

for (const name of Object.keys(links)) {
  for (const fragment of [false, true]) {
    test(`xray accepts the config: ${name}${fragment ? " + fragment" : ""}`, { skip: !haveXray && "no xray binary (set XRAY_PATH)" }, () => {
      const file = path.join(mkdtempSync(path.join(tmpdir(), "nyx-xray-")), "config.json");
      writeFileSync(file, JSON.stringify(build(name, { fragment, socksAuth: { user: "u", pass: "p" } })));
      const r = spawnSync(xrayBin, ["run", "-test", "-c", file], { encoding: "utf8" });
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    });
  }
}
