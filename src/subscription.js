import { fragmentOf, hostOf } from "./country.js";

// atob + TextDecoder exist in Node and in the phone's WebView alike; Node's Buffer
// does not exist in the WebView, which made every base64 subscription look empty there.
function base64ToUtf8(b64) {
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Subscription bodies are either plain text with one link per line, or the
// same thing base64-encoded (standard or URL-safe alphabet).
export function decodeSubscriptionBody(text) {
  const t = text.trim();
  if (t && !t.includes("://") && /^[A-Za-z0-9+/_\-=\s]+$/.test(t)) {
    const normalized = t.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    try {
      return base64ToUtf8(normalized);
    } catch {
      return t;
    }
  }
  return t;
}

// Identity of a server entry, ignoring the query string and remark so that a
// renamed or re-parametrized link still counts as the same server.
export function linkKey(link) {
  const m = /^vless:\/\/([^@]+)@([^?#]+)/i.exec(link);
  return m ? `${m[1]}@${m[2]}`.toLowerCase() : link;
}

export function nameFromLink(link) {
  return fragmentOf(link).trim() || hostOf(link) || link;
}

// Only vless:// links are usable; anything else (vmess, trojan, ss, ...) is
// counted so the user can be told why a subscription "has more servers".
export function parseSubscription(text) {
  const lines = decodeSubscriptionBody(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const links = [];
  const seen = new Set();
  let skipped = 0;
  for (const line of lines) {
    if (/^vless:\/\//i.test(line)) {
      const key = linkKey(line);
      if (!seen.has(key)) {
        seen.add(key);
        links.push(line);
      }
    } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
      skipped++;
    }
  }
  return { links, skipped };
}

// existing: profiles that already belong to this subscription.
// otherKeys: linkKey()s of profiles the user added by hand (never duplicated).
// A profile the user renamed keeps its name; only a changed link is updated.
export function planSubscriptionSync(existing, links, otherKeys = new Set()) {
  const byKey = new Map(existing.map((p) => [linkKey(p.link), p]));
  const seen = new Set();
  const toAdd = [];
  const toUpdate = [];
  for (const link of links) {
    const key = linkKey(link);
    if (seen.has(key)) continue;
    seen.add(key);
    const current = byKey.get(key);
    if (current) {
      if (current.link !== link) {
        const update = { id: current.id, link };
        // A name the user never changed follows the server's (the panel renamed the
        // server); a name the user typed stays as it is.
        const serverName = nameFromLink(link);
        if (current.name === nameFromLink(current.link) && serverName !== current.name) update.name = serverName;
        toUpdate.push(update);
      }
    } else if (!otherKeys.has(key)) {
      toAdd.push({ name: nameFromLink(link), link });
    }
  }
  const toRemoveIds = existing.filter((p) => !seen.has(linkKey(p.link))).map((p) => p.id);
  return { toAdd, toUpdate, toRemoveIds };
}
