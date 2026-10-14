import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSubscriptionBody, parseSubscription } from "./subscription.js";

const LINKS = [
  "vless://aaaaaaaa-0000-0000-0000-000000000001@5.145.176.51:443?type=ws&security=tls&path=%2F#England-1-%F0%9F%87%AC%F0%9F%87%A7%D0%94%D0%BE%D0%BC",
  "vless://aaaaaaaa-0000-0000-0000-000000000001@87.58.205.194:443?type=tcp&security=reality&pbk=abc&sid=de#%F0%9F%87%B7%F0%9F%87%B4%20Romania",
];
const plain = LINKS.join("\n");
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

test("a base64 subscription (what 3X-UI serves) yields all its links", () => {
  assert.equal(parseSubscription(b64(plain)).links.length, 2);
});

test("URL-safe and unpadded base64 work too", () => {
  const urlSafe = b64(plain).replace(/\+/g, "-").replace(/\//g, "_");
  assert.equal(parseSubscription(urlSafe).links.length, 2);
  assert.equal(parseSubscription(b64(plain).replace(/=+$/, "")).links.length, 2);
});

test("non-ASCII text survives decoding (names with flags and Cyrillic)", () => {
  const text = "vless://u@h:443?type=tcp#🇬🇧 Домашний";
  assert.equal(decodeSubscriptionBody(b64(text)), text);
});

test("plain text is left alone", () => {
  assert.equal(decodeSubscriptionBody(plain), plain);
  assert.equal(parseSubscription(plain).links.length, 2);
});

test("decoding does not need Node's Buffer (the phone's WebView has none)", () => {
  const body = b64(plain);
  const japanese = "vless://u@h:1#名前";
  const japaneseBody = b64(japanese);
  const saved = globalThis.Buffer;
  globalThis.Buffer = undefined;
  try {
    assert.equal(parseSubscription(body).links.length, 2);
    assert.equal(decodeSubscriptionBody(japaneseBody), japanese);
  } finally {
    globalThis.Buffer = saved;
  }
});

test("garbage that only looks like base64 does not crash", () => {
  assert.doesNotThrow(() => decodeSubscriptionBody("abc"));
  assert.equal(parseSubscription("not a subscription").links.length, 0);
});
