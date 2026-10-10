// Picks which profile to use. `pings` maps profile id -> { ok, ms } as
// returned by the TCP ping.

export function pickBest(profiles, pings, excludeIds = []) {
  let best = null;
  for (const profile of profiles) {
    if (excludeIds.includes(profile.id)) continue;
    const r = pings[profile.id];
    if (r?.ok && (best === null || r.ms < best.ms)) best = { profile, ms: r.ms };
  }
  return best;
}

// Order in which to try profiles after the tunnel drops: the one that just
// failed (a blip is the most common reason), then the chosen fallback, then
// every other reachable profile, fastest first. Unreachable ones are left out.
export function buildReconnectPlan({ lostId, fallbackId, profiles, pings }) {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const order = [];
  if (byId.has(lostId)) order.push(lostId);
  if (fallbackId && fallbackId !== "auto" && fallbackId !== lostId && byId.has(fallbackId)) order.push(fallbackId);
  const rest = profiles
    .filter((p) => !order.includes(p.id) && pings[p.id]?.ok)
    .sort((a, b) => pings[a.id].ms - pings[b.id].ms);
  return [...order, ...rest.map((p) => p.id)];
}

// Favorites first, otherwise the user's own order.
export function sortWithFavorites(profiles, favoriteIds) {
  const fav = new Set(favoriteIds);
  return [...profiles.filter((p) => fav.has(p.id)), ...profiles.filter((p) => !fav.has(p.id))];
}
