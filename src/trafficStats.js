import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";

const RETENTION_DAYS = 90;

// Local calendar day, because "traffic today" means the user's today.
export function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function daysAgo(now, n) {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  return d;
}

// Bytes per day per profile, kept locally in userData/traffic-stats.json.
// Only counters — no hosts, no URLs, nothing about what was visited.
export function createTrafficStats(userDataDir, { now = () => new Date(), logger = console.error } = {}) {
  const file = path.join(userDataDir, "traffic-stats.json");
  let data = null;
  let dirty = false;

  function load() {
    if (data) return;
    data = {};
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        if (raw && typeof raw === "object" && !Array.isArray(raw)) data = raw;
      } catch (err) {
        logger(`trafficStats: could not read ${file}: ${err.message}`);
      }
    }
    prune();
  }

  function prune() {
    const cutoff = dayKey(daysAgo(now(), RETENTION_DAYS));
    for (const key of Object.keys(data)) if (key < cutoff) delete data[key];
  }

  function add(profileId, up, down) {
    if (!profileId || !(up > 0 || down > 0)) return;
    load();
    const day = (data[dayKey(now())] ??= {});
    const entry = (day[profileId] ??= { up: 0, down: 0 });
    entry.up += up;
    entry.down += down;
    dirty = true;
  }

  function flush() {
    if (!dirty || !data) return;
    try {
      mkdirSync(userDataDir, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, file);
      dirty = false;
    } catch (err) {
      logger(`trafficStats: could not save ${file}: ${err.message}`);
    }
  }

  // The last `days` days ending today (zero-filled), plus per-profile totals
  // over the same window.
  function summary(days = 7) {
    load();
    const list = [];
    const perProfile = new Map();
    const totals = { up: 0, down: 0 };
    for (let i = days - 1; i >= 0; i--) {
      const key = dayKey(daysAgo(now(), i));
      const day = data[key] || {};
      let up = 0;
      let down = 0;
      for (const [id, e] of Object.entries(day)) {
        up += e.up;
        down += e.down;
        const p = perProfile.get(id) || { id, up: 0, down: 0 };
        p.up += e.up;
        p.down += e.down;
        perProfile.set(id, p);
      }
      list.push({ date: key, up, down });
      totals.up += up;
      totals.down += down;
    }
    const profiles = [...perProfile.values()].sort((a, b) => b.up + b.down - (a.up + a.down));
    return { days: list, profiles, totals };
  }

  return { add, flush, summary };
}
