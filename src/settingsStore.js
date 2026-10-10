import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const DEFAULT_SETTINGS = {
  killSwitchEnabled: false,
  splitTunneling: {
    enabled: false,
    // Domains/hosts that should bypass the VPN and go out directly.
    domains: [],
    // Windows process executable names (e.g. "chrome.exe") that should
    // bypass the VPN and go out directly.
    processes: [],
  },
  // Connect to the fastest server (by TCP ping) instead of the last used one.
  autoBest: { enabled: false },
  // If the tunnel drops, try the same profile again, then a fallback.
  // fallbackProfileId: "auto" = best available by ping, or a profile id.
  autoReconnect: { enabled: false, fallbackProfileId: "auto" },
  subscriptionsAutoUpdate: true,
  lastProfileId: null,
  favorites: [],
  // { x, y, width, height, maximized } remembered between launches.
  window: null,
  hints: { trayShown: false },
};

export function settingsStorePath(userDataDir) {
  return path.join(userDataDir, "settings.json");
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// One level of nesting is merged (so {splitTunneling:{enabled:true}} keeps the
// domain list); everything else, including arrays, is replaced.
export function mergeSettings(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? { ...base[key], ...value } : value;
  }
  return out;
}

function withDefaults(raw) {
  return mergeSettings(structuredClone(DEFAULT_SETTINGS), raw);
}

export function createSettingsStore(userDataDir, logger = console.error) {
  const file = settingsStorePath(userDataDir);

  function load() {
    if (!existsSync(file)) return withDefaults({});
    try {
      return withDefaults(JSON.parse(readFileSync(file, "utf8")));
    } catch (err) {
      logger(`Failed to read settings from ${file}: ${err.message}`);
      return withDefaults({});
    }
  }

  function save(settings) {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(file, JSON.stringify(settings, null, 2));
  }

  function update(partial) {
    const next = mergeSettings(load(), partial);
    save(next);
    return next;
  }

  return { load, save, update };
}
