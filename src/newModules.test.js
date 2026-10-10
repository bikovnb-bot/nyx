import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTrafficStats, dayKey } from "./trafficStats.js";
import { parseSubscription, planSubscriptionSync, linkKey, nameFromLink, decodeSubscriptionBody } from "./subscription.js";
import { pickBest, buildReconnectPlan, sortWithFavorites } from "./selection.js";
import { createSecureJsonStore } from "./secureStore.js";
import { createSubscriptionStore } from "./subscriptionStore.js";
import { createProfileStore } from "./profileStore.js";
import { createSettingsStore, mergeSettings } from "./settingsStore.js";
import { qrSvg } from "./qr.js";
import { parseSingBoxVersion } from "./singbox.js";

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "nyx-new-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fakeCrypto = {
  protect: (buf) => Buffer.from(buf.toString("base64")),
  unprotect: (buf) => Buffer.from(buf.toString("utf8"), "base64"),
};

/* ---------------- traffic stats ---------------- */

test("traffic stats accumulate per day and per profile, with zero-filled days", () =>
  withTempDir((dir) => {
    let clock = new Date(2026, 9, 10, 12, 0, 0);
    const stats = createTrafficStats(dir, { now: () => clock });
    stats.add("a", 100, 1000);
    stats.add("a", 50, 500);
    stats.add("b", 10, 10);
    clock = new Date(2026, 9, 11, 9, 0, 0);
    stats.add("a", 1, 2);

    const s = stats.summary(3);
    assert.deepEqual(s.days.map((d) => d.date), ["2026-10-09", "2026-10-10", "2026-10-11"]);
    assert.deepEqual(s.days.map((d) => d.down), [0, 1510, 2]);
    assert.equal(s.profiles[0].id, "a");
    assert.deepEqual(s.totals, { up: 161, down: 1512 });
  }));

test("traffic stats persist across instances and drop data older than 90 days", () =>
  withTempDir((dir) => {
    const old = new Date(2026, 5, 1);
    const early = createTrafficStats(dir, { now: () => old });
    early.add("a", 5, 5);
    early.flush();

    const later = createTrafficStats(dir, { now: () => new Date(2026, 9, 10) });
    later.add("a", 1, 1);
    later.flush();
    const raw = JSON.parse(readFileSync(path.join(dir, "traffic-stats.json"), "utf8"));
    assert.ok(!raw[dayKey(old)], "June data is more than 90 days old and must be pruned");
    assert.ok(raw["2026-10-10"]);
  }));

test("traffic stats ignore empty samples and survive a corrupt file", () =>
  withTempDir((dir) => {
    writeFileSync(path.join(dir, "traffic-stats.json"), "{not json");
    const stats = createTrafficStats(dir, { logger: () => {} });
    stats.add("a", 0, 0);
    stats.flush();
    assert.deepEqual(stats.summary(1).totals, { up: 0, down: 0 });
  }));

/* ---------------- subscriptions ---------------- */

const L1 = "vless://u1@h1.example:443?type=ws&security=tls#%F0%9F%87%A9%F0%9F%87%AA%20Berlin";
const L2 = "vless://u2@h2.example:443?security=reality#Fast";

