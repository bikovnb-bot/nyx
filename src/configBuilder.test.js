import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSingBoxConfig } from "./configBuilder.js";
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
