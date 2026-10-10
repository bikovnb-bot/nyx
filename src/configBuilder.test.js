import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSingBoxConfig, resolveDnsServer } from "./configBuilder.js";
import { parseVlessLink } from "./parseLink.js";

test("builds a ws+tls outbound", () => {
  const profile = parseVlessLink(
    "vless://uuid-1@example.com:443?type=ws&security=tls&path=%2Fchat&host=cdn.example.com&sni=cdn.example.com"
  );
  const config = buildSingBoxConfig(profile);
  const outbound = config.outbounds[0];
  assert.equal(outbound.server, "example.com");
  assert.equal(outbound.server_port, 443);
  assert.equal(outbound.transport.type, "ws");
  assert.equal(outbound.transport.path, "/chat");
  assert.deepEqual(outbound.transport.headers, { Host: "cdn.example.com" });
  assert.equal(outbound.tls.enabled, true);
  assert.equal(outbound.tls.server_name, "cdn.example.com");
});

test("builds a reality outbound", () => {
  const profile = parseVlessLink("vless://uuid@host:443?security=reality&pbk=abc123&sid=de&sni=example.com");
  const config = buildSingBoxConfig(profile);
  const tls = config.outbounds[0].tls;
  assert.equal(tls.reality.enabled, true);
  assert.equal(tls.reality.public_key, "abc123");
  assert.equal(tls.reality.short_id, "de");
});

test("respects a custom interface name", () => {
  const profile = parseVlessLink("vless://uuid@host:443");
  const config = buildSingBoxConfig(profile, { interfaceName: "myTun" });
  assert.equal(config.inbounds[0].interface_name, "myTun");
});

test("adds no split-tunneling rules when disabled or unset", () => {
  const profile = parseVlessLink("vless://uuid@host:443");
  const config = buildSingBoxConfig(profile);
  assert.ok(!config.route.rules.some((r) => r.domain_suffix || r.process_name));
});

test("excludes the physical interface from TUN capture when provided", () => {
  const profile = parseVlessLink("vless://uuid@host:443");
  const config = buildSingBoxConfig(profile, { defaultInterfaceName: "Ethernet" });
  assert.deepEqual(config.inbounds[0].exclude_interface, ["Ethernet"]);
});

test("leaves exclude_interface unset when no default interface is known", () => {
  const profile = parseVlessLink("vless://uuid@host:443");
  const config = buildSingBoxConfig(profile);
  assert.equal(config.inbounds[0].exclude_interface, undefined);
});

test("routes listed domains and processes directly when split tunneling is enabled", () => {
  const profile = parseVlessLink("vless://uuid@host:443");
  const config = buildSingBoxConfig(profile, {
    splitTunneling: { enabled: true, domains: ["example.com"], processes: ["chrome.exe"] },
  });
  const domainRule = config.route.rules.find((r) => r.domain_suffix);
  const processRule = config.route.rules.find((r) => r.process_name);
  assert.deepEqual(domainRule, { domain_suffix: ["example.com"], outbound: "direct" });
  assert.deepEqual(processRule, { process_name: ["chrome.exe"], outbound: "direct" });
});

test("ready-made routing: Russian sites direct, ads blocked, only when enabled", () => {
  const profile = parseVlessLink("vless://uuid@host:443");
  const off = buildSingBoxConfig(profile, { rulesDir: "/r" });
  assert.equal(off.route.rule_set, undefined);
  assert.equal(off.dns.rules, undefined);
  assert.equal(off.dns.servers.length, 1);

  const on = buildSingBoxConfig(profile, { rulesDir: "/r", routing: { directRu: true, blockAds: true } });
  assert.deepEqual(on.route.rule_set.map((r) => r.tag), ["geosite-ru", "geoip-ru", "geosite-ads"]);
  assert.ok(on.route.rules.some((r) => r.rule_set?.includes("geoip-ru") && r.outbound === "direct"));
  assert.ok(on.route.rules.some((r) => r.rule_set?.includes("geosite-ads") && r.action === "reject"));
  assert.ok(on.dns.servers.some((s) => s.tag === "ru-dns"));
  // plain UDP DNS did not get answered in practice; DoH works
  assert.equal(on.dns.servers.find((s) => s.tag === "ru-dns").type, "https");
  // the direct outbound must resolve names through it, not through the tunnel
  assert.deepEqual(on.outbounds.find((x) => x.tag === "direct").domain_resolver, { server: "ru-dns", strategy: "ipv4_only" });
  assert.ok(on.dns.rules.filter((r) => r.server === "ru-dns").every((r) => r.strategy === "ipv4_only"));
  // ads are rejected before anything can be routed directly
  const adsAt = on.route.rules.findIndex((r) => r.rule_set?.includes("geosite-ads"));
  const directAt = on.route.rules.findIndex((r) => r.outbound === "direct");
  assert.ok(adsAt < directAt);
  // without the rules folder the options are ignored instead of producing a broken config
  assert.equal(buildSingBoxConfig(profile, { routing: { directRu: true } }).route.rule_set, undefined);
});

test("DNS provider selection, with a safe fallback for bad custom values", () => {
  assert.equal(resolveDnsServer({ provider: "google" }), "8.8.8.8");
  assert.equal(resolveDnsServer({ provider: "quad9" }), "9.9.9.9");
  assert.equal(resolveDnsServer({ provider: "custom", custom: " 9.9.9.10 " }), "9.9.9.10");
  assert.equal(resolveDnsServer({ provider: "custom", custom: "evil.example" }), "1.1.1.1");
  assert.equal(resolveDnsServer(undefined), "1.1.1.1");
  const profile = parseVlessLink("vless://uuid@host:443");
  assert.equal(buildSingBoxConfig(profile, { dns: { provider: "google" } }).dns.servers[0].server, "8.8.8.8");
});

test("TLS fragment is only added when enabled", () => {
  const tls = parseVlessLink("vless://uuid@host:443?security=tls");
  assert.equal(buildSingBoxConfig(tls).outbounds[0].tls.fragment, undefined);
  assert.equal(buildSingBoxConfig(tls, { fragment: true }).outbounds[0].tls.fragment, true);
});
