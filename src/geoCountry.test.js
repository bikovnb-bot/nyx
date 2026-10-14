import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GEO_URL,
  isPublicIp,
  parseGeoCountry,
  cachedCountry,
  needsLookup,
  profileCountryWithGeo,
  createGeoResolver,
} from "./geoCountry.js";

const profile = (name, host = "87.58.205.194") => ({
  name,
  link: `vless://uuid-secret@${host}:443?type=tcp&security=reality&pbk=k#${encodeURIComponent(name)}`,
});
const tick = () => new Promise((r) => setImmediate(r));

test("only a bare IP address goes into the request, never the link", () => {
  assert.equal(GEO_URL("87.58.205.194"), "https://ipwho.is/87.58.205.194?fields=success,country_code");
});

test("private and special addresses are not public", () => {
  for (const ip of ["10.0.0.1", "192.168.1.5", "172.20.0.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "::1", "fe80::1", "fd00::1", "example.com"]) {
    assert.equal(isPublicIp(ip), false, ip);
  }
  for (const ip of ["87.58.205.194", "5.145.176.51", "172.32.0.1", "2001:db8::1"]) {
    assert.equal(isPublicIp(ip), true, ip);
  }
});

test("parses the service answer and ignores countries without a bundled flag", () => {
  assert.equal(parseGeoCountry({ success: true, country_code: "RO" }), "ro");
  assert.equal(parseGeoCountry({ success: false }), null);
  assert.equal(parseGeoCountry({ success: true, country_code: "XX" }), null);
  assert.equal(parseGeoCountry(null), null);
});

test("cache: a hit is kept long, a miss is retried after a day", () => {
  const now = 1_000_000_000;
  assert.equal(needsLookup({}, "h", now), true);
  assert.equal(needsLookup({ h: { code: "ro", at: now - 5 * 24 * 3600 * 1000 } }, "h", now), false);
  assert.equal(needsLookup({ h: { code: null, at: now - 3600 * 1000 } }, "h", now), false);
  assert.equal(needsLookup({ h: { code: null, at: now - 25 * 3600 * 1000 } }, "h", now), true);
  assert.equal(cachedCountry({ h: { code: "ro", at: now } }, "h"), "ro");
  assert.equal(cachedCountry({ h: { code: null, at: now } }, "h"), null);
});

test("the name wins over the geolocation answer", () => {
  const cache = { "87.58.205.194": { code: "ro", at: 1 } };
  assert.equal(profileCountryWithGeo(profile("user1"), cache), "ro");
  assert.equal(profileCountryWithGeo(profile("🇩🇪 Berlin"), cache), "de");
  assert.equal(profileCountryWithGeo(profile("user1"), {}), null);
});

test("resolver looks up only nameless profiles, once, and reports the change", async () => {
  const cache = {};
  const asked = [];
  let saved = 0;
  let changed = 0;
  const resolver = createGeoResolver({
    cache,
    save: () => saved++,
    fetchCountry: async (ip) => (asked.push(ip), "ro"),
    onChange: () => changed++,
  });
  const profiles = [profile("user1"), profile("🇩🇪 Berlin", "1.2.3.4"), profile("second", "87.58.205.194")];
  resolver.queue(profiles);
  resolver.queue(profiles); // in flight: must not ask twice
  await tick();
  resolver.queue(profiles); // cached now: must not ask again
  await tick();
  assert.deepEqual(asked, ["87.58.205.194"]);
  assert.equal(cache["87.58.205.194"].code, "ro");
  assert.equal(saved, 1);
  assert.equal(changed, 1);
});

test("a network failure is not cached, so it is retried", async () => {
  const cache = {};
  let calls = 0;
  const resolver = createGeoResolver({
    cache,
    save() {},
    fetchCountry: async () => {
      calls++;
      throw new Error("offline");
    },
  });
  resolver.queue([profile("user1")]);
  await tick();
  resolver.queue([profile("user1")]);
  await tick();
  assert.equal(calls, 2);
  assert.deepEqual(cache, {});
});

test("a private address is never sent to the service", async () => {
  const cache = {};
  let calls = 0;
  const resolver = createGeoResolver({ cache, save() {}, fetchCountry: async () => (calls++, "ro") });
  resolver.queue([profile("lan", "192.168.1.10")]);
  await tick();
  assert.equal(calls, 0);
  assert.equal(cache["192.168.1.10"].code, null);
});

test("domains are resolved first; without a resolver they are skipped", async () => {
  const cache = {};
  const asked = [];
  const withDns = createGeoResolver({
    cache,
    save() {},
    resolveHost: async () => "5.145.176.51",
    fetchCountry: async (ip) => (asked.push(ip), "gb"),
  });
  withDns.queue([profile("vpn", "vpn.example.com")]);
  await tick();
  assert.deepEqual(asked, ["5.145.176.51"]);
  assert.equal(cache["vpn.example.com"].code, "gb");

  const noDns = createGeoResolver({ cache: {}, save() {}, fetchCountry: async () => "gb" });
  noDns.queue([profile("vpn", "other.example.com")]);
  await tick();
});
