import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { restore, restoreAsync, isEngaged } from "./killswitch.js";

const windows = process.platform === "win32";

// The state file names an adapter that does not exist, so nothing on this machine
// is touched; what is checked is that the restore finishes and clears its state.
function withState(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "nyx-killswitch-"));
  writeFileSync(path.join(dir, "killswitch-state.json"), JSON.stringify(["Nyx test adapter that does not exist", "it's quoted"]));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("restore without a state file does nothing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nyx-killswitch-"));
  restore(dir, () => {});
  await restoreAsync(dir, () => {});
  assert.equal(isEngaged(dir), false);
  rmSync(dir, { recursive: true, force: true });
});

test("restore clears the state", { skip: !windows }, () =>
  withState((dir) => {
    assert.equal(isEngaged(dir), true);
    restore(dir, () => {});
    assert.equal(isEngaged(dir), false);
  })
);

test("restoreAsync clears the state without blocking the event loop", { skip: !windows }, () =>
  withState(async (dir) => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    await restoreAsync(dir, () => {});
    clearInterval(timer);
    assert.equal(existsSync(path.join(dir, "killswitch-state.json")), false);
    assert.ok(ticks > 0, "the event loop kept running");
  })
);
