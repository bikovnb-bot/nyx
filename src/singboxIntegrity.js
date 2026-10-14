import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

export function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

// "singbox" keeps the file name earlier versions already wrote.
function baselinePath(userDataDir, label) {
  return path.join(userDataDir, `${label}-integrity.json`);
}

// Trust-on-first-use: the first time a given app version runs, this
// remembers the bundled sing-box binary's hash. On every later run of the
// SAME app version it verifies the binary on disk still matches — catching
// an unexpected swap/tamper of the vendored executable — without needing a
// table of precomputed hashes for every sing-box release baked into Nyx.
// A new app version (which ships its own pinned sing-box build) resets the
// baseline, so app updates never trigger a false mismatch.
export function verifyBinary(userDataDir, binaryPath, appVersion, logger = console.error, label = "singbox") {
  if (!existsSync(binaryPath)) return { ok: false, reason: "missing" };

  const hash = sha256File(binaryPath);
  const file = baselinePath(userDataDir, label);
  let baseline = null;
  if (existsSync(file)) {
    try {
      baseline = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
  }

  if (!baseline || baseline.appVersion !== appVersion) {
    writeFileSync(file, JSON.stringify({ appVersion, hash }));
    logger(`[integrity] recorded ${label === "singbox" ? "sing-box" : label} baseline for app ${appVersion}: ${hash}`);
    return { ok: true, firstRun: true };
  }

  if (baseline.hash !== hash) {
    logger(`[integrity] MISMATCH (${label}): expected ${baseline.hash}, got ${hash}`);
    return { ok: false, reason: "mismatch", expected: baseline.hash, actual: hash };
  }

  return { ok: true };
}

export function verifySingBoxBinary(userDataDir, binaryPath, appVersion, logger = console.error) {
  return verifyBinary(userDataDir, binaryPath, appVersion, logger, "singbox");
}
