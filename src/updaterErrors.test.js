import { test } from "node:test";
import assert from "node:assert/strict";
import {
  networkErrorCode,
  isTransientNetworkError,
  summarizeUpdaterError,
  createRetryPolicy,
} from "./updaterErrors.js";

const FEED = Array.from({ length: 60 }, (_, i) => `<entry><id>tag:${i}</id></entry>`).join("\n");
const feedError = (code) =>
  new Error(
    `Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/o/r/releases/latest), please ensure a production release exists: Error: net::${code}\nXML:\n<feed>${FEED}</feed>\n    at newError (x.js:5:19)`,
  );

test("finds the net:: code in a long feed dump", () => {
  assert.equal(networkErrorCode(new Error(`a\n${FEED}\nError: net::ERR_NETWORK_CHANGED`)), "ERR_NETWORK_CHANGED");
});

test("network changes and DNS failures are transient", () => {
  assert.equal(isTransientNetworkError(feedError("ERR_NETWORK_CHANGED")), true);
  assert.equal(isTransientNetworkError(feedError("ERR_NAME_NOT_RESOLVED")), true);
  assert.equal(isTransientNetworkError(new Error("connect ETIMEDOUT 1.2.3.4:443")), true);
});

test("a real problem is not transient", () => {
  assert.equal(isTransientNetworkError(new Error("sha512 checksum mismatch")), false);
  assert.equal(isTransientNetworkError(new Error("HttpError: 404 Not Found")), false);
  assert.equal(isTransientNetworkError(null), false);
});

test("summary is a single short line that keeps the code", () => {
  const s = summarizeUpdaterError(feedError("ERR_NETWORK_CHANGED"));
  assert.ok(!s.includes("\n"));
  assert.ok(s.length < 400);
  assert.ok(s.includes("ERR_NETWORK_CHANGED"));
});

test("summary of a plain message is unchanged", () => {
  assert.equal(summarizeUpdaterError(new Error("sha512 checksum mismatch")), "sha512 checksum mismatch");
  assert.equal(summarizeUpdaterError(undefined), "unknown updater error");
});

test("retry policy retries transient errors a limited number of times", () => {
  const policy = createRetryPolicy({ delayMs: 10, maxRetries: 2 });
  const err = feedError("ERR_NETWORK_CHANGED");
  assert.equal(policy.next(err), 10);
  assert.equal(policy.next(err), 10);
  assert.equal(policy.next(err), null);
  policy.reset();
  assert.equal(policy.next(err), 10);
});

test("retry policy never retries a real error", () => {
  assert.equal(createRetryPolicy().next(new Error("sha512 checksum mismatch")), null);
});
