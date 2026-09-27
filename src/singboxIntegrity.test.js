import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifySingBoxBinary } from "./singboxIntegrity.js";

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "nyx-integrity-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("first run for a given app version records a trusted baseline", () => {
  withTempDir((dir) => {
    const binary = path.join(dir, "sing-box.exe");
    writeFileSync(binary, "fake-binary-v1");
    const result = verifySingBoxBinary(dir, binary, "0.1.7", () => {});
    assert.equal(result.ok, true);
    assert.equal(result.firstRun, true);
  });
});

test("same app version and unchanged binary verifies clean on later runs", () => {
  withTempDir((dir) => {
    const binary = path.join(dir, "sing-box.exe");
    writeFileSync(binary, "fake-binary-v1");
    verifySingBoxBinary(dir, binary, "0.1.7", () => {});
    const result = verifySingBoxBinary(dir, binary, "0.1.7", () => {});
    assert.equal(result.ok, true);
    assert.ok(!result.firstRun);
  });
});

test("flags a mismatch when the binary changes under the same app version", () => {
  withTempDir((dir) => {
    const binary = path.join(dir, "sing-box.exe");
    writeFileSync(binary, "fake-binary-v1");
    verifySingBoxBinary(dir, binary, "0.1.7", () => {});
    writeFileSync(binary, "tampered-binary");
    const result = verifySingBoxBinary(dir, binary, "0.1.7", () => {});
    assert.equal(result.ok, false);
    assert.equal(result.reason, "mismatch");
  });
});

test("an app version bump resets the baseline instead of flagging a mismatch", () => {
  withTempDir((dir) => {
    const binary = path.join(dir, "sing-box.exe");
    writeFileSync(binary, "fake-binary-v1");
    verifySingBoxBinary(dir, binary, "0.1.7", () => {});
    writeFileSync(binary, "fake-binary-v2-shipped-with-new-app-version");
    const result = verifySingBoxBinary(dir, binary, "0.1.8", () => {});
    assert.equal(result.ok, true);
    assert.equal(result.firstRun, true);
  });
});

test("reports a missing binary without throwing", () => {
  withTempDir((dir) => {
    const binary = path.join(dir, "does-not-exist.exe");
    const result = verifySingBoxBinary(dir, binary, "0.1.7", () => {});
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing");
  });
});
