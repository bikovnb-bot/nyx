import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVlessLink } from "./parseLink.js";

test("parses a basic ws+tls link", () => {
  const p = parseVlessLink(
    "vless://uuid-1@example.com:443?type=ws&security=tls&path=%2Fchat&host=cdn.example.com&fp=chrome#My%20Server"
  );
  assert.equal(p.uuid, "uuid-1");
  assert.equal(p.host, "example.com");
  assert.equal(p.port, 443);
  assert.equal(p.type, "ws");
  assert.equal(p.security, "tls");
  assert.equal(p.path, "/chat");
  assert.equal(p.wsHost, "cdn.example.com");
  assert.equal(p.name, "My Server");
});

test("rejects non-vless links", () => {
  assert.throws(() => parseVlessLink("vmess://foo"), /Only vless:\/\/ links/);
});

test("rejects missing uuid or host", () => {
  assert.throws(() => parseVlessLink("vless://"), /missing uuid or host/);
});

test("rejects missing port", () => {
  assert.throws(() => parseVlessLink("vless://uuid@host"), /missing host or port/);
});

test("rejects reality without a public key", () => {
  assert.throws(
    () => parseVlessLink("vless://uuid@host:443?security=reality"),
    /security=reality requires a pbk/
  );
});

test("accepts reality with a public key", () => {
  const p = parseVlessLink("vless://uuid@host:443?security=reality&pbk=abc123&sid=de");
  assert.equal(p.security, "reality");
  assert.equal(p.publicKey, "abc123");
  assert.equal(p.shortId, "de");
});

test("rejects grpc without a service name", () => {
  assert.throws(() => parseVlessLink("vless://uuid@host:443?type=grpc"), /type=grpc requires a serviceName/);
});

test("defaults type to tcp and security to none", () => {
  const p = parseVlessLink("vless://uuid@host:443");
  assert.equal(p.type, "tcp");
  assert.equal(p.security, "none");
});
