// Country for a profile whose name does not say where the server is: ask an
// IP-geolocation service about the server's address, once, and remember the
// answer. Only the server's public IP address is sent — never the profile name,
// the UUID or any other part of the link. Pure logic only: the network call and
// the storage are passed in, so the desktop and the phone share it.
import { isIP } from "node:net";
import { AVAILABLE_FLAGS, hostOf, profileCountryCode } from "./country.js";

export const GEO_URL = (ip) => `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code`;

const HIT_TTL_MS = 30 * 24 * 3600 * 1000;
const MISS_TTL_MS = 24 * 3600 * 1000;

// Addresses a geolocation service cannot answer for (and that must not be sent
// to it): loopback, private LAN, link-local, carrier-grade NAT.
export function isPublicIp(host) {
  const h = String(host || "").replace(/^\[|\]$/g, "");
  const kind = isIP(h);
  if (kind === 4) {
    const [a, b] = h.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  if (kind === 6) {
    const l = h.toLowerCase();
    return !(l === "::" || l === "::1" || l.startsWith("fe80") || l.startsWith("fc") || l.startsWith("fd"));
  }
  return false;
}

export function parseGeoCountry(json) {
  if (!json || json.success === false) return null;
  const code = String(json.country_code || "").toLowerCase();
  return AVAILABLE_FLAGS.has(code) ? code : null;
}

// cache: { [host]: { code: "ro" | null, at: epoch ms } }
export function cachedCountry(cache, host) {
  const entry = cache?.[host];
  return entry && entry.code ? entry.code : null;
}

export function needsLookup(cache, host, now = Date.now()) {
  const entry = cache?.[host];
  if (!entry) return true;
  return now - entry.at > (entry.code ? HIT_TTL_MS : MISS_TTL_MS);
}

// The name wins (the user may know better, and it costs nothing); the cached
// geolocation answer is the fallback.
export function profileCountryWithGeo(profile, cache) {
  return profileCountryCode(profile) || cachedCountry(cache, hostOf(profile.link || ""));
}

// Looks up the profiles that still have no country. `fetchCountry(ip)` returns
// a country code or null (throws on a network failure, which is not cached, so
// it is tried again next time). `resolveHost(host)` turns a domain into an IP
// (omit it where DNS is not available: such profiles are skipped).
// Calls `onChange()` after the cache gained an entry.
export function createGeoResolver({ cache, save, fetchCountry, resolveHost, onChange, now = Date.now }) {
  const inFlight = new Set();

  async function lookup(host) {
    inFlight.add(host);
    try {
      let ip = host;
      if (!isIP(host.replace(/^\[|\]$/g, ""))) {
        if (!resolveHost) return;
        ip = await resolveHost(host);
      }
      if (!isPublicIp(ip)) {
        cache[host] = { code: null, at: now() };
      } else {
        cache[host] = { code: await fetchCountry(ip), at: now() };
      }
      save(cache);
      onChange?.();
    } catch {
      // network down or service unavailable: leave the cache alone, retry later
    } finally {
      inFlight.delete(host);
    }
  }

  return {
    // Call with the current profiles whenever they are shown; cheap when nothing is missing.
    queue(profiles) {
      for (const profile of profiles) {
        if (profileCountryCode(profile)) continue;
        const host = hostOf(profile.link || "");
        if (!host || inFlight.has(host) || !needsLookup(cache, host, now())) continue;
        lookup(host);
      }
    },
  };
}
