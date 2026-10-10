// Manual refresh of the routing lists (.srs rule-sets for "Russian sites direct"
// and the ad list). The app ships a copy; this puts newer files into the user
// data folder, which then take precedence. Nothing here runs on its own.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const RULE_FILES = {
  "geosite-category-ru.srs": "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ru.srs",
  "geoip-ru.srs": "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-ru.srs",
  "geosite-category-ads-all.srs": "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ads-all.srs",
};

const MIN_BYTES = 200;
const MAX_BYTES = 8 * 1024 * 1024;

// A sing-box binary rule-set starts with the magic "SRS" and a version byte.
export function isValidRuleSet(buf) {
  return Buffer.isBuffer(buf) && buf.length >= MIN_BYTES && buf.length <= MAX_BYTES && buf.subarray(0, 3).toString("latin1") === "SRS";
}

export function userRulesDir(userDataDir) {
  return path.join(userDataDir, "rules");
}

export function hasAllRules(dir) {
  return !!dir && Object.keys(RULE_FILES).every((name) => existsSync(path.join(dir, name)));
}

// The folder sing-box should read the lists from: the user's refreshed copy when
// complete, otherwise the one bundled with the app.
export function pickRulesDir(userDataDir, bundledDir) {
  const mine = userRulesDir(userDataDir);
  return hasAllRules(mine) ? mine : bundledDir;
}

// Downloads every list, validates all of them, and only then replaces the files
// (so a failure half-way never leaves a mixed set). `fetchBuffer(url)` returns a
// Buffer; it is injected so this can be tested without the network.
export async function refreshRules(userDataDir, fetchBuffer) {
  const dir = userRulesDir(userDataDir);
  const fresh = {};
  for (const [name, url] of Object.entries(RULE_FILES)) {
    const buf = await fetchBuffer(url);
    if (!isValidRuleSet(buf)) throw new Error(`Файл ${name} скачан некорректно`);
    fresh[name] = buf;
  }
  mkdirSync(dir, { recursive: true });
  const written = [];
  try {
    for (const [name, buf] of Object.entries(fresh)) {
      const tmp = path.join(dir, name + ".tmp");
      writeFileSync(tmp, buf);
      renameSync(tmp, path.join(dir, name));
      written.push(name);
    }
  } catch (err) {
    for (const name of written) rmSync(path.join(dir, name), { force: true });
    throw err;
  }
  return { dir, files: Object.keys(fresh), bytes: Object.values(fresh).reduce((a, b) => a + b.length, 0) };
}

export function readFileOrNull(file) {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}
