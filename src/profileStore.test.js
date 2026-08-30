import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
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

// A reversible but non-identity codec, standing in for safeStorage — enough
// to prove the store round-trips through *some* transform rather than only
// ever reading back what it just wrote in the same shape.
const reverseCodec = {
  encode: (str) => Buffer.from(str.split("").reverse().join(""), "utf8"),
  decode: (buf) => buf.toString("utf8").split("").reverse().join(""),
};

test("add/load round-trips a profile with the default (plaintext) codec", () => {
  withTempDir((dir) => {
    const store = createProfileStore(dir);
    const id = store.add({ name: "Test", link: "vless://uuid@host:443" });
    const profiles = store.load();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].id, id);
    assert.equal(profiles[0].name, "Test");
  });
});

test("add/load round-trips through a non-identity codec", () => {
  withTempDir((dir) => {
    const store = createProfileStore(dir, reverseCodec);
    store.add({ name: "Encoded", link: "vless://uuid@host:443" });
    const profiles = store.load();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].name, "Encoded");

    // The file on disk should not contain the plaintext name.
    const raw = readFileSync(profileStorePath(dir), "utf8");
    assert.ok(!raw.includes("Encoded"));
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

test("migrates and deletes a legacy plaintext profiles.json", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "profiles.json"),
      JSON.stringify([{ id: "legacy1", name: "Legacy", link: "vless://old@host:443" }])
    );

    const store = createProfileStore(dir, reverseCodec);
    const profiles = store.load();

    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].name, "Legacy");
    assert.ok(!existsSync(path.join(dir, "profiles.json")), "legacy file should be removed after migration");
    assert.ok(existsSync(profileStorePath(dir)), "profiles should be re-saved through the new codec");
  });
});

test("returns an empty list when nothing has been saved yet", () => {
  withTempDir((dir) => {
    const store = createProfileStore(dir);
    assert.deepEqual(store.load(), []);
  });
});