test("parses plain and base64 subscription bodies and counts unsupported links", () => {
  const plain = `${L1}\n${L2}\nvmess://abc\ntrojan://def\n\n`;
  assert.deepEqual(parseSubscription(plain).links, [L1, L2]);
  assert.equal(parseSubscription(plain).skipped, 2);

  const b64 = Buffer.from(plain, "utf8").toString("base64");
  assert.deepEqual(parseSubscription(b64).links, [L1, L2]);
  const urlSafe = b64.replace(/\+/g, "-").replace(/\//g, "_");
  assert.deepEqual(parseSubscription(urlSafe).links, [L1, L2]);
  assert.equal(decodeSubscriptionBody("vless://x@y:1"), "vless://x@y:1");
});

test("duplicate servers inside one subscription collapse to one", () => {
  const dup = `${L1}\n${L1.replace("#", "&x=1#")}`;
  assert.equal(parseSubscription(dup).links.length, 1);
});

test("link key ignores query and remark; names come from the remark", () => {
  assert.equal(linkKey(L1), linkKey("vless://U1@H1.example:443#other"));
  assert.match(nameFromLink(L1), /Berlin/);
  assert.equal(nameFromLink("vless://u@host.example:443"), "host.example");
});

test("sync plan adds new, updates changed links, removes vanished, keeps hand-added", () => {
  const existing = [
    { id: "1", name: "Mine renamed", link: L1 },
    { id: "2", name: "Gone", link: "vless://u9@gone:443#g" },
  ];
  const changedL1 = L1.replace("type=ws", "type=grpc");
  const handKey = linkKey("vless://u3@h3.example:443");
  const plan = planSubscriptionSync(existing, [changedL1, L2, "vless://u3@h3.example:443#H3"], new Set([handKey]));
  assert.deepEqual(plan.toUpdate, [{ id: "1", link: changedL1 }]);
  assert.deepEqual(plan.toAdd.map((p) => p.name), ["Fast"]);
  assert.deepEqual(plan.toRemoveIds, ["2"]);
});

test("subscription store keeps URLs encrypted at rest", () =>
  withTempDir((dir) => {
    const store = createSubscriptionStore(dir, { crypto: fakeCrypto });
    const id = store.add({ url: "https://panel.example/sub/SECRETTOKEN", name: "Panel" });
    assert.equal(store.add({ url: "https://panel.example/sub/SECRETTOKEN" }), id, "same URL is not added twice");
    store.patch(id, { count: 3 });
    assert.equal(store.list()[0].count, 3);
    const raw = readFileSync(path.join(dir, "subscriptions.json"), "utf8");
    assert.ok(!raw.includes("SECRETTOKEN"));
    store.remove(id);
    assert.deepEqual(store.list(), []);
  }));

test("secure store falls back to plain JSON if encryption fails, and reads it back", () =>
  withTempDir((dir) => {
    const broken = { protect: () => { throw new Error("no dpapi"); }, unprotect: fakeCrypto.unprotect };
    const store = createSecureJsonStore(path.join(dir, "x.json"), { crypto: broken, fallback: [], logger: () => {} });
    store.save([{ a: 1 }]);
    assert.deepEqual(store.load(), [{ a: 1 }]);
  }));

test("profile store remembers the subscription a profile came from", () =>
  withTempDir((dir) => {
    const store = createProfileStore(dir, { crypto: fakeCrypto });
    store.add({ name: "A", link: L1, subscriptionId: "sub1" });
    store.add({ name: "B", link: L2 });
    const [a, b] = store.load();
    assert.equal(a.subscriptionId, "sub1");
    assert.equal("subscriptionId" in b, false);
  }));

/* ---------------- selection ---------------- */

const profiles = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

test("pickBest chooses the fastest reachable profile and honours exclusions", () => {
  const pings = { a: { ok: true, ms: 80 }, b: { ok: true, ms: 30 }, c: { ok: false }, d: { ok: true, ms: 50 } };
  assert.equal(pickBest(profiles, pings).profile.id, "b");
  assert.equal(pickBest(profiles, pings, ["b"]).profile.id, "d");
  assert.equal(pickBest(profiles, { a: { ok: false } }), null);
});

test("reconnect plan: failed profile first, explicit fallback second, rest by ping", () => {
  const pings = { b: { ok: true, ms: 90 }, c: { ok: false }, d: { ok: true, ms: 20 } };
  assert.deepEqual(buildReconnectPlan({ lostId: "a", fallbackId: "b", profiles, pings }), ["a", "b", "d"]);
  assert.deepEqual(buildReconnectPlan({ lostId: "a", fallbackId: "auto", profiles, pings }), ["a", "d", "b"]);
  assert.deepEqual(buildReconnectPlan({ lostId: "zzz", fallbackId: "zzz", profiles, pings }), ["d", "b"]);
});

/* ---------------- settings ---------------- */

test("settings merge nested objects one level deep and replace arrays", () => {
  const base = { splitTunneling: { enabled: false, domains: ["a"] }, favorites: ["x"], autoBest: { enabled: false } };
  const next = mergeSettings(base, { splitTunneling: { enabled: true }, favorites: ["y"], autoBest: { enabled: true } });
  assert.deepEqual(next.splitTunneling, { enabled: true, domains: ["a"] });
  assert.deepEqual(next.favorites, ["y"]);
  assert.equal(next.autoBest.enabled, true);
});

test("new settings have safe, opt-in defaults", () =>
  withTempDir((dir) => {
    const s = createSettingsStore(dir).load();
    assert.equal(s.autoBest.enabled, false);
    assert.equal(s.autoReconnect.enabled, false);
    assert.equal(s.autoReconnect.fallbackProfileId, "auto");
    assert.deepEqual(s.favorites, []);
    assert.equal(s.hints.trayShown, false);
  }));

/* ---------------- QR ---------------- */

test("qr generator returns a self-contained SVG, including for non-ASCII text", () => {
  const svg = qrSvg("vless://u@h:443?x=1#Домашний");
  assert.match(svg, /^<svg/);
  assert.match(svg, /<\/svg>$/);
});

test("favorites sort first and keep their relative order", () => {
  const ps = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  assert.deepEqual(sortWithFavorites(ps, ["d", "b"]).map((p) => p.id), ["b", "d", "a", "c"]);
  assert.deepEqual(sortWithFavorites(ps, []).map((p) => p.id), ["a", "b", "c", "d"]);
});

test("profile store serves repeat loads from memory and notices outside changes", () =>
  withTempDir((dir) => {
    let unprotectCalls = 0;
    const counting = { protect: fakeCrypto.protect, unprotect: (b) => { unprotectCalls++; return fakeCrypto.unprotect(b); } };
    const store = createProfileStore(dir, { crypto: counting }, () => {});
    store.add({ name: "A", link: "vless://a@h:1" });
    const fresh = createProfileStore(dir, { crypto: counting }, () => {});
    fresh.load();
    fresh.load();
    fresh.load();
    assert.equal(unprotectCalls, 1, "second and third load must come from memory");

    // an edit made behind the store's back (another process) must not be hidden by the cache
    const other = createProfileStore(dir, { crypto: fakeCrypto }, () => {});
    other.add({ name: "B", link: "vless://b@h:1" });
    assert.equal(fresh.load().length, 2);
  }));

test("callers cannot corrupt the cache by mutating a loaded list", () =>
  withTempDir((dir) => {
    const store = createProfileStore(dir, { crypto: fakeCrypto }, () => {});
    store.add({ name: "A", link: "vless://a@h:1" });
    store.load().push({ id: "ghost" });
    assert.equal(store.load().length, 1);
  }));

test("sing-box version output is parsed, with a sane fallback", () => {
  assert.equal(parseSingBoxVersion("sing-box version 1.14.3\n\nEnvironment: go1.26"), "1.14.3");
  assert.equal(parseSingBoxVersion("something unexpected\nsecond line"), "something unexpected");
  assert.equal(parseSingBoxVersion(""), null);
  assert.equal(parseSingBoxVersion(undefined), null);
});
