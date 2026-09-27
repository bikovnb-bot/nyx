import { test } from "node:test";
import assert from "node:assert/strict";
import { redactVlessLink } from "./redact.js";

test("masks the UUID credential but keeps the rest of the link readable", () => {
  const link = "vless://e0ea4d17-d8ae-4a11-ae9b-ca5d4a01bcfb@5.145.176.51:443?security=tls#Test";
  const redacted = redactVlessLink(link);
  assert.ok(!redacted.includes("e0ea4d17-d8ae-4a11-ae9b-ca5d4a01bcfb"));
  assert.ok(redacted.startsWith("vless://e0ea"));
  assert.ok(redacted.includes("@5.145.176.51:443?security=tls#Test"));
});

test("passes through anything that isn't a vless link unchanged", () => {
  assert.equal(redactVlessLink("not a link"), "not a link");
  assert.equal(redactVlessLink(""), "");
});
