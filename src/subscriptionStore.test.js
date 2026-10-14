import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSubscriptionStore } from "./subscriptionStore.js";

const fakeCrypto = { protect: (b) => b, unprotect: (b) => b };
const fresh = () => createSubscriptionStore(mkdtempSync(path.join(tmpdir(), "nyx-subs-")), { crypto: fakeCrypto, logger: () => {} });

test("a subscription starts with the host name unless the user typed one", () => {
  const store = fresh();
  const a = store.add({ url: "https://a.example/s", name: "a.example" });
  const b = store.add({ url: "https://b.example/s", name: "  Моя   подписка ", custom: true });
  const [sa, sb] = [store.list().find((s) => s.id === a), store.list().find((s) => s.id === b)];
  assert.equal(sa.name, "a.example");
  assert.equal(sa.nameIsCustom, false);
  assert.equal(sb.name, "Моя подписка");
  assert.equal(sb.nameIsCustom, true);
});

test("adding the same address twice returns the same subscription", () => {
  const store = fresh();
  const a = store.add({ url: "https://a.example/s", name: "x" });
  assert.equal(store.add({ url: "https://a.example/s", name: "y" }), a);
  assert.equal(store.list().length, 1);
});

test("rename keeps the user's name against the server's title", () => {
  const store = fresh();
  const id = store.add({ url: "https://a.example/s", name: "a.example" });
  assert.equal(store.applyServerTitle(id, "Server title"), true);
  assert.equal(store.list()[0].name, "Server title");
  assert.equal(store.rename(id, "Семья"), true);
  assert.equal(store.applyServerTitle(id, "Another title"), false);
  assert.equal(store.list()[0].name, "Семья");
  assert.equal(store.list()[0].nameIsCustom, true);
});

test("an empty or missing name is refused", () => {
  const store = fresh();
  const id = store.add({ url: "https://a.example/s", name: "a.example" });
  assert.equal(store.rename(id, "   "), false);
  assert.equal(store.rename("nope", "x"), false);
  assert.equal(store.applyServerTitle(id, ""), false);
  assert.equal(store.list()[0].name, "a.example");
});

test("a name is limited in length", () => {
  const store = fresh();
  const id = store.add({ url: "https://a.example/s", name: "x" });
  store.rename(id, "n".repeat(200));
  assert.equal(store.list()[0].name.length, 60);
});

test("patch stores usage and survives a reload", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nyx-subs-"));
  const open = () => createSubscriptionStore(dir, { crypto: fakeCrypto, logger: () => {} });
  const store = open();
  const id = store.add({ url: "https://a.example/s", name: "x" });
  store.patch(id, { usage: { used: 5, total: 10, expire: null } });
  assert.deepEqual(open().list()[0].usage, { used: 5, total: 10, expire: null });
});
