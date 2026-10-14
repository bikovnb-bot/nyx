// What the "+" dialog was given, the facts a subscription's response headers carry,
// and how the profile list is split into collapsible groups. Pure functions: the
// window and the tray both use them.

export const FAVORITES_GROUP_ID = "favorites";
export const MANUAL_GROUP_ID = "manual";

// ---------------------------------------------------------------- the "+" input

// A subscription is one http(s) address; servers are one or more vless:// links
// (one per line). Anything else is left for the dialog to reject.
export function detectAddInput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { kind: "unknown" };
  const lines = trimmed.split(/\s+/).filter(Boolean);
  if (lines.length === 1 && /^https?:\/\//i.test(lines[0])) {
    try {
      const url = new URL(lines[0]);
      if (url.hostname) return { kind: "subscription", url: url.toString() };
    } catch {}
    return { kind: "unknown" };
  }
  const links = lines.filter((l) => /^vless:\/\//i.test(l));
  if (links.length && links.length === lines.length) return { kind: "servers", links };
  return { kind: "unknown" };
}

// ---------------------------------------------------------------- response headers

function decodeBase64Utf8(b64) {
  const clean = b64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Profile-Title is plain text or "base64:<text>" (panels use the second form for
// non-ASCII names). Returns a short, single-line name or null.
export function parseProfileTitle(value) {
  if (value == null) return null;
  let text = String(value).trim();
  if (!text) return null;
  if (/^base64:/i.test(text)) {
    try {
      text = decodeBase64Utf8(text.slice(7));
    } catch {
      return null;
    }
  }
  text = text.replace(/[\r\n\t]+/g, " ").trim();
  if (!text) return null;
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

// "upload=1; download=2; total=3; expire=4" -> bytes used, limit (0 = none) and
// the expiry as epoch milliseconds (null = none).
export function parseUserinfo(value) {
  if (!value) return null;
  const fields = {};
  for (const part of String(value).split(";")) {
    const m = /^\s*([a-z]+)\s*=\s*(\d+)\s*$/i.exec(part);
    if (m) fields[m[1].toLowerCase()] = Number(m[2]);
  }
  if (!("upload" in fields) && !("download" in fields) && !("total" in fields)) return null;
  const used = (fields.upload || 0) + (fields.download || 0);
  const total = fields.total || 0;
  const expire = fields.expire ? fields.expire * 1000 : null;
  return { used, total, expire };
}

function formatBytes(n) {
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 || v >= 100 ? 0 : 1;
  const text = v.toFixed(digits).replace(/\.0$/, "").replace(".", ",");
  return `${text} ${units[i]}`;
}

// "19,2 ГБ из 50 ГБ · до 21.11.2026" (or just the used amount when there is no limit).
export function formatUsage(info) {
  if (!info) return "";
  const parts = [info.total ? `${formatBytes(info.used)} из ${formatBytes(info.total)}` : `${formatBytes(info.used)}`];
  if (info.expire) {
    const d = new Date(info.expire);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    parts.push(`до ${dd}.${mm}.${d.getFullYear()}`);
  }
  return parts.join(" · ");
}

// What a group header shows next to its name: "19,2 / 50 ГБ · 38 дн.", how full
// the limit is (0-100, null without a limit) and a level for the bar's colour.
export function formatUsageBar(info, now = Date.now()) {
  if (!info) return null;
  const text = info.total ? `${formatBytes(info.used)} / ${formatBytes(info.total)}` : formatBytes(info.used);
  let left = "";
  if (info.expire) {
    const days = Math.ceil((info.expire - now) / 86400000);
    left = days < 0 ? "истекла" : days === 0 ? "сегодня последний день" : `${days} дн.`;
  }
  const percent = info.total ? Math.min(100, Math.round((info.used / info.total) * 100)) : null;
  const level = percent === null ? "ok" : percent >= 90 ? "high" : percent >= 70 ? "mid" : "ok";
  return { text: left ? `${text} · ${left}` : text, percent, level };
}

// ---------------------------------------------------------------- grouping

// profiles: [{ id, name, subscriptionId?, favorite? }]
// subscriptions: [{ id, name, updatedAt, error, usage }]
// opts: collapsed (array of group ids), activeProfileId,
//       filtering (true while a search or country filter is on: groups with no
//       match disappear and the rest open up so every match is visible).
// Order: favorites, the servers added by hand, then each subscription.
export function buildGroups(profiles, subscriptions, opts = {}) {
  const collapsed = new Set(opts.collapsed || []);
  const filtering = !!opts.filtering;
  const groups = [];

  const make = (id, kind, name, items, extra = {}) => ({
    id,
    kind,
    name,
    profiles: items,
    count: items.length,
    hasActive: items.some((p) => p.id === opts.activeProfileId),
    collapsed: filtering ? false : collapsed.has(id),
    ...extra,
  });

  const favorites = profiles.filter((p) => p.favorite);
  if (favorites.length) groups.push(make(FAVORITES_GROUP_ID, "favorites", "Избранное", favorites));

  const manual = profiles.filter((p) => !p.subscriptionId);
  if (manual.length) groups.push(make(MANUAL_GROUP_ID, "manual", "Мои серверы", manual));

  for (const sub of subscriptions || []) {
    const items = profiles.filter((p) => p.subscriptionId === sub.id);
    // an empty subscription stays visible (it can be refreshed or removed) unless a filter is on
    if (!items.length && filtering) continue;
    groups.push(
      make(sub.id, "subscription", sub.name, items, {
        updatedAt: sub.updatedAt ?? null,
        error: sub.error ?? null,
        usage: sub.usage ?? null,
      })
    );
  }
  return groups;
}
