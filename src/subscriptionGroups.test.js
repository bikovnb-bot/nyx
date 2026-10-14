import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectAddInput,
  parseProfileTitle,
  parseUserinfo,
  formatUsage,
  buildGroups,
  FAVORITES_GROUP_ID,
  MANUAL_GROUP_ID,
} from "./subscriptionGroups.js";

test("the + dialog tells a subscription from servers", () => {
  assert.deepEqual(detectAddInput("https://5.145.176.51:2096/sub/abc"), { kind: "subscription", url: "https://5.145.176.51:2096/sub/abc" });
  assert.equal(detectAddInput("  http://example.com/s  ").kind, "subscription");
  assert.deepEqual(detectAddInput("vless://u@h:443?type=tcp#a"), { kind: "servers", links: ["vless://u@h:443?type=tcp#a"] });
  const many = detectAddInput("vless://u@h:1#a\nvless://u@h:2#b\r\nvless://u@h:3#c");
  assert.equal(many.kind, "servers");
  assert.equal(many.links.length, 3);
});

test("the + dialog rejects what is neither", () => {
  for (const bad of ["", "   ", "hello", "vmess://abc", "ftp://example.com", "https://", "vless://u@h:1 hello", "https://a.com https://b.com"]) {
    assert.equal(detectAddInput(bad).kind, "unknown", JSON.stringify(bad));
  }
});

test("profile title: plain, base64 with Cyrillic, junk", () => {
  assert.equal(parseProfileTitle("My VPN"), "My VPN");
  const b64 = Buffer.from("Мой VPN 🇷🇴", "utf8").toString("base64");
  assert.equal(parseProfileTitle(`base64:${b64}`), "Мой VPN 🇷🇴");
  assert.equal(parseProfileTitle("base64:%%%"), null);
  assert.equal(parseProfileTitle(""), null);
  assert.equal(parseProfileTitle(null), null);
  assert.equal(parseProfileTitle("a\nb"), "a b");
  assert.equal(parseProfileTitle("x".repeat(100)).length, 60);
});

test("profile title decoding does not need Node's Buffer", () => {
  const body = `base64:${Buffer.from("Мой VPN", "utf8").toString("base64")}`;
  const saved = globalThis.Buffer;
  globalThis.Buffer = undefined;
  try {
    assert.equal(parseProfileTitle(body), "Мой VPN");
  } finally {
    globalThis.Buffer = saved;
  }
});

test("userinfo header: usage, limit, expiry", () => {
  assert.deepEqual(parseUserinfo("upload=12213540592; download=7224999567; total=0; expire=0"), { used: 19438540159, total: 0, expire: null });
  assert.deepEqual(parseUserinfo("upload=1; download=2; total=100; expire=1800000000"), { used: 3, total: 100, expire: 1800000000000 });
  assert.equal(parseUserinfo(""), null);
  assert.equal(parseUserinfo("nonsense"), null);
});

test("usage is shown for people: with and without a limit", () => {
  assert.equal(formatUsage({ used: 19438540159, total: 0, expire: null }), "18,1 ГБ");
  assert.equal(formatUsage({ used: 10 * 2 ** 30, total: 50 * 2 ** 30, expire: null }), "10 ГБ из 50 ГБ");
  assert.match(formatUsage({ used: 0, total: 2 ** 30, expire: new Date(2026, 10, 21).getTime() }), /до 21\.11\.2026$/);
  assert.equal(formatUsage(null), "");
});

const profiles = [
  { id: "m1", name: "Home" },
  { id: "a1", name: "England", subscriptionId: "sub-a", favorite: true },
  { id: "a2", name: "Romania", subscriptionId: "sub-a" },
  { id: "b1", name: "Germany", subscriptionId: "sub-b" },
];
const subs = [
  { id: "sub-a", name: "Family", updatedAt: 5, usage: { used: 1, total: 0, expire: null } },
  { id: "sub-b", name: "Work", error: "oops" },
  { id: "sub-empty", name: "Empty" },
];

test("groups: favorites, then manual servers, then each subscription", () => {
  const g = buildGroups(profiles, subs, { activeProfileId: "a2" });
  assert.deepEqual(g.map((x) => x.id), [FAVORITES_GROUP_ID, MANUAL_GROUP_ID, "sub-a", "sub-b", "sub-empty"]);
  assert.deepEqual(g.find((x) => x.id === "sub-a").profiles.map((p) => p.id), ["a1", "a2"]);
  assert.equal(g.find((x) => x.id === "sub-a").name, "Family");
  assert.equal(g.find((x) => x.id === "sub-b").error, "oops");
  assert.equal(g.find((x) => x.id === "sub-a").usage.used, 1);
  // a favorite also stays in its own group
  assert.equal(g.find((x) => x.id === FAVORITES_GROUP_ID).profiles[0].id, "a1");
  assert.ok(g.find((x) => x.id === "sub-a").profiles.some((p) => p.id === "a1"));
});

test("groups: the active server is reported even when its group is collapsed", () => {
  const g = buildGroups(profiles, subs, { activeProfileId: "a2", collapsed: ["sub-a"] });
  const a = g.find((x) => x.id === "sub-a");
  assert.equal(a.collapsed, true);
  assert.equal(a.hasActive, true);
  assert.equal(g.find((x) => x.id === "sub-b").hasActive, false);
});

test("groups: no favorites or manual servers means no such group", () => {
  const g = buildGroups([{ id: "x", name: "x", subscriptionId: "sub-a" }], subs);
  assert.deepEqual(g.map((x) => x.id), ["sub-a", "sub-b", "sub-empty"]);
});

test("groups while filtering: groups open up and empty ones disappear", () => {
  const filtered = profiles.filter((p) => p.name === "Romania");
  const g = buildGroups(filtered, subs, { collapsed: ["sub-a", "sub-b"], filtering: true });
  assert.deepEqual(g.map((x) => x.id), ["sub-a"]);
  assert.equal(g[0].collapsed, false);
});

test("groups: an empty subscription is listed when nothing is filtered", () => {
  const g = buildGroups([], subs);
  assert.deepEqual(g.map((x) => x.id), ["sub-a", "sub-b", "sub-empty"]);
  assert.equal(g[0].count, 0);
});

test("the group header shows usage compactly with a coloured level", async () => {
  const { formatUsageBar } = await import("./subscriptionGroups.js");
  const GB = 1024 ** 3;
  const day = 86400000;
  const now = Date.UTC(2026, 9, 14);
  assert.equal(formatUsageBar(null, now), null);
  assert.deepEqual(formatUsageBar({ used: 10 * GB, total: 50 * GB, expire: now + 38 * day }, now), { text: "10 ГБ / 50 ГБ · 38 дн.", percent: 20, level: "ok" });
  assert.equal(formatUsageBar({ used: 40 * GB, total: 50 * GB, expire: null }, now).level, "mid");
  assert.equal(formatUsageBar({ used: 48 * GB, total: 50 * GB, expire: null }, now).level, "high");
  assert.deepEqual(formatUsageBar({ used: 2 * GB, total: 0, expire: null }, now), { text: "2 ГБ", percent: null, level: "ok" });
  assert.match(formatUsageBar({ used: 1, total: 10, expire: now - day }, now).text, /истекла/);
});
