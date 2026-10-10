import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AVAILABLE_FLAGS, profileCountryCode, emojiFlagCode, fragmentOf, hostOf } from "./country.js";

const link = (fragment) => `vless://uuid@5.145.176.51:443?type=ws&security=tls#${fragment}`;

test("reads a flag emoji from the link's remark, even if the profile was renamed", () => {
  const p = { name: "Домашний", link: link(encodeURIComponent("England-1-🇬🇧Домашний")) };
  assert.equal(profileCountryCode(p), "gb");
});

test("recognizes country and city names in Russian and English", () => {
  assert.equal(profileCountryCode({ name: "Reality Франкфурт", link: link("x") }), "de");
  assert.equal(profileCountryCode({ name: "Amsterdam fast", link: link("x") }), "nl");
});

test("short codes only match as whole words, so 'Reality' is not Italy", () => {
  assert.equal(profileCountryCode({ name: "Reality", link: link("x") }), null);
  assert.equal(profileCountryCode({ name: "DE-1", link: link("x") }), "de");
});

test("returns null when nothing identifies a country", () => {
  assert.equal(profileCountryCode({ name: "Резервный gRPC", link: link("backup") }), null);
});

test("helpers: fragment decoding, host extraction, emoji parsing", () => {
  assert.equal(fragmentOf("vless://a@h:1#%D0%B4%D0%B0"), "да");
  assert.equal(hostOf("vless://a@example.com:443?x=1#n"), "example.com");
  assert.equal(emojiFlagCode("🇩🇪 Berlin"), "de");
  assert.equal(emojiFlagCode("plain"), null);
});

test("every flag we claim to have exists as a bundled SVG", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "electron", "assets", "flags");
  const files = new Set(readdirSync(dir));
  const missing = [...AVAILABLE_FLAGS].filter((c) => !files.has(`${c}.svg`));
  assert.deepEqual(missing, []);
});
