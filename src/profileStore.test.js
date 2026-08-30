import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProfileStore, profileStorePath } from "./profileStore.js";

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "nyx-profiles-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Stands in for the old safeStorage-backed codec used to migrate a leftover
// profiles.dat from before encryption was reverted (see profileStore.js).
const reverseCodec = {
  encode: (str) => Buffer.from(str.split("").reverse().join(""), "utf8"),
  decode: (buf) => buf.toString("utf8").split("").reverse().join(""),
};

test("add/load round-trips a profile as plain JSON", () => {
  withTempDir((dir) => {
    const store = createProfileStore(dir);
    const id = store.add({ name: "Test", link: "vless://uuid@host:443" });
    const profiles = store.load();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].id, id);
    assert.equal(profiles[0].name, "Test");

    // Plain JSON on disk — no encryption layer to survive an app update.
    const raw = readFileSync(profileStorePath(dir), "utf8");
    assert.ok(raw.includes("Test"));
  });
});

test("update and remove operate on the right profile", () => {
  withTempDir((dir) => {
    const store = createProfileStore(dir);
    const id1 = store.add({ name: "One", link: "vless://a@host:443" });
    const id2 = store.add({ name: "Two", link: "vless://b@host:443" });

    store.update(id1, { name: "One renamed" });
    let profiles = store.load();
    assert.equal(profiles.find((p) => p.id === id1).name, "One renamed");
    assert.equal(profiles.find((p) => p.id === id2).name, "Two");

    store.remove(id2);
    profiles = store.load();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].id, id1);
  });
});

test("add() never collides ids for profiles created back-to-back", () => {
  withTempDir((dir) => {
    const store = createProfileStore(dir);
    const id1 = store.add({ name: "A", link: "vless://a@host:443" });
    const id2 = store.add({ name: "B", link: "vless://b@host:443" });
    assert.notEqual(id1, id2);
  });
});

test("migrates and deletes a legacy encrypted profiles.dat", () => {
  withTempDir((dir) => {
    const payload = JSON.stringify([{ id: "legacy1", name: "Legacy", link: "vless://old@host:443" }]);
    writeFileSync(path.join(dir, "profiles.dat"), reverseCodec.encode(payload));

    const store = createProfileStore(dir, reverseCodec);
    const profiles = store.load();

    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].name, "Legacy");
    assert.ok(!existsSync(path.join(dir, "profiles.dat")), "legacy encrypted file should be removed after migration");
    assert.ok(existsSync(profileStorePath(dir)), "profiles should be re-saved as plain JSON");
  });
});

test("gives up quietly if the legacy profiles.dat can't be decoded", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, "profiles.dat"), Buffer.from([1, 2, 3, 4]));
    const store = createProfileStore(dir);
    assert.deepEqual(store.load(), []);
  });
});

test("returns an empty list when nothing has been saved yet", () => {
  withTempDir((dir) => {
    const store = createProfileStore(dir);
    assert.deepEqual(store.load(), []);
  });
});
