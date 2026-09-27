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
};

export function settingsStorePath(userDataDir) {
  return path.join(userDataDir, "settings.json");
}

export function createSettingsStore(userDataDir, logger = console.error) {
  const file = settingsStorePath(userDataDir);

  function load() {
    if (!existsSync(file)) return { ...DEFAULT_SETTINGS };
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      return {
        ...DEFAULT_SETTINGS,
        ...raw,
        splitTunneling: { ...DEFAULT_SETTINGS.splitTunneling, ...(raw.splitTunneling || {}) },
      };
    } catch (err) {
      logger(`Failed to read settings from ${file}: ${err.message}`);
      return { ...DEFAULT_SETTINGS };
    }
  }

  function save(settings) {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(file, JSON.stringify(settings, null, 2));
  }

  function update(partial) {
    const current = load();
    const next = {
      ...current,
      ...partial,
      splitTunneling: { ...current.splitTunneling, ...(partial.splitTunneling || {}) },
    };
    save(next);
    return next;
  }

  return { load, save, update };
}
