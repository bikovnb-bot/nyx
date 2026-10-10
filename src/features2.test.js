import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { explainSingBoxLine, createIssueThrottle, cleanLogLine } from "./errorHints.js";
import { parseIpInfo, leakVerdict, describeDns } from "./leakCheck.js";
import { isValidRuleSet, refreshRules, pickRulesDir, hasAllRules, RULE_FILES, userRulesDir } from "./rulesUpdate.js";

const ESC = String.fromCharCode(27);

test("proxy errors get a plain explanation, direct-outbound noise is ignored", () => {
  const line = (msg) => `+0300 2026-10-10 18:09:00 ${ESC}[31mERROR${ESC}[0m [123 4ms] connection: open connection to 1.2.3.4:443 using outbound/vless[proxy]: ${msg}`;
  assert.equal(explainSingBoxLine(line("dial tcp 1.2.3.4:443: connectex: No connection could be made because the target machine actively refused it.")).kind, "refused");
  assert.equal(explainSingBoxLine(line("dial tcp 1.2.3.4:443: i/o timeout")).kind, "timeout");
  assert.equal(explainSingBoxLine(line("tls: failed to verify certificate: x509: certificate signed by unknown authority")).kind, "tls");
  assert.equal(explainSingBoxLine(line("REALITY: processed invalid connection")).kind, "reality");
  assert.equal(explainSingBoxLine(line("lookup example.com: no such host")).kind, "dns");
  assert.equal(explainSingBoxLine(line("dial tcp [2a02::1]:443: connectex: A socket operation was attempted to an unreachable network.")).kind, "network");
  // a failing Russian site sent directly says nothing about the server
  assert.equal(
    explainSingBoxLine("ERROR connection: open connection to [2a02:6b8::1d0]:443 using outbound/direct[direct]: dial tcp: unreachable network"),
    null
  );
  assert.equal(explainSingBoxLine("INFO outbound/vless[proxy]: outbound connection to example.com:443"), null);
  assert.equal(explainSingBoxLine(""), null);
});

test("fatal start-up errors are explained too, with a generic fallback", () => {
  assert.equal(explainSingBoxLine("FATAL start service: configure tun interface: Access is denied.").kind, "admin");
  assert.equal(explainSingBoxLine("FATAL start service: listen tcp 127.0.0.1:9095: bind: Only one usage of each socket address").kind, "port");
  const other = explainSingBoxLine("FATAL something nobody planned for");
  assert.equal(other.kind, "other");
  assert.ok(other.hint.includes("журнал"));
  assert.equal(cleanLogLine(`${ESC}[31mERROR${ESC}[0m x`), "ERROR x");
});

test("the same kind of issue is reported once per window", () => {
  let t = 0;
  const allow = createIssueThrottle(1000, () => t);
  assert.equal(allow("timeout"), true);
  assert.equal(allow("timeout"), false);
  assert.equal(allow("tls"), true);
  t = 1500;
  assert.equal(allow("timeout"), true);
});

test("IP info is normalised and bad answers are rejected", () => {
  const info = parseIpInfo({ success: true, ip: "5.145.176.51", country: "United Kingdom", country_code: "GB", city: "London", connection: { isp: "Example Ltd" } });
  assert.deepEqual(info, { ip: "5.145.176.51", country: "United Kingdom", countryCode: "gb", city: "London", isp: "Example Ltd" });
  assert.equal(parseIpInfo({ success: false, message: "x" }), null);
  assert.equal(parseIpInfo({ ip: "not-an-ip" }), null);
  assert.equal(parseIpInfo(null), null);
});

test("leak verdict compares with the real IP and the server address", () => {
  const info = { ip: "5.145.176.51" };
  assert.equal(leakVerdict({ connected: true, info: null }).level, "error");
  assert.equal(leakVerdict({ connected: false, info }).level, "info");
  assert.equal(leakVerdict({ connected: true, info, serverHost: "5.145.176.51", realIp: "9.9.9.9" }).level, "ok");
  assert.equal(leakVerdict({ connected: true, info, serverHost: "other.example", realIp: "9.9.9.9" }).level, "ok");
  assert.equal(leakVerdict({ connected: true, info, serverHost: "other.example", realIp: "5.145.176.51" }).level, "warn");
  assert.equal(leakVerdict({ connected: true, info, serverHost: "other.example", realIp: null }).level, "info");
});

test("the DNS description follows the settings", () => {
  assert.match(describeDns({ dns: { provider: "google" } }), /Google \(8\.8\.8\.8\)/);
  assert.match(describeDns({ dns: { provider: "custom", custom: "9.9.9.10" }, routing: { directRu: true } }), /свой сервер \(9\.9\.9\.10\).*Яндекс/);
  assert.match(describeDns({}), /Cloudflare/);
});

const srs = (extra = 400) => Buffer.concat([Buffer.from("SRS\u0001"), Buffer.alloc(extra, 7)]);

test("rule-set files are validated by their header and size", () => {
  assert.equal(isValidRuleSet(srs()), true);
  assert.equal(isValidRuleSet(Buffer.from("<html>not found</html>".repeat(30))), false);
  assert.equal(isValidRuleSet(Buffer.from("SRS\u0001")), false);
  assert.equal(isValidRuleSet(null), false);
});

test("refreshing the lists replaces the set only when every file is valid", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nyx-rules-"));
  const bundled = path.join(dir, "bundled");
  assert.equal(pickRulesDir(dir, bundled), bundled);

  await assert.rejects(() => refreshRules(dir, async (url) => (url.includes("geoip") ? Buffer.from("oops") : srs())), /geoip-ru\.srs/);
  assert.equal(hasAllRules(userRulesDir(dir)), false);
  assert.equal(pickRulesDir(dir, bundled), bundled);

  const res = await refreshRules(dir, async () => srs(500));
  assert.equal(res.files.length, Object.keys(RULE_FILES).length);
  assert.equal(pickRulesDir(dir, bundled), userRulesDir(dir));
  assert.equal(readFileSync(path.join(userRulesDir(dir), "geoip-ru.srs")).length, 504);
  assert.equal(existsSync(path.join(userRulesDir(dir), "geoip-ru.srs.tmp")), false);
});
