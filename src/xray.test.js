import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { freeLoopbackPort, randomSocksAuth, waitForPort, findXrayBinary } from "./xray.js";
import { verifyBinary, verifySingBoxBinary } from "./singboxIntegrity.js";

test("freeLoopbackPort returns a port nothing listens on", async () => {
  const port = await freeLoopbackPort();
  assert.ok(port > 1024 && port < 65536);
  await assert.rejects(waitForPort(port, { timeoutMs: 200, intervalMs: 20 }), /timeout/);
});

test("waitForPort resolves once something starts listening", async () => {
  const port = await freeLoopbackPort();
  const server = createServer((s) => s.destroy());
  setTimeout(() => server.listen(port, "127.0.0.1"), 150);
  await waitForPort(port, { timeoutMs: 3000, intervalMs: 20 });
  server.close();
});

test("waitForPort gives up at once when the process is gone", async () => {
  const port = await freeLoopbackPort();
  const started = Date.now();
  await assert.rejects(waitForPort(port, { timeoutMs: 5000, isAlive: () => false }), /exited/);
  assert.ok(Date.now() - started < 1000);
});

test("SOCKS credentials are random per call", () => {
  const a = randomSocksAuth();
  const b = randomSocksAuth();
  assert.notEqual(a.pass, b.pass);
  assert.ok(a.user.length >= 8 && a.pass.length >= 24);
});

test("findXrayBinary honours XRAY_PATH only when the file exists", () => {
  const saved = process.env.XRAY_PATH;
  try {
    process.env.XRAY_PATH = path.join(tmpdir(), "definitely-not-here", "xray.exe");
    const found = findXrayBinary();
    assert.ok(found === null || existsSync(found));
    assert.notEqual(found, process.env.XRAY_PATH);
  } finally {
    if (saved === undefined) delete process.env.XRAY_PATH;
    else process.env.XRAY_PATH = saved;
  }
});

test("integrity baselines of the two cores are kept apart", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nyx-int-"));
  const a = path.join(dir, "a.exe");
  const b = path.join(dir, "b.exe");
  writeFileSync(a, "singbox-bytes");
  writeFileSync(b, "xray-bytes");
  assert.equal(verifySingBoxBinary(dir, a, "1.0.0", () => {}).ok, true);
  assert.equal(verifyBinary(dir, b, "1.0.0", () => {}, "xray").ok, true);
  assert.equal(verifySingBoxBinary(dir, a, "1.0.0", () => {}).ok, true);
  assert.equal(verifyBinary(dir, b, "1.0.0", () => {}, "xray").ok, true);
  writeFileSync(b, "tampered");
  assert.equal(verifyBinary(dir, b, "1.0.0", () => {}, "xray").reason, "mismatch");
  assert.equal(verifySingBoxBinary(dir, a, "1.0.0", () => {}).ok, true);
  assert.equal(verifyBinary(dir, path.join(dir, "none.exe"), "1.0.0", () => {}, "xray").reason, "missing");
});

// With a real binary (XRAY_PATH or vendor/xray.exe): the runner starts it, the
// SOCKS port comes up, and stopping it removes the config that holds the UUID.
import { runXray } from "./xray.js";
import { buildXrayConfig } from "./xrayConfig.js";
import { parseVlessLink } from "./parseLink.js";

test("runXray starts the real core, serves its port and cleans the config up", { skip: !findXrayBinary() && "no xray binary (set XRAY_PATH)" }, async () => {
  const port = await freeLoopbackPort();
  const profile = parseVlessLink("vless://11111111-1111-1111-1111-111111111111@203.0.113.5:443?type=tcp#x");
  const dir = mkdtempSync(path.join(tmpdir(), "nyx-run-"));
  const configPath = path.join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(buildXrayConfig(profile, { socksPort: port, socksAuth: randomSocksAuth() })));
  const child = runXray(configPath, {});
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    await waitForPort(port, { timeoutMs: 10000, isAlive: () => child.exitCode === null });
  } finally {
    child.kill();
    await exited;
  }
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(existsSync(dir), false, "the config folder is removed after the process exits");
});
