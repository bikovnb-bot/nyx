import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSettingsStore, settingsStorePath } from "./settingsStore.js";

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "nyx-settings-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("load() returns safe defaults when nothing has been saved yet", () => {
  withTempDir((dir) => {
    const store = createSettingsStore(dir);
    const settings = store.load();
    assert.equal(settings.killSwitchEnabled, false);
    assert.equal(settings.splitTunneling.enabled, false);
    assert.deepEqual(settings.splitTunneling.domains, []);
    assert.deepEqual(settings.splitTunneling.processes, []);
  });
});

test("update() merges partial changes, including nested splitTunneling", () => {
  withTempDir((dir) => {
    const store = createSettingsStore(dir);
    store.update({ killSwitchEnabled: true });
    let settings = store.load();
    assert.equal(settings.killSwitchEnabled, true);
    assert.equal(settings.splitTunneling.enabled, false);

    store.update({ splitTunneling: { enabled: true, domains: ["example.com"] } });
    settings = store.load();
    assert.equal(settings.killSwitchEnabled, true, "unrelated setting should survive a partial update");
    assert.equal(settings.splitTunneling.enabled, true);
    assert.deepEqual(settings.splitTunneling.domains, ["example.com"]);
    assert.deepEqual(settings.splitTunneling.processes, []);
  });
});

test("load() tolerates a corrupted settings file", () => {
  withTempDir((dir) => {
    const store = createSettingsStore(dir, () => {});
    writeFileSync(settingsStorePath(dir), "{not json");
    assert.deepEqual(store.load().splitTunneling, { enabled: false, domains: [], processes: [] });
  });
});
