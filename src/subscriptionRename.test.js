import { test } from "node:test";
import assert from "node:assert/strict";
import { planSubscriptionSync, nameFromLink } from "./subscription.js";

const uuid = "11111111-1111-1111-1111-111111111111";
const link = (host, name, extra = "type=ws&security=tls") => `vless://${uuid}@${host}:443?${extra}#${encodeURIComponent(name)}`;

test("a profile the user never renamed follows the new name from the server", () => {
  const oldLink = link("5.145.176.51", "England-1-🇬🇧Mobile-001");
  const newLink = link("5.145.176.51", "🇬🇧 United Kingdom");
  // what Nyx stored when the subscription was first added: the name from the link
  const existing = [{ id: "a", name: nameFromLink(oldLink), link: oldLink, subscriptionId: "s" }];
  const plan = planSubscriptionSync(existing, [newLink]);
  assert.deepEqual(plan.toUpdate, [{ id: "a", link: newLink, name: "🇬🇧 United Kingdom" }]);
});

test("a name the user typed is kept", () => {
  const oldLink = link("5.145.176.51", "England-1-Mobile-001");
  const newLink = link("5.145.176.51", "🇬🇧 United Kingdom");
  const existing = [{ id: "a", name: "Мой английский", link: oldLink, subscriptionId: "s" }];
  const plan = planSubscriptionSync(existing, [newLink]);
  assert.deepEqual(plan.toUpdate, [{ id: "a", link: newLink }]);
});

test("a changed link with the same name does not touch the name", () => {
  const oldLink = link("h.example", "Fast");
  const newLink = link("h.example", "Fast", "type=grpc&serviceName=x");
  const existing = [{ id: "a", name: "Fast", link: oldLink, subscriptionId: "s" }];
  assert.deepEqual(planSubscriptionSync(existing, [newLink]).toUpdate, [{ id: "a", link: newLink }]);
});

test("nothing is updated when the link is the same", () => {
  const l = link("h.example", "Fast");
  const existing = [{ id: "a", name: "Fast", link: l, subscriptionId: "s" }];
  assert.deepEqual(planSubscriptionSync(existing, [l]).toUpdate, []);
});

test("both servers of a two-server subscription are renamed independently", () => {
  const e1 = link("5.145.176.51", "England-1-Test");
  const r1 = link("87.58.205.194", "reality-443", "type=tcp&security=reality&pbk=k&sid=1");
  const existing = [
    { id: "gb", name: nameFromLink(e1), link: e1, subscriptionId: "s" },
    { id: "ro", name: "Румыния", link: r1, subscriptionId: "s" }, // the user renamed this one
  ];
  const plan = planSubscriptionSync(existing, [link("5.145.176.51", "🇬🇧 United Kingdom"), link("87.58.205.194", "🇷🇴 Romania", "type=tcp&security=reality&pbk=k&sid=1")]);
  const byId = Object.fromEntries(plan.toUpdate.map((u) => [u.id, u]));
  assert.equal(byId.gb.name, "🇬🇧 United Kingdom");
  assert.equal(byId.ro.name, undefined);
});
