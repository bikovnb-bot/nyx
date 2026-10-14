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

test("rejects QUIC and keeps the TUN MTU below 1500", () => {
  const config = buildSingBoxConfig(parseVlessLink("vless://uuid@host:443"));
  assert.ok(config.route.rules.some((r) => r.protocol === "quic" && r.action === "reject"));
  assert.ok(config.inbounds[0].mtu < 1500);
  const sniffAt = config.route.rules.findIndex((r) => r.action === "sniff");
  const quicAt = config.route.rules.findIndex((r) => r.protocol === "quic");
  assert.ok(sniffAt >= 0 && sniffAt < quicAt, "sniff must run before the QUIC rule");
});

test("keeps the tunnel IPv4-only: no IPv6 TUN address and AAAA answered empty", () => {
  const config = buildSingBoxConfig(parseVlessLink("vless://uuid@host:443"));
  assert.ok(config.inbounds[0].address.every((a) => !a.includes(":")));
  const aaaa = config.dns.rules[0];
  assert.deepEqual(aaaa.query_type, ["AAAA"]);
  assert.equal(aaaa.action, "predefined");
  assert.equal(aaaa.rcode, "NOERROR");
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
  const profile = parseVlessLink("vless://uuid@203.0.113.5:443");
  const off = buildSingBoxConfig(profile, { rulesDir: "/r" });
  assert.equal(off.route.rule_set, undefined);
  // only the always-on AAAA rule, nothing from the optional routing
  assert.equal(off.dns.rules.length, 1);
  assert.deepEqual(off.dns.rules[0].query_type, ["AAAA"]);
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
  // sing-box 1.14 rejects the legacy per-rule `strategy` next to the AAAA rule
  assert.ok(on.dns.rules.every((r) => r.strategy === undefined));
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

test("a server given by name is resolved outside the tunnel, an IP needs no resolver", () => {
  const named = buildSingBoxConfig(parseVlessLink("vless://uuid@cloud.example.com:443?type=ws&security=tls"), { dns: { provider: "google" } });
  const proxy = named.outbounds.find((o) => o.tag === "proxy");
  assert.deepEqual(proxy.domain_resolver, { server: "bootstrap-dns", strategy: "ipv4_only" });
  const boot = named.dns.servers.find((x) => x.tag === "bootstrap-dns");
  assert.equal(boot.server, "8.8.8.8");
  assert.equal(boot.detour, undefined); // not through the proxy it is meant to reach
  assert.equal(named.dns.servers.find((x) => x.tag === "remote-dns").detour, "proxy");

  const byIp = buildSingBoxConfig(parseVlessLink("vless://uuid@203.0.113.5:443"));
  assert.equal(byIp.outbounds.find((o) => o.tag === "proxy").domain_resolver, undefined);
  assert.equal(byIp.dns.servers.find((x) => x.tag === "bootstrap-dns"), undefined);
});

test("the tunnel is IPv4-only: AAAA answered empty, small MTU, QUIC rejected", () => {
  const c = buildSingBoxConfig(parseVlessLink("vless://uuid@203.0.113.5:443"));
  const tun = c.inbounds.find((i) => i.type === "tun");
  assert.deepEqual(tun.address, ["172.19.0.1/30"]);
  assert.equal(tun.mtu, 1400);
  assert.deepEqual(c.dns.rules[0], { query_type: ["AAAA"], action: "predefined", rcode: "NOERROR" });
  assert.ok(c.route.rules.some((r) => r.protocol === "quic" && r.action === "reject"));
});

test("upstream core: the proxy outbound is a local SOCKS port, not the server", () => {
  const profile = parseVlessLink("vless://uuid-1@cloud.example.com:443?type=ws&security=tls&path=%2Fs");
  const config = buildSingBoxConfig(profile, { upstream: { port: 10808, auth: { user: "u", pass: "p" } } });
  const proxy = config.outbounds.find((o) => o.tag === "proxy");
  assert.deepEqual(proxy, { type: "socks", tag: "proxy", server: "127.0.0.1", server_port: 10808, version: "5", username: "u", password: "p" });
  // sing-box never connects to the server, so no bootstrap DNS for its name
  assert.ok(!config.dns.servers.some((s) => s.tag === "bootstrap-dns"));
  assert.equal(config.route.final, "proxy");
});

test("upstream core: its own connection to the server bypasses the tunnel", () => {
  const profile = parseVlessLink("vless://uuid-1@203.0.113.5:443?type=tcp");
  const config = buildSingBoxConfig(profile, { upstream: { port: 1, serverIps: ["203.0.113.5", "2001:db8::1"], processNames: ["xray.exe"] } });
  const [byProcess, byAddress, sniff] = config.route.rules;
  assert.deepEqual(byProcess, { process_name: ["xray.exe"], outbound: "direct" });
  assert.deepEqual(byAddress, { ip_cidr: ["203.0.113.5/32", "2001:db8::1/128"], outbound: "direct" });
  assert.deepEqual(sniff, { action: "sniff" });
});

test("without an upstream core nothing changes", () => {
  const profile = parseVlessLink("vless://uuid-1@203.0.113.5:443?type=tcp");
  const config = buildSingBoxConfig(profile);
  assert.equal(config.outbounds[0].type, "vless");
  assert.deepEqual(config.route.rules[0], { action: "sniff" });
});
