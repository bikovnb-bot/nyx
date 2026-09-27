import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

export function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function baselinePath(userDataDir) {
  return path.join(userDataDir, "singbox-integrity.json");
}

// Trust-on-first-use: the first time a given app version runs, this
// remembers the bundled sing-box binary's hash. On every later run of the
// SAME app version it verifies the binary on disk still matches — catching
// an unexpected swap/tamper of the vendored executable — without needing a
// table of precomputed hashes for every sing-box release baked into Nyx.
// A new app version (which ships its own pinned sing-box build) resets the
// baseline, so app updates never trigger a false mismatch.
export function verifySingBoxBinary(userDataDir, binaryPath, appVersion, logger = console.error) {
  if (!existsSync(binaryPath)) return { ok: false, reason: "missing" };

  const hash = sha256File(binaryPath);
  const file = baselinePath(userDataDir);
  let baseline = null;
  if (existsSync(file)) {
    try {
      baseline = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
  }

  if (!baseline || baseline.appVersion !== appVersion) {
    writeFileSync(file, JSON.stringify({ appVersion, hash }));
    logger(`[integrity] recorded sing-box baseline for app ${appVersion}: ${hash}`);
    return { ok: true, firstRun: true };
  }

  if (baseline.hash !== hash) {
    logger(`[integrity] MISMATCH: expected ${baseline.hash}, got ${hash}`);
    return { ok: false, reason: "mismatch", expected: baseline.hash, actual: hash };
  }

  return { ok: true };
}
